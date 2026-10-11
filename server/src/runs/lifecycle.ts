/** What happens when the agent goes idle, finishes, or opencode stops answering (plan.md §5–6). */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { db, getRun, type RunRow } from "../db.ts";
import { getSettings } from "../settings.ts";
import { runtime } from "../runtime/index.ts";
import { hasReport } from "../knowledge.ts";
import { snapshotWorkbase } from "../history.ts";
import { clientFor, notifyRun, setRun, setStatus, timeline } from "./state.ts";
import { syncTranscript, transcript, unwatch } from "./events.ts";

export async function sendPrompt(run: RunRow, text: string) {
  setRun(run.id, { agent_status: "busy", last_activity: Date.now() });
  await clientFor(run).prompt(run.session_id!, text, run.model, run.variant);
}

const pendingQuestions = (runId: string) =>
  db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM questions WHERE run_id = ? AND status = 'pending'").get(runId)!.n;

/** The root session went idle: done if there's a report, otherwise continue (autopilot) or stop. */
export async function onIdle(id: string, source: "event" | "watchdog") {
  const run = getRun(id);
  if (!run || run.status !== "running" || run.agent_status === "idle") return;
  setRun(id, { agent_status: "idle" });
  if (pendingQuestions(id)) return;

  if (hasReport(id)) return finish(id);

  const s = getSettings();
  if (!run.autopilot) {
    setRun(id, { status_detail: "Agent is idle without a report; autopilot is off" });
    timeline(id, "pixel", "idle", "Agent went idle without REPORT.md; autopilot is off, waiting for you");
    notifyRun("stopped", run, "Agent idle", "The agent stopped without writing REPORT.md. Autopilot is off.");
    return;
  }
  if (run.continues >= s.maxAutoContinues) {
    setStatus(id, "stopped", `Agent stopped without a report after ${run.continues} automatic continues`);
    timeline(id, "pixel", "stopped", `Agent went idle without REPORT.md after ${run.continues} automatic continues; stopping`);
    notifyRun("stopped", run, "Run stopped", `The agent stopped without writing REPORT.md after ${run.continues} automatic continues.`);
    return;
  }
  const n = run.continues + 1;
  setRun(id, { continues: n, status_detail: null });
  timeline(id, "pixel", "continue", `Agent went idle without REPORT.md${source === "watchdog" ? " (noticed by the watchdog)" : ""}; sending "${s.continueMessage}" (${n}/${s.maxAutoContinues})`);
  await sendPrompt(getRun(id)!, s.continueMessage);
}

/** Report written: export the transcript, snapshot the workbase, stop (but keep) the machine. */
export async function finish(id: string) {
  const run = setStatus(id, "done", null, { finished_at: Date.now(), report_ready: 1, agent_status: "idle" })!;
  timeline(id, "pixel", "done", "REPORT.md written and the agent is idle: run done");
  notifyRun("done", run, "Run done", `${run.repo}\nREPORT.md is ready.`);
  unwatch(id);
  try {
    exportTranscript(id);
  } catch (e) {
    console.error("transcript export failed", e);
  }
  await snapshotWorkbase(id, "done").catch(() => {});
  try {
    await runtime.stopVm(run);
    timeline(id, "pixel", "vm", "Machine stopped (kept for reproducing findings)");
  } catch (e: any) {
    timeline(id, "pixel", "vm", `Stopping the machine failed: ${e.message}`);
  }
}

export function exportTranscript(id: string) {
  const sessions = db.query<{ id: string; parent_id: string | null; title: string | null }, [string]>("SELECT id, parent_id, title FROM sessions WHERE run_id = ?").all(id);
  const out = sessions.map((s) => ({ ...s, messages: transcript(id, s.id) }));
  writeFileSync(join(config.transcriptsDir, `${id}.json`), JSON.stringify(out));
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
    await runtime.restartOpencode(run);
    await client.waitHealthy(180_000);
    run = setStatus(id, "running")!;
    await syncTranscript(id);
    timeline(id, "pixel", "continue", `opencode is back; sending "${message}"`);
    await sendPrompt(run, message);
  } catch (e: any) {
    stop("recovery failed", `Recovery failed: ${e.message}`);
  }
}
