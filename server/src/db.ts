import { Database } from "bun:sqlite";
import { config } from "./config.ts";

export const db = new Database(config.dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS runs (
  id               TEXT PRIMARY KEY,           -- also the workbase folder name
  repo             TEXT NOT NULL,
  ref              TEXT,
  commit_sha       TEXT,
  language         TEXT,
  template_id      TEXT,
  template_version INTEGER,
  prompt           TEXT,                       -- the rendered prompt that was sent
  model            TEXT NOT NULL,              -- provider/model
  size             TEXT NOT NULL,              -- JSON {cpu, memoryGiB, diskGiB}
  status           TEXT NOT NULL,              -- see RunStatus
  status_detail    TEXT,
  runtime          TEXT NOT NULL,
  vm_name          TEXT,
  endpoint         TEXT,                       -- opencode base URL
  opencode_password TEXT,
  session_id       TEXT,                       -- root opencode session
  agent_status     TEXT,                       -- busy | idle | retry
  autopilot        INTEGER NOT NULL DEFAULT 1,
  continues        INTEGER NOT NULL DEFAULT 0,
  oom_restarts     INTEGER NOT NULL DEFAULT 0,
  parent_run       TEXT,                       -- re-audit: earlier run whose workbase is offered
  compare_group    TEXT,
  tokens_in        INTEGER NOT NULL DEFAULT 0,
  tokens_out       INTEGER NOT NULL DEFAULT 0,
  tokens_reasoning INTEGER NOT NULL DEFAULT 0,
  tokens_cache     INTEGER NOT NULL DEFAULT 0,
  cost             REAL NOT NULL DEFAULT 0,
  report_ready     INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  started_at       INTEGER,
  finished_at      INTEGER,
  last_activity    INTEGER,
  triaged_at       INTEGER,
  triage_notes     TEXT,
  triage_verdict   TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  parent_id  TEXT,
  title      TEXT,
  agent      TEXT,
  cost       REAL NOT NULL DEFAULT 0,
  tokens     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_run ON sessions(run_id);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  role       TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS messages_created ON messages(created_at);

CREATE TABLE IF NOT EXISTS parts (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  type       TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS parts_message ON parts(message_id);
CREATE INDEX IF NOT EXISTS parts_session ON parts(session_id);

CREATE TABLE IF NOT EXISTS todos (
  session_id TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  data       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  data       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',   -- pending | answered | rejected
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS timeline (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id  TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ts      INTEGER NOT NULL,
  actor   TEXT NOT NULL,                       -- pixel | user | agent
  kind    TEXT NOT NULL,
  message TEXT NOT NULL,
  data    TEXT
);
CREATE INDEX IF NOT EXISTS timeline_run ON timeline(run_id, ts);

CREATE TABLE IF NOT EXISTS metrics (
  run_id    TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ts        INTEGER NOT NULL,
  cpu       REAL,
  mem_used  INTEGER,
  mem_total INTEGER,
  disk_used INTEGER,
  disk_total INTEGER,
  workbase_bytes INTEGER,
  tokens    INTEGER,
  cost      REAL
);
CREATE INDEX IF NOT EXISTS metrics_run ON metrics(run_id, ts);

CREATE TABLE IF NOT EXISTS cross_reads (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  other_run TEXT NOT NULL,                     -- '*' = browsed /workbases or INDEX.md
  tool      TEXT NOT NULL,
  path      TEXT,
  ts        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cross_reads_run ON cross_reads(run_id);

CREATE TABLE IF NOT EXISTS templates (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS template_versions (
  template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  body        TEXT NOT NULL,
  note        TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (template_id, version)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files_index (
  run_id TEXT NOT NULL,
  path   TEXT NOT NULL,
  mtime  INTEGER NOT NULL,
  size   INTEGER NOT NULL,
  PRIMARY KEY (run_id, path)
);
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(run_id UNINDEXED, path, content, tokenize = 'porter unicode61');

-- Every distinct version of a run's PROGRESS.md (the agent's status notes for the human).
CREATE TABLE IF NOT EXISTS progress (
  run_id  TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ts      INTEGER NOT NULL,
  content TEXT NOT NULL,
  added   INTEGER NOT NULL DEFAULT 0,             -- lines added / removed vs the previous version
  removed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, ts)
);
`);

// Columns added after the first release: add them to existing databases.
for (const [table, column, type] of [["runs", "variant", "TEXT"], ["runs", "creds_hash", "TEXT"], ["runs", "label", "TEXT"], ["runs", "key_id", "TEXT"], ["runs", "key_failover", "INTEGER NOT NULL DEFAULT 1"], ["runs", "progress_at", "INTEGER"]] as const) {
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export type RunStatus =
  | "preparing"
  | "running"
  | "recovering"
  | "paused"
  | "stopped"
  | "failed"
  | "done"
  | "triaged";

export const ACTIVE_STATUSES: RunStatus[] = ["preparing", "running", "recovering", "paused"];

export interface RunSize {
  cpu: number;
  memoryGiB: number;
  diskGiB: number;
}

export interface RunRow {
  id: string;
  repo: string;
  ref: string | null;
  commit_sha: string | null;
  language: string | null;
  template_id: string | null;
  template_version: number | null;
  prompt: string | null;
  model: string;
  /** opencode model variant (thinking level), null = the model's default. */
  variant: string | null;
  /** Fingerprint of the keys and provider settings the run's opencode was last started with. */
  creds_hash: string | null;
  /** Display name set by the user; the id (and workbase folder) never changes. */
  label: string | null;
  /** API key (ProviderAccount key id) the run uses for its model's provider; null = the provider's default. */
  key_id: string | null;
  /** 1 = move to the provider's next key when this one runs out or is rejected. */
  key_failover: number;
  /** When PROGRESS.md last changed (as Pixel noticed it), null = never written. */
  progress_at: number | null;
  size: string;
  status: RunStatus;
  status_detail: string | null;
  runtime: string;
  vm_name: string | null;
  endpoint: string | null;
  opencode_password: string | null;
  session_id: string | null;
  agent_status: string | null;
  autopilot: number;
  continues: number;
  oom_restarts: number;
  parent_run: string | null;
  compare_group: string | null;
  tokens_in: number;
  tokens_out: number;
  tokens_reasoning: number;
  tokens_cache: number;
  cost: number;
  report_ready: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  last_activity: number | null;
  triaged_at: number | null;
  triage_notes: string | null;
  triage_verdict: string | null;
}

export const getRun = (id: string) =>
  db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(id);

export const listRuns = () =>
  db.query<RunRow, []>("SELECT * FROM runs ORDER BY created_at DESC").all();

export function updateRun(id: string, fields: Partial<RunRow>) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sql = `UPDATE runs SET ${keys.map((k) => `${k} = $${k}`).join(", ")} WHERE id = $id`;
  const params: Record<string, any> = { $id: id };
  for (const k of keys) params[`$${k}`] = (fields as any)[k];
  db.query(sql).run(params);
}

export function addTimeline(runId: string, actor: "pixel" | "user" | "agent", kind: string, message: string, data?: unknown) {
  const ts = Date.now();
  const res = db
    .query("INSERT INTO timeline (run_id, ts, actor, kind, message, data) VALUES (?, ?, ?, ?, ?, ?)")
    .run(runId, ts, actor, kind, message, data === undefined ? null : JSON.stringify(data));
  return { id: Number(res.lastInsertRowid), run_id: runId, ts, actor, kind, message, data };
}
