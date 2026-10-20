/**
 * Pixel-wide statistics for the Stats page: token usage and cache hit rate over time, per model,
 * per run, tool calls, recoveries, provider trouble, and a health check of Pixel itself.
 *
 * Token figures come from the stored assistant messages (opencode's per-message `tokens`), so they
 * cover every run that still exists, including history from before this page. opencode's `input`
 * already excludes cached tokens, so the cache hit rate is cache read / (input + cache read + cache write).
 * Deleted runs take their messages with them and drop out of the numbers.
 */
import { statfsSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem, uptime as hostUptime } from "node:os";
import { config } from "./config.ts";
import { db, listRuns } from "./db.ts";
import { getSettings } from "./settings.ts";
import { backupStatus } from "./backup.ts";
import { cachedCatalog, catalogProviders } from "./catalog.ts";
import { effective } from "./modelOverrides.ts";
import { runtime } from "./runtime/index.ts";
import { isWatching } from "./runs/events.ts";
import { kindOf } from "./fleet.ts";
import { leaderboard, pct, tpsOf, ttftOf, type CallRow as LlmCall } from "./providers.ts";

db.exec("CREATE INDEX IF NOT EXISTS messages_created ON messages(created_at)");

const startedAt = Date.now();
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const GiB = 1024 ** 3;

export interface TokenTotals {
  calls: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  errors: number;
  /** cache read / every prompt token (input + cache read + cache write); null without any prompt tokens. */
  hitRate: number | null;
}

const zero = (): TokenTotals => ({ calls: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, errors: 0, hitRate: null });

interface CallRow {
  t: number;
  run: string;
  provider: string | null;
  model: string | null;
  i: number;
  o: number;
  r: number;
  cr: number;
  cw: number;
  cost: number;
  err: string | null;
  done: number | null;
}

function add(into: TokenTotals, c: CallRow) {
  into.calls++;
  into.input += c.i;
  into.output += c.o;
  into.reasoning += c.r;
  into.cacheRead += c.cr;
  into.cacheWrite += c.cw;
  into.cost += c.cost;
  if (c.err && c.err !== "MessageAbortedError") into.errors++;
}

function finish<T extends TokenTotals>(t: T): T {
  const prompt = t.input + t.cacheRead + t.cacheWrite;
  t.hitRate = prompt ? t.cacheRead / prompt : null;
  return t;
}

const CALL_COLUMNS = `created AS t, run_id AS run, provider, model, input AS i, output AS o, reasoning AS r,
  cache_read AS cr, cache_write AS cw, cost, error AS err, completed AS done`;

/** Bucket size for a window: hourly up to two days, 6-hourly up to two weeks, daily beyond. */
const bucketFor = (days: number) => (days <= 2 ? HOUR : days <= 14 ? 6 * HOUR : DAY);

