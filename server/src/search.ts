/**
 * Search over all workbases for the dashboard (agents use grep themselves). Runs ripgrep when someone
 * searches; nothing is indexed in the background. Until 2026-10-16 this was an FTS index rebuilt by a
 * walk of every workbase each minute, which cost far more than the occasional search.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";

const SKIP_DIRS = new Set([".git", "node_modules", ".pixel"]);
const RG = ["--no-ignore", "--hidden", "--ignore-case", "--fixed-strings", "--max-filesize", "512K", ...[...SKIP_DIRS].flatMap((d) => ["--glob", `!${d}`])];

/** Run ripgrep in the workbases folder; stdout lines, or nothing on error or after the timeout. */
async function rg(args: string[], timeoutMs = 10_000): Promise<string[]> {
  const proc = Bun.spawn(["rg", ...RG, ...args], { cwd: config.workbasesDir, stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const out = await new Response(proc.stdout).text();
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** The line around the first match, with every term marked as [[term]]. */
function snippet(line: string, terms: string[]) {
  const lower = line.toLowerCase();
  const at = Math.min(...terms.map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0));
  const from = Math.max(0, at - 80);
  let text = (from ? "... " : "") + line.slice(from, from + 220).trim() + (line.length > from + 220 ? " ..." : "");
  const re = new RegExp(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  return text.replace(re, (m) => `[[${m}]]`);
}

/** Files containing every term (case-insensitive), most recently changed first. */
export async function search(q: string, limit = 50) {
  const terms = [...new Set(q.split(/\s+/).filter(Boolean))].slice(0, 8);
  if (!terms.length) return [];
  // One fast pass per term for the files that contain it; keep the files that contain all of them.
  const sets = await Promise.all(terms.map((t) => rg(["--files-with-matches", "-e", t])));
  let files = sets[0];
  for (const s of sets.slice(1)) {
    const keep = new Set(s);
    files = files.filter((f) => keep.has(f));
  }
  const dated = await Promise.all(files.map(async (f) => ({ f, mtime: (await stat(join(config.workbasesDir, f)).catch(() => null))?.mtimeMs ?? 0 })));
  const top = dated
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((d) => d.f);
  if (!top.length) return [];
  // The first matching line of each file, for the snippet.
  const lines = new Map<string, string>();
  for (const l of await rg(["--json", "--max-count", "1", "--max-columns", "2000", ...terms.flatMap((t) => ["-e", t]), "--", ...top])) {
    const m = JSON.parse(l);
    if (m.type === "match" && !lines.has(m.data.path.text)) lines.set(m.data.path.text, m.data.lines.text ?? "");
  }
  return top.map((f) => {
    const i = f.indexOf("/");
    return { run_id: f.slice(0, i), path: f.slice(i + 1), snippet: snippet(lines.get(f) ?? "", terms) };
  });
}

/** File count, size and last change of every workbase; walked when asked (the Knowledge page) and cached briefly. */
let sizes: { at: number; value: Promise<Map<string, { files: number; bytes: number; last: number }>> } | null = null;
export function workbaseSizes() {
  if (!sizes || Date.now() - sizes.at > 30_000) sizes = { at: Date.now(), value: walkSizes() };
  return sizes.value;
}

async function walkSizes() {
  const out = new Map<string, { files: number; bytes: number; last: number }>();
  const runs = await readdir(config.workbasesDir, { withFileTypes: true }).catch(() => []);
  for (const r of runs) {
    if (!r.isDirectory()) continue;
    const s = { files: 0, bytes: 0, last: 0 };
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) await walk(full);
        } else if (e.isFile()) {
          const st = await stat(full).catch(() => null);
          if (!st) continue;
          s.files++;
          s.bytes += st.size;
          s.last = Math.max(s.last, Math.floor(st.mtimeMs));
        }
      }
    };
    await walk(join(config.workbasesDir, r.name));
    if (s.files) out.set(r.name, s);
  }
  return out;
}
