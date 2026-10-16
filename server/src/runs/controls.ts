/** Manual controls: everything Pixel does automatically, plus more, triggered from the dashboard or CLI. */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { ACTIVE_STATUSES, db, getRun, type RunRow } from "../db.ts";
import { getSettings } from "../settings.ts";
import { publish } from "../bus.ts";
import { runtime } from "../runtime/index.ts";
import { workbasePath, writeIndex, writeTriage } from "../knowledge.ts";
import { clientFor, credsStale, mustRun, mustSession, restartOpencode as restartWithCurrentKeys, setRun, setStatus, timeline } from "./state.ts";
import { unwatch, watch } from "./events.ts";
import { dropArchive } from "../archive.ts";
import { finish, sendPrompt } from "./lifecycle.ts";
import { createRun, prepare } from "./create.ts";

/**
 * Make sure the machine and opencode are up, e.g. to talk to a stopped or done run. An idle agent whose
 * keys changed since opencode started (say, a key that ran out was replaced) gets opencode restarted with the new ones.
 */
async function ensureMachine(run: RunRow) {
  const client = clientFor(run);
  if (await client.healthy()) {
    if (!credsStale(run)) return;
    const busy = (await client.status().catch(() => ({}) as Record<string, unknown>))[run.session_id!];
    if (busy) return;
    timeline(run.id, "user", "restart", "Keys or provider settings changed since opencode started; restarting it to pick them up");
  } else timeline(run.id, "user", "vm", "Starting the machine and opencode");
  await restartWithCurrentKeys(run);
  await client.waitHealthy(180_000);
}

/** Put a non-running run back to running (machine up, watched). */
async function reopen(run: RunRow) {
  if (run.status === "running" || run.status === "recovering") return;
  await ensureMachine(run);
  setStatus(run.id, "running", null, { finished_at: null });
  watch(run.id);
}

export async function sendMessage(id: string, text: string) {
  if (!text?.trim()) throw new Error("empty message");
  const run = mustSession(mustRun(id));
  await reopen(run);
  timeline(id, "user", "message", `You: ${text.slice(0, 300)}`);
  await sendPrompt(getRun(id)!, text);
}

export const continueRun = (id: string) => sendMessage(id, getSettings().continueMessage);

export async function abortRun(id: string) {
  const run = mustSession(mustRun(id));
  setStatus(id, "paused", "Aborted by you");
  timeline(id, "user", "abort", "Aborted the agent's current work; run paused (autopilot won't continue it)");
  await clientFor(run).abort(run.session_id!);
}

export function pauseRun(id: string) {
  mustRun(id);
  setStatus(id, "paused", "Paused by you");
  timeline(id, "user", "pause", "Paused: Pixel won't send automatic continues until resumed");
}

/** Back to running; sends a continue (or `message`) if the agent is idle. */
export async function resumeRun(id: string, message?: string) {
  const run = mustSession(mustRun(id));
  await ensureMachine(run);
  // A resume is a fresh start: otherwise a run stopped after its last automatic continue stops again the moment it idles.
  setStatus(id, "running", null, { finished_at: null, continues: 0 });
  watch(id);
  timeline(id, "user", "resume", run.continues ? `Resumed (automatic continues reset from ${run.continues})` : "Resumed");
  const status = await clientFor(run).status().catch(() => ({}) as Record<string, unknown>);
  if (message || !status[run.session_id!]) await sendPrompt(getRun(id)!, message || getSettings().continueMessage);
}

export async function stopRun(id: string) {
  const run = mustRun(id);
  if (run.session_id && run.endpoint) await clientFor(run).abort(run.session_id).catch(() => {});
  setStatus(id, "stopped", "Stopped by you");
  timeline(id, "user", "stop", "Stopped by you; machine kept");
}

export async function markDone(id: string) {
  mustRun(id);
  timeline(id, "user", "done", "Marked done by you");
  await finish(id);
}

export function retryPrepare(id: string) {
  const run = mustRun(id);
  if (run.status !== "failed") throw new Error("only failed runs can be retried");
  setStatus(id, "preparing");
  timeline(id, "user", "retry", "Retrying preparation");
  void prepare(id);
}

export async function restartOpencode(id: string) {
  const run = mustRun(id);
  timeline(id, "user", "restart", "Restarting opencode");
  await restartWithCurrentKeys(run);
  await clientFor(run).waitHealthy(180_000);
  watch(id);
  timeline(id, "pixel", "restart", "opencode is back (no message sent)");
}

/** Change the model and/or thinking level; both apply from the next message. `variant` "" = the model's default. */
export function setModel(id: string, model?: string, variant?: string | null) {
  const run = mustRun(id);
  const m = model?.trim() || run.model;
  if (!m.includes("/")) throw new Error("model must look like provider/model");
  const v = variant === undefined ? (m === run.model ? run.variant : null) : variant?.trim() || null;
  setRun(id, { model: m, variant: v });
  const label = (mm: string, vv: string | null) => `${mm}${vv ? ` (thinking ${vv})` : ""}`;
  timeline(id, "user", "model", `Model changed from ${label(run.model, run.variant)} to ${label(m, v)} (applies from the next message)`);
}

