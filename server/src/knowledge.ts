/** Workbase folders on the host and the metadata files Pixel keeps in them. */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { config } from "./config.ts";
import { db, listRuns, getRun, type RunRow } from "./db.ts";

export const workbasePath = (runId: string) => join(config.workbasesDir, runId);

/** Resolve a path inside a run's workbase; throws if it would leave the workbase. */
export function safeWorkbasePath(runId: string, rel: string) {
  const base = resolve(workbasePath(runId));
  const full = resolve(base, (rel || "").replace(/^\/+/, ""));
  if (full !== base && !full.startsWith(base + sep)) throw new Error("path is outside the workbase");
  return full;
}

function writeAtomic(path: string, content: string) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function ensureWorkbase(runId: string) {
  mkdirSync(join(workbasePath(runId), ".pixel"), { recursive: true });
}

export function reportPath(runId: string) {
  return join(workbasePath(runId), "REPORT.md");
}

export function hasReport(runId: string) {
  try {
    return statSync(reportPath(runId)).size > 0;
  } catch {
    return false;
  }
}

const SEV_ORDER = ["critical", "high", "medium", "low", "info"];
export interface VerdictCounts {
  real: number;
  not_bug: number;
  duplicate: number;
  realBySeverity: Record<string, number>;
}

/** The human's finding verdicts per run (removed findings left out): what a run's result is made of. */
export function verdictCounts(runId?: string) {
  const rows = db
    .query<{ run_id: string; verdict: string; severity: string | null; n: number }, any[]>(
      `SELECT run_id, verdict, severity, COUNT(*) AS n FROM findings WHERE verdict IS NOT NULL AND removed_at IS NULL ${runId ? "AND run_id = ?" : ""} GROUP BY run_id, verdict, severity`,
    )
    .all(...(runId ? [runId] : []));
  const out: Record<string, VerdictCounts> = {};
  for (const r of rows) {
    const c = (out[r.run_id] ??= { real: 0, not_bug: 0, duplicate: 0, realBySeverity: {} });
    if (r.verdict === "real") {
      c.real += r.n;
      const sev = r.severity ?? "info";
      c.realBySeverity[sev] = (c.realBySeverity[sev] ?? 0) + r.n;
    } else if (r.verdict === "not_bug" || r.verdict === "duplicate") c[r.verdict] += r.n;
  }
  return out;
}

/** A run's result in a few words, from its finding verdicts: "2 real (1 high, 1 low)", "nothing real", or null before any verdict. */
export function outcomeText(c: VerdictCounts | undefined) {
  if (!c || c.real + c.not_bug + c.duplicate === 0) return null;
  if (!c.real) return "nothing real";
  const sev = SEV_ORDER.filter((s) => c.realBySeverity[s]).map((s) => `${c.realBySeverity[s]} ${s}`);
  return `${c.real} real (${sev.join(", ")})`;
}

/** .pixel/run.json: facts about the run, for the user and for other agents browsing workbases. */
export function writeRunJson(run: RunRow) {
  const dir = join(workbasePath(run.id), ".pixel");
  if (!existsSync(dir)) return;
  const info = {
    run: run.id,
    repo: run.repo,
    ref: run.ref,
    commit: run.commit_sha,
    language: run.language,
    model: run.model,
    template: run.template_id ? `${run.template_id}@v${run.template_version}` : null,
    status: run.status,
    started: run.started_at ? new Date(run.started_at).toISOString() : null,
    finished: run.finished_at ? new Date(run.finished_at).toISOString() : null,
    report: hasReport(run.id),
    triage: outcomeText(verdictCounts(run.id)[run.id]),
    follow_up_of: run.parent_run,
  };
  writeAtomic(join(dir, "run.json"), JSON.stringify(info, null, 2) + "\n");
}

/** TRIAGE.md: the user's triage notes and verdicts on findings, so other agents know which findings held up. */
export function writeTriage(run: RunRow) {
  const verdicts = db
    .query<{ id: string; title: string; verdict: string; verdict_note: string | null }, [string]>(
      "SELECT id, title, verdict, verdict_note FROM findings WHERE run_id = ? AND verdict IS NOT NULL ORDER BY CAST(SUBSTR(id, 2) AS INTEGER)",
    )
    .all(run.id);
  if (!run.triage_notes && !run.triage_verdict && !verdicts.length) return;
  const outcome = outcomeText(verdictCounts(run.id)[run.id]);
  const word: Record<string, string> = { real: "real", not_bug: "not a bug", duplicate: "duplicate", needs_work: "needs more work" };
  const lines = [`# Triage of ${run.id}`, "", "Written by the human who reviewed this run's findings and REPORT.md.", ""];
  if (outcome) lines.push(`Result: ${outcome}.`, "");
  // Runs triaged before findings had verdicts carry a typed overall verdict.
  if (run.triage_verdict) lines.push(`Earlier overall verdict: ${run.triage_verdict}`, "");
  if (run.triage_notes) lines.push(run.triage_notes, "");
  if (verdicts.length) {
    lines.push("## Findings", "");
    for (const v of verdicts) lines.push(`- ${v.id} ${v.title}: **${word[v.verdict] ?? v.verdict}**${v.verdict_note ? `. ${v.verdict_note}` : ""}`);
    lines.push("");
  }
  writeAtomic(join(workbasePath(run.id), "TRIAGE.md"), lines.join("\n"));
}

