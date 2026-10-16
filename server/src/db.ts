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

-- Workbase search index, replaced by ripgrep on demand (2026-10-16, search.ts).
DROP TABLE IF EXISTS files_fts;
DROP TABLE IF EXISTS files_index;

-- PROGRESS.md versions, from before findings replaced it (2026-10-15).
DROP TABLE IF EXISTS progress;

-- Findings the agent keeps in the workbase (findings/F<n>-name/README.md, see findings.ts), synced from
-- those files. The verdict columns are the human's and never come from the files.
CREATE TABLE IF NOT EXISTS findings (
  run_id         TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  id             TEXT NOT NULL,                  -- F1, F2, … per run
  state          TEXT NOT NULL,                  -- lead | suspected | confirmed | ruled_out
  severity       TEXT,                           -- critical | high | medium | low | info
  title          TEXT NOT NULL,
  class          TEXT,
  location       TEXT,
  poc            TEXT,
  summary        TEXT NOT NULL DEFAULT '',
  created        INTEGER NOT NULL,
  updated        INTEGER NOT NULL,
  session_id     TEXT,                           -- last writer
  removed_at     INTEGER,
  removed_reason TEXT,
  duplicate_of   TEXT,
  verdict        TEXT,                           -- real | not_bug | duplicate (older rows: needs_work)
  verdict_note   TEXT,
  verdict_at     INTEGER,
  PRIMARY KEY (run_id, id)
);
CREATE INDEX IF NOT EXISTS findings_updated ON findings(updated);

CREATE TABLE IF NOT EXISTS finding_events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  finding_id TEXT NOT NULL,
  at         INTEGER NOT NULL,
  action     TEXT NOT NULL,                      -- add | update | remove | verdict
  changes    TEXT,                               -- JSON {field: [old, new]}
  note       TEXT,
  session_id TEXT,
  UNIQUE (run_id, finding_id, at, action)
);
CREATE INDEX IF NOT EXISTS finding_events_run ON finding_events(run_id, at);
CREATE INDEX IF NOT EXISTS finding_events_at ON finding_events(at);

