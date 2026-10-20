/** Run controls shared by tiles, list rows, the run header and the command palette. */
import { api } from "./api.ts";
import { navigate } from "./router.tsx";
import { reloadRuns } from "./runs.ts";
import { toast } from "../components/Toast.tsx";
import type { Run } from "./types.ts";

const done = (msg: string) => () => {
  toast(msg);
  void reloadRuns();
};
const fail = (e: unknown) => toast((e as Error).message ?? String(e), "error");
const runAct = (p: Promise<unknown>, msg: string) => p.then(done(msg), fail);

export const runUrl = (id: string, tab?: string) => `/runs/${encodeURIComponent(id)}${tab ? `#${tab}` : ""}`;
export const openRun = (id: string, tab?: string) => navigate(runUrl(id, tab));

export const act = {
  pause: (id: string) => runAct(api.control(id, "pause"), "Paused"),
  resume: (id: string) => runAct(api.resume(id), "Resumed"),
  stop: (id: string) => {
    if (confirm("Stop this run? The agent is aborted; the machine is kept.")) void runAct(api.control(id, "stop"), "Stopped");
  },
  /** Stop without asking (bulk actions ask once for all). */
  stopNow: (id: string) => runAct(api.control(id, "stop"), "Stopped"),
  retry: (id: string) => runAct(api.control(id, "retry"), "Preparing again"),
  continue: (id: string) => runAct(api.control(id, "continue"), "Sent continue"),
  abort: (id: string) => {
    if (confirm("Abort what the agent is doing right now? The run will be paused.")) void runAct(api.control(id, "abort"), "Aborted");
  },
  restartOpencode: (id: string) => runAct(api.control(id, "restart-opencode"), "opencode restarted"),
  release: (id: string) =>
    api.release(id).then(
      (r) => (toast(r.released ? "Memory freed" : "The agent is still finishing a step; try again in a moment"), void reloadRuns()),
      fail,
    ),
  autopilot: (r: Run) => runAct(api.setAutopilot(r.id, !r.autopilot), r.autopilot ? "Autopilot off" : "Autopilot on"),
  resetCounters: (id: string) => runAct(api.control(id, "reset-counters"), "Counters reset"),
  compact: (id: string) => runAct(api.control(id, "compact"), "Compacting after this turn"),
  markDone: (id: string) => {
    if (confirm("Mark this run done? opencode's machine will be stopped.")) void runAct(api.control(id, "done"), "Marked done");
  },
  rerun: (id: string) => api.rerun(id, {}).then((r) => openRun(r.id), fail),
  followUp: (r: Run) => navigate(`/new?repo=${encodeURIComponent(r.repo)}&parent=${encodeURIComponent(r.id)}${r.ref ? `&ref=${encodeURIComponent(r.ref)}` : ""}`),
  editRetry: (r: Run) => navigate(`/new?repo=${encodeURIComponent(r.repo)}${r.ref ? `&ref=${encodeURIComponent(r.ref)}` : ""}`),
  delete: async (id: string) => {
    if (!confirm(`Delete run ${id}? Its machine is destroyed.`)) return;
    const wb = confirm("Also delete its workbase? (Cancel keeps the workbase as shared knowledge.)");
    await api.deleteRun(id, wb).then(done("Deleted"), fail);
    navigate("/");
  },
  message: (id: string, text: string) => api.message(id, text),
  boostDisk: (id: string) =>
    api.boostDisk(id).then((b) => (toast(`${b.boost.extraGiB} GB extra disk; the agent was asked to clean up`), void reloadRuns()), fail),
  endBoost: (id: string) => runAct(api.endBoost(id), "Disk back to normal"),
};

/** Stopped because the machine disk filled up. */
export const diskFull = (r: Run) => r.status_detail === "machine disk full";

export const canPause = (r: Run) => r.status === "running" || r.status === "recovering";
export const canResume = (r: Run) => r.status === "paused" || r.status === "stopped" || r.status === "done";
export const canStop = (r: Run) => ["running", "recovering", "paused", "preparing"].includes(r.status);
