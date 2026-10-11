/** Capture of opencode's event stream into SQLite, and the per-run watcher that holds the connection. */
import { db, getRun, updateRun } from "../db.ts";
import { publish } from "../bus.ts";
import type { OpencodeEvent } from "../opencode.ts";
import { runtime } from "../runtime/index.ts";
import { recordCrossReads } from "../crossreads.ts";
import { onPart } from "../fleet.ts";
import { clientFor, notifyRun, setRun, timeline } from "./state.ts";
import { onIdle } from "./lifecycle.ts";

export interface Watcher {
  abort: AbortController;
  connected: boolean;
  /** Tool parts already checked for cross-reads. */
  seenCalls: Set<string>;
  /** Consecutive failed health checks. */
  unhealthy: number;
  lastMetrics: number;
  /** Tail of the queue that serialises idle handling and recovery so they never overlap. */
  queue: Promise<unknown>;
}

const watchers = new Map<string, Watcher>();

export const getWatcher = (id: string) => watchers.get(id);
export const isWatching = (id: string) => watchers.get(id)?.connected ?? false;
export const watchedRuns = () => [...watchers.keys()];

/** Run `fn` after everything already queued for this run. */
export function serial(w: Watcher, fn: () => Promise<unknown>) {
  const next = w.queue.then(fn, fn).catch((e) => console.error("run task failed", e));
  w.queue = next;
  return next;
}

