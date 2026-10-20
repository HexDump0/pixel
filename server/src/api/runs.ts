/** /api/runs: list, create, inspect and control runs. */
import { existsSync, readFileSync } from "node:fs";
import { config } from "../config.ts";
import { addTimeline, db, getRun, listRuns, type RunRow } from "../db.ts";
import { runtime } from "../runtime/index.ts";
import { boostDisk, clientFor, controls, createRun, endBoost, resizeRun, exportTranscript, releaseRun, isWatching, publicRun, syncTranscript, transcript, type NewRun } from "../runs/index.ts";
import { listDir, readWorkbaseFile, reportPath, safeWorkbasePath, writeWorkbaseFile } from "../knowledge.ts";
import { crossReadsFor } from "../crossreads.ts";
import { historyLog, historyShow, snapshotWorkbase } from "../history.ts";
import {
  DISCLOSURE_FILTERS,
  DISPOSITION_FILTERS,
  enumFilter,
  findingCounts,
  findingEvents,
  listFindings,
  setDisclosure,
  SEVERITY_FILTERS,
  STATES,
  triageFinding,
  triageFindings,
  VIEWS,
  type DisclosureInput,
  type TriageInput,
} from "../findings.ts";
import { LLM_PURPOSES, llmBrief, llmList, originOf } from "../findingShare.ts";
import { del, get, HttpError, post, put, readJson } from "./router.ts";
import { findKey, keyFor, NO_KEY, providerKeys, publicKey } from "../providerAccounts.ts";
import { chooseKey, chooseProxy, nextKey, setFailover } from "../runs/keys.ts";

/** `limit` and `offset` from the query, applied when given (the dashboard asks for everything). */
function page<T>(list: T[], query: URLSearchParams): T[] {
  const limit = query.get("limit");
  const offset = Math.max(0, Number(query.get("offset")) || 0);
  if (limit === null && !offset) return list;
  const n = limit === null ? list.length : Number(limit);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, "limit must be a number of at least 0");
  return list.slice(offset, offset + n);
}

/** Filters shared by /findings and /runs/:id/findings. */
const findingQuery = (query: URLSearchParams) => {
  if (query.has("verdict")) throw new HttpError(400, "verdict was replaced by disposition (report, known, duplicate, weak, invalid, none)");
  return {
    severity: enumFilter("severity", query.get("severity"), SEVERITY_FILTERS),
    finalSeverity: enumFilter("final_severity", query.get("final_severity"), SEVERITY_FILTERS),
    state: enumFilter("state", query.get("state"), STATES),
    untriaged: query.get("untriaged") === "1",
    triaged: query.get("triaged") === "1",
    disposition: enumFilter("disposition", query.get("disposition"), DISPOSITION_FILTERS),
    disclosure: enumFilter("disclosure", query.get("disclosure"), DISCLOSURE_FILTERS),
    duplicateOf: query.get("duplicate_of") || undefined,
    repo: query.get("repo") || undefined,
    view: enumFilter("view", query.get("view"), VIEWS),
    q: query.get("q") || undefined,
  };
};

/** Who is triaging: the MCP endpoint calls the API itself and says which token it was (mcp.ts). */
const triager = (req: Request) => {
  const mcp = req.headers.get("x-pixel-mcp-token");
  return mcp ? `MCP: ${decodeURIComponent(mcp)}` : "dashboard";
};

function mustRun(id: string) {
  const r = getRun(id);
  if (!r) throw new HttpError(404, `no run ${id}`);
  return r;
}

const countBy = (sql: string) => new Map(db.query<{ run_id: string; n: number }, []>(sql).all().map((r) => [r.run_id, r.n]));

/** `opencode attach` command for the user's own terminal. */
function attachCommand(run: RunRow) {
  if (!run.endpoint) return null;
  const ep = new URL(run.endpoint);
  const host = config.publicHost || ep.hostname;
  const session = run.session_id ? ` --session ${run.session_id}` : "";
  return `OPENCODE_SERVER_PASSWORD='${run.opencode_password}' opencode attach http://${host}:${ep.port}${session} --dir ${runtime.paths(run).target}`;
}

get("/runs", ({ query }) => {
  const questions = countBy("SELECT run_id, COUNT(*) AS n FROM questions WHERE status = 'pending' GROUP BY run_id");
  const reads = countBy("SELECT run_id, COUNT(*) AS n FROM cross_reads GROUP BY run_id");
  const findings = findingCounts();
  // The oldest pending question per run, so the Wall can show it and take an answer on the tile.
  const asking = new Map<string, { id: string; created_at: number; questions: unknown[] }>();
  for (const q of db.query<{ run_id: string; data: string; created_at: number }, []>("SELECT run_id, data, created_at FROM questions WHERE status = 'pending' ORDER BY created_at").all())
    if (!asking.has(q.run_id)) {
      const d = JSON.parse(q.data);
      asking.set(q.run_id, { id: d.id, created_at: q.created_at, questions: d.questions ?? [] });
    }
  return page(listRuns(), query).map((r) => ({
    ...publicRun(r),
    questions: questions.get(r.id) ?? 0,
    question: asking.get(r.id) ?? null,
    cross_reads: reads.get(r.id) ?? 0,
    findings: findings[r.id] ?? null,
  }));
});

