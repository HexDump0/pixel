/** Periodic checks of every active run: health, missed events, questions, resources. Plus reattach on start. */
import { statfsSync } from "node:fs";
import { config } from "../config.ts";
import { ACTIVE_STATUSES, db, getRun, listRuns, type RunRow } from "../db.ts";
import { getSettings, type Settings } from "../settings.ts";
import { publish } from "../bus.ts";
import type { OpencodeClient } from "../opencode.ts";
import { runtime } from "../runtime/index.ts";
import { workbaseSize } from "../knowledge.ts";
import { clientFor, notifyRun, setRun, setStatus, timeline } from "./state.ts";
import { autoApprove, getWatcher, serial, unwatch, watch, watchedRuns, type Watcher } from "./events.ts";
import { onIdle, recover, sendPrompt } from "./lifecycle.ts";
import { prepare } from "./create.ts";

const GiB = 1024 ** 3;
const METRICS_MS = 60_000;
/** Root session not busy per opencode, but we think it is, for this long → treat as a missed idle event. */
const MISSED_IDLE_MS = 60_000;
/** Failed health checks in a row before recovering (one blip is tolerated). */
const UNHEALTHY_LIMIT = 2;

const WATCHED: RunRow["status"][] = ["running", "recovering", "paused"];

export async function check(id: string) {
  const run = getRun(id);
  if (!run || !WATCHED.includes(run.status) || !run.endpoint) return;
  const w = getWatcher(id);
  if (!w) return watch(id);
  const client = clientFor(run);

  if (!(await client.healthy())) {
    if (++w.unhealthy >= UNHEALTHY_LIMIT && run.status !== "paused") await serial(w, () => recover(id));
    return;
  }
  w.unhealthy = 0;
  if (run.status === "recovering") setStatus(id, "running");
  const s = getSettings();
  if (run.status === "running" && run.session_id) await safetyNets(run, w, client, s);
  if (Date.now() - w.lastMetrics >= METRICS_MS) {
    w.lastMetrics = Date.now();
    await resources(id, client, s);
  }
}

/** Things events should have told us but might not have (dropped stream, Pixel restart). */
async function safetyNets(run: RunRow, w: Watcher, client: OpencodeClient, s: Settings) {
  const status = await client.status().catch(() => null);
  if (status) {
    const st = status[run.session_id!]?.type;
    if (st && st !== run.agent_status) setRun(run.id, { agent_status: st });
    if (!st && run.agent_status !== "idle" && Date.now() - (run.last_activity ?? 0) > MISSED_IDLE_MS) await serial(w, () => onIdle(run.id, "watchdog"));
  }
  for (const p of await client.pendingPermissions().catch(() => [])) autoApprove(run.id, p);

  if (s.questionTimeoutMin > 0 && run.autopilot) {
    const stale = db
      .query<{ id: string }, [string, number]>("SELECT id FROM questions WHERE run_id = ? AND status = 'pending' AND created_at < ?")
      .all(run.id, Date.now() - s.questionTimeoutMin * 60_000);
    for (const q of stale) {
      await client.rejectQuestion(q.id).catch(() => {});
      db.query("UPDATE questions SET status = 'rejected' WHERE id = ?").run(q.id);
      timeline(run.id, "pixel", "question", `No answer after ${s.questionTimeoutMin} min; dismissed the agent's question so it carries on`);
    }
  }
}

/** Record metrics; stop the run if the machine disk is full or the workbase is too big. */
async function resources(id: string, client: OpencodeClient, s: Settings) {
  let run = getRun(id)!;
  const limit = s.workbaseLimitGiB * GiB;
  const m = await runtime.metrics(run).catch(() => ({}) as Awaited<ReturnType<typeof runtime.metrics>>);
  const wb = workbaseSize(id, limit * 1.1);
  const ts = Date.now();
  db.query("INSERT INTO metrics (run_id, ts, cpu, mem_used, mem_total, disk_used, disk_total, workbase_bytes, tokens, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    ts,
    m.cpu ?? null,
    m.memUsed ?? null,
    m.memTotal ?? null,
    m.diskUsed ?? null,
    m.diskTotal ?? null,
    wb,
    run.tokens_in + run.tokens_out + run.tokens_reasoning,
    run.cost,
  );
  publish(id, "metrics", { ts, ...m, workbase: wb });

  run = getRun(id)!;
  if (run.status !== "running") return;
  const stop = async (detail: string, message: string) => {
    await client.abort(run.session_id!).catch(() => {});
    const r = setStatus(id, "stopped", detail)!;
    timeline(id, "pixel", "stopped", message);
    notifyRun("stopped", r, `Run stopped: ${detail}`, message);
  };
  const free = freeBytes();
  if (free !== null && free < config.minFreeGiB * GiB) {
    return stop("server disk almost full", `Only ${(free / GiB).toFixed(1)} GiB free on Pixel's data disk (minimum ${config.minFreeGiB} GiB): aborted the session and stopped the run`);
  }
  if (m.diskUsed && m.diskTotal && (m.diskUsed / m.diskTotal) * 100 >= s.diskFullPercent) {
    return stop("machine disk full", `Machine disk at ${((m.diskUsed / m.diskTotal) * 100).toFixed(1)}%: aborted the session and stopped the run (machine kept for inspection)`);
  }
  if (wb > limit) {
    return stop("workbase too big", `Workbase is ${(wb / GiB).toFixed(2)} GiB, over the ${s.workbaseLimitGiB} GiB limit: aborted the session and stopped the run`);
  }
}

/** Free space on the data disk, which the process runtimes share with Pixel (and possibly other apps). */
function freeBytes() {
  try {
    const fs = statfsSync(config.dataDir);
    return fs.bavail * fs.bsize;
  } catch {
    return null;
  }
}

let timer: Timer | null = null;
let checking = false;

export function startWatchdog() {
  if (timer) return;
  runtime.onLimit = (id, message) => timeline(id, "pixel", "limit", message);
  timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const active = listRuns().filter((r) => WATCHED.includes(r.status));
      await Promise.all(active.map((r) => check(r.id).catch((e) => console.error(`watchdog ${r.id}`, e))));
    } finally {
      checking = false;
    }
  }, config.watchdogMs);
}

export function stopWatchdog() {
  if (timer) clearInterval(timer);
  timer = null;
  for (const id of watchedRuns()) unwatch(id);
}

/** On Pixel start: pick every active run back up from SQLite. */
export async function reattach() {
  for (const run of listRuns().filter((r) => ACTIVE_STATUSES.includes(r.status))) {
    if (run.status === "preparing") {
      timeline(run.id, "pixel", "restart", "Pixel restarted while preparing; resuming");
      void prepare(run.id);
      continue;
    }
    timeline(run.id, "pixel", "restart", "Pixel restarted; reattaching");
    if (runtime.agentsDieWithPixel && run.endpoint) {
      // opencode ran as Pixel's child and died with it; bring it back without counting it as a recovery.
      try {
        await runtime.restartOpencode(run);
        await clientFor(run).waitHealthy(60_000);
        if (run.status === "running" && run.agent_status !== "idle") {
          timeline(run.id, "pixel", "continue", `Restarted opencode; sending "${getSettings().continueMessage}" (not counted)`);
          await sendPrompt(run, getSettings().continueMessage);
        }
      } catch (e: any) {
        timeline(run.id, "pixel", "restart", `Could not restart opencode: ${e.message}`);
      }
    }
    watch(run.id);
  }
}
