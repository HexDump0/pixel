/**
 * Live fleet telemetry for the dashboard: tokens/s per run, what each agent is doing right now,
 * subagent states, 30-minute activity history, per-agent swimlanes, context use, memory and spend.
 *
 * Tokens/s comes from a 1-second sampler over streamed output (see below). Everything else is
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

import { kindOf, type Kind } from "./kinds.ts";
export { kindOf, type Kind };

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
  // Shorten the run's own paths so commands read like they would in a terminal opened there.
  if (run) {
    const p = runtime.paths(run);
    text = text.split(`${p.target}/`).join("").split(p.target).join(".").split(`${p.workbases}/`).join("workbases/").split(p.scratch).join("scratch");
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
  /** When the call finished, if it has. */
  end?: number | null;
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
    end: part.state.time?.end ?? null,
  };
  publish("*", "activity", a);
}

// ---- tokens per second ----
//
// Output tokens (text, reasoning and tool-call arguments) the models are generating, per second.
// Token totals only arrive when a model call finishes, so live numbers are estimated from the
// streamed text deltas (characters / CHARS_PER_TOKEN). When the call finishes, the estimate for
// its seconds is corrected to the real output count, spread evenly over the time it streamed.
// Prompt tokens are left out on purpose: they are re-sent context, not generation.

const WINDOW = 90;
const ACTIVE = ["preparing", "running", "recovering", "paused"];
const CHARS_PER_TOKEN = 3.8;
/** Per run: one sample per second (oldest first) and the estimate for the second in progress. */
const rates = new Map<string, { samples: number[]; pending: number }>();
/** Per assistant message still streaming: what we've estimated for it so far, by sampler tick. */
const streaming = new Map<string, { run: string; est: Map<number, number> }>();
const finished = new Set<string>();
/** Runs whose recent samples were corrected; their whole window goes out with the next tick. */
const corrected = new Set<string>();
/** Number of samples taken; deltas arriving now belong to sample number `tick`. */
let tick = 0;

const rateFor = (runId: string) => {
  let e = rates.get(runId);
  if (!e) rates.set(runId, (e = { samples: Array(WINDOW).fill(0), pending: 0 }));
  return e;
};

/** A streamed text or reasoning delta. */
export function onDelta(runId: string, messageId: string | undefined, delta: unknown) {
  if (!messageId || typeof delta !== "string" || !delta || finished.has(messageId)) return;
  const v = delta.length / CHARS_PER_TOKEN;
  rateFor(runId).pending += v;
  let m = streaming.get(messageId);
  if (!m) streaming.set(messageId, (m = { run: runId, est: new Map() }));
  m.est.set(tick, (m.est.get(tick) ?? 0) + v);
}

/** An assistant message update: once it has finished, swap the estimate for the real output count. */
export function onAssistantMessage(runId: string, info: any) {
  if (info?.role !== "assistant" || !info.time?.completed || finished.has(info.id)) return;
  finished.add(info.id);
  if (finished.size > 5000) finished.delete(finished.values().next().value!);
  const m = streaming.get(info.id);
  streaming.delete(info.id);
  // Messages that finished before Pixel was watching (a resync) are history, not live throughput.
  if (Date.now() - info.time.completed > 30_000) return;
  const actual = (info.tokens?.output ?? 0) + (info.tokens?.reasoning ?? 0);
  // Spread over the ticks it streamed in; without deltas, over its whole duration.
  const first = m?.est.size ? Math.min(...m.est.keys()) : tick - Math.floor((info.time.completed - (info.time.created ?? info.time.completed)) / 1000);
  const ticks = tick - first + 1;
  const e = rateFor(runId);
  for (let t = first; t <= tick; t++) {
    const delta = actual / ticks - (m?.est.get(t) ?? 0);
    if (t === tick) e.pending = Math.max(0, e.pending + delta);
    else {
      const i = WINDOW - (tick - t); // sample number t sits this far back in the window
      if (i >= 0) e.samples[i] = Math.max(0, e.samples[i] + delta);
    }
  }
  if (first < tick) corrected.add(runId);
}

