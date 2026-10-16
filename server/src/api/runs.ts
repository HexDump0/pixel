/** /api/runs: list, create, inspect and control runs. */
import { existsSync, readFileSync } from "node:fs";
import { config } from "../config.ts";
import { addTimeline, db, getRun, listRuns, type RunRow } from "../db.ts";
import { runtime } from "../runtime/index.ts";
import { clientFor, controls, createRun, isWatching, publicRun, syncTranscript, transcript, type NewRun } from "../runs/index.ts";
import { listDir, readWorkbaseFile, reportPath, safeWorkbasePath, writeWorkbaseFile } from "../knowledge.ts";
import { crossReadsFor } from "../crossreads.ts";
import { historyLog, historyShow, snapshotWorkbase } from "../history.ts";
import { findingCounts, findingEvents, listFindings, setVerdict, type Verdict } from "../findings.ts";
import { llmBrief, originOf } from "../findingShare.ts";
import { del, get, HttpError, post, put, readJson } from "./router.ts";
import { findKey, keyFor, providerKeys, publicKey } from "../providerAccounts.ts";
import { chooseKey, nextKey, setFailover } from "../runs/keys.ts";

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

get("/runs", () => {
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
  return listRuns().map((r) => ({
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
        `SELECT COALESCE(SUM(json_extract(data, '$.tokens.input')), 0) AS input, COALESCE(SUM(json_extract(data, '$.tokens.cache.read')), 0) AS read,
           COALESCE(SUM(json_extract(data, '$.tokens.cache.write')), 0) AS write FROM messages WHERE run_id = ? AND role = 'assistant'`,
      )
      .get(id),
    compare: run.compare_group ? all.filter((r) => r.compare_group === run.compare_group).map((r) => r.id) : [],
    followUps: all.filter((r) => r.parent_run === id).map((r) => r.id),
  };
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

get("/runs/:id/findings", ({ params: { id } }) => {
  mustRun(id);
  return listFindings({ run: id, includeRemoved: true });
});
get("/runs/:id/findings/events", ({ params: { id }, query }) => {
  mustRun(id);
  return findingEvents({ run: id, finding: query.get("finding") ?? undefined, since: Number(query.get("since") ?? 0) || undefined, limit: Number(query.get("limit") ?? 1000) });
});
post("/runs/:id/findings/:fid/verdict", async ({ req, params: { id, fid } }) => {
  mustRun(id);
  const b = await readJson<{ verdict?: Verdict | null; note?: string | null }>(req);
  return setVerdict(id, fid, b.verdict ?? null, b.note ?? null);
});
/** The finding as one markdown text for another model, with a signed link to its files. */
get("/runs/:id/findings/:fid/llm", ({ req, params: { id, fid } }) => {
  mustRun(id);
  return llmBrief(id, fid, originOf(req));
});
get("/findings", ({ query }) =>
  listFindings({ run: query.get("run") ?? undefined, untriaged: query.get("untriaged") === "1", severity: query.get("severity") ?? undefined }),
);
get("/findings/events", ({ query }) => findingEvents({ since: Number(query.get("since") ?? 0) || undefined, limit: Number(query.get("limit") ?? 200) }));

get("/runs/:id/vm", async ({ params: { id } }) => {
  const run = mustRun(id);
  const [state, opencode] = await Promise.all([runtime.vmState(run), run.endpoint ? clientFor(run).healthy() : false]);
  return { state, opencode };
});
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
    current: cur?.id ?? null,
    failover: !!run.key_failover,
    next: cur && run.key_failover ? (nextKey(provider, cur.id)?.name ?? null) : null,
    keys: keys.map(publicKey),
    costs: costs.filter((c) => c.cost > 0).map((c) => ({ key: c.key_id, name: nameOf(c.key_id), cost: c.cost })),
  };
});
post("/runs/:id/key", async ({ req, params: { id } }) => chooseKey(id, (await readJson(req)).keyId ?? null));
post("/runs/:id/failover", async ({ req, params: { id } }) => setFailover(id, !!(await readJson(req)).on));
post("/runs/:id/label", async ({ req, params: { id } }) => controls.setLabel(id, (await readJson(req)).label));
post("/runs/:id/reset-counters", ({ params: { id } }) => controls.resetCounters(id));
post("/runs/:id/sync", ({ params: { id } }) => syncTranscript(id));
post("/runs/:id/vm/:action", async ({ req, params: { id, action } }) => {
  if (!["start", "stop", "snapshot", "restore"].includes(action)) throw new HttpError(400, "bad action");
  return controls.vmAction(id, action as controls.VmAction, (await readJson(req)).snapshot);
});
del("/runs/:id/vm", ({ params: { id } }) => controls.deleteMachine(id));
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
