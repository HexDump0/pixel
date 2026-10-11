import type { RunRow, RunSize } from "../db.ts";

/** Paths as the agent sees them. */
export interface AgentPaths {
  target: string;
  workbases: string;
  workbase: string;
  scratch: string;
}

export interface PrepareOptions {
  run: RunRow;
  size: RunSize;
  /** Host path of this run's workbase. */
  workbaseHostPath: string;
  env: Record<string, string>;
  authJson: string;
  opencodePassword: string;
  log: (msg: string) => void;
}

export interface Prepared {
  vmName: string;
  endpoint: string;
}

export interface Metrics {
  cpu?: number; // percent of one core summed across vCPUs
  memUsed?: number;
  memTotal?: number;
  diskUsed?: number;
  diskTotal?: number;
}

export type OpencodeState = "running" | "oom" | "exited" | "vm-down" | "unknown";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Runtime {
  kind: "incus" | "single" | "local";
  /** Agents are child processes of Pixel and must be started again after Pixel restarts. */
  agentsDieWithPixel?: boolean;
  /** Called when the runtime acts on its own against a run (e.g. kills a process over its memory limit). */
  onLimit?: (runId: string, message: string) => void;
  paths(run: RunRow): AgentPaths;
  /** Create the machine, attach shares, inject secrets, clone the target, start opencode. */
  prepare(opts: PrepareOptions): Promise<Prepared>;
  exec(run: RunRow, cmd: string[], timeoutMs?: number): Promise<ExecResult>;
  /** Why opencode is not answering. */
  opencodeState(run: RunRow): Promise<OpencodeState>;
  /** Start opencode again (after OOM or crash). Starts the VM first if needed. */
  restartOpencode(run: RunRow): Promise<void>;
  metrics(run: RunRow): Promise<Metrics>;
  vmState(run: RunRow): Promise<string>;
  startVm(run: RunRow): Promise<void>;
  stopVm(run: RunRow): Promise<void>;
  snapshot(run: RunRow, name: string): Promise<void>;
  listSnapshots(run: RunRow): Promise<{ name: string; created: string }[]>;
  restore(run: RunRow, name: string): Promise<void>;
  destroy(run: RunRow): Promise<void>;
  /** Process id of the run's opencode, where the runtime knows it (process runtimes). */
  pid?(run: RunRow): number | null;
  /** One line for the prompt's environment section: what the machine is and what the agent may do there. */
  describeMachine(run: RunRow): string;
  /** Shell command the user can run to get a shell in the machine. */
  shellCommand(run: RunRow): string;
  /** All machines Pixel manages, for the system page. */
  listMachines(): Promise<{ name: string; status: string; memory?: number; cpu?: string }[]>;
  info(): Promise<Record<string, unknown>>;
}