function allTime(): TokenTotals {
  const r = db
    .query<Omit<TokenTotals, "hitRate">, []>(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(i), 0) AS input, COALESCE(SUM(o), 0) AS output, COALESCE(SUM(r), 0) AS reasoning,
         COALESCE(SUM(cr), 0) AS cacheRead, COALESCE(SUM(cw), 0) AS cacheWrite, COALESCE(SUM(cost), 0) AS cost,
         COALESCE(SUM(err IS NOT NULL AND err != 'MessageAbortedError'), 0) AS errors
       FROM (SELECT ${CALL_COLUMNS} FROM model_calls)`,
    )
    .get()!;
  return finish({ ...r, hitRate: null });
}

/** USD saved by cache reads for models whose catalogue entry has both an input and a cache-read price. */
function cacheSavings(byModel: { provider: string; model: string; cacheRead: number }[]) {
  const catalog = cachedCatalog();
  const s = getSettings();
  let saved = 0;
  let priced = 0;
  let unpriced = 0;
  for (const m of byModel) {
    const c = effective(`${m.provider}/${m.model}`, s, catalog?.get(m.provider)?.models.find((x) => x.id === m.model) ?? null);
    if (c.costIn != null && c.costCacheRead != null) {
      saved += (m.cacheRead * (c.costIn - c.costCacheRead)) / 1e6;
      priced += m.cacheRead;
    } else unpriced += m.cacheRead;
  }
  return { saved, pricedTokens: priced, unpricedTokens: unpriced };
}

function tools(since: number) {
  const rows = db
    .query<{ tool: string; n: number; errors: number; avgMs: number | null; running: number }, [number]>(
      `SELECT tool, COUNT(*) AS n, SUM(status = 'error') AS errors, SUM(status IN ('running', 'pending')) AS running,
         AVG(CASE WHEN ended IS NOT NULL THEN ended - started END) AS avgMs
       FROM tool_calls WHERE updated_at >= ? AND tool IS NOT NULL GROUP BY tool ORDER BY n DESC`,
    )
    .all(since);
  return rows.map((r) => ({ ...r, kind: kindOf(r.tool) }));
}

function counts<T extends string>(sql: string, ...args: (string | number)[]) {
  return Object.fromEntries(db.query<{ k: T; n: number }, any>(sql).all(...args).map((r) => [r.k, r.n])) as Record<T, number>;
}

function diskOf(path: string) {
  try {
    const fs = statfsSync(path);
    return { total: fs.blocks * fs.bsize, free: fs.bavail * fs.bsize };
  } catch {
    return null;
  }
}

type CheckState = "ok" | "warn" | "bad";

async function system() {
  const runs = listRuns();
  const info = await runtime.info().catch((e: Error) => ({ error: e.message }) as Record<string, unknown>);
  const disk = diskOf(config.dataDir);
  const mem = process.memoryUsage();
  const watched = runs.filter((r) => ["running", "recovering", "paused"].includes(r.status) && r.endpoint);
  const streamsDown = watched.filter((r) => !isWatching(r.id));
  const backup = backupStatus();
  const backupConfigured = !!getSettings().backup.repository;
  const hourAgo = Date.now() - HOUR;
  const trouble = counts<string>("SELECT kind AS k, COUNT(*) AS n FROM provider_events WHERE ts >= ? GROUP BY kind", hourAgo);
  const committed = runs.filter((r) => ["preparing", "running", "recovering", "paused", "stopped", "done"].includes(r.status)).reduce((n, r) => n + JSON.parse(r.size).memoryGiB, 0);
  const budget = totalmem() / GiB - 1.5;

  const checks: { name: string; state: CheckState; detail: string }[] = [];
  checks.push(info.error ? { name: "Runtime", state: "bad", detail: `not reachable: ${info.error}` } : { name: "Runtime", state: "ok", detail: `${runtime.kind} reachable` });
  if (disk) {
    const freeGiB = disk.free / GiB;
    checks.push({
      name: "Data disk",
      state: freeGiB < config.minFreeGiB ? "bad" : freeGiB < config.minFreeGiB * 2 ? "warn" : "ok",
      detail: `${freeGiB.toFixed(1)} GiB free (runs stop below ${config.minFreeGiB} GiB)`,
    });
  } else checks.push({ name: "Data disk", state: "warn", detail: "could not read free space" });
  const freeShare = freemem() / totalmem();
  checks.push({ name: "Host memory", state: freeShare < 0.05 ? "bad" : freeShare < 0.12 ? "warn" : "ok", detail: `${Math.round(freeShare * 100)}% free` });
  checks.push({
    name: "Memory promised",
    state: committed > budget ? "warn" : "ok",
    detail: `${committed} GiB promised to machines of ~${budget.toFixed(0)} GiB`,
  });
  checks.push({
    name: "Event streams",
    state: streamsDown.length ? "warn" : "ok",
    detail: watched.length ? `${watched.length - streamsDown.length}/${watched.length} connected${streamsDown.length ? `: ${streamsDown.map((r) => r.id).join(", ")} down` : ""}` : "no runs to watch",
  });
  const rate = trouble.ratelimit ?? 0;
  const errs = trouble.error ?? 0;
  checks.push({
    name: "Providers",
    state: errs + rate > 20 ? "bad" : errs + rate ? "warn" : "ok",
    detail: errs + rate || trouble.retry ? `last hour: ${errs} errors, ${rate} rate limits, ${trouble.retry ?? 0} retries` : "no errors in the last hour",
  });
  checks.push(
    !backupConfigured
      ? { name: "Backups", state: "warn", detail: "not configured" }
      : !backup.last
        ? { name: "Backups", state: "warn", detail: "configured, never ran" }
        : !backup.last.ok
          ? { name: "Backups", state: "bad", detail: "last backup failed" }
          : { name: "Backups", state: Date.now() - backup.last.ts > 2 * DAY ? "warn" : "ok", detail: `last ok ${new Date(backup.last.ts).toISOString().slice(0, 16).replace("T", " ")} UTC` },
  );

  const rowCount = (t: string) => db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n ?? 0;
  return {
    checks,
    pixel: {
      startedAt,
      uptimeMs: Date.now() - startedAt,
      pid: process.pid,
      bun: Bun.version,
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      runtime: runtime.kind,
      runtimeInfo: info,
    },
    host: { memTotal: totalmem(), memFree: freemem(), load: loadavg(), cpus: cpus().length, uptimeMs: hostUptime() * 1000, disk, dataDir: config.dataDir },
    db: {
      bytes: Bun.file(config.dbPath).size,
      walBytes: Bun.file(`${config.dbPath}-wal`).size,
      rows: Object.fromEntries(["runs", "sessions", "messages", "parts", "timeline", "metrics", "llm_calls", "provider_events"].map((t) => [t, rowCount(t)])),
    },
  };
}

/** The window ending now, in buckets that start on the viewer's clock (`tzOffsetMin`: their UTC offset in minutes). */
function windowFor(days: number, tzOffsetMin: number) {
  days = Math.max(1, Math.min(90, Math.round(days) || 7));
  const bucket = bucketFor(days);
  const tzMs = Math.max(-840, Math.min(840, Math.round(tzOffsetMin) || 0)) * 60_000;
  const shift = tzMs % bucket;
  const to = Math.ceil((Date.now() + shift) / bucket) * bucket - shift;
  const from = to - Math.ceil((days * DAY) / bucket) * bucket;
  return { days, bucket, from, to, tzMs };
}

const LLM_COLUMNS = "provider, model, run_id, created, first_token, completed, tokens_in, tokens_out, tokens_reasoning, error";
type LlmRow = LlmCall & { run_id: string };
const nums = (xs: (number | null)[]) => xs.filter((x): x is number => x != null);

/** `tzOffsetMin`: the viewer's UTC offset in minutes, so hour and day buckets start on their clock. */
export async function stats(days: number, tzOffsetMin = 0) {
  const now = Date.now();
  const win = windowFor(days, tzOffsetMin);
  days = win.days;
  const { bucket, from, to } = win;
  // Load the model catalogue (cached for a day) so cache savings can be priced.
  await catalogProviders().catch(() => null);
  const calls = db.query<CallRow, [number]>(`SELECT ${CALL_COLUMNS} FROM model_calls WHERE created >= ? ORDER BY created`).all(from);

  const totals = zero();
  const series = Array.from({ length: (to - from) / bucket }, (_, i) => ({ t: from + i * bucket, ...zero() }));
  const models = new Map<string, TokenTotals & { provider: string; model: string; durations: number[] }>();
  const perRun = new Map<string, TokenTotals>();
  // Model calls by the viewer's weekday (0 = Monday) and hour, for the when-do-agents-work heatmap.
  const heatmap = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const c of calls) {
    const local = new Date(c.t + win.tzMs);
    heatmap[(local.getUTCDay() + 6) % 7][local.getUTCHours()]++;
    add(totals, c);
    const b = series[Math.floor((c.t - from) / bucket)];
    if (b) add(b, c);
    const key = `${c.provider ?? "?"}/${c.model ?? "?"}`;
    let m = models.get(key);
    if (!m) models.set(key, (m = { ...zero(), provider: c.provider ?? "?", model: c.model ?? "?", durations: [] }));
    add(m, c);
    if (c.done && c.done > c.t) m.durations.push(c.done - c.t);
    let r = perRun.get(c.run);
    if (!r) perRun.set(c.run, (r = zero()));
    add(r, c);
  }
  finish(totals);
  series.forEach(finish);

  const byModel = [...models.values()]
    .map(({ durations, ...m }) => {
      durations.sort((a, b) => a - b);
      return { ...finish(m), medianMs: durations.length ? durations[Math.floor(durations.length / 2)] : null, tpsP50: null as number | null, ttftP50: null as number | null, runs: 0 };
    })
    .sort((a, b) => b.input + b.cacheRead + b.output - (a.input + a.cacheRead + a.output));

  // ---- per-bucket extras: cost by model, model speed, tool calls by kind, findings by severity, runs started and finished ----
  const nB = series.length;
  const at = (t: number) => Math.floor((t - from) / bucket);
  const zeros = () => Array<number>(nB).fill(0);
  const topModels = byModel.slice(0, 5).map((m) => `${m.provider}/${m.model}`);
  const modelSeries = [...topModels, ...(byModel.length > 5 ? ["other"] : [])].map((key) => ({ key, cost: zeros(), tokens: zeros() }));
  for (const c of calls) {
    const i = at(c.t);
    if (i < 0 || i >= nB) continue;
    const m = modelSeries.find((x) => x.key === `${c.provider ?? "?"}/${c.model ?? "?"}`) ?? modelSeries.find((x) => x.key === "other");
    if (!m) continue;
    m.cost[i] += c.cost;
    m.tokens[i] += c.i + c.o + c.cr + c.cw;
  }
  const llm = db.query<LlmRow, [number]>(`SELECT ${LLM_COLUMNS} FROM llm_calls WHERE created >= ?`).all(from);
  // Speed per model (llm_calls has the first token; model_calls doesn't) and how many runs used it.
  const llmByModel = Map.groupBy(llm, (c) => `${c.provider}/${c.model}`);
  const runsByModel = Map.groupBy(calls, (c) => `${c.provider ?? "?"}/${c.model ?? "?"}`);
  for (const m of byModel) {
    const key = `${m.provider}/${m.model}`;
    const cs = llmByModel.get(key) ?? [];
    const tps = nums(cs.map(tpsOf));
    Object.assign(m, { tpsP50: pct(tps, 50), ttftP50: pct(nums(cs.map(ttftOf)), 50), runs: new Set((runsByModel.get(key) ?? []).map((c) => c.run)).size });
  }
  const speedBuckets = Array.from({ length: nB }, () => ({ ttft: [] as number[], tps: [] as number[] }));
  for (const c of llm) {
    const b = speedBuckets[at(c.created)];
    if (!b) continue;
    const f = ttftOf(c);
    const v = tpsOf(c);
    if (f != null) b.ttft.push(f);
    if (v != null) b.tps.push(v);
  }
  const speed = speedBuckets.map((b) => ({ ttft: pct(b.ttft, 50), tps: pct(b.tps, 50) }));
  const toolRows = db
    .query<{ b: number; tool: string; n: number }, [number, number, number]>("SELECT (started - ?) / ? AS b, tool, COUNT(*) AS n FROM tool_calls WHERE started >= ? AND tool IS NOT NULL GROUP BY b, tool")
    .all(from, bucket, from);
  const toolSeries: Record<string, number[]> = {};
  for (const r of toolRows) {
    const i = Math.floor(r.b);
    if (i < 0 || i >= nB) continue;
    (toolSeries[kindOf(r.tool) ?? "other"] ??= zeros())[i] += r.n;
  }
  const findingSeries: Record<string, number[]> = {};
  for (const f of db.query<{ created: number; severity: string | null }, [number]>("SELECT created, severity FROM findings WHERE created >= ? AND removed_at IS NULL").all(from)) {
    const i = at(f.created);
    if (i >= 0 && i < nB) (findingSeries[f.severity ?? "none"] ??= zeros())[i]++;
  }

  const runs = listRuns();
  const runSeries = { started: zeros(), finished: zeros() };
  for (const r of runs) {
    if (r.started_at && r.started_at >= from) runSeries.started[at(r.started_at)] !== undefined && runSeries.started[at(r.started_at)]++;
    if (r.finished_at && r.finished_at >= from) runSeries.finished[at(r.finished_at)] !== undefined && runSeries.finished[at(r.finished_at)]++;
  }
  const runById = new Map(runs.map((r) => [r.id, r]));
  const byRun = [...perRun.entries()]
    .map(([id, t]) => {
      const r = runById.get(id);
      return { id, label: r?.label ?? null, hue: r?.hue ?? null, repo: r?.repo ?? null, status: r?.status ?? null, model: r?.model ?? null, ...finish(t) };
    })
    .sort((a, b) => b.input + b.cacheRead + b.output - (a.input + a.cacheRead + a.output))
    .slice(0, 20);

  // Agent time: how long runs were alive inside the window.
  let agentMs = 0;
  for (const r of runs) {
    if (!r.started_at) continue;
    const end = r.finished_at ?? (["running", "recovering", "paused", "preparing"].includes(r.status) ? now : r.last_activity ?? r.started_at);
    agentMs += Math.max(0, Math.min(end, now) - Math.max(r.started_at, from));
  }

  const status = counts<string>("SELECT status AS k, COUNT(*) AS n FROM runs GROUP BY status");
  const dispositions = counts<string>("SELECT disposition AS k, COUNT(*) AS n FROM findings WHERE disposition IS NOT NULL AND removed_at IS NULL GROUP BY disposition");
  const runTotals = db
    .query<{ continues: number; oom: number; created: number; finished: number }, [number, number]>(
      "SELECT COALESCE(SUM(continues), 0) AS continues, COALESCE(SUM(oom_restarts), 0) AS oom, SUM(created_at >= ?) AS created, SUM(finished_at >= ?) AS finished FROM runs",
    )
    .get(from, from)!;
  const findings = db
    .query<{ severity: string | null; state: string; n: number }, [number]>("SELECT severity, state, COUNT(*) AS n FROM findings WHERE created >= ? AND removed_at IS NULL GROUP BY severity, state")
    .all(from);
  const sessions = db.query<{ n: number; sub: number }, [number]>("SELECT COUNT(*) AS n, COALESCE(SUM(parent_id IS NOT NULL), 0) AS sub FROM sessions WHERE created_at >= ?").get(from)!;

  return {
    window: { days, from, to, bucketMs: bucket },
    totals,
    allTime: allTime(),
    savings: cacheSavings(byModel),
    series,
    byModel,
    byRun,
    tools: tools(from),
    heatmap,
    modelSeries,
    speed,
    toolSeries,
    findingSeries,
    runSeries,
    findings: {
      total: findings.reduce((a, f) => a + f.n, 0),
      bySeverity: findings.reduce<Record<string, number>>((m, f) => ((m[f.severity ?? "none"] = (m[f.severity ?? "none"] ?? 0) + f.n), m), {}),
      byState: findings.reduce<Record<string, number>>((m, f) => ((m[f.state] = (m[f.state] ?? 0) + f.n), m), {}),
    },
    runs: {
      total: runs.length,
      status,
      dispositions,
      createdInWindow: runTotals.created ?? 0,
      finishedInWindow: runTotals.finished ?? 0,
      continues: runTotals.continues,
      oomRestarts: runTotals.oom,
      agentMs,
      sessions: sessions.n,
      subagents: sessions.sub,
    },
    pixelEvents: counts<string>("SELECT kind AS k, COUNT(*) AS n FROM timeline WHERE actor = 'pixel' AND ts >= ? GROUP BY kind", from),
    providerEvents: counts<string>("SELECT kind AS k, COUNT(*) AS n FROM provider_events WHERE ts >= ? GROUP BY kind", from),
    system: await system(),
  };
}

export type Stats = Awaited<ReturnType<typeof stats>>;

/**
 * One model over the window: tokens, cost and calls over time, speed (output tok/s and first token,
 * p50 and p90, over time and as a spread), what a call looks like on average, errors by kind,
 * provider trouble, the runs that used it, its catalogue facts and how its runs did.
 */
export async function modelStats(key: string, days: number, tzOffsetMin = 0) {
  const slash = key.indexOf("/");
  if (slash <= 0) throw new Error("model must look like provider/model");
  const provider = key.slice(0, slash);
  const model = key.slice(slash + 1);
  const win = windowFor(days, tzOffsetMin);
  const { bucket, from, to } = win;
  await catalogProviders().catch(() => null);

  const calls = db.query<CallRow, [string, string, number]>(`SELECT ${CALL_COLUMNS} FROM model_calls WHERE provider = ? AND model = ? AND created >= ? ORDER BY created`).all(provider, model, from);
  const llm = db.query<LlmRow, [string, string, number]>(`SELECT ${LLM_COLUMNS} FROM llm_calls WHERE provider = ? AND model = ? AND created >= ?`).all(provider, model, from);
  const nB = (to - from) / bucket;
  const at = (t: number) => Math.floor((t - from) / bucket);

  const totals = zero();
  const series = Array.from({ length: nB }, (_, i) => ({ t: from + i * bucket, ...zero() }));
  const perRun = new Map<string, TokenTotals>();
  const durations: number[] = [];
  const errors: Record<string, number> = {};
  let aborted = 0;
  for (const c of calls) {
    add(totals, c);
    const b = series[at(c.t)];
    if (b) add(b, c);
    let r = perRun.get(c.run);
    if (!r) perRun.set(c.run, (r = zero()));
    add(r, c);
    if (c.done && c.done > c.t) durations.push(c.done - c.t);
    if (c.err === "MessageAbortedError") aborted++;
    else if (c.err) errors[c.err] = (errors[c.err] ?? 0) + 1;
  }
  finish(totals);
  series.forEach(finish);

  // Speed over time and overall; a call counts for tok/s once it streamed at least 30 tokens.
  const speedBuckets = Array.from({ length: nB }, () => ({ ttft: [] as number[], tps: [] as number[] }));
  const tpsByRun = new Map<string, number[]>();
  const allTps: number[] = [];
  const allTtft: number[] = [];
  for (const c of llm) {
    const v = tpsOf(c);
    const f = ttftOf(c);
    const b = speedBuckets[at(c.created)];
    if (v != null) {
      allTps.push(v);
      b?.tps.push(v);
      (tpsByRun.get(c.run_id) ?? tpsByRun.set(c.run_id, []).get(c.run_id)!).push(v);
    }
    if (f != null) {
      allTtft.push(f);
      b?.ttft.push(f);
    }
  }
  const speed = speedBuckets.map((b) => ({ ttft: pct(b.ttft, 50), tps: pct(b.tps, 50), tpsP90: pct(b.tps, 90) }));
  // Spread of output speed: 12 equal bins from 0 to the 98th percentile.
  const top = pct(allTps, 98) ?? 0;
  const binW = top > 0 ? Math.max(1, Math.ceil(top / 12)) : 1;
  const tpsSpread = Array.from({ length: 12 }, (_, i) => ({ from: i * binW, to: (i + 1) * binW, n: 0 }));
  for (const v of allTps) tpsSpread[Math.min(11, Math.floor(v / binW))].n++;

  const runs = listRuns();
  const runById = new Map(runs.map((r) => [r.id, r]));
  const byRun = [...perRun.entries()]
    .map(([id, t]) => {
      const r = runById.get(id);
      return { id, label: r?.label ?? null, hue: r?.hue ?? null, status: r?.status ?? null, tpsP50: pct(tpsByRun.get(id) ?? [], 50), ...finish(t) };
    })
    .sort((a, b) => b.input + b.cacheRead + b.output - (a.input + a.cacheRead + a.output))
    .slice(0, 20);

  const life = db
    .query<Omit<TokenTotals, "hitRate"> & { first: number | null }, [string, string]>(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(input), 0) AS input, COALESCE(SUM(output), 0) AS output, COALESCE(SUM(reasoning), 0) AS reasoning,
         COALESCE(SUM(cache_read), 0) AS cacheRead, COALESCE(SUM(cache_write), 0) AS cacheWrite, COALESCE(SUM(cost), 0) AS cost,
         COALESCE(SUM(error IS NOT NULL AND error != 'MessageAbortedError'), 0) AS errors, MIN(created) AS first
       FROM model_calls WHERE provider = ? AND model = ?`,
    )
    .get(provider, model)!;
  const { first, ...lifeTotals } = life;

  const cat = cachedCatalog()?.get(provider)?.models.find((x) => x.id === model) ?? null;
  const c = effective(key, getSettings(), cat);
  const done = calls.length - aborted;
  const sorted = [...durations].sort((a, b) => a - b);
  const allTokensOf = (t: TokenTotals) => t.input + t.output + t.cacheRead + t.cacheWrite;
  const lb = leaderboard().find((x) => x.model === key) ?? null;

  return {
    key,
    provider,
    model,
    window: { days: win.days, from, to, bucketMs: bucket },
    totals,
    allTime: { ...finish({ ...lifeTotals, hitRate: null }), since: first },
    savings: cacheSavings([{ provider, model, cacheRead: totals.cacheRead }]),
    series,
    speed,
    tpsSpread,
    speedSummary: {
      tpsP50: pct(allTps, 50),
      tpsP90: pct(allTps, 90),
      ttftP50: pct(allTtft, 50),
      ttftP90: pct(allTtft, 90),
      durationP50: pct(sorted, 50),
      durationP90: pct(sorted, 90),
      measured: allTps.length,
    },
    perCall: {
      prompt: done ? (totals.input + totals.cacheRead + totals.cacheWrite) / done : null,
      output: done ? totals.output / done : null,
      reasoning: done ? totals.reasoning / done : null,
      cost: done ? totals.cost / done : null,
    },
    costPerMTokens: allTokensOf(totals) ? (totals.cost / allTokensOf(totals)) * 1e6 : null,
    errors,
    aborted,
    providerEvents: counts<string>("SELECT kind AS k, COUNT(*) AS n FROM provider_events WHERE provider = ? AND model = ? AND ts >= ? GROUP BY kind", provider, model, from),
    byRun,
    catalog: { name: cat?.name ?? null, context: c.context, output: c.output, costIn: c.costIn, costOut: c.costOut, costCacheRead: c.costCacheRead, reasoning: c.reasoning },
    runs: lb && { total: lb.runs, active: lb.active, finished: lb.finished, gaveUp: lb.gaveUp, finishRate: lb.finishRate, medianDuration: lb.medianDuration, real: lb.real, report: lb.report, triaged: lb.triaged, realRate: lb.realRate, costPerReal: lb.costPerReal, costPerReport: lb.costPerReport },
  };
}

export type ModelStats = Awaited<ReturnType<typeof modelStats>>;
