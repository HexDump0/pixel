/** Shared helpers for changing a run and telling everyone about it (dashboard, workbase files, notifications). */
import { config } from "../config.ts";
import { addTimeline, getRun, updateRun, type RunRow, type RunSize, type RunStatus } from "../db.ts";
import { publish } from "../bus.ts";
import { OpencodeClient } from "../opencode.ts";
import { runtime } from "../runtime/index.ts";
import { refreshRunFiles } from "../knowledge.ts";
import { notify, type NotifyKind } from "../notify.ts";

export type Actor = "pixel" | "user" | "agent";

export function timeline(runId: string, actor: Actor, kind: string, message: string, data?: unknown) {
  const entry = addTimeline(runId, actor, kind, message, data);
  publish(runId, "timeline", entry);
  publish("*", "timeline", entry);
  return entry;
}

/** The run as the dashboard sees it (no secrets, size parsed). */
export function publicRun(run: RunRow) {
  const { opencode_password, prompt, ...rest } = run;
  return { ...rest, size: JSON.parse(run.size) as RunSize };
}
export type PublicRun = ReturnType<typeof publicRun>;

/** Fields that other agents can see in run.json / INDEX.md; changing them rewrites those files. */
const INDEXED_FIELDS = ["status", "commit_sha", "triage_verdict", "report_ready", "language"];

export function setRun(id: string, fields: Partial<RunRow>) {
  updateRun(id, fields);
  const run = getRun(id);
  if (run) {
    const pub = publicRun(run);
    publish(id, "run", pub);
    publish("*", "run", pub);
  }
  if (Object.keys(fields).some((k) => INDEXED_FIELDS.includes(k))) refreshRunFiles(id);
  return run;
}

export function setStatus(id: string, status: RunStatus, detail: string | null = null, extra: Partial<RunRow> = {}) {
  return setRun(id, { status, status_detail: detail, ...extra });
}

export function mustRun(id: string) {
  const run = getRun(id);
  if (!run) throw new Error(`no run ${id}`);
  return run;
}

export function mustSession(run: RunRow) {
  if (!run.session_id || !run.endpoint) throw new Error("the run has no session yet");
  return run;
}

export function clientFor(run: RunRow) {
  if (!run.endpoint) throw new Error("run has no opencode endpoint yet");
  return new OpencodeClient(run.endpoint, run.opencode_password, runtime.paths(run).target);
}

export function notifyRun(kind: NotifyKind, run: RunRow, title: string, body: string) {
  const link = config.publicUrl ? `${config.publicUrl.replace(/\/$/, "")}/runs/${encodeURIComponent(run.id)}` : undefined;
  notify(kind, `${title}: ${run.id}`, body, link).catch((e) => console.error("notify failed", e));
}
