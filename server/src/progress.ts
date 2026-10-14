/**
 * PROGRESS.md: the main agent's short status notes for the human (what looks promising, what it is
 * trying, what it has found). Pixel polls the file of every live run, keeps each distinct version,
 * and tells the dashboard when it changes. It is not agent state and Pixel never acts on it.
 */
import { openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import { ACTIVE_STATUSES, db, getRun, listRuns, type RunRow } from "./db.ts";
import { publish } from "./bus.ts";
import { workbasePath } from "./knowledge.ts";
import { setRun, timeline } from "./runs/state.ts";

/** Longer files are cut here: the file is meant to be short, and a runaway one shouldn't flood the UI. */
const MAX_BYTES = 64 * 1024;
/** Versions kept per run; older ones are dropped. */
const MAX_VERSIONS = 300;
/** Finished runs are still checked for a while, in case the last update landed just before the end. */
const AFTER_FINISH_MS = 10 * 60_000;

export const progressPath = (runId: string) => join(workbasePath(runId), "PROGRESS.md");

export interface ProgressVersion {
  ts: number;
  added: number;
  removed: number;
}

function readCapped(path: string, size: number) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(Math.min(size, MAX_BYTES));
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString("utf8");
    return size > MAX_BYTES ? `${text}\n\n… (cut at ${MAX_BYTES / 1024} KB)` : text;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

const latest = (runId: string) =>
  db.query<{ ts: number; content: string }, [string]>("SELECT ts, content FROM progress WHERE run_id = ? ORDER BY ts DESC LIMIT 1").get(runId);

/** Last stat seen per run, so an unchanged file costs one stat per poll. */
const seen = new Map<string, string>();

/** Store PROGRESS.md if it changed since the last stored version. Returns true when it did. */
export function checkProgress(run: RunRow) {
  let st;
  try {
    st = statSync(progressPath(run.id));
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const stamp = `${st.mtimeMs}:${st.size}`;
  if (seen.get(run.id) === stamp) return false;
  seen.set(run.id, stamp);
  const content = st.size ? readCapped(progressPath(run.id), st.size) : "";
  if (content === null) return false;
  const prev = latest(run.id);
  if (prev?.content === content) return false;
  // Two writes in the same millisecond would collide on the key; keep the order strictly increasing.
  const ts = Math.max(Date.now(), (prev?.ts ?? 0) + 1);
  const { added, removed } = diffCounts(prev?.content ?? "", content);
  db.query("INSERT INTO progress (run_id, ts, content, added, removed) VALUES (?, ?, ?, ?, ?)").run(run.id, ts, content, added, removed);
  db.query(`DELETE FROM progress WHERE run_id = ?1 AND ts NOT IN (SELECT ts FROM progress WHERE run_id = ?1 ORDER BY ts DESC LIMIT ${MAX_VERSIONS})`).run(run.id);
  setRun(run.id, { progress_at: ts });
  timeline(run.id, "agent", "progress", prev ? `Updated PROGRESS.md (+${added} −${removed} lines)` : "Wrote PROGRESS.md", { ts, added, removed });
  publish(run.id, "progress", { ts, added, removed });
  return true;
}

/** Poll every live run (and recently finished ones). */
export function checkAllProgress() {
  const now = Date.now();
  for (const r of listRuns()) {
    if (ACTIVE_STATUSES.includes(r.status) || (r.finished_at && now - r.finished_at < AFTER_FINISH_MS)) {
      try {
        checkProgress(r);
      } catch (e) {
        console.error(`progress check ${r.id}`, e);
      }
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startProgressWatch(everyMs = 5000) {
  timer ??= setInterval(checkAllProgress, everyMs);
}
export function stopProgressWatch() {
  if (timer) clearInterval(timer);
  timer = null;
}

// ---- reading ----

export function progressOf(runId: string) {
  const run = getRun(runId);
  if (run) checkProgress(run); // pick up a write the poll hasn't seen yet
  const cur = latest(runId);
  const versions = db.query<ProgressVersion, [string]>("SELECT ts, added, removed FROM progress WHERE run_id = ? ORDER BY ts DESC").all(runId);
  return { content: cur?.content ?? null, updated_at: cur?.ts ?? null, versions };
}

export const progressVersion = (runId: string, ts: number) =>
  db.query<{ ts: number; content: string }, [string, number]>("SELECT ts, content FROM progress WHERE run_id = ? AND ts = ?").get(runId, ts) ?? null;

/** The version stored just before `ts` (null for the first one). */
const previousVersion = (runId: string, ts: number) =>
  db.query<{ ts: number; content: string }, [string, number]>("SELECT ts, content FROM progress WHERE run_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1").get(runId, ts) ?? null;

/**
 * The whole file at `to` with changes since `from` marked (`+` added, `-` removed, ` ` unchanged).
 * `to` defaults to the latest version, `from` to the version before `to`; `from = 0` diffs against nothing.
 */
export function progressDiff(runId: string, from?: number, to?: number) {
  const target = to ? progressVersion(runId, to) : latest(runId);
  if (!target) return null;
  const base = from === 0 ? null : from ? progressVersion(runId, from) : previousVersion(runId, target.ts);
  return { from: base?.ts ?? null, to: target.ts, lines: lineDiff(base?.content ?? "", target.content) };
}

// ---- line diff ----

const split = (s: string) => (s === "" ? [] : s.replace(/\n$/, "").split("\n"));

/** Above this many cells the LCS table gets expensive; fall back to "everything changed". */
const MAX_CELLS = 4_000_000;

/** Full-file line diff (LCS), each line prefixed with "+", "-" or " ". */
export function lineDiff(a: string, b: string): string[] {
  const x = split(a);
  const y = split(b);
  // Common head and tail first: progress files usually change in one or two places.
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head++;
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  const xs = x.slice(head, x.length - tail);
  const ys = y.slice(head, y.length - tail);
  const mid: string[] = [];
  const n = xs.length;
  const m = ys.length;
  if (n * m > MAX_CELLS) {
    mid.push(...xs.map((l) => `-${l}`), ...ys.map((l) => `+${l}`));
  } else {
    // lcs[i][j] = LCS length of xs[i..] and ys[j..]
    const lcs = new Uint32Array((n + 1) * (m + 1));
    const at = (i: number, j: number) => i * (m + 1) + j;
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) lcs[at(i, j)] = xs[i] === ys[j] ? lcs[at(i + 1, j + 1)] + 1 : Math.max(lcs[at(i + 1, j)], lcs[at(i, j + 1)]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && xs[i] === ys[j]) {
        mid.push(` ${xs[i++]}`);
        j++;
      } else if (i < n && (j === m || lcs[at(i + 1, j)] >= lcs[at(i, j + 1)])) mid.push(`-${xs[i++]}`);
      else mid.push(`+${ys[j++]}`);
    }
  }
  return [...x.slice(0, head).map((l) => ` ${l}`), ...mid, ...x.slice(x.length - tail).map((l) => ` ${l}`)];
}

export function diffCounts(a: string, b: string) {
  let added = 0;
  let removed = 0;
  for (const l of lineDiff(a, b)) {
    if (l[0] === "+") added++;
    else if (l[0] === "-") removed++;
  }
  return { added, removed };
}