interface CreateBody extends Omit<NewRun, "compareGroup"> {
  /** Compare mode: one run per model × template version. */
  models?: string[];
  templateVersions?: number[];
}

post("/runs", async ({ req }) => {
  const b = await readJson<CreateBody>(req);
  const models = b.models?.length ? b.models : [b.model];
  const versions = b.templateVersions?.length ? b.templateVersions : [b.templateVersion];
  const compare = models.length * versions.length > 1;
  const compareGroup = compare ? `cmp-${Date.now().toString(36)}` : undefined;
  const created = [];
  for (const model of models)
    for (const templateVersion of versions)
      created.push(
        publicRun(
          createRun({
            ...b,
            model,
            templateVersion,
            compareGroup,
            // a fixed name or edited prompt only makes sense for a single run
            name: compare ? undefined : b.name,
            promptOverride: compare ? undefined : b.promptOverride,
            // compare mode uses each provider's default key
            keyId: compare ? undefined : b.keyId,
          }),
        ),
      );
  return created;
});

get("/runs/:id", ({ params: { id } }) => {
  const run = mustRun(id);
  const all = listRuns();
  return {
    run: publicRun(run),
    prompt: run.prompt,
    sessions: db.query("SELECT * FROM sessions WHERE run_id = ? ORDER BY created_at").all(id),
    todos: db.query<{ session_id: string; data: string }, [string]>("SELECT session_id, data FROM todos WHERE run_id = ?").all(id).map((t) => ({ session_id: t.session_id, todos: JSON.parse(t.data) })),
    questions: db
      .query<{ data: string; status: string; created_at: number }, [string]>("SELECT data, status, created_at FROM questions WHERE run_id = ? ORDER BY created_at DESC")
      .all(id)
      .map((q) => ({ ...JSON.parse(q.data), status: q.status, created_at: q.created_at })),
    paths: runtime.paths(run),
    attach: attachCommand(run),
    shell: run.vm_name ? runtime.shellCommand(run) : null,
    watching: isWatching(id),
    report: existsSync(reportPath(id)),
    // Prompt tokens of every model call: cache rate = read / (input + read + write), as on the Stats page.
    cache: db
      .query<{ input: number; read: number; write: number }, [string]>(
        "SELECT COALESCE(SUM(input), 0) AS input, COALESCE(SUM(cache_read), 0) AS read, COALESCE(SUM(cache_write), 0) AS write FROM model_calls WHERE run_id = ?",
      )
      .get(id),
    compare: run.compare_group ? all.filter((r) => r.compare_group === run.compare_group).map((r) => r.id) : [],
    followUps: all.filter((r) => r.parent_run === id).map((r) => r.id),
  };
});

get("/runs/:id/transcript.json", async ({ params: { id } }) => {
  mustRun(id);
  const body = Bun.gzipSync(JSON.stringify(await exportTranscript(id)));
  return new Response(body, { headers: { "content-type": "application/json", "content-encoding": "gzip", "content-disposition": `attachment; filename="${id}-transcript.json"` } });
});

get("/runs/:id/transcript", ({ params: { id }, query }) => {
  const run = mustRun(id);
  const session = query.get("session") || run.session_id;
  return session ? transcript(id, session, Number(query.get("since") ?? 0)) : [];
});
get("/runs/:id/timeline", ({ params: { id } }) =>
  db.query<any, [string]>("SELECT * FROM timeline WHERE run_id = ? ORDER BY ts, id").all(id).map((t) => ({ ...t, data: t.data ? JSON.parse(t.data) : null })),
);
get("/runs/:id/metrics", ({ params: { id } }) => db.query("SELECT * FROM metrics WHERE run_id = ? ORDER BY ts").all(id));
get("/runs/:id/crossreads", ({ params: { id } }) => crossReadsFor(id));
get("/runs/:id/report", ({ params: { id } }) => {
  mustRun(id);
  const p = reportPath(id);
  return { content: existsSync(p) ? readFileSync(p, "utf8") : null };
});
// ---- findings (workbase findings/F<n>-name/README.md → findings table) ----

