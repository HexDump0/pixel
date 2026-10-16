/**
 * Transcript parts of finished runs move out of SQLite into one gzipped JSONL file per session
 * (transcripts/<run>/<session>.jsonl.gz). Parts are the bulk of the database (tool outputs, file
 * contents the agent read); once a run has been quiet for ARCHIVE_AFTER_MS nobody reads them except
 * the Transcript tab, which reads the file instead. Messages, tool_calls, sessions and the timeline
 * stay, so stats, charts and the Wall are unchanged. Agents never read any of this: their context
 * is opencode's own storage.
 *
 * A run that is resumed later just gets new rows in `parts`; the transcript merges both (the
 * database wins), and the next archive pass folds them into the file.
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip, createGzip } from "node:zlib";
import { once } from "node:events";
import { config } from "./config.ts";
import { ACTIVE_STATUSES, db, getRun } from "./db.ts";

const ARCHIVE_AFTER_MS = 7 * 86_400_000;
const DELETE_CHUNK = 1000;

const runDir = (runId: string) => join(config.transcriptsDir, runId);
const sessionFile = (runId: string, sessionId: string) => join(runDir(runId), `${sessionId}.jsonl.gz`);

/** One part per line: {"m": message id, "p": the part as stored}. */
async function* readLines(file: string): AsyncGenerator<string> {
  const lines = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of lines) if (line) yield line;
}

/** The archived parts of one session with their message ids (none if it was never archived). */
export async function archivedParts(runId: string, sessionId: string): Promise<{ m: string; p: any }[]> {
  const file = sessionFile(runId, sessionId);
  if (!existsSync(file)) return [];
  const out: { m: string; p: any }[] = [];
  for await (const line of readLines(file)) out.push(JSON.parse(line));
  return out;
}

/** Write a session's parts (database rows, then archived ones the database doesn't have) to its file; returns the ids written. */
async function writeSession(runId: string, sessionId: string, upTo: number) {
  mkdirSync(runDir(runId), { recursive: true });
  const file = sessionFile(runId, sessionId);
  const tmp = `${file}.tmp`;
  const gz = createGzip();
  const done = new Promise<void>((resolve, reject) => {
    const out = createWriteStream(tmp);
    out.on("finish", resolve).on("error", reject);
    gz.on("error", reject).pipe(out);
  });
  const write = async (line: string) => {
    if (!gz.write(line + "\n")) await once(gz, "drain");
  };
  const fromDb = new Set<string>();
  const rows = db.query<{ id: string; message_id: string; data: string }, [string, string, number]>("SELECT id, message_id, data FROM parts WHERE session_id = ? AND run_id = ? AND updated_at <= ?");
  for (const r of rows.iterate(sessionId, runId, upTo)) {
    fromDb.add(r.id);
    await write(`{"m":${JSON.stringify(r.message_id)},"p":${r.data}}`);
  }
  if (existsSync(file)) {
    for await (const line of readLines(file)) {
      if (!fromDb.has(JSON.parse(line).p.id)) await write(line);
    }
  }
  gz.end();
  await done;
  renameSync(tmp, file);
  return fromDb.size;
}

/** Move one run's parts to its files. Only rows already written to a file are deleted. */
export async function archiveRun(runId: string) {
  const startedAt = Date.now();
  const sessions = db.query<{ id: string }, [string]>("SELECT id FROM sessions WHERE run_id = ?").all(runId);
  let moved = 0;
  for (const s of sessions) {
    if (!db.query("SELECT 1 FROM parts WHERE session_id = ? AND run_id = ? LIMIT 1").get(s.id, runId)) continue;
    moved += await writeSession(runId, s.id, startedAt);
  }
  // Resumed while we wrote: leave the database alone, the next pass picks it up.
  const run = getRun(runId);
  if (!run || ACTIVE_STATUSES.includes(run.status)) return 0;
  // The marker keeps the tool_calls rows: they stay for stats and charts (see the trigger in db.ts).
  db.query("INSERT OR IGNORE INTO parts_archiving (run_id) VALUES (?)").run(runId);
  try {
    const del = db.query("DELETE FROM parts WHERE rowid IN (SELECT rowid FROM parts WHERE session_id = ? AND run_id = ? AND updated_at <= ? LIMIT ?)");
    for (const s of sessions) {
      while (del.run(s.id, runId, startedAt, DELETE_CHUNK).changes > 0) await Bun.sleep(0);
    }
  } finally {
    db.query("DELETE FROM parts_archiving WHERE run_id = ?").run(runId);
  }
  return moved;
}

/** Runs that are finished, quiet for `quietMs`, and still have parts in the database. */
export function runsToArchive(now: number, quietMs = ARCHIVE_AFTER_MS) {
  const active = ACTIVE_STATUSES.map(() => "?").join(", ");
  return db
    .query<{ id: string }, any[]>(
      `SELECT r.id FROM runs r
       WHERE r.status NOT IN (${active}) AND COALESCE(r.finished_at, r.last_activity, r.started_at, r.created_at) < ?
         AND EXISTS (SELECT 1 FROM sessions s JOIN parts p ON p.session_id = s.id WHERE s.run_id = r.id)`,
    )
    .all(...ACTIVE_STATUSES, now - quietMs)
    .map((r) => r.id);
}

// One pass at a time (the hourly one and the System page's clean-up): two writing the same file would clash.
let queue: Promise<unknown> = Promise.resolve();

/** Archive every run quiet for `quietMs` (a week by default); returns how many parts moved. */
export function archiveOldRuns(quietMs = ARCHIVE_AFTER_MS, onRun?: (id: string, i: number, n: number) => void): Promise<number> {
  const pass = queue.then(async () => {
    const ids = runsToArchive(Date.now(), quietMs);
    let total = 0;
    for (const [i, id] of ids.entries()) {
      onRun?.(id, i, ids.length);
      const t = Date.now();
      const n = await archiveRun(id).catch((e) => (console.error(`archiving ${id} failed`, e), 0));
      if (n) console.log(`archived ${n} transcript parts of ${id} in ${Date.now() - t} ms`);
      total += n;
    }
    return total;
  });
  queue = pass.catch(() => {});
  return pass;
}

export function startArchiving() {
  setTimeout(() => void archiveOldRuns(), 60_000);
  setInterval(() => void archiveOldRuns(), 3_600_000);
}

export const dropArchive = (runId: string) => rmSync(runDir(runId), { recursive: true, force: true });
