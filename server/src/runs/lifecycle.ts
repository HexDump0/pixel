/** What happens when the agent goes idle, finishes, or opencode stops answering (plan.md §5–6). */
import { db, getRun, type RunRow } from "../db.ts";
import { getSettings } from "../settings.ts";
import { runtime } from "../runtime/index.ts";
import { hasReport } from "../knowledge.ts";
import { snapshotWorkbase } from "../history.ts";
import { clientFor, credsStale, notifyRun, restartOpencode, setRun, setStatus, timeline } from "./state.ts";
import { syncTranscript, transcript, unwatch } from "./events.ts";

/** `delivery`: "steer" (default) goes into the work in progress at its next step, "queue" waits for the turn to end. */
export async function sendPrompt(run: RunRow, text: string, delivery?: "steer" | "queue") {
  setRun(run.id, { agent_status: "busy", last_activity: Date.now(), ...(run.waiting && { waiting: null }) });
  await clientFor(run).prompt(run.session_id!, text, run.model, run.variant, delivery);
}

/** Background work an idle agent is waiting for (opencode wakes it when that ends). */
export interface Waiting {
  since: number;
  subagents: number;
  /** Commands of the shell commands still running, cut short. */
  shells: string[];
  /** When the work was seen to have ended; opencode wakes the agent right after, so Pixel holds off a moment. */
  ended?: number;
}

/** After background work ends, how long opencode gets to wake the agent before Pixel treats it as idle. */
const WAKE_GRACE_MS = 20_000;

export const waitingOf = (run: RunRow): Waiting | null => (run.waiting ? JSON.parse(run.waiting) : null);

const childSessions = (runId: string) =>
  db.query<{ id: string }, [string]>("SELECT id FROM sessions WHERE run_id = ? AND parent_id IS NOT NULL").all(runId).map((r) => r.id);

const pendingQuestions = (runId: string) =>
  db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM questions WHERE run_id = ? AND status = 'pending'").get(runId)!.n;

/**
 * Shell commands the run's agents started in the background: the call returned at once while the command kept
 * running (`background: true`, or moved to the background). Foreground ones belong to a busy session anyway.
 */
const backgroundShells = (runId: string) =>
  new Set(
    db
      .query<{ id: string }, [string]>(
        `SELECT json_extract(p.data, '$.state.metadata.shellID') AS id FROM tool_calls c JOIN parts p ON p.id = c.id
         WHERE c.run_id = ? AND c.tool = 'bash' AND c.status = 'completed' AND json_extract(p.data, '$.state.metadata.status') = 'running'`,
      )
      .all(runId)
      .map((r) => r.id),
  );

/** Tool calls by any of the run's agents since `ts`. */
const callsSince = (runId: string, ts: number) => db.query<{ n: number }, [string, number]>("SELECT COUNT(*) AS n FROM tool_calls WHERE run_id = ? AND started >= ?").get(runId, ts)!.n;

