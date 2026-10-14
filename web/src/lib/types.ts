/** Shapes returned by the Pixel API. Server-side types are reused where they exist. */
import type { PublicRun } from "../../../server/src/runs/state.ts";
import type { Settings } from "../../../server/src/settings.ts";
import type { AgentPaths } from "../../../server/src/runtime/types.ts";
import type { Activity, FleetRun, FleetSnapshot, Lanes, RecentActivity } from "../../../server/src/fleet.ts";
import type { Leaderboard, ProviderHealth } from "../../../server/src/providers.ts";
import type { Stats } from "../../../server/src/stats.ts";
import type { CatalogList, CatalogModel, CatalogProvider } from "../../../server/src/catalog.ts";
import type { ConnectedProvider, PublicKey } from "../../../server/src/providerAccounts.ts";

export type { Settings, AgentPaths, Activity, FleetRun, FleetSnapshot, Lanes, RecentActivity, Leaderboard, ProviderHealth, Stats };
export type { CatalogList, CatalogModel, CatalogProvider, ConnectedProvider, PublicKey };

export interface SpeedTestRow {
  id: number;
  batch: string;
  ts: number;
  provider: string;
  model: string;
  ttft_ms: number | null;
  total_ms: number | null;
  tokens_out: number | null;
  tps: number | null;
  ok: number;
  error: string | null;
}

export type Run = PublicRun & { questions?: number; cross_reads?: number };
export type RunStatus = Run["status"];

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled" | string;
  priority: string;
}

export interface Question {
  id: string;
  sessionID: string;
  questions: { question: string; header: string; options: { label: string; description?: string }[]; multiple?: boolean; custom?: boolean }[];
  status: "pending" | "answered" | "rejected";
  created_at: number;
}

export interface SessionRow {
  id: string;
  parent_id: string | null;
  title: string | null;
  agent: string | null;
  cost: number;
  tokens: string;
  created_at: number;
}

export interface RunDetail {
  run: Run;
  prompt: string | null;
  sessions: SessionRow[];
  todos: { session_id: string; todos: Todo[] }[];
  questions: Question[];
  paths: AgentPaths;
  attach: string | null;
  shell: string | null;
  watching: boolean;
  report: boolean;
  compare: string[];
  followUps: string[];
}

/** opencode message part (only the fields the dashboard reads). */
export interface Part {
  id: string;
  messageID: string;
  sessionID: string;
  type: "text" | "reasoning" | "tool" | "step-start" | "step-finish" | "patch" | "file" | "agent" | "subtask" | string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: { status: "pending" | "running" | "completed" | "error"; input?: any; output?: string; title?: string; error?: string; metadata?: any; time?: { start: number; end?: number } };
  [k: string]: unknown;
}

export interface Message {
  info: { id: string; sessionID: string; role: "user" | "assistant"; time: { created: number; completed?: number }; modelID?: string; providerID?: string; agent?: string; cost?: number; tokens?: any; error?: { name: string; data?: any } };
  parts: Part[];
}

/** PROGRESS.md: the agent's status notes for the human, with every version Pixel saw. */
export interface Progress {
  content: string | null;
  updated_at: number | null;
  /** Newest first; added/removed lines vs the version before. */
  versions: { ts: number; added: number; removed: number }[];
}

/** The whole file at `to`, each line prefixed "+", "-" or " " against `from`. */
export interface ProgressDiff {
  from: number | null;
  to: number | null;
  lines: string[];
}

export interface TimelineEntry {
  id: number;
  run_id: string;
  ts: number;
  actor: "pixel" | "user" | "agent";
  kind: string;
  message: string;
  data: unknown;
}

export interface MetricRow {
  ts: number;
  cpu: number | null;
  mem_used: number | null;
  mem_total: number | null;
  disk_used: number | null;
  disk_total: number | null;
  workbase_bytes: number | null;
  tokens: number | null;
  cost: number | null;
}

export interface FileEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mtime: number;
}

export interface FileContent {
  size: number;
  mtime: number;
  truncated: boolean;
  binary: boolean;
  content: string;
}

export interface HistoryEntry {
  commit: string;
  ts: number;
  message: string;
  stat: string;
}

export interface Template {
  id: string;
  name: string;
  version: number;
  updated_at: number;
  runs: number;
}

export interface TemplateVersion {
  template_id: string;
  version: number;
  body: string;
  note: string | null;
  created_at: number;
  runs?: number;
}

export interface SearchHit {
  run_id: string;
  path: string;
  snippet: string;
}

export interface CrossReadEdge {
  run_id: string;
  other_run: string;
  n: number;
  last: number;
}

export interface WorkbaseInfo {
  run: string;
  files: number;
  bytes: number;
  last: number;
  repo: string | null;
  language: string | null;
  status: RunStatus | null;
  verdict: string | null;
  started_at: number | null;
  model: string | null;
  orphan: boolean;
}

export interface SystemInfo {
  host: { memTotal: number; memFree: number; load: number[]; cpus: number; disk: { total: number; free: number } | null; dataDir: string };
  runtime: Record<string, any>;
  machines: { name: string; status: string; memory?: number; cpu?: string }[];
  committedMemoryGiB: number;
  activeRuns: number;
  backup: { running: boolean; last?: { ts: number; ok: boolean; output: string } };
  dbBytes: number;
  indexedBytes: number;
}
