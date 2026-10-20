/**
 * A run's machine size on the fly: change CPU, memory and disk while it works, and the temporary
 * extra disk that lets an agent clean up after filling its disk.
 *
 * Disk rescue: when the watchdog finds the machine disk full, the run gets `diskRescueGiB` more disk
 * and the agent is asked to clean up. Once usage is back under the goal (90% of where the run would
 * stop on its normal disk) the disk goes back to normal and the agent carries on. If the extra fills
 * up too, or the goal isn't reached within `diskRescueMin`, the run stops. You can give a run extra
 * disk the same way by hand (Give more disk), e.g. after it stopped for a full disk.
 */
import { getRun, type RunRow, type RunSize } from "../db.ts";
import { getSettings, type Settings } from "../settings.ts";
import { runtime } from "../runtime/index.ts";
import type { Metrics } from "../runtime/types.ts";
import { clientFor, mustRun, mustSession, setRun, timeline, type Actor } from "./state.ts";
import { sendPrompt } from "./lifecycle.ts";
import { getWatcher, serial } from "./events.ts";
import { resumeRun } from "./controls.ts";

export interface DiskBoost {
  /** The disk size to go back to, GiB. */
  baseGiB: number;
  /** GiB over the base right now. */
  extraGiB: number;
  /** When the (latest) extra was given. */
  at: number;
  by: "pixel" | "user";
}

const GiB = 1024 ** 3;
const LIMITS = { cpu: [1, 64], memoryGiB: [0.5, 512], diskGiB: [1, 4096] } as const;
const RESCUE_DETAIL = "Cleaning up a full disk";

export const sizeOf = (run: RunRow) => JSON.parse(run.size) as RunSize;
export const boostOf = (run: RunRow): DiskBoost | null => (run.disk_boost ? JSON.parse(run.disk_boost) : null);
const sizeLabel = (s: RunSize) => `${s.cpu} CPU, ${s.memoryGiB} GiB memory, ${s.diskGiB} GiB disk`;
const gib = (bytes: number) => `${(bytes / GiB).toFixed(1)} GiB`;

/** Usage the cleanup has to get under: comfortably below where the run would stop on its normal disk. */
export const cleanGoal = (baseGiB: number, s: Settings) => baseGiB * GiB * (s.diskFullPercent / 100) * 0.9;

function validate(patch: Partial<RunSize>, cur: RunSize): RunSize {
  const out = { ...cur };
  for (const k of Object.keys(LIMITS) as (keyof RunSize)[]) {
    const v = patch[k];
    if (v === undefined || v === null) continue;
    const [lo, hi] = LIMITS[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) throw new Error(`${k} must be between ${lo} and ${hi}`);
    out[k] = k === "memoryGiB" ? Math.round(v * 2) / 2 : Math.round(v);
  }
  return out;
}

/** Apply a size to the live machine (if the runtime can) and record it. */
async function apply(run: RunRow, next: RunSize, fields: Partial<RunRow> = {}) {
  const notes = (await runtime.resize?.(run, next, sizeOf(run))) ?? [];
  setRun(run.id, { size: JSON.stringify(next), ...fields });
  return notes;
}

/** Change the machine size now. Setting the disk by hand ends a temporary boost: that's the disk from now on. */
export async function resizeRun(id: string, patch: Partial<RunSize>, actor: Actor = "user") {
  const run = mustRun(id);
  const prev = sizeOf(run);
  const next = validate(patch, prev);
  if (JSON.stringify(next) === JSON.stringify(prev)) return { size: next, notes: [] as string[] };
  const boost = boostOf(run);
  const endsBoost = !!boost && next.diskGiB !== prev.diskGiB;
  const notes = await apply(run, next, endsBoost ? { disk_boost: null, ...clearedDetail(run) } : {});
  timeline(id, actor, "resize", `Machine changed from ${sizeLabel(prev)} to ${sizeLabel(next)}${notes.length ? `. ${notes.join(". ")}` : ""}`);
  return { size: next, notes };
}

const clearedDetail = (run: RunRow) => (run.status_detail === RESCUE_DETAIL ? { status_detail: null } : {});

function rescueMessage(run: RunRow, used: number | undefined, s: Settings, base: number, extra: number) {
  const p = runtime.paths(run);
  const vars: Record<string, string> = {
    used: used ? gib(used) : "nearly all",
    limit: `${base} GiB`,
    extra: `${extra} GiB`,
    goal: gib(cleanGoal(base, s)),
    dirs: runtime.kind === "incus" ? `anywhere on the VM, e.g. ${p.target}, ${p.scratch} and /tmp` : `${p.target}, ${p.scratch} and your home`,
  };
  return s.diskRescueMessage.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
}