get("/runs/:id/findings", ({ params: { id }, query }) => {
  mustRun(id);
  return page(listFindings({ run: id, includeRemoved: true, ...findingQuery(query) }), query);
});
get("/runs/:id/findings/events", ({ params: { id }, query }) => {
  mustRun(id);
  return findingEvents({ run: id, finding: query.get("finding") ?? undefined, since: Number(query.get("since") ?? 0) || undefined, limit: Number(query.get("limit") ?? 1000) });
});
/** Triage: disposition, final severity, duplicate_of and note; fields left out stay as they are. */
post("/runs/:id/findings/:fid/triage", async ({ req, params: { id, fid } }) => {
  mustRun(id);
  return triageFinding(id, fid, await readJson<TriageInput>(req), triager(req));
});
/** Many at once (imports, a triage agent's batch): each item reports ok or its error; files are written once. */
post("/findings/triage", async ({ req }) => {
  const b = await readJson<{ items?: (TriageInput & { run: string; finding: string })[] }>(req);
  if (!Array.isArray(b.items) || !b.items.length) throw new HttpError(400, "items: a list of {run, finding, disposition, severity, duplicate_of, note}");
  if (b.items.length > 500) throw new HttpError(400, "at most 500 items at once");
  if (b.items.some((it) => typeof it?.run !== "string" || typeof it?.finding !== "string")) throw new HttpError(400, "each item needs run and finding");
  const results = triageFindings(b.items, triager(req));
  return { ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results: results.map((r) => (r.ok ? { run: r.run, finding: r.finding, ok: true, finding_row: r.finding_row } : r)) };
});
/** Disclosure (ready, reported, fixed, dropped): set by hand in the dashboard only, so no agent marks something as sent. */
post("/runs/:id/findings/:fid/disclosure", async ({ req, params: { id, fid } }) => {
  mustRun(id);
  if (req.headers.get("x-pixel-mcp-token")) throw new HttpError(403, "disclosure is set by a person in the dashboard, not over MCP");
  return setDisclosure(id, fid, await readJson<DisclosureInput>(req));
});
/** The finding as one markdown text for another model, with a signed link to its files. purpose: verify, disclose or variants. */
get("/runs/:id/findings/:fid/llm", ({ req, params: { id, fid }, query }) => {
  mustRun(id);
  const purpose = enumFilter("purpose", query.get("purpose"), LLM_PURPOSES) as (typeof LLM_PURPOSES)[number] | undefined;
  return llmBrief(id, fid, originOf(req), purpose);
});
/** Several findings as one markdown text (a list on the Findings page): ids as run/id, purpose: list, triage, verify, disclose or variants. */
post("/findings/llm", async ({ req }) => {
  const b = await readJson<{ ids?: string[]; purpose?: string; title?: string }>(req);
  if (!Array.isArray(b.ids) || !b.ids.length) throw new HttpError(400, "ids: a list of run/finding ids");
  if (b.ids.length > 500) throw new HttpError(400, "at most 500 findings at once");
  const purpose = enumFilter("purpose", b.purpose, ["list", ...LLM_PURPOSES, "triage"]) ?? "list";
  return llmList(b.ids, purpose as any, b.title);
});
get("/findings", ({ query }) => page(listFindings({ run: query.get("run") ?? undefined, ...findingQuery(query) }), query));
get("/findings/events", ({ query }) => findingEvents({ since: Number(query.get("since") ?? 0) || undefined, limit: Number(query.get("limit") ?? 200) }));

get("/runs/:id/vm", async ({ params: { id } }) => {
  const run = mustRun(id);
  const [state, opencode] = await Promise.all([runtime.vmState(run), run.endpoint ? clientFor(run).healthy() : false]);
  return { state, opencode };
});
post("/runs/:id/release", async ({ params: { id } }) => ({ released: await releaseRun(id) }));
get("/runs/:id/processes", ({ params: { id } }) => runtime.processes(mustRun(id)).catch(() => []));
get("/runs/:id/snapshots", ({ params: { id } }) => runtime.listSnapshots(mustRun(id)).catch(() => []));

// ---- workbase files and history ----

get("/runs/:id/files", ({ params: { id }, query }) => listDir(id, query.get("path") ?? ""));
get("/runs/:id/file", ({ params: { id }, query }) => readWorkbaseFile(id, query.get("path") ?? ""));
get("/runs/:id/raw", ({ params: { id }, query }) => {
  const full = safeWorkbasePath(id, query.get("path") ?? "");
  return new Response(Bun.file(full), { headers: { "content-disposition": `attachment; filename="${full.split("/").pop()}"` } });
});
put("/runs/:id/file", async ({ req, params: { id }, query }) => {
  const path = query.get("path") ?? "";
  writeWorkbaseFile(id, path, (await readJson<{ content: string }>(req)).content);
  addTimeline(id, "user", "file", `Edited ${path} in the workbase`);
});
/** `path` (relative to the workbase) narrows the log and the patch to one file or folder. */
const historyPath = (id: string, p: string | null) => (p ? (safeWorkbasePath(id, p), p.replace(/^\/+/, "")) : undefined);
get("/runs/:id/history", ({ params: { id }, query }) => historyLog(id, 200, historyPath(id, query.get("path"))));
post("/runs/:id/history", async ({ params: { id } }) => ({ commit: await snapshotWorkbase(id, "manual snapshot") }));
get("/runs/:id/history/:commit", async ({ params: { id, commit }, query }) => ({ patch: await historyShow(id, commit, historyPath(id, query.get("path"))) }));