const STATUS_WORD: Record<string, string> = {
  preparing: "starting",
  running: "in progress",
  recovering: "in progress",
  paused: "paused",
  stopped: "stopped early",
  failed: "failed",
  done: "finished",
  triaged: "finished, triaged",
};

/** INDEX.md at the top of /workbases: one line per run. */
export function writeIndex() {
  const runs = listRuns().filter((r) => existsSync(workbasePath(r.id)));
  const verdicts = verdictCounts();
  const rows = runs.map((r) => {
    const cells = [
      r.id,
      r.repo.replace(/\|/g, "\\|"),
      r.language || "?",
      STATUS_WORD[r.status] || r.status,
      r.started_at ? new Date(r.started_at).toISOString().slice(0, 10) : "",
      r.model,
      hasReport(r.id) ? "yes" : "no",
      outcomeText(verdicts[r.id]) ?? r.triage_verdict ?? "",
    ];
    return `| ${cells.join(" | ")} |`;
  });
  const body = [
    "# Workbases",
    "",
    "One folder per audit run. Each has `.pixel/run.json` (facts about the run), usually `REPORT.md` (the agent's final report), `findings/` (one folder per finding: README.md with the details, PoCs next to it), `FINDINGS.md` (an index of those, by state) and sometimes `TRIAGE.md` (a human's verdicts on the findings and the report).",
    "",
    "| Run | Repository | Language | Status | Started | Model | Report | Triage |",
    "|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
  writeAtomic(join(config.workbasesDir, "INDEX.md"), body);
}

export function refreshRunFiles(runId: string) {
  const run = getRun(runId);
  if (!run) return;
  try {
    writeRunJson(run);
    writeIndex();
  } catch (e) {
    console.error("refreshing workbase files failed", e);
  }
}

// ---- file browsing for the dashboard ----

export interface FileEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mtime: number;
}

export function listDir(runId: string, rel: string): FileEntry[] {
  const full = safeWorkbasePath(runId, rel);
  const base = resolve(workbasePath(runId));
  let entries;
  try {
    entries = readdirSync(full, { withFileTypes: true });
  } catch (e) {
    missing(rel, e);
  }
  return entries
    .map((d) => {
      const p = join(full, d.name);
      let st;
      try {
        st = statSync(p);
      } catch {
        return null;
      }
      return { name: d.name, path: p.slice(base.length + 1), dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs };
    })
    .filter((x): x is FileEntry => !!x)
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

/** A missing file named by its workbase path, not the server's (which errors would otherwise show). */
function missing(rel: string, e: any): never {
  if (e?.code === "ENOENT") throw new Error(`no ${rel.replace(/^\/+/, "") || "workbase"} in the workbase`);
  if (e?.code === "ENOTDIR") throw new Error(`${rel} is not a folder in the workbase`);
  if (e?.code === "EISDIR") throw new Error(`${rel} is a folder; list it instead`);
  throw e;
}

export function readWorkbaseFile(runId: string, rel: string, maxBytes = 2_000_000) {
  const full = safeWorkbasePath(runId, rel);
  let st;
  try {
    st = statSync(full);
    if (st.isDirectory()) throw Object.assign(new Error("dir"), { code: "EISDIR" });
  } catch (e) {
    missing(rel, e);
  }
  const buf = readFileSync(full).subarray(0, maxBytes);
  const binary = buf.subarray(0, 8000).includes(0);
  return { size: st.size, mtime: st.mtimeMs, truncated: st.size > maxBytes, binary, content: binary ? "" : buf.toString("utf8") };
}

export function writeWorkbaseFile(runId: string, rel: string, content: string) {
  const full = safeWorkbasePath(runId, rel);
  mkdirSync(resolve(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

/** Total size of a workbase in bytes (stops counting at `stopAt`). */
export function workbaseSize(runId: string, stopAt = Infinity) {
  let total = 0;
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (total > stopAt) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          total += statSync(p).size;
        } catch {}
      }
    }
  };
  walk(workbasePath(runId));
  return total;
}

// ---- language detection from the target's file list ----

const EXT_LANG: Record<string, string> = {
  c: "C", h: "C", cc: "C++", cpp: "C++", cxx: "C++", hpp: "C++", hh: "C++", rs: "Rust", go: "Go", py: "Python",
  js: "JavaScript", mjs: "JavaScript", ts: "TypeScript", tsx: "TypeScript", java: "Java", kt: "Kotlin", rb: "Ruby",
  php: "PHP", cs: "C#", swift: "Swift", m: "Objective-C", zig: "Zig", lua: "Lua", ex: "Elixir", erl: "Erlang",
  scala: "Scala", hs: "Haskell", ml: "OCaml", dart: "Dart", sol: "Solidity", pl: "Perl", sh: "Shell",
};

export function detectLanguage(fileList: string) {
  const counts = new Map<string, number>();
  for (const f of fileList.split("\n")) {
    const ext = f.split(".").pop()?.toLowerCase() ?? "";
    const lang = EXT_LANG[ext];
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
