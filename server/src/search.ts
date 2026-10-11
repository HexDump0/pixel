/** Full-text index over all workbases, for the dashboard (agents use grep). */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { db } from "./db.ts";

const MAX_FILE = 512 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", ".pixel"]);

function* walk(dir: string, base: string): Generator<{ rel: string; full: string }> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(full, base);
    } else if (e.isFile()) {
      yield { rel: full.slice(base.length + 1), full };
    }
  }
}

const upsertMeta = db.query("INSERT INTO files_index (run_id, path, mtime, size) VALUES (?, ?, ?, ?) ON CONFLICT(run_id, path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size");
const delFts = db.query("DELETE FROM files_fts WHERE run_id = ? AND path = ?");
const insFts = db.query("INSERT INTO files_fts (run_id, path, content) VALUES (?, ?, ?)");
const delMeta = db.query("DELETE FROM files_index WHERE run_id = ? AND path = ?");

/** Re-index files whose mtime changed. Cheap enough to run every minute. */
export function indexWorkbases() {
  let changed = 0;
  let runDirs: string[];
  try {
    runDirs = readdirSync(config.workbasesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return 0;
  }
  for (const runId of runDirs) {
    const base = join(config.workbasesDir, runId);
    const known = new Map(
      db.query<{ path: string; mtime: number }, [string]>("SELECT path, mtime FROM files_index WHERE run_id = ?").all(runId).map((r) => [r.path, r.mtime]),
    );
    const seen = new Set<string>();
    const tx = db.transaction(() => {
      for (const { rel, full } of walk(base, base)) {
        seen.add(rel);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        const mtime = Math.floor(st.mtimeMs);
        if (known.get(rel) === mtime) continue;
        upsertMeta.run(runId, rel, mtime, st.size);
        delFts.run(runId, rel);
        if (st.size <= MAX_FILE) {
          const buf = readFileSync(full);
          if (!buf.subarray(0, 8000).includes(0)) insFts.run(runId, rel, buf.toString("utf8"));
        }
        changed++;
      }
      for (const path of known.keys()) {
        if (!seen.has(path)) {
          delMeta.run(runId, path);
          delFts.run(runId, path);
          changed++;
        }
      }
    });
    tx();
  }
  return changed;
}

export function search(q: string, limit = 50) {
  const query = q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
  if (!query) return [];
  return db
    .query<{ run_id: string; path: string; snippet: string; rank: number }, [string, number]>(
      `SELECT run_id, path, snippet(files_fts, 2, '[[', ']]', ' … ', 24) AS snippet, rank
       FROM files_fts WHERE files_fts MATCH ? ORDER BY rank LIMIT ?`,
    )
    .all(query, limit);
}

export function dropRunIndex(runId: string) {
  db.query("DELETE FROM files_fts WHERE run_id = ?").run(runId);
  db.query("DELETE FROM files_index WHERE run_id = ?").run(runId);
}
