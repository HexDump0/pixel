/** Creating runs and bringing them from 'preparing' to a running opencode session. */
import { existsSync } from "node:fs";
import { db, getRun, type RunRow, type RunSize } from "../db.ts";
import { getSettings } from "../settings.ts";
import { publish } from "../bus.ts";
import { runtime } from "../runtime/index.ts";
import { detectLanguage, ensureWorkbase, refreshRunFiles, workbasePath } from "../knowledge.ts";
import { getVersion, latestVersion, render } from "../templates.ts";
import { snapshotWorkbase } from "../history.ts";
import { clientFor, notifyRun, publicRun, setRun, setStatus, timeline } from "./state.ts";
import { watch } from "./events.ts";

export interface NewRun {
  repo: string;
  ref?: string;
  templateId: string;
  templateVersion?: number;
  model?: string;
  /** Preset name or explicit size. */
  size?: string | RunSize;
  /** Earlier run whose workbase is offered as a starting point (re-audit). */
  parentRun?: string;
  compareGroup?: string;
  autopilot?: boolean;
  /** Template body edited in the dashboard for this run only; rendered like a template. */
  promptOverride?: string;
  name?: string;
}

export function repoName(repo: string) {
  const last = repo.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop() || "run";
  return last.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[.-]+/, "").slice(0, 40) || "run";
}

const taken = (id: string) => !!getRun(id) || existsSync(workbasePath(id));

/** `<repo>-<YYYY-MM-DD>[-n]`, unique across runs and workbases. */
export function newRunId(repo: string, date = new Date()) {
  const base = `${repoName(repo)}-${date.toISOString().slice(0, 10)}`;
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!taken(id)) return id;
  }
}

const randomSecret = () => Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");

export function createRun(o: NewRun): RunRow {
  const s = getSettings();
  const repo = o.repo?.trim() ?? "";
  if (!/^(https?:\/\/|git@|ssh:\/\/|git:\/\/|\/)/.test(repo)) throw new Error("repo must be a git URL");
  const tv = o.templateVersion ? getVersion(o.templateId, o.templateVersion) : latestVersion(o.templateId);
  if (!tv) throw new Error(`template ${o.templateId}${o.templateVersion ? ` v${o.templateVersion}` : ""} not found`);
  const size = typeof o.size === "object" ? o.size : s.sizePresets[o.size || s.defaultSize];
  if (!size) throw new Error(`unknown size preset ${o.size}`);
  if (o.parentRun && !getRun(o.parentRun)) throw new Error(`no run ${o.parentRun}`);
  const model = o.model || s.defaultModel;
  if (!model.includes("/")) throw new Error("model must look like provider/model");
  const id = o.name?.trim() ? o.name.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-") : newRunId(repo);
  if (taken(id)) throw new Error(`a run or workbase named ${id} already exists`);

  db.query(
    `INSERT INTO runs (id, repo, ref, template_id, template_version, prompt, model, size, status, runtime, autopilot, parent_run, compare_group, opencode_password, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    repo,
    o.ref?.trim() || null,
    tv.template_id,
    tv.version,
    o.promptOverride ?? null,
    model,
    JSON.stringify(size),
    runtime.kind,
    o.autopilot === false ? 0 : 1,
    o.parentRun || null,
    o.compareGroup || null,
    randomSecret(),
    Date.now(),
  );
  ensureWorkbase(id);
  refreshRunFiles(id);
  timeline(id, "user", "created", `Run created: ${repo}${o.ref ? ` @ ${o.ref}` : ""}, ${model}, template ${tv.template_id} v${tv.version}`);
  const run = getRun(id)!;
  publish("*", "run", publicRun(run));
  void prepare(id);
  return run;
}

/** Variables available to prompt templates. */
export function templateVars(run: Pick<RunRow, "id" | "repo" | "ref" | "commit_sha" | "size" | "started_at" | "model" | "parent_run">) {
  const p = runtime.paths(run as RunRow);
  const size = JSON.parse(run.size) as RunSize;
  return {
    run: run.id,
    repo: run.repo,
    ref: run.ref,
    commit: run.commit_sha ?? "(not cloned yet)",
    target: p.target,
    workbase: p.workbase,
    workbases: p.workbases,
    scratch: p.scratch,
    disk_gib: String(size.diskGiB),
    date: new Date(run.started_at ?? Date.now()).toISOString().slice(0, 10),
    model: run.model,
    previous_workbase: run.parent_run ? `${p.workbases}/${run.parent_run}` : null,
  };
}

/** Until the run starts, `prompt` holds an optional edited template body; afterwards, the prompt that was sent. */
export function renderPrompt(run: RunRow) {
  const body = run.prompt ?? getVersion(run.template_id!, run.template_version!)?.body;
  if (body === undefined) throw new Error(`template ${run.template_id} v${run.template_version} is gone`);
  return render(body, templateVars(run));
}

const preparing = new Set<string>();

/** Machine, clone, opencode, session, first prompt. Safe to call again after a crash or failure. */
export async function prepare(id: string) {
  if (preparing.has(id)) return;
  preparing.add(id);
  try {
    let run = getRun(id)!;
    const s = getSettings();
    ensureWorkbase(id);
    timeline(id, "pixel", "prepare", "Preparing machine");
    const prepared = await runtime.prepare({
      run,
      size: JSON.parse(run.size),
      workbaseHostPath: workbasePath(id),
      env: s.agentEnv,
      authJson: s.agentAuthJson,
      opencodePassword: run.opencode_password!,
      log: (m) => {
        setRun(id, { status_detail: m });
        timeline(id, "pixel", "prepare", m);
      },
    });
    run = setRun(id, { vm_name: prepared.vmName, endpoint: prepared.endpoint })!;

    const target = runtime.paths(run).target;
    const [head, files] = await Promise.all([
      runtime.exec(run, ["git", "-C", target, "rev-parse", "HEAD"]),
      runtime.exec(run, ["git", "-C", target, "ls-files"]),
    ]);
    run = setRun(id, {
      commit_sha: head.code === 0 ? head.stdout.trim() : run.commit_sha,
      language: detectLanguage(files.stdout) ?? run.language,
    })!;

    setRun(id, { status_detail: "Waiting for opencode" });
    const client = clientFor(run);
    await client.waitHealthy(180_000);

    if (run.session_id) {
      // Prepared before Pixel restarted: the session exists, just watch it again.
      setStatus(id, "running");
      watch(id);
      return;
    }
    run = setRun(id, { started_at: Date.now() })!;
    const text = renderPrompt(run);
    const session = await client.createSession(run.id);
    run = setStatus(id, "running", null, { session_id: session.id, prompt: text, agent_status: "busy", last_activity: Date.now() })!;
    watch(id);
    await client.prompt(session.id, text, run.model);
    timeline(id, "pixel", "prompt", "Sent the audit prompt", { chars: text.length });
    snapshotWorkbase(id, "start").catch(() => {});
  } catch (e: any) {
    const message = e?.message ?? String(e);
    console.error(`prepare ${id} failed`, e);
    const run = setStatus(id, "failed", message.slice(0, 1000));
    timeline(id, "pixel", "failed", `Preparing failed: ${message}`);
    if (run) notifyRun("failed", run, "Run failed", message);
  } finally {
    preparing.delete(id);
  }
}
