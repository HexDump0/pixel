/**
 * Live fleet telemetry for the dashboard: tokens/s per run, what each agent is doing right now,
 * subagent states, 30-minute activity history, per-agent swimlanes, context use, memory and spend.
 *
 * Tokens/s comes from a 1-second sampler over each active run's token totals. Everything else is
 * derived from what events.ts already stores (parts, sessions, timeline, metrics), so it survives
 * Pixel restarts.
 */
import { readFileSync } from "node:fs";
import { relative, isAbsolute } from "node:path";
import { freemem, totalmem } from "node:os";
import { db, getRun, listRuns, type RunRow } from "./db.ts";
import { publish } from "./bus.ts";
import { runtime } from "./runtime/index.ts";
import { crossReadGraph } from "./crossreads.ts";
import { OpencodeClient } from "./opencode.ts";

// ---- what a tool call is doing ----

export type Kind = "shell" | "read" | "edit" | "task" | "web" | "other";

const KINDS: Record<string, Kind> = {
  bash: "shell",
  read: "read",
  grep: "read",
  glob: "read",
  list: "read",
  lsp: "read",
  edit: "edit",
  write: "edit",
  patch: "edit",
  multiedit: "edit",
  apply_patch: "edit",
  todowrite: "edit",
  task: "task",
  webfetch: "web",
  websearch: "web",
};
export const kindOf = (tool: string): Kind => KINDS[tool] ?? "other";

