/** Detect when an agent touches other runs' workbases, from its tool calls. */
import { db } from "./db.ts";
import { publish } from "./bus.ts";

/** Paths in a tool call's input that point into the workbases root. */
function pathsFromTool(tool: string, input: any): string[] {
  if (!input || typeof input !== "object") return [];
  const out: string[] = [];
  for (const k of ["filePath", "path", "file", "directory", "pattern", "include"]) {
    if (typeof input[k] === "string") out.push(input[k]);
  }
  if (tool === "bash" && typeof input.command === "string") out.push(input.command);
  return out;
}

/**
 * Record reads of other workbases. `root` is the workbases path as the agent sees it.
 * Returns the other runs touched ('*' means it looked at the root or INDEX.md).
 */
export function recordCrossReads(runId: string, root: string, tool: string, input: any): string[] {
  const touched = new Set<string>();
  const esc = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${esc}(?:/([^/\\s'"\`;|&)]+))?`, "g");
  for (const text of pathsFromTool(tool, input)) {
    for (const m of text.matchAll(re)) {
      const name = m[1];
      if (!name || name === "INDEX.md" || name === "*") touched.add("*");
      else if (name !== runId) touched.add(name);
    }
  }
  if (!touched.size) return [];
  const ts = Date.now();
  const path = pathsFromTool(tool, input)[0]?.slice(0, 500) ?? null;
  const ins = db.query("INSERT INTO cross_reads (run_id, other_run, tool, path, ts) VALUES (?, ?, ?, ?, ?)");
  for (const other of touched) ins.run(runId, other, tool, path, ts);
  publish("*", "crossread", { run: runId, others: [...touched], tool, ts });
  return [...touched];
}

export function crossReadGraph() {
  return db
    .query<{ run_id: string; other_run: string; n: number; last: number }, []>(
      "SELECT run_id, other_run, COUNT(*) AS n, MAX(ts) AS last FROM cross_reads GROUP BY run_id, other_run ORDER BY n DESC",
    )
    .all();
}

export function crossReadsFor(runId: string) {
  return db
    .query<{ other_run: string; tool: string; path: string | null; ts: number }, [string]>(
      "SELECT other_run, tool, path, ts FROM cross_reads WHERE run_id = ? ORDER BY ts DESC LIMIT 500",
    )
    .all(runId);
}
