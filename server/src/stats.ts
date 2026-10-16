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
import { runtime } from "./runtime/index.ts";
import { isWatching } from "./runs/events.ts";
import { kindOf } from "./fleet.ts";

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

const CALL_COLUMNS = `created_at AS t, run_id AS run,
  json_extract(data, '$.providerID') AS provider, json_extract(data, '$.modelID') AS model,
  COALESCE(json_extract(data, '$.tokens.input'), 0) AS i, COALESCE(json_extract(data, '$.tokens.output'), 0) AS o,
  COALESCE(json_extract(data, '$.tokens.reasoning'), 0) AS r, COALESCE(json_extract(data, '$.tokens.cache.read'), 0) AS cr,
  COALESCE(json_extract(data, '$.tokens.cache.write'), 0) AS cw, COALESCE(json_extract(data, '$.cost'), 0) AS cost,
  json_extract(data, '$.error.name') AS err, json_extract(data, '$.time.completed') AS done`;

/** Bucket size for a window: hourly up to two days, 6-hourly up to two weeks, daily beyond. */
const bucketFor = (days: number) => (days <= 2 ? HOUR : days <= 14 ? 6 * HOUR : DAY);

function allTime(): TokenTotals {
  const r = db
    .query<Omit<TokenTotals, "hitRate">, []>(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(i), 0) AS input, COALESCE(SUM(o), 0) AS output, COALESCE(SUM(r), 0) AS reasoning,
         COALESCE(SUM(cr), 0) AS cacheRead, COALESCE(SUM(cw), 0) AS cacheWrite, COALESCE(SUM(cost), 0) AS cost,
         COALESCE(SUM(err IS NOT NULL AND err != 'MessageAbortedError'), 0) AS errors
       FROM (SELECT ${CALL_COLUMNS} FROM messages WHERE role = 'assistant')`,
    )
    .get()!;
  return finish({ ...r, hitRate: null });
}

/** USD saved by cache reads for models whose catalogue entry has both an input and a cache-read price. */
function cacheSavings(byModel: { provider: string; model: string; cacheRead: number }[]) {
  const catalog = cachedCatalog();
  let saved = 0;
  let priced = 0;
  let unpriced = 0;
  for (const m of byModel) {
    const c = catalog?.get(m.provider)?.models.find((x) => x.id === m.model);
    if (c?.costIn != null && c.costCacheRead != null) {
      saved += (m.cacheRead * (c.costIn - c.costCacheRead)) / 1e6;
      priced += m.cacheRead;
    } else unpriced += m.cacheRead;
  }
  return { saved, pricedTokens: priced, unpricedTokens: unpriced };
}

function tools(since: number) {
  const rows = db
    .query<{ tool: string; n: number; errors: number; avgMs: number | null; running: number }, [number]>(
      `SELECT tool, COUNT(*) AS n, SUM(st = 'error') AS errors, SUM(st IN ('running', 'pending')) AS running,
         AVG(CASE WHEN e IS NOT NULL AND s IS NOT NULL THEN e - s END) AS avgMs
       FROM (SELECT json_extract(data, '$.tool') AS tool, json_extract(data, '$.state.status') AS st,
               json_extract(data, '$.state.time.start') AS s, json_extract(data, '$.state.time.end') AS e
             FROM parts WHERE type = 'tool' AND updated_at >= ?)
       WHERE tool IS NOT NULL GROUP BY tool ORDER BY n DESC`,
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
      rows: Object.fromEntries(["runs", "sessions", "messages", "parts", "timeline", "metrics", "llm_calls", "provider_events", "files_index"].map((t) => [t, rowCount(t)])),
    },
  };
}

/** `tzOffsetMin`: the viewer's UTC offset in minutes, so hour and day buckets start on their clock. */
export async function stats(days: number, tzOffsetMin = 0) {
  days = Math.max(1, Math.min(90, Math.round(days) || 7));
  const now = Date.now();
  const bucket = bucketFor(days);
  const shift = (Math.max(-840, Math.min(840, Math.round(tzOffsetMin) || 0)) * 60_000) % bucket;
  const to = Math.ceil((now + shift) / bucket) * bucket - shift;
  const from = to - Math.ceil((days * DAY) / bucket) * bucket;
  // Load the model catalogue (cached for a day) so cache savings can be priced.
  await catalogProviders().catch(() => null);
  const calls = db.query<CallRow, [number]>(`SELECT ${CALL_COLUMNS} FROM messages WHERE role = 'assistant' AND created_at >= ? ORDER BY created_at`).all(from);

  const totals = zero();
  const series = Array.from({ length: (to - from) / bucket }, (_, i) => ({ t: from + i * bucket, ...zero() }));
  const models = new Map<string, TokenTotals & { provider: string; model: string; durations: number[] }>();
  const perRun = new Map<string, TokenTotals>();
  for (const c of calls) {
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
      return { ...finish(m), medianMs: durations.length ? durations[Math.floor(durations.length / 2)] : null };
    })
    .sort((a, b) => b.input + b.cacheRead + b.output - (a.input + a.cacheRead + a.output));

  const runs = listRuns();
  const runById = new Map(runs.map((r) => [r.id, r]));
  const byRun = [...perRun.entries()]
    .map(([id, t]) => {
      const r = runById.get(id);
      return { id, repo: r?.repo ?? null, status: r?.status ?? null, model: r?.model ?? null, ...finish(t) };
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
  const verdicts = counts<string>("SELECT verdict AS k, COUNT(*) AS n FROM findings WHERE verdict IS NOT NULL AND removed_at IS NULL GROUP BY verdict");
  const runTotals = db
    .query<{ continues: number; oom: number; created: number; finished: number }, [number, number]>(
      "SELECT COALESCE(SUM(continues), 0) AS continues, COALESCE(SUM(oom_restarts), 0) AS oom, SUM(created_at >= ?) AS created, SUM(finished_at >= ?) AS finished FROM runs",
    )
    .get(from, from)!;
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
    runs: {
      total: runs.length,
      status,
      verdicts,
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