export function setAutopilot(id: string, on: boolean) {
  mustRun(id);
  setRun(id, { autopilot: on ? 1 : 0 });
  timeline(id, "user", "autopilot", `Autopilot ${on ? "on" : "off"}`);
}

/** Set or clear the display name. Only the dashboard uses it; the id and workbase folder stay the same. */
export function setLabel(id: string, label: unknown) {
  const run = mustRun(id);
  const next = typeof label === "string" ? label.replace(/\s+/g, " ").trim().slice(0, 80) || null : null;
  if (next === run.label) return;
  setRun(id, { label: next });
  timeline(id, "user", "rename", next ? `Renamed to "${next}"` : "Name reset to the run id");
}

export function resetCounters(id: string) {
  mustRun(id);
  setRun(id, { continues: 0, oom_restarts: 0 });
  timeline(id, "user", "counters", "Reset the continue and OOM-restart counters");
}

export async function answerQuestion(id: string, questionId: string, answers: string[][] | null) {
  const client = clientFor(mustSession(mustRun(id)));
  if (answers) await client.replyQuestion(questionId, answers);
  else await client.rejectQuestion(questionId);
  db.query("UPDATE questions SET status = ? WHERE id = ?").run(answers ? "answered" : "rejected", questionId);
  timeline(id, "user", "question", answers ? `Answered: ${answers.map((a) => a.join(", ")).join(" / ")}` : "Dismissed the agent's question");
}

export type VmAction = "start" | "stop" | "snapshot" | "restore";

export async function vmAction(id: string, action: VmAction, snapshot?: string) {
  const run = mustRun(id);
  const active = ACTIVE_STATUSES.includes(run.status);
  switch (action) {
    case "start":
      await runtime.startVm(run);
      timeline(id, "user", "vm", "Machine started");
      return;
    case "stop":
      if (active) setStatus(id, "stopped", "Machine stopped by you");
      await runtime.stopVm(run);
      timeline(id, "user", "vm", "Machine stopped");
      return;
    case "snapshot": {
      const name = snapshot || `manual-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await runtime.snapshot(run, name);
      timeline(id, "user", "vm", `Snapshot ${name} taken`);
      return;
    }
    case "restore":
      if (!snapshot) throw new Error("which snapshot?");
      if (active) setStatus(id, "stopped", `Restored snapshot ${snapshot}`);
      await runtime.restore(run, snapshot);
      timeline(id, "user", "vm", `Restored snapshot ${snapshot} (the workbase on the host is not affected)`);
      return;
  }
}

export async function deleteMachine(id: string) {
  const run = mustRun(id);
  unwatch(id);
  if (ACTIVE_STATUSES.includes(run.status)) setStatus(id, "stopped", "Machine deleted");
  await runtime.destroy(run);
  setRun(id, { endpoint: null });
  timeline(id, "pixel", "vm", "Machine deleted; workbase kept");
}

/** Save triage notes (→ TRIAGE.md; the run's result comes from its finding verdicts); optionally mark triaged, which deletes the machine. */
export async function triage(id: string, notes: string | null, markTriaged: boolean, keepVm = false) {
  mustRun(id);
  setRun(id, { triage_notes: notes || null });
  writeTriage(getRun(id)!);
  timeline(id, "user", "triage", "Triage notes saved");
  if (!markTriaged) return;
  setStatus(id, "triaged", null, { triaged_at: Date.now() });
  timeline(id, "user", "triage", "Marked triaged");
  unwatch(id);
  if (!keepVm) await deleteMachine(id).catch((e) => timeline(id, "pixel", "vm", `Deleting the machine failed: ${e.message}`));
}

/** Delete a run. The workbase (shared knowledge) is kept unless asked. */
export async function deleteRun(id: string, deleteWorkbase: boolean) {
  const run = mustRun(id);
  unwatch(id);
  await runtime.destroy(run).catch((e) => console.error("destroy failed", e));
  db.query("DELETE FROM runs WHERE id = ?").run(id);
  if (deleteWorkbase) {
    rmSync(workbasePath(id), { recursive: true, force: true });
    rmSync(join(config.historyDir, `${id}.git`), { recursive: true, force: true });
  }
  rmSync(join(config.transcriptsDir, `${id}.json`), { force: true });
  dropArchive(id);
  writeIndex();
  publish("*", "run.deleted", { id });
}

/** New run with the same settings; `asFollowUp` offers this run's workbase to the new one. */
export function rerun(id: string, opts: { asFollowUp?: boolean; model?: string; templateVersion?: number } = {}) {
  const run = mustRun(id);
  return createRun({
    repo: run.repo,
    ref: run.ref ?? undefined,
    templateId: run.template_id!,
    templateVersion: opts.templateVersion,
    model: opts.model || run.model,
    variant: opts.model && opts.model !== run.model ? undefined : (run.variant ?? undefined),
    size: JSON.parse(run.size),
    parentRun: opts.asFollowUp ? run.id : undefined,
    autopilot: !!run.autopilot,
    keyId: !opts.model || opts.model.split("/")[0] === run.model.split("/")[0] ? (run.key_id ?? undefined) : undefined,
    keyFailover: !!run.key_failover,
  });
}