function sample() {
  const now: Record<string, number> = {};
  const fix: Record<string, number[]> = {};
  const active = listRuns().filter((r) => ACTIVE.includes(r.status));
  for (const r of active) {
    const e = rateFor(r.id);
    e.samples.push(e.pending);
    e.samples.shift();
    e.pending = 0;
    now[r.id] = Math.round(e.samples[WINDOW - 1]);
    if (corrected.has(r.id)) fix[r.id] = e.samples.map(Math.round);
  }
  tick++;
  corrected.clear();
  for (const id of rates.keys()) if (!active.some((r) => r.id === id)) rates.delete(id);
  // Aborted messages never finish; forget them once they've scrolled out of the window.
  for (const [id, m] of streaming) if (!rates.has(m.run) || Math.max(...m.est.keys()) < tick - WINDOW) streaming.delete(id);
  if (active.length) publish("*", "fleet.tick", { ts: Date.now(), tps: now, fix });
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

/** Tool calls of the last 15 minutes, for the tiles' agent lanes. */
function recentTicks(runId: string, now: number): [string, number, Kind][] {
  const from = now - 15 * 60_000;
  return toolParts(runId, from).flatMap((p) => {
    const part = JSON.parse(p.data);
    const ts = part.state?.time?.start ?? p.updated_at;
    return ts >= from ? [[p.session_id, ts, kindOf(part.tool)] as [string, number, Kind]] : [];
  });
}

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
  now: { tool: string; kind: Kind; text: string; ts: number; status: string } | null;
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
    out.set(r.session_id, { tool: part.tool, kind: kindOf(part.tool), text: describeCall(run, part.tool, part.state), ts: part.state?.time?.start ?? 0, status: part.state?.status ?? "completed" });
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
  // The newest message may still be streaming with zero tokens; use the latest one that has counts.
  for (const m of db.query<{ data: string }, [string]>("SELECT data FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 5").all(run.session_id)) {
    const t = JSON.parse(m.data).tokens;
    const n = t ? (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0) : 0;
    if (n > 0) return n;
  }
  return null;
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
/**
 * Today's spend and token use, from every assistant message (opencode's own per-call cost and
 * token counts), with yesterday up to the same time of day for comparison. Cached briefly since
 * every open dashboard asks for a snapshot every few seconds.
 */
let todayCache: { at: number; value: ReturnType<typeof computeToday> } | null = null;
function today(now: number) {
  if (!todayCache || now - todayCache.at > 10_000) todayCache = { at: now, value: computeToday(now) };
  return todayCache.value;
}

function computeToday(now: number) {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const start = day.getTime();
  const yStart = start - 86_400_000;
  const hours = Math.floor((now - start) / 3_600_000) + 1;
  const rows = db
    .query<{ t: number; run: string; i: number; o: number; r: number; cr: number; cw: number; cost: number }, [number]>(
      `SELECT created_at AS t, run_id AS run,
         COALESCE(json_extract(data, '$.tokens.input'), 0) AS i, COALESCE(json_extract(data, '$.tokens.output'), 0) AS o,
         COALESCE(json_extract(data, '$.tokens.reasoning'), 0) AS r, COALESCE(json_extract(data, '$.tokens.cache.read'), 0) AS cr,
         COALESCE(json_extract(data, '$.tokens.cache.write'), 0) AS cw, COALESCE(json_extract(data, '$.cost'), 0) AS cost
       FROM messages WHERE created_at >= ? AND role = 'assistant'`,
    )
    .all(yStart);
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
  const yTok = { prompt: 0, cacheRead: 0, total: 0 };
  const perRun = new Map<string, number[]>();
  let total = 0;
  let yesterday = 0;
  let lastHour = 0;
  for (const c of rows) {
    if (c.t < start) {
      // yesterday, only up to the same time of day
      if (c.t > now - 86_400_000) continue;
      yesterday += c.cost;
      yTok.prompt += c.i + c.cr + c.cw;
      yTok.cacheRead += c.cr;
      yTok.total += c.i + c.o + c.r + c.cr + c.cw;
      continue;
    }
    tokens.input += c.i;
    tokens.output += c.o;
    tokens.reasoning += c.r;
    tokens.cacheRead += c.cr;
    tokens.cacheWrite += c.cw;
    tokens.calls++;
    total += c.cost;
    if (c.t > now - 3_600_000) lastHour += c.cost;
    if (!c.cost) continue;
    const h = Math.min(hours - 1, Math.floor((c.t - start) / 3_600_000));
    let list = perRun.get(c.run);
    if (!list) perRun.set(c.run, (list = Array(hours).fill(0)));
    list[h] += c.cost;
  }
  // The four biggest spenders get their own colour; the rest are summed as "other".
  const ranked = [...perRun].map(([id, hourly]) => ({ id, hourly, cost: hourly.reduce((a, b) => a + b, 0) })).sort((a, b) => b.cost - a.cost);
  const top: { id: string | null; cost: number; hourly: number[] }[] = ranked.slice(0, 4);
  const rest = ranked.slice(4);
  if (rest.length) top.push({ id: null, cost: rest.reduce((a, r) => a + r.cost, 0), hourly: Array.from({ length: hours }, (_, h) => rest.reduce((a, r) => a + r.hourly[h], 0)) });
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  const left = (start + 86_400_000 - now) / 3_600_000;
  return {
    spend: { total, perHour: lastHour, projected: total + lastHour * left, yesterday, dayStart: start, hours, runs: top },
    tokens: {
      ...tokens,
      total: prompt + tokens.output + tokens.reasoning,
      hitRate: prompt ? tokens.cacheRead / prompt : null,
      yesterday: { total: yTok.total, hitRate: yTok.prompt ? yTok.cacheRead / yTok.prompt : null },
    },
  };
}

/** Output tokens/s per run over the last 30 minutes in 10-second buckets, rebuilt from finished model calls. */
const SERIES_MS = 30 * 60_000;
const SERIES_STEP = 10_000;
const SERIES_N = SERIES_MS / SERIES_STEP;

function outputSeries(runIds: Set<string>, now: number) {
  const from = now - SERIES_MS;
  const out = new Map<string, number[]>();
  const rows = db
    .query<{ run: string; created: number; done: number | null; o: number; r: number }, [number]>(
      `SELECT run_id AS run, created_at AS created, json_extract(data, '$.time.completed') AS done,
         COALESCE(json_extract(data, '$.tokens.output'), 0) AS o, COALESCE(json_extract(data, '$.tokens.reasoning'), 0) AS r
       FROM messages WHERE role = 'assistant' AND created_at >= ?`,
    )
    .all(from - 3_600_000);
  for (const m of rows) {
    if (!runIds.has(m.run) || !m.done || m.done < from) continue;
    const tokens = m.o + m.r;
    if (!tokens) continue;
    let list = out.get(m.run);
    if (!list) out.set(m.run, (list = Array(SERIES_N).fill(0)));
    // Spread the call's output evenly over the time it took.
    const a = Math.max(m.created, from);
    const b = Math.max(a + 1, Math.min(m.done, now));
    const perMs = tokens / Math.max(1000, m.done - m.created);
    for (let t = a; t < b; ) {
      const i = Math.floor((t - from) / SERIES_STEP);
      const end = Math.min(b, Math.max(t + 1, from + (i + 1) * SERIES_STEP));
      if (i >= 0 && i < SERIES_N) list[i] += (perMs * (end - t)) / (SERIES_STEP / 1000);
      t = end;
    }
  }
  for (const list of out.values()) for (let i = 0; i < list.length; i++) list[i] = Math.round(list[i] * 10) / 10;
  return out;
}

export interface FleetRun {
  id: string;
  label: string | null;
  hue: number | null;
  tps: number[];
  /** Output tokens/s over the last 30 minutes, 10-second buckets, oldest first (finished model calls only). */
  tps30: number[];
  /** Tool calls in the last 15 minutes: [session id, start, kind]. */
  ticks: [string, number, Kind][];
  /** The main agent's todo states, in order. */
  todos: string[];
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
  const series = outputSeries(new Set(shown.map((r) => r.id)), now);
  for (const r of shown) {
    const calls = latestCalls(r);
    const subs = subAgents(r, calls);
    const rootNow = r.session_id ? (calls.get(r.session_id) ?? null) : null;
    const working = subs.filter((s) => s.status === "running").length;
    const main =
      r.status === "recovering" ? "recovering" : r.status === "paused" ? "paused" : !ACTIVE.includes(r.status) ? "finished" : working && rootNow?.tool === "task" && rootNow.status === "running" ? "waiting" : r.agent_status === "idle" ? "idle" : "working";
    const m = latestMetrics(r.id);
    const size = JSON.parse(r.size);
    const todos = r.session_id ? db.query<{ data: string }, [string]>("SELECT data FROM todos WHERE session_id = ?").get(r.session_id) : null;
    out.push({
      id: r.id,
      label: r.label,
      hue: r.hue,
      tps: rates.get(r.id)?.samples.map(Math.round) ?? [],
      tps30: series.get(r.id) ?? [],
      ticks: recentTicks(r.id, now),
      todos: todos ? (JSON.parse(todos.data) as { status: string }[]).map((t) => t.status) : [],
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
    ...today(now),
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
      end: part.state?.time?.end ?? null,
    };
  });
  const events = db
    .query<{ run_id: string; ts: number; actor: "pixel" | "user" | "agent"; kind: string; message: string }, [number, string | null, string | null, number]>(
      "SELECT run_id, ts, actor, kind, message FROM timeline WHERE ts >= ? AND (? IS NULL OR run_id = ?) AND kind NOT IN ('prepare', 'permission') ORDER BY ts DESC LIMIT ?",
    )
    .all(since, runId ?? null, runId ?? null, limit);
  return { calls, events };
}

export type FleetSnapshot = Awaited<ReturnType<typeof fleetSnapshot>>;
export type Lanes = NonNullable<ReturnType<typeof lanes>>;
export type RecentActivity = ReturnType<typeof recentActivity>;

// ---- the Latest feed ----

/** Timeline kinds worth a line in the fleet's Latest feed (and the catch-up): findings, questions and problems. */
export const FEED_KINDS = ["finding", "question", "failed", "stopped", "recover", "limit", "done", "idle", "key", "created"];

export function feed(limit: number, since = 0) {
  const kinds = FEED_KINDS.map(() => "?").join(", ");
  return db
    .query<{ id: number; run_id: string; ts: number; actor: string; kind: string; message: string; data: string | null }, any[]>(
      `SELECT id, run_id, ts, actor, kind, message, data FROM timeline WHERE kind IN (${kinds}) AND ts > ? ORDER BY ts DESC, id DESC LIMIT ?`,
    )
    .all(...FEED_KINDS, since, Math.min(Math.max(limit, 1), 1000))
    .map((t) => ({ ...t, data: t.data ? JSON.parse(t.data) : null }));
}

// ---- one run over its whole life (Overview charts) ----

/** Tokens/s, cost, context use and tool calls per kind over the run's life, in equal buckets, plus the events worth marking. */
export function runSeries(runId: string, buckets = 120) {
  const run = getRun(runId);
  if (!run) return null;
  const from = run.started_at ?? run.created_at;
  const to = Math.max(from + 60_000, run.finished_at ?? Date.now());
  const step = (to - from) / buckets;
  const at = (t: number) => Math.min(buckets - 1, Math.max(0, Math.floor((t - from) / step)));
  const tps = Array(buckets).fill(0);
  const cost = Array(buckets).fill(0);
  const context: (number | null)[] = Array(buckets).fill(null);
  const msgs = db
    .query<{ session: string; created: number; done: number | null; o: number; r: number; i: number; cr: number; cw: number; cost: number }, [string]>(
      `SELECT session_id AS session, created_at AS created, json_extract(data, '$.time.completed') AS done,
         COALESCE(json_extract(data, '$.tokens.output'), 0) AS o, COALESCE(json_extract(data, '$.tokens.reasoning'), 0) AS r,
         COALESCE(json_extract(data, '$.tokens.input'), 0) AS i, COALESCE(json_extract(data, '$.tokens.cache.read'), 0) AS cr,
         COALESCE(json_extract(data, '$.tokens.cache.write'), 0) AS cw, COALESCE(json_extract(data, '$.cost'), 0) AS cost
       FROM messages WHERE run_id = ? AND role = 'assistant' ORDER BY created_at`,
    )
    .all(runId);
  for (const m of msgs) {
    const end = m.done ?? m.created;
    cost[at(end)] += m.cost;
    const out = m.o + m.r;
    if (out) {
      // spread over the call's duration, as tokens per second of wall time
      const a = Math.max(m.created, from);
      const b = Math.max(a + 1, Math.min(end, to));
      const perMs = out / Math.max(1000, end - m.created);
      for (let t = a; t < b; ) {
        const i = at(t);
        // always move forward, even when float rounding puts the bucket edge at or before t
        const e = Math.min(b, Math.max(t + 1, from + (i + 1) * step));
        tps[i] += (perMs * (e - t)) / (step / 1000);
        t = e;
      }
    }
    if (m.session === run.session_id) {
      const used = m.i + m.o + m.r + m.cr + m.cw;
      if (used) context[at(end)] = used;
    }
  }
  let sum = 0;
  const costCum = cost.map((c) => (sum += c));
  const kinds: Record<string, number[]> = {};
  for (const p of db.query<{ data: string; updated_at: number }, [string]>("SELECT data, updated_at FROM parts WHERE run_id = ? AND type = 'tool'").all(runId)) {
    const part = JSON.parse(p.data);
    const k = kindOf(part.tool);
    (kinds[k] ??= Array(buckets).fill(0))[at(part.state?.time?.start ?? p.updated_at)]++;
  }
  const marks = db
    .query<{ ts: number; kind: string; message: string }, [string]>(
      "SELECT ts, kind, message FROM timeline WHERE run_id = ? AND kind IN ('continue', 'recover', 'restart', 'key', 'limit', 'finding', 'question', 'message') ORDER BY ts",
    )
    .all(runId);
  return { from, to, step, tps: tps.map((v) => Math.round(v * 10) / 10), cost: costCum, context, kinds, marks };
}
export type RunSeries = NonNullable<ReturnType<typeof runSeries>>;