/** Keep an event stream open to the run's opencode, reconnecting with backoff. */
export function watch(id: string) {
  if (watchers.has(id)) return;
  const w: Watcher = { abort: new AbortController(), connected: false, seenCalls: new Set(), unhealthy: 0, lastMetrics: 0, queue: Promise.resolve() };
  watchers.set(id, w);
  (async () => {
    let backoff = 1000;
    while (!w.abort.signal.aborted) {
      const run = getRun(id);
      if (!run?.endpoint) break;
      try {
        await clientFor(run).streamEvents((e) => {
          if (!w.connected) {
            w.connected = true;
            backoff = 1000;
            syncTranscript(id).catch((err) => console.error("sync failed", err));
          }
          try {
            handleEvent(id, w, e);
          } catch (err) {
            console.error(`event ${e.type} for ${id} failed`, err);
          }
        }, w.abort.signal);
      } catch {
        // connection refused or dropped; the watchdog decides whether opencode needs recovering
      }
      w.connected = false;
      if (w.abort.signal.aborted) break;
      await Bun.sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  })();
}

export function unwatch(id: string) {
  watchers.get(id)?.abort.abort();
  watchers.delete(id);
}

// ---- storage ----

const upsertMessage = db.query(
  "INSERT INTO messages (id, run_id, session_id, role, data, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
);
const upsertPart = db.query(
  "INSERT INTO parts (id, run_id, session_id, message_id, type, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
);
const upsertSession = db.query(
  `INSERT INTO sessions (id, run_id, parent_id, title, agent, cost, tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET title = excluded.title, agent = excluded.agent, cost = excluded.cost, tokens = excluded.tokens, parent_id = excluded.parent_id`,
);
const upsertTodos = db.query("INSERT INTO todos (session_id, run_id, data) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET data = excluded.data");

function storeSession(runId: string, info: any) {
  if (!info?.id) return;
  upsertSession.run(info.id, runId, info.parentID ?? null, info.title ?? null, info.agent ?? null, info.cost ?? 0, JSON.stringify(info.tokens ?? {}), info.time?.created ?? Date.now());
  // Run totals = root session + every subagent session.
  const t = { tokens_in: 0, tokens_out: 0, tokens_reasoning: 0, tokens_cache: 0, cost: 0 };
  for (const r of db.query<{ cost: number; tokens: string }, [string]>("SELECT cost, tokens FROM sessions WHERE run_id = ?").all(runId)) {
    const k = JSON.parse(r.tokens || "{}");
    t.tokens_in += k.input ?? 0;
    t.tokens_out += k.output ?? 0;
    t.tokens_reasoning += k.reasoning ?? 0;
    t.tokens_cache += (k.cache?.read ?? 0) + (k.cache?.write ?? 0);
    t.cost += r.cost ?? 0;
  }
  setRun(runId, t);
  publish(runId, "session", info);
}

function storeMessage(runId: string, info: any) {
  upsertMessage.run(info.id, runId, info.sessionID, info.role, JSON.stringify(info), info.time?.created ?? Date.now());
  publish(runId, "message", info);
}

function storePart(runId: string, w: Watcher, part: any) {
  upsertPart.run(part.id, runId, part.sessionID, part.messageID, part.type, JSON.stringify(part), Date.now());
  publish(runId, "part", part);
  onPart(runId, part);
  if (part.type !== "tool" || w.seenCalls.has(part.id)) return;
  const input = part.state?.input;
  if (!input || !Object.keys(input).length) return;
  w.seenCalls.add(part.id);
  const run = getRun(runId);
  if (!run) return;
  const others = recordCrossReads(runId, runtime.paths(run).workbases, part.tool, input);
  if (others.length) timeline(runId, "agent", "crossread", `Looked at ${others.map((o) => (o === "*" ? "the workbases index" : o)).join(", ")} (${part.tool})`);
}

export function autoApprove(runId: string, req: { id: string; permission?: string; patterns?: string[] }) {
  const run = getRun(runId);
  if (!run) return;
  clientFor(run)
    .replyPermission(req.id, "always")
    .then(() => timeline(runId, "pixel", "permission", `Auto-approved permission ${req.permission ?? ""} ${(req.patterns ?? []).join(" ")}`.slice(0, 300)))
    .catch((e) => console.error("permission reply failed", e));
}

/** last_activity is written at most every few seconds; deltas arrive many times a second. */
const lastActivityWrite = new Map<string, number>();
function touch(runId: string) {
  const now = Date.now();
  if (now - (lastActivityWrite.get(runId) ?? 0) < 5000) return;
  lastActivityWrite.set(runId, now);
  updateRun(runId, { last_activity: now });
}

const errorText = (err: any) => `${err?.name ?? "unknown"}: ${err?.data?.message ?? ""}`.slice(0, 500);

function handleEvent(id: string, w: Watcher, e: OpencodeEvent) {
  const p = e.properties ?? {};
  const run = getRun(id);
  if (!run) return;
  const isRoot = !!p.sessionID && p.sessionID === run.session_id;
  if (p.sessionID && e.type !== "session.status" && e.type !== "session.idle") touch(id);

  switch (e.type) {
    case "session.created":
    case "session.updated":
      storeSession(id, p.info);
      break;
    case "message.updated":
      storeMessage(id, p.info);
      if (isRoot && p.info?.role === "assistant" && p.info.error && p.info.error.name !== "MessageAbortedError") timeline(id, "agent", "error", `Agent error: ${errorText(p.info.error)}`);
      break;
    case "message.part.updated":
      storePart(id, w, p.part);
      break;
    case "message.part.delta":
      publish(id, "delta", p);
      break;
    case "message.removed":
      db.query("DELETE FROM messages WHERE id = ?").run(p.messageID);
      db.query("DELETE FROM parts WHERE message_id = ?").run(p.messageID);
      publish(id, "message.removed", p);
      break;
    case "message.part.removed":
      db.query("DELETE FROM parts WHERE id = ?").run(p.partID);
      publish(id, "part.removed", p);
      break;
    case "todo.updated":
      upsertTodos.run(p.sessionID, id, JSON.stringify(p.todos ?? []));
      publish(id, "todos", p);
      break;
    case "session.status":
      if (isRoot && (p.status?.type === "busy" || p.status?.type === "retry")) setRun(id, { agent_status: p.status.type });
      if (isRoot && p.status?.type === "retry") publish(id, "retry", p.status);
      break;
    case "session.idle":
      if (isRoot) serial(w, () => onIdle(id, "event"));
      break;
    case "session.error":
      if ((!p.sessionID || isRoot) && p.error?.name !== "MessageAbortedError") timeline(id, "agent", "error", `Session error: ${errorText(p.error)}`);
      break;
    case "permission.asked":
      autoApprove(id, p);
      break;
    case "question.asked": {
      const text = (p.questions ?? []).map((q: any) => q.question).join(" / ");
      db.query("INSERT OR REPLACE INTO questions (id, run_id, session_id, data, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)").run(p.id, id, p.sessionID, JSON.stringify(p), Date.now());
      timeline(id, "agent", "question", `Agent asked: ${text}`.slice(0, 500));
      publish(id, "question", p);
      notifyRun("question", run, "Agent asks a question", text);
      break;
    }
    case "question.replied":
    case "question.rejected":
      db.query("UPDATE questions SET status = ? WHERE id = ?").run(e.type === "question.replied" ? "answered" : "rejected", p.requestID);
      publish(id, "question.closed", p);
      break;
  }
}

/** Pull the full transcript (root + subagent sessions), to fill gaps after (re)connecting. */
export async function syncTranscript(id: string) {
  const run = getRun(id);
  if (!run?.session_id || !run.endpoint) return;
  const client = clientFor(run);
  const w = watchers.get(id);
  const queue = [run.session_id];
  const seen = new Set<string>();
  while (queue.length) {
    const sid = queue.shift()!;
    if (seen.has(sid)) continue;
    seen.add(sid);
    try {
      storeSession(id, await client.getSession(sid));
      const msgs = await client.messages(sid);
      db.transaction(() => {
        for (const m of msgs) {
          upsertMessage.run(m.info.id, id, m.info.sessionID, m.info.role, JSON.stringify(m.info), m.info.time?.created ?? Date.now());
          for (const part of m.parts) {
            upsertPart.run(part.id, id, part.sessionID, part.messageID, part.type, JSON.stringify(part), Date.now());
            if (part.type === "tool") w?.seenCalls.add(part.id);
          }
        }
      })();
      const todos = await client.todos(sid).catch(() => null);
      if (todos) upsertTodos.run(sid, id, JSON.stringify(todos));
      for (const c of await client.children(sid).catch(() => [])) queue.push(c.id);
    } catch (e) {
      console.error(`sync of session ${sid} failed`, e);
    }
  }
  publish(id, "synced", {});
}

/** Messages with their parts, oldest first. */
export function transcript(runId: string, sessionId: string, since = 0) {
  const msgs = db
    .query<{ id: string; data: string }, [string, string, number]>("SELECT id, data FROM messages WHERE run_id = ? AND session_id = ? AND created_at >= ? ORDER BY created_at, id")
    .all(runId, sessionId, since);
  const byMsg = new Map<string, any[]>();
  for (const p of db.query<{ message_id: string; data: string }, [string, string]>("SELECT message_id, data FROM parts WHERE run_id = ? AND session_id = ? ORDER BY id").all(runId, sessionId)) {
    const list = byMsg.get(p.message_id) ?? [];
    list.push(JSON.parse(p.data));
    byMsg.set(p.message_id, list);
  }
  return msgs.map((m) => ({ info: JSON.parse(m.data), parts: byMsg.get(m.id) ?? [] }));
}