/** One-line description of a tool call, e.g. `make -j4` or `src/ini.c:118`. */
export function describeCall(run: RunRow | undefined, tool: string, state: any): string {
  const input = state?.input ?? {};
  const rel = (p: unknown) => {
    if (typeof p !== "string") return "";
    const target = run ? runtime.paths(run).target : "";
    return target && isAbsolute(p) && p.startsWith(target) ? relative(target, p) || "." : p;
  };
  let text: string;
  switch (tool) {
    case "bash":
      text = String(input.command ?? input.description ?? "");
      break;
    case "read":
      text = rel(input.filePath) + (input.offset ? `:${input.offset}` : "");
      break;
    case "edit":
    case "write":
    case "multiedit":
      text = rel(input.filePath);
      break;
    case "grep":
      text = `${input.pattern ?? ""}${input.path ? `  ${rel(input.path)}` : ""}`;
      break;
    case "glob":
    case "list":
      text = String(input.pattern ?? rel(input.path) ?? "");
      break;
    case "task":
      text = String(input.description ?? "subagent");
      break;
    case "webfetch":
      text = String(input.url ?? "");
      break;
    default:
      text = String(state?.title ?? "");
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

// ---- live activity (called by events.ts for every stored part) ----

export interface Activity {
  run: string;
  session: string;
  /** Subagent title, or null for the main agent. */
  agent: string | null;
  tool: string;
  kind: Kind;
  text: string;
  status: string;
  ts: number;
}

const lastStatus = new Map<string, string>();
const sessionTitle = new Map<string, string | null>();

function agentOf(sessionId: string): string | null {
  if (!sessionTitle.has(sessionId)) {
    const s = db.query<{ parent_id: string | null; title: string | null }, [string]>("SELECT parent_id, title FROM sessions WHERE id = ?").get(sessionId);
    if (!s) return null; // not stored yet; try again next time
    sessionTitle.set(sessionId, s.parent_id ? (s.title ?? "subagent").replace(/\s*\(@\w+ subagent\)$/, "") : null);
  }
  return sessionTitle.get(sessionId) ?? null;
}

/** Publish a tool call to the fleet feed when its status changes (not on every streamed update). */
export function onPart(runId: string, part: any) {
  if (part?.type !== "tool" || !part.state?.status) return;
  const status = part.state.status;
  if (lastStatus.get(part.id) === status) return;
  if (status === "completed" || status === "error") lastStatus.delete(part.id);
  else lastStatus.set(part.id, status);
  if (status === "pending" && !Object.keys(part.state.input ?? {}).length) return;
  const a: Activity = {
    run: runId,
    session: part.sessionID,
    agent: agentOf(part.sessionID),
    tool: part.tool,
    kind: kindOf(part.tool),
    text: describeCall(getRun(runId) ?? undefined, part.tool, part.state),
    status,
    ts: part.state.time?.start ?? Date.now(),
  };
  publish("*", "activity", a);
}

// ---- tokens per second ----

const WINDOW = 90;
const ACTIVE = ["preparing", "running", "recovering", "paused"];
const rates = new Map<string, { last: number; samples: number[] }>();
const totalOf = (r: RunRow) => r.tokens_in + r.tokens_out + r.tokens_reasoning;

function sample() {
  const now: Record<string, number> = {};
  const active = listRuns().filter((r) => ACTIVE.includes(r.status));
  for (const r of active) {
    const t = totalOf(r);
    let e = rates.get(r.id);
    if (!e) rates.set(r.id, (e = { last: t, samples: Array(WINDOW).fill(0) }));
    const v = Math.max(0, t - e.last);
    e.last = t;
    e.samples.push(v);
    e.samples.shift();
    now[r.id] = v;
  }
  for (const id of rates.keys()) if (!active.some((r) => r.id === id)) rates.delete(id);
  if (active.length) publish("*", "fleet.tick", { ts: Date.now(), tps: now });
}

let sampler: Timer | null = null;
export function startFleet() {
  sampler ??= setInterval(sample, 1000);
}
export function stopFleet() {
  if (sampler) clearInterval(sampler);
  sampler = null;
}

// ---- snapshot for the dashboard ----

const HISTORY_MS = 30 * 60_000;
const BUCKETS = 60;

interface ToolRow {
  session_id: string;
  data: string;
  updated_at: number;
}

const toolParts = (runId: string, since: number) =>
  db.query<ToolRow, [string, number]>("SELECT session_id, data, updated_at FROM parts WHERE run_id = ? AND type = 'tool' AND updated_at >= ? ORDER BY updated_at").all(runId, since);

/** 60 buckets of 30 s: how many tool calls started and which kind dominated; "alert" where Pixel had to recover. */
function activityHistory(runId: string, now: number) {
  const from = now - HISTORY_MS;
  const size = HISTORY_MS / BUCKETS;
  const buckets = Array.from({ length: BUCKETS }, () => ({ n: 0, kinds: {} as Record<string, number>, alert: false }));
  for (const p of toolParts(runId, from)) {
    const part = JSON.parse(p.data);
    const ts = part.state?.time?.start ?? p.updated_at;
    const i = Math.floor((ts - from) / size);
    if (i < 0 || i >= BUCKETS) continue;
    const k = kindOf(part.tool);
    buckets[i].n++;
    buckets[i].kinds[k] = (buckets[i].kinds[k] ?? 0) + 1;
  }
  for (const t of db.query<{ ts: number }, [string, number]>("SELECT ts FROM timeline WHERE run_id = ? AND kind IN ('recover', 'limit') AND ts >= ?").all(runId, from)) {
    const i = Math.floor((t.ts - from) / size);
    if (i >= 0 && i < BUCKETS) buckets[i].alert = true;
  }
  return buckets.map((b) => ({ n: b.n, k: Object.entries(b.kinds).sort((a, c) => c[1] - a[1])[0]?.[0] ?? null, alert: b.alert }));
}

interface SubAgent {
  id: string;
  parent: string | null;
  title: string;
  status: "running" | "done" | "interrupted" | "failed";
  now: { tool: string; kind: Kind; text: string; ts: number } | null;
  started: number;
}

/** Latest tool call per session, for "what is it doing right now". */
function latestCalls(run: RunRow) {
  const out = new Map<string, SubAgent["now"]>();
  const rows = db
    .query<{ session_id: string; data: string }, [string]>(
      `SELECT p.session_id, p.data FROM parts p
       JOIN (SELECT session_id, MAX(updated_at) AS m FROM parts WHERE run_id = ?1 AND type = 'tool' GROUP BY session_id) l
         ON l.session_id = p.session_id AND p.updated_at = l.m
       WHERE p.run_id = ?1 AND p.type = 'tool'`,
    )
    .all(run.id);
  for (const r of rows) {
    const part = JSON.parse(r.data);
    out.set(r.session_id, { tool: part.tool, kind: kindOf(part.tool), text: describeCall(run, part.tool, part.state), ts: part.state?.time?.start ?? 0 });
  }
  return out;
}

/** Subagents with their state, taken from the task calls that started (or resumed) them. */
function subAgents(run: RunRow, calls: Map<string, SubAgent["now"]>): SubAgent[] {
  const sessions = db
    .query<{ id: string; parent_id: string; title: string | null; created_at: number }, [string]>("SELECT id, parent_id, title, created_at FROM sessions WHERE run_id = ? AND parent_id IS NOT NULL ORDER BY created_at")
    .all(run.id);
  if (!sessions.length) return [];
  const taskState = new Map<string, { status: string; interrupted: boolean }>();
  for (const p of db.query<{ data: string }, [string]>("SELECT data FROM parts WHERE run_id = ? AND type = 'tool' AND data LIKE '%\"tool\":\"task\"%' ORDER BY updated_at").all(run.id)) {
    const part = JSON.parse(p.data);
    const child = part.state?.metadata?.sessionId ?? part.state?.input?.task_id;
    if (child) taskState.set(child, { status: part.state.status, interrupted: part.state.metadata?.interrupted === true || /abort/i.test(part.state.error ?? "") });
  }
  const live = ACTIVE.includes(run.status) && run.status !== "paused";
  return sessions.map((s) => {
    const t = taskState.get(s.id);
    let status: SubAgent["status"] = "done";
    if (!t || t.status === "running" || t.status === "pending") status = live ? "running" : "interrupted";
    else if (t.status === "error") status = t.interrupted ? "interrupted" : "failed";
    return {
      id: s.id,
      parent: s.parent_id === run.session_id ? null : s.parent_id,
      title: (s.title ?? "subagent").replace(/\s*\(@\w+ subagent\)$/, ""),
      status,
      now: calls.get(s.id) ?? null,
      started: s.created_at,
    };
  });
}

/** Tokens in the root session's context right now (from its last assistant message). */
function contextUsed(run: RunRow): number | null {
  if (!run.session_id) return null;
  const m = db.query<{ data: string }, [string]>("SELECT data FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1").get(run.session_id);
  if (!m) return null;
  const t = JSON.parse(m.data).tokens;
  if (!t) return null;
  return (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
}

/** Context window per model, asked from opencode once and cached. */
const contextLimits = new Map<string, number | null>();
async function contextLimit(run: RunRow): Promise<number | null> {
  if (contextLimits.has(run.model)) return contextLimits.get(run.model)!;
  if (!run.endpoint || !ACTIVE.includes(run.status)) return null;
  try {
    const client = new OpencodeClient(run.endpoint, run.opencode_password, runtime.paths(run).target);
    const r = await client.req<any>("GET", "/config/providers", undefined, undefined, 5000);
    const [provider, ...rest] = run.model.split("/");
    const model = (r?.providers ?? []).find((p: any) => p.id === provider)?.models?.[rest.join("/")];
    const limit = model?.limit?.context ?? null;
    contextLimits.set(run.model, limit);
    return limit;
  } catch {
    return null;
  }
}

function latestMetrics(runId: string) {
  return db
    .query<{ cpu: number | null; mem_used: number | null; mem_total: number | null; disk_used: number | null; disk_total: number | null }, [string]>(
      "SELECT cpu, mem_used, mem_total, disk_used, disk_total FROM metrics WHERE run_id = ? ORDER BY ts DESC LIMIT 1",
    )
    .get(runId);
}

/** Memory of the box agents share: the container's cgroup limit when there is one, else the machine. */
function sharedMemory() {
  try {
    const max = readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
    const cur = Number(readFileSync("/sys/fs/cgroup/memory.current", "utf8").trim());
    if (max !== "max" && Number.isFinite(cur)) return { label: "Container memory", used: cur, total: Number(max) };
  } catch {}
  return { label: runtime.kind === "incus" ? "Host memory" : "Machine memory", used: totalmem() - freemem(), total: totalmem() };
}

/** Spend since local midnight, cumulative per hour, and a projection to the end of the day. */
function spendToday(runs: RunRow[], now: number) {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const start = day.getTime();
  const hours = Math.floor((now - start) / 3_600_000) + 1;
  const hourly = Array(hours).fill(0);
  let total = 0;
  for (const r of runs) {
    if ((r.finished_at ?? now) < start || r.cost <= 0) continue;
    const base = db.query<{ cost: number | null }, [string, number]>("SELECT cost FROM metrics WHERE run_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1").get(r.id, start)?.cost ?? 0;
    const rows = db.query<{ ts: number; cost: number | null }, [string, number]>("SELECT ts, cost FROM metrics WHERE run_id = ? AND ts >= ? ORDER BY ts").all(r.id, start);
    let last = base;
    let row = 0;
    for (let h = 0; h < hours; h++) {
      const end = start + (h + 1) * 3_600_000;
      while (row < rows.length && rows[row].ts < end) last = rows[row++].cost ?? last;
      if (h === hours - 1) last = r.cost; // the current hour uses the live total
      hourly[h] += Math.max(0, last - base);
    }
    total += Math.max(0, r.cost - base);
  }
  // Projection: the last two hours' rate for the rest of the day.
  const recent = hours > 2 ? (hourly[hours - 1] - hourly[hours - 3]) / 2 : total / Math.max(1, (now - start) / 3_600_000);
  const left = (start + 86_400_000 - now) / 3_600_000;
  return { total, hourly, projected: total + Math.max(0, recent) * left, dayStart: start };
}

export interface FleetRun {
  id: string;
  tps: number[];
  now: SubAgent["now"];
  agents: { main: string; subs: SubAgent[] };
  activity: { n: number; k: string | null; alert: boolean }[];
  cpu: number | null;
  mem: { used: number | null; total: number | null };
  disk: { used: number | null; total: number | null };
  context: { used: number | null; limit: number | null };
  machine: { name: string | null; pid: number | null; endpoint: string | null };
}

/** Everything the Runs page draws, for every run that isn't archived. */
export async function fleetSnapshot() {
  const now = Date.now();
  const runs = listRuns();
  const shown = runs.filter((r) => r.status !== "triaged" || now - (r.triaged_at ?? 0) < 86_400_000);
  const out: FleetRun[] = [];
  for (const r of shown) {
    const calls = latestCalls(r);
    const subs = subAgents(r, calls);
    const rootNow = r.session_id ? (calls.get(r.session_id) ?? null) : null;
    const working = subs.filter((s) => s.status === "running").length;
    const main =
      r.status === "recovering" ? "recovering" : r.status === "paused" ? "paused" : !ACTIVE.includes(r.status) ? "finished" : working && rootNow?.tool === "task" ? "waiting" : r.agent_status === "idle" ? "idle" : "working";
    const m = latestMetrics(r.id);
    const size = JSON.parse(r.size);
    out.push({
      id: r.id,
      tps: rates.get(r.id)?.samples ?? [],
      now: rootNow,
      agents: { main, subs },
      activity: activityHistory(r.id, now),
      cpu: ACTIVE.includes(r.status) ? (m?.cpu ?? null) : null,
      mem: { used: ACTIVE.includes(r.status) ? (m?.mem_used ?? null) : null, total: m?.mem_total ?? size.memoryGiB * 1024 ** 3 },
      disk: { used: m?.disk_used ?? null, total: m?.disk_total ?? size.diskGiB * 1024 ** 3 },
      context: { used: contextUsed(r), limit: await contextLimit(r) },
      machine: { name: r.vm_name, pid: runtime.pid?.(r) ?? null, endpoint: r.endpoint ? new URL(r.endpoint).host : null },
    });
  }
  return {
    ts: now,
    window: WINDOW,
    runs: out,
    memory: { ...sharedMemory(), pixel: process.memoryUsage().rss },
    spend: spendToday(runs, now),
    links: crossReadGraph(),
  };
}

/** Per-agent swimlanes for one run: tool calls as [start, end, kind] segments plus Pixel's interventions. */
export function lanes(runId: string, minutes: number) {
  const run = getRun(runId);
  if (!run) return null;
  const now = Date.now();
  const from = now - minutes * 60_000;
  const sessions = db.query<{ id: string; parent_id: string | null; title: string | null }, [string]>("SELECT id, parent_id, title FROM sessions WHERE run_id = ? ORDER BY created_at").all(runId);
  const segs = new Map<string, [number, number, Kind][]>();
  const marks = new Map<string, [number, string][]>();
  for (const p of toolParts(runId, from)) {
    const part = JSON.parse(p.data);
    const start = part.state?.time?.start;
    if (!start) continue;
    const done = part.state.status === "completed" || part.state.status === "error";
    const end = done ? (part.state.time?.end ?? p.updated_at) : ACTIVE.includes(run.status) ? now : p.updated_at;
    if (end < from) continue;
    const list = segs.get(p.session_id) ?? [];
    list.push([Math.max(start, from), end, kindOf(part.tool)]);
    segs.set(p.session_id, list);
    // A finished subagent gets a dot on its own lane where its task call ended.
    const child = part.tool === "task" ? part.state?.metadata?.sessionId : null;
    if (child && part.state.status === "completed") marks.set(child, [...(marks.get(child) ?? []), [end, "done"]]);
    if (child && part.state.status === "error") marks.set(child, [...(marks.get(child) ?? []), [end, "interrupted"]]);
  }
  const pixel = db.query<{ ts: number; kind: string }, [string, number]>("SELECT ts, kind FROM timeline WHERE run_id = ? AND actor = 'pixel' AND kind IN ('recover', 'limit', 'continue') AND ts >= ?").all(runId, from);
  if (run.session_id) marks.set(run.session_id, [...(marks.get(run.session_id) ?? []), ...pixel.map((t) => [t.ts, t.kind] as [number, string])]);
  const out = sessions
    .filter((s) => s.id === run.session_id || segs.has(s.id))
    .map((s) => ({
      session: s.id,
      title: s.id === run.session_id ? "Main agent" : (s.title ?? "subagent").replace(/\s*\(@\w+ subagent\)$/, ""),
      sub: s.id !== run.session_id,
      segs: segs.get(s.id) ?? [],
      marks: marks.get(s.id) ?? [],
    }));
  return { from, to: now, lanes: out };
}

/** Recent tool calls and Pixel actions across the fleet (or one run), newest first. */
export function recentActivity(limit: number, runId?: string) {
  const since = Date.now() - 24 * 3_600_000;
  const parts = db
    .query<{ run_id: string; session_id: string; data: string; updated_at: number }, [number, string | null, string | null, number]>(
      "SELECT run_id, session_id, data, updated_at FROM parts WHERE type = 'tool' AND updated_at >= ? AND (? IS NULL OR run_id = ?) ORDER BY updated_at DESC LIMIT ?",
    )
    .all(since, runId ?? null, runId ?? null, limit);
  const runs = new Map(listRuns().map((r) => [r.id, r]));
  const calls: Activity[] = parts.map((p) => {
    const part = JSON.parse(p.data);
    return {
      run: p.run_id,
      session: p.session_id,
      agent: agentOf(p.session_id),
      tool: part.tool,
      kind: kindOf(part.tool),
      text: describeCall(runs.get(p.run_id), part.tool, part.state),
      status: part.state?.status ?? "completed",
      ts: part.state?.time?.start ?? p.updated_at,
    };
  });
  const events = db
    .query<{ run_id: string; ts: number; actor: string; kind: string; message: string }, [number, string | null, string | null, number]>(
      "SELECT run_id, ts, actor, kind, message FROM timeline WHERE ts >= ? AND (? IS NULL OR run_id = ?) AND kind NOT IN ('prepare', 'permission') ORDER BY ts DESC LIMIT ?",
    )
    .all(since, runId ?? null, runId ?? null, limit);
  return { calls, events };
}