const short = (cmd: string) => {
  const one = cmd.replace(/\s+/g, " ").trim();
  return one.length > 120 ? `${one.slice(0, 117)}...` : one;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function describeWaiting(w: Waiting) {
  const parts = [w.subagents && plural(w.subagents, "subagent"), w.shells.length && `${plural(w.shells.length, "background command")} (${w.shells.slice(0, 3).join("; ")})`].filter(Boolean);
  return parts.join(" and ");
}

/**
 * The root session went idle: done if there's a report; waiting while its subagents or background shell commands
 * still run (opencode wakes the agent when they finish); otherwise continue (autopilot) or stop.
 */
export async function onIdle(id: string, source: "event" | "watchdog") {
  const run = getRun(id);
  if (!run || run.status !== "running" || run.agent_status === "idle" || !run.session_id) return;
  const client = clientFor(run);
  const active = await client.status().catch(() => null);
  // Can't tell what is still running: the watchdog asks again on its next check rather than continuing blind.
  if (!active) return;
  // Busy again (an idle event that waited in the queue behind a restart, a key switch that already sent "continue").
  if (active[run.session_id]) return;
  const subagents = childSessions(id).filter((s) => active[s]).length;
  const running = await client.shells().catch(() => null);
  if (!running) return;
  const launched = running.length ? backgroundShells(id) : new Set<string>();
  const shells = running.filter((x) => launched.has(x.id));
  // Stopped or paused meanwhile (a stop aborts the agent, which is what made it idle): no continue.
  if (getRun(id)?.status !== "running") return;
  const s = getSettings();

  let nudge: Waiting | null = null;
  if (subagents || shells.length) {
    const was = waitingOf(run);
    const w: Waiting = { since: was?.since ?? Date.now(), subagents, shells: shells.map((x) => short(x.command)) };
    if (JSON.stringify(w) !== JSON.stringify(was)) setRun(id, { waiting: JSON.stringify(w) });
    if (!was) timeline(id, "pixel", "wait", `Agent ended its turn with ${describeWaiting(w)} still running; waiting for them (opencode wakes the agent when they finish)`);
    // Subagents are agents at work; only shell commands alone (a server, a fuzzer with no end) get a time limit.
    const limit = s.backgroundWaitMin * 60_000;
    if (subagents || !limit || Date.now() - w.since < limit) return;
    nudge = w;
  } else if (run.waiting) {
    const was = waitingOf(run)!;
    if (!was.ended) return void setRun(id, { waiting: JSON.stringify({ ...was, subagents: 0, shells: [], ended: Date.now() }) });
    if (Date.now() - was.ended < WAKE_GRACE_MS) return;
    setRun(id, { waiting: null });
  }

  setRun(id, { agent_status: "idle", waiting: null });
  if (pendingQuestions(id)) return;

  if (hasReport(id)) return finish(id);

  if (!run.autopilot) {
    setRun(id, { status_detail: "Agent is idle without a report; autopilot is off" });
    timeline(id, "pixel", "idle", "Agent went idle without REPORT.md; autopilot is off, waiting for you");
    notifyRun("stopped", run, "Agent idle", "The agent stopped without writing REPORT.md. Autopilot is off.");
    return;
  }

  if (nudge) {
    const minutes = Math.round((Date.now() - nudge.since) / 60_000);
    const text = s.backgroundWaitMessage.replaceAll("{minutes}", String(minutes)).replaceAll("{commands}", nudge.shells.join("; "));
    timeline(id, "pixel", "nudge", `Background commands still running after ${minutes} min (${nudge.shells.slice(0, 3).join("; ")}); reminding the agent to carry on (not counted)`);
    await sendPrompt(getRun(id)!, text);
    return;
  }

  // Real work since the last automatic continue: the agent isn't stuck, so the count starts over.
  let continues = run.continues;
  if (continues > 0 && s.continueResetCalls > 0 && run.continued_at) {
    const calls = callsSince(id, run.continued_at);
    if (calls >= s.continueResetCalls) {
      timeline(id, "pixel", "reset", `Agent made ${calls} tool calls since the last automatic continue; the count starts over (was ${continues}/${s.maxAutoContinues})`);
      continues = 0;
    }
  }
  if (continues >= s.maxAutoContinues) {
    setStatus(id, "stopped", `Agent stopped without a report after ${continues} automatic continues in a row`, { continues });
    timeline(id, "pixel", "stopped", `Agent went idle without REPORT.md after ${continues} automatic continues with no progress in between; stopping`);
    notifyRun("stopped", run, "Run stopped", `The agent stopped without writing REPORT.md after ${continues} automatic continues in a row.`);
    return;
  }
  // Keys changed while it was busy (a key was replaced or the run moved to another): restart opencode first.
  if (credsStale(run)) {
    timeline(id, "pixel", "restart", "Keys or provider settings changed while the agent was busy; restarting opencode to pick them up");
    await restartOpencode(run);
    await clientFor(run).waitHealthy(180_000);
  }
  const n = continues + 1;
  setRun(id, { continues: n, continued_at: Date.now(), status_detail: null });
  timeline(id, "pixel", "continue", `Agent went idle without REPORT.md${source === "watchdog" ? " (noticed by the watchdog)" : ""}; sending "${s.continueMessage}" (${n}/${s.maxAutoContinues})`);
  await sendPrompt(getRun(id)!, s.continueMessage);
}

/** Report written: export the transcript, snapshot the workbase, stop (but keep) the machine. */
export async function finish(id: string) {
  const run = setStatus(id, "done", null, { finished_at: Date.now(), report_ready: 1, agent_status: "idle" })!;
  timeline(id, "pixel", "done", "REPORT.md written and the agent is idle: run done");
  notifyRun("done", run, "Run done", `${run.repo}\nREPORT.md is ready.`);
  unwatch(id);
  await snapshotWorkbase(id, "done").catch(() => {});
  try {
    await runtime.stopVm(run);
    timeline(id, "pixel", "vm", "Machine stopped (kept for reproducing findings)");
  } catch (e: any) {
    timeline(id, "pixel", "vm", `Stopping the machine failed: ${e.message}`);
  }
}

/** The whole transcript (every session with its messages and parts), for downloading. */
export async function exportTranscript(id: string) {
  const sessions = db.query<{ id: string; parent_id: string | null; title: string | null }, [string]>("SELECT id, parent_id, title FROM sessions WHERE run_id = ? ORDER BY created_at").all(id);
  const out = [];
  for (const s of sessions) out.push({ ...s, messages: await transcript(id, s.id) });
  return out;
}

/** opencode stopped answering: find out why and bring it back with the right message. */
export async function recover(id: string) {
  let run = getRun(id);
  if (!run || !["running", "recovering"].includes(run.status)) return;
  const client = clientFor(run);
  if (await client.healthy()) return;
  const s = getSettings();
  const state = await runtime.opencodeState(run);
  setStatus(id, "recovering", `opencode is not answering (${state})`);
  timeline(id, "pixel", "recover", `opencode is not answering; state: ${state}`);

  const stop = (detail: string, message: string) => {
    const r = setStatus(id, "stopped", detail)!;
    timeline(id, "pixel", "stopped", message);
    notifyRun("stopped", r, `Run stopped: ${detail}`, message);
  };

  let message = s.continueMessage;
  if (state === "oom") {
    if (run.oom_restarts >= s.maxOomRestarts) return stop("out of memory", `opencode was OOM-killed again after ${run.oom_restarts} restarts; stopping`);
    setRun(id, { oom_restarts: run.oom_restarts + 1 });
    message = s.oomMessage;
  } else {
    if (run.continues >= s.maxAutoContinues) return stop(`opencode down (${state})`, `opencode is down (${state}) and the ${s.maxAutoContinues} automatic continues are used up; stopping`);
    setRun(id, { continues: run.continues + 1 });
  }
  try {
    timeline(id, "pixel", "recover", state === "vm-down" ? "Starting the machine and opencode" : "Restarting opencode");
    await restartOpencode(run);
    await client.waitHealthy(180_000);
    run = setStatus(id, "running")!;
    await syncTranscript(id);
    timeline(id, "pixel", "continue", `opencode is back; sending "${message}"`);
    await sendPrompt(run, message);
  } catch (e: any) {
    stop("recovery failed", `Recovery failed: ${e.message}`);
  }
}