/**
 * Give the run extra disk for a while and ask the agent to clean up. The watchdog does this when the
 * disk fills up (its current step is aborted first); by hand it also brings a stopped run back.
 * A second boost while one is on adds to it.
 */
export async function boostDisk(id: string, by: "pixel" | "user", used?: number) {
  const s = getSettings();
  const run = mustSession(mustRun(id));
  const extra = s.diskRescueGiB > 0 ? s.diskRescueGiB : 5;
  const prev = sizeOf(run);
  const boost = boostOf(run);
  const base = boost?.baseGiB ?? prev.diskGiB;
  const next = { ...prev, diskGiB: prev.diskGiB + extra };
  const nextBoost: DiskBoost = { baseGiB: base, extraGiB: next.diskGiB - base, at: Date.now(), by };
  const notes = await apply(run, next, { disk_boost: JSON.stringify(nextBoost), ...(by === "pixel" ? { disk_rescues: run.disk_rescues + 1 } : {}) });
  const msg = rescueMessage(run, used, s, base, nextBoost.extraGiB);
  const why = by === "pixel" ? `Machine disk full${used ? ` (${gib(used)} of ${base} GiB)` : ""}` : "You gave the machine more disk";
  timeline(
    id,
    by,
    "disk",
    `${why}: ${extra} GiB extra (disk now ${next.diskGiB} GiB) to clean up; back to ${base} GiB once under ${gib(cleanGoal(base, s))}${notes.length ? `. ${notes.join(". ")}` : ""}`,
  );

  const fresh = getRun(id)!;
  if (fresh.status === "running" || fresh.status === "recovering") {
    if (by === "pixel") await clientFor(fresh).abort(fresh.session_id!).catch(() => {});
    setRun(id, { status_detail: RESCUE_DETAIL });
    await sendPrompt(getRun(id)!, msg);
  } else {
    // Stopped or paused (say, for the full disk): back to running with the cleanup request.
    await resumeRun(id, msg);
    setRun(id, { status_detail: RESCUE_DETAIL });
  }
  return { size: next, boost: nextBoost };
}

/** Back to the normal disk. */
export async function endBoost(id: string, actor: Actor, message?: string) {
  const run = mustRun(id);
  const boost = boostOf(run);
  if (!boost) return;
  const next = { ...sizeOf(run), diskGiB: boost.baseGiB };
  await apply(run, next, { disk_boost: null, ...clearedDetail(run) });
  timeline(id, actor, "disk", message ?? `Disk back to ${boost.baseGiB} GiB`);
}

/**
 * The watchdog's disk rule, run with each metrics sample of a running run. `stop` stops the run with a
 * reason. Returns true when it acted (the run stopped or a cleanup started), so no other rule runs.
 */
export async function checkDisk(run: RunRow, m: Metrics, s: Settings, stop: (detail: string, message: string) => Promise<void>) {
  const used = m.diskUsed;
  const full = !!used && !!m.diskTotal && (used / m.diskTotal) * 100 >= s.diskFullPercent;
  const boost = boostOf(run);
  if (boost && used != null) {
    const goal = cleanGoal(boost.baseGiB, s);
    if (used <= goal) {
      await endBoost(run.id, "pixel", `Disk cleaned up to ${gib(used)}: back to ${boost.baseGiB} GiB`);
      return false;
    }
    if (full) {
      await endBoost(run.id, "pixel");
      await stop("machine disk full", `Machine disk filled the ${boost.extraGiB} GiB extra too (${gib(used)}): aborted the session and stopped the run (machine kept for inspection)`);
      return true;
    }
    if (Date.now() - boost.at > s.diskRescueMin * 60_000) {
      await endBoost(run.id, "pixel");
      await stop("machine disk full", `Cleanup didn't get the disk under ${gib(goal)} within ${s.diskRescueMin} min (${gib(used)} used): stopped the run`);
      return true;
    }
    return false;
  }
  if (!full) return false;
  if (s.diskRescueGiB > 0 && run.disk_rescues < s.diskRescueMax && run.session_id) {
    const w = getWatcher(run.id);
    const task = () => boostDisk(run.id, "pixel", used);
    await (w ? serial(w, task) : task());
    return true;
  }
  const left = s.diskRescueGiB > 0 ? ` after ${run.disk_rescues} automatic cleanups` : "";
  await stop("machine disk full", `Machine disk at ${((used! / m.diskTotal!) * 100).toFixed(1)}%${left}: aborted the session and stopped the run (machine kept for inspection)`);
  return true;
}