// ---- controls ----

post("/runs/:id/message", async ({ req, params: { id } }) => controls.sendMessage(id, (await readJson(req)).text));
post("/runs/:id/continue", ({ params: { id } }) => controls.continueRun(id));
post("/runs/:id/abort", ({ params: { id } }) => controls.abortRun(id));
post("/runs/:id/pause", ({ params: { id } }) => controls.pauseRun(id));
post("/runs/:id/resume", async ({ req, params: { id } }) => controls.resumeRun(id, (await readJson(req)).message));
post("/runs/:id/stop", ({ params: { id } }) => controls.stopRun(id));
post("/runs/:id/done", ({ params: { id } }) => controls.markDone(id));
post("/runs/:id/retry", ({ params: { id } }) => controls.retryPrepare(id));
post("/runs/:id/restart-opencode", ({ params: { id } }) => controls.restartOpencode(id));
post("/runs/:id/model", async ({ req, params: { id } }) => {
  const b = await readJson<{ model?: string; variant?: string | null }>(req);
  return controls.setModel(id, b.model, b.variant);
});
post("/runs/:id/autopilot", async ({ req, params: { id } }) => controls.setAutopilot(id, !!(await readJson(req)).on));
get("/runs/:id/keys", ({ params: { id } }) => {
  const run = mustRun(id);
  const provider = run.model.split("/")[0];
  const keys = providerKeys(provider);
  const cur = keyFor(run, provider);
  const costs = db.query<{ key_id: string | null; cost: number }, [string]>("SELECT key_id, SUM(cost) AS cost FROM llm_calls WHERE run_id = ? GROUP BY key_id").all(id);
  const nameOf = (k: string | null) => (k && findKey(k)?.key.name) || (k ? "removed key" : "before keys were tracked");
  return {
    provider,
    current: run.key_id === NO_KEY ? NO_KEY : (cur?.id ?? null),
    failover: !!run.key_failover,
    next: cur && run.key_failover ? (nextKey(provider, cur.id)?.name ?? null) : null,
    keys: keys.map(publicKey),
    costs: costs.filter((c) => c.cost > 0).map((c) => ({ key: c.key_id, name: nameOf(c.key_id), cost: c.cost })),
  };
});
post("/runs/:id/key", async ({ req, params: { id } }) => chooseKey(id, (await readJson(req)).keyId ?? null));
post("/runs/:id/proxy", async ({ req, params: { id } }) => chooseProxy(id, (await readJson(req)).proxyId || null));
post("/runs/:id/failover", async ({ req, params: { id } }) => setFailover(id, !!(await readJson(req)).on));
post("/runs/:id/label", async ({ req, params: { id } }) => controls.setLabel(id, (await readJson(req)).label));
post("/runs/:id/reset-counters", ({ params: { id } }) => controls.resetCounters(id));
post("/runs/:id/sync", ({ params: { id } }) => syncTranscript(id));
post("/runs/:id/vm/:action", async ({ req, params: { id, action } }) => {
  if (!["start", "stop", "snapshot", "restore"].includes(action)) throw new HttpError(400, "bad action");
  return controls.vmAction(id, action as controls.VmAction, (await readJson(req)).snapshot);
});
del("/runs/:id/vm", ({ params: { id } }) => controls.deleteMachine(id));
post("/runs/:id/size", async ({ req, params: { id } }) => resizeRun(id, await readJson(req)));
post("/runs/:id/disk-boost", ({ params: { id } }) => boostDisk(id, "user"));
del("/runs/:id/disk-boost", ({ params: { id } }) => endBoost(id, "user"));
post("/runs/:id/question/:qid", async ({ req, params: { id, qid } }) => {
  const b = await readJson<{ answers?: string[][]; reject?: boolean }>(req);
  return controls.answerQuestion(id, qid, b.reject ? null : (b.answers ?? []));
});
post("/runs/:id/triage", async ({ req, params: { id } }) => {
  const b = await readJson(req);
  return controls.triage(id, b.notes ?? null, !!b.markTriaged, !!b.keepVm);
});
post("/runs/:id/rerun", async ({ req, params: { id } }) => publicRun(controls.rerun(id, await readJson(req))));
del("/runs/:id", ({ params: { id }, query }) => controls.deleteRun(id, query.get("workbase") === "1"));
