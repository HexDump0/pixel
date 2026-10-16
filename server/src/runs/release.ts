/**
 * Freeing the memory of runs that wait on you (user's rules, 2026-10-16): a run paused or stopped
 * for `releaseIdleMin` gets its opencode stopped. Processes the agent left running (fuzzers, test
 * servers) keep running on the process runtimes; an Incus VM stops whole. Nothing else changes: a
 * resume or a message starts opencode again on the same session (controls.ensureMachine). Runs
 * waiting on an answer to a question are "running" and never released.
 */
import { listRuns } from "../db.ts";
import { getSettings } from "../settings.ts";
import { runtime } from "../runtime/index.ts";
import { clientFor, mustRun, setRun, timeline, type Actor } from "./state.ts";
import { unwatch } from "./events.ts";

const RELEASABLE = ["paused", "stopped"];
export const canRelease = (r: { status: string; asleep: number; endpoint: string | null }) => RELEASABLE.includes(r.status) && !r.asleep && !!r.endpoint;

/** Stop the run's opencode. Returns false (and does nothing) while the agent is still finishing a step. */
export async function releaseRun(id: string, actor: Actor = "user", why = "") {
  const run = mustRun(id);
  if (!canRelease(run)) throw new Error("only paused or stopped runs with a machine can free their memory");
  // Pausing doesn't interrupt the step in progress; let it finish first.
  if (run.session_id) {
    const status = await clientFor(run)
      .status()
      .catch(() => ({}) as Record<string, unknown>);
    if (status[run.session_id]) return false;
  }
  unwatch(id);
  await runtime.release(run);
  setRun(id, { asleep: 1 });
  timeline(id, actor, "sleep", `Freed memory: opencode stopped${why ? ` ${why}` : ""}; it starts again on resume or a message`);
  return true;
}

let releasing = false;
export async function releaseIdle(now = Date.now()) {
  const min = getSettings().releaseIdleMin;
  if (min <= 0 || releasing) return;
  releasing = true;
  try {
    for (const run of listRuns()) {
      if (!canRelease(run) || now - (run.status_at ?? run.last_activity ?? run.created_at) < min * 60_000) continue;
      await releaseRun(run.id, "pixel", `after ${min} min ${run.status}`).catch((e) => console.error(`freeing ${run.id} failed`, e));
    }
  } finally {
    releasing = false;
  }
}