-- "Copy for LLM" download tokens: each lets its holder download one finding's files until it expires.
CREATE TABLE IF NOT EXISTS share_tokens (
  hash       TEXT PRIMARY KEY,                   -- sha256 of the token; the token itself is only in the copied text
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  finding_id TEXT NOT NULL,
  created    INTEGER NOT NULL,
  expires    INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX IF NOT EXISTS share_tokens_finding ON share_tokens(run_id, finding_id);
`);

// Columns added after the first release: add them to existing databases.
for (const [table, column, type] of [["runs", "variant", "TEXT"], ["runs", "creds_hash", "TEXT"], ["runs", "label", "TEXT"], ["runs", "key_id", "TEXT"], ["runs", "key_failover", "INTEGER NOT NULL DEFAULT 1"], ["runs", "hue", "INTEGER"], ["findings", "path", "TEXT"], ["findings", "problem", "TEXT"]] as const) {
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
// Columns no longer used: runs.progress_at (PROGRESS.md, replaced by findings on 2026-10-15).
if (db.query<{ name: string }, []>("PRAGMA table_info(runs)").all().some((c) => c.name === "progress_at")) db.exec("ALTER TABLE runs DROP COLUMN progress_at");

// Messages by run (run detail's cache totals, a run's whole-life series); added 2026-10-16.
db.exec("CREATE INDEX IF NOT EXISTS messages_run ON messages(run_id, created_at)");

/*
 * Tool calls: the few fields the dashboard needs from each tool part, kept in step with `parts` by
 * triggers. Reading `parts` itself means parsing every call's full JSON (outputs included) and,
 * without an index on run, scanning the whole table; the fleet snapshot did that several times
 * per run for every open tab. `args` holds only the inputs describeCall() looks at.
 */
const hadToolCalls = !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tool_calls'").get();
db.exec(`
CREATE TABLE IF NOT EXISTS tool_calls (
  id          TEXT PRIMARY KEY,               -- the part id
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  tool        TEXT,
  status      TEXT,
  started     INTEGER NOT NULL,               -- state.time.start, else when the part was stored
  ended       INTEGER,
  child       TEXT,                           -- task calls: the subagent's session
  interrupted INTEGER NOT NULL DEFAULT 0,
  args        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_calls_run ON tool_calls(run_id, updated_at);
CREATE INDEX IF NOT EXISTS tool_calls_session ON tool_calls(session_id, updated_at);
CREATE INDEX IF NOT EXISTS tool_calls_updated ON tool_calls(updated_at);
CREATE INDEX IF NOT EXISTS tool_calls_child ON tool_calls(run_id, updated_at) WHERE child IS NOT NULL;
-- Runs whose parts are being moved to transcript files (archive.ts): their tool_calls rows stay.
CREATE TABLE IF NOT EXISTS parts_archiving (run_id TEXT PRIMARY KEY);
`);
/** The tool_calls row for parts row `p` (NEW in a trigger, the table alias in the backfill). */
const toolCallRow = (p: string) => {
  const j = (path: string) => `json_extract(${p}.data, '$.${path}')`;
  const args = ["command", "description", "filePath", "offset", "pattern", "path", "url"].map((k) => `'${k}', substr(${j(`state.input.${k}`)}, 1, 2000)`).join(", ");
  return `SELECT ${p}.id, ${p}.run_id, ${p}.session_id, ${p}.message_id, ${j("tool")}, ${j("state.status")},
    COALESCE(${j("state.time.start")}, ${p}.updated_at), ${j("state.time.end")},
    CASE ${j("tool")} WHEN 'task' THEN COALESCE(${j("state.metadata.sessionId")}, ${j("state.input.task_id")}) END,
    COALESCE(${j("state.metadata.interrupted")} = 1, 0) OR COALESCE(${j("state.error")} LIKE '%abort%', 0),
    json_object(${args}, 'title', substr(${j("state.title")}, 1, 2000)), ${p}.updated_at`;
};
// Recreated on every start so a change to toolCallRow reaches existing databases. Delete-then-insert rather than
// INSERT OR REPLACE: an outer upsert's conflict policy would override the trigger's.
db.exec(`
DROP TRIGGER IF EXISTS tool_calls_insert;
DROP TRIGGER IF EXISTS tool_calls_update;
DROP TRIGGER IF EXISTS tool_calls_delete;
CREATE TRIGGER tool_calls_insert AFTER INSERT ON parts WHEN NEW.type = 'tool' AND json_valid(NEW.data) BEGIN
  DELETE FROM tool_calls WHERE id = NEW.id;
  INSERT INTO tool_calls ${toolCallRow("NEW")};
END;
CREATE TRIGGER tool_calls_update AFTER UPDATE ON parts WHEN NEW.type = 'tool' AND json_valid(NEW.data) BEGIN
  DELETE FROM tool_calls WHERE id = NEW.id;
  INSERT INTO tool_calls ${toolCallRow("NEW")};
END;
CREATE TRIGGER tool_calls_delete AFTER DELETE ON parts WHEN OLD.type = 'tool' AND NOT EXISTS (SELECT 1 FROM parts_archiving WHERE run_id = OLD.run_id) BEGIN
  DELETE FROM tool_calls WHERE id = OLD.id;
END;
`);
if (!hadToolCalls) db.exec(`INSERT OR REPLACE INTO tool_calls ${toolCallRow("p")} FROM parts p WHERE p.type = 'tool' AND json_valid(p.data)`);

/*
 * Prompt tokens per run (uncached input, cache reads, cache writes) from its assistant messages, kept
 * by triggers. The run view asks for these after every message; summing every message each time
 * grew with the run's length.
 */
const hadMessageTotals = !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message_totals'").get();
const tok = (row: string, path: string) => `COALESCE(json_extract(${row}.data, '$.tokens.${path}'), 0)`;
const addTotals = (row: string, sign: string) => `
  INSERT INTO message_totals (run_id, input, cache_read, cache_write)
  VALUES (${row}.run_id, ${sign}${tok(row, "input")}, ${sign}${tok(row, "cache.read")}, ${sign}${tok(row, "cache.write")})
  ON CONFLICT(run_id) DO UPDATE SET input = input + excluded.input, cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write;`;
db.exec(`
CREATE TABLE IF NOT EXISTS message_totals (
  run_id      TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  input       INTEGER NOT NULL DEFAULT 0,
  cache_read  INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0
);
DROP TRIGGER IF EXISTS message_totals_insert;
DROP TRIGGER IF EXISTS message_totals_update;
DROP TRIGGER IF EXISTS message_totals_delete;
CREATE TRIGGER message_totals_insert AFTER INSERT ON messages WHEN NEW.role = 'assistant' AND json_valid(NEW.data) BEGIN ${addTotals("NEW", "")} END;
CREATE TRIGGER message_totals_update AFTER UPDATE OF data ON messages WHEN NEW.role = 'assistant' AND json_valid(OLD.data) AND json_valid(NEW.data) BEGIN
  ${addTotals("OLD", "-")}
  ${addTotals("NEW", "")}
END;
-- Only an update here: when a run is deleted its messages go with it, and inserting a row for the gone run would fail the delete.
CREATE TRIGGER message_totals_delete AFTER DELETE ON messages WHEN OLD.role = 'assistant' AND json_valid(OLD.data) BEGIN
  UPDATE message_totals SET input = input - ${tok("OLD", "input")}, cache_read = cache_read - ${tok("OLD", "cache.read")}, cache_write = cache_write - ${tok("OLD", "cache.write")}
  WHERE run_id = OLD.run_id;
END;
`);
if (!hadMessageTotals)
  db.exec(`INSERT INTO message_totals (run_id, input, cache_read, cache_write)
    SELECT m.run_id, SUM(${tok("m", "input")}), SUM(${tok("m", "cache.read")}), SUM(${tok("m", "cache.write")})
    FROM messages m WHERE m.role = 'assistant' AND json_valid(m.data) AND m.run_id IN (SELECT id FROM runs) GROUP BY m.run_id`);

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
  /** Colour of the run on every chart and tile (0–5), picked at creation so runs live at the same time differ. */
  hue: number | null;
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

const HUES = 6;

/** A colour for a run created now: the next one in turn, skipping colours that live runs already have. */
export function pickHue() {
  const all = db.query<{ hue: number | null; status: RunStatus }, []>("SELECT hue, status FROM runs").all();
  const used = new Set(all.filter((r) => ACTIVE_STATUSES.includes(r.status) && r.hue != null).map((r) => r.hue));
  const start = all.length % HUES;
  for (let k = 0; k < HUES; k++) if (!used.has((start + k) % HUES)) return (start + k) % HUES;
  return start;
}

/** Runs from before colours were stored: the same rule, replayed in creation order against the runs alive at the time. */
function backfillHues() {
  const all = db.query<{ id: string; hue: number | null; created_at: number; finished_at: number | null }, []>("SELECT id, hue, created_at, finished_at FROM runs ORDER BY created_at").all();
  if (!all.some((r) => r.hue == null)) return;
  all.forEach((r, i) => {
    if (r.hue != null) return;
    const used = new Set(all.slice(0, i).filter((o) => o.hue != null && (o.finished_at == null || o.finished_at > r.created_at)).map((o) => o.hue));
    const start = i % HUES;
    let hue = start;
    for (let k = 0; k < HUES; k++) if (!used.has((start + k) % HUES)) {
      hue = (start + k) % HUES;
      break;
    }
    r.hue = hue;
    db.query("UPDATE runs SET hue = ? WHERE id = ?").run(hue, r.id);
  });
}
backfillHues();

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

export function addTimeline(runId: string, actor: "pixel" | "user" | "agent", kind: string, message: string, data?: unknown, ts = Date.now()) {
  const res = db
    .query("INSERT INTO timeline (run_id, ts, actor, kind, message, data) VALUES (?, ?, ?, ?, ?, ?)")
    .run(runId, ts, actor, kind, message, data === undefined ? null : JSON.stringify(data));
  return { id: Number(res.lastInsertRowid), run_id: runId, ts, actor, kind, message, data };
}
