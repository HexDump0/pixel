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
export interface DispositionCounts {
  report: number;
  known: number;
  duplicate: number;
  weak: number;
  invalid: number;
  /** Findings to report, by final severity. */
  reportBySeverity: Record<string, number>;
}

/** The triage per run (removed findings left out): what a run's result is made of. */
export function dispositionCounts(runId?: string) {
  const rows = db
    .query<{ run_id: string; disposition: string; severity: string | null; n: number }, any[]>(
      `SELECT run_id, disposition, COALESCE(severity_final, severity) AS severity, COUNT(*) AS n FROM findings WHERE disposition IS NOT NULL AND removed_at IS NULL ${runId ? "AND run_id = ?" : ""} GROUP BY run_id, disposition, 3`,
    )
    .all(...(runId ? [runId] : []));
  const out: Record<string, DispositionCounts> = {};
  for (const r of rows) {
    const c = (out[r.run_id] ??= { report: 0, known: 0, duplicate: 0, weak: 0, invalid: 0, reportBySeverity: {} });
    if (!(r.disposition in c)) continue;
    c[r.disposition as "report"] += r.n;
    if (r.disposition === "report") {
      const sev = !r.severity || r.severity === "none" ? "info" : r.severity;
      c.reportBySeverity[sev] = (c.reportBySeverity[sev] ?? 0) + r.n;
    }
  }
  return out;
}

/** A run's result in a few words, from its triage: "2 to report (1 high, 1 low)", "nothing to report", or null before any. */
export function outcomeText(c: DispositionCounts | undefined) {
  if (!c || c.report + c.known + c.duplicate + c.weak + c.invalid === 0) return null;
  if (!c.report) return "nothing to report";
  const sev = SEV_ORDER.filter((s) => c.reportBySeverity[s]).map((s) => `${c.reportBySeverity[s]} ${s}`);
  return `${c.report} to report (${sev.join(", ")})`;
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
    triage: outcomeText(dispositionCounts(run.id)[run.id]),
    follow_up_of: run.parent_run,
  };
  writeAtomic(join(dir, "run.json"), JSON.stringify(info, null, 2) + "\n");
}

const DISPOSITION_TEXT: Record<string, string> = {
  report: "report: a real, novel bug to disclose",
  known: "known: already public",
  duplicate: "duplicate: same root cause as another finding",
  weak: "weak: real, but the preconditions or impact don't justify a disclosure",
  invalid: "invalid: not a bug",
};
const DISCLOSURE_TEXT: Record<string, string> = { reported: "reported upstream", fixed: "fixed upstream", dropped: "disclosure dropped" };

type TriagedRow = {
  run_id: string;
  id: string;
  title: string;
  location: string | null;
  severity: string | null;
  severity_final: string | null;
  disposition: string;
  disposition_note: string | null;
  duplicate_of: string | null;
  disclosure: string | null;
  path: string | null;
  repo: string | null;
};
const TRIAGED_SQL = `SELECT f.run_id, f.id, f.title, f.location, f.severity, f.severity_final, f.disposition, f.disposition_note, f.duplicate_of, f.disclosure, f.path, r.repo
  FROM findings f LEFT JOIN runs r ON r.id = f.run_id WHERE f.disposition IS NOT NULL AND f.removed_at IS NULL`;

/** "report, medium (agent: high), fixed upstream" */
function triageLine(v: TriagedRow) {
  const sev = v.severity_final && v.severity_final !== v.severity ? `${v.severity_final === "none" ? "no impact" : v.severity_final} (agent: ${v.severity ?? "none"})` : v.severity;
  return [v.disposition === "duplicate" && v.duplicate_of ? `duplicate of ${v.duplicate_of}` : v.disposition, sev, v.disposition === "report" && v.disclosure && DISCLOSURE_TEXT[v.disclosure]].filter(Boolean).join(", ");
}
const oneLine = (s: string | null, max = 300) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** TRIAGE.md: the user's triage notes and the triage of each finding, so other agents know which findings held up. */
export function writeTriage(run: RunRow) {
  const rows = db.query<TriagedRow, [string]>(`${TRIAGED_SQL} AND f.run_id = ? ORDER BY CAST(SUBSTR(f.id, 2) AS INTEGER)`).all(run.id);
  const path = join(workbasePath(run.id), "TRIAGE.md");
  if (!run.triage_notes && !run.triage_verdict && !rows.length) {
    // Nothing left to say (the last triage was cleared): an old file would say otherwise.
    if (existsSync(path)) writeAtomic(path, `# Triage of ${run.id}\n\nNothing triaged.\n`);
    return;
  }
  const outcome = outcomeText(dispositionCounts(run.id)[run.id]);
  const lines = [`# Triage of ${run.id}`, "", "Written by the human who reviewed this run's findings and REPORT.md.", ""];
  if (outcome) lines.push(`Result: ${outcome}.`, "");
  // Runs triaged before findings had verdicts carry a typed overall verdict.
  if (run.triage_verdict) lines.push(`Earlier overall verdict: ${run.triage_verdict}`, "");
  if (run.triage_notes) lines.push(run.triage_notes, "");
  if (rows.length) {
    lines.push("## Findings", "", ...Object.values(DISPOSITION_TEXT).map((t) => `- ${t}`), "");
    for (const v of rows) lines.push(`- ${v.id} ${v.title}: **${triageLine(v)}**${v.disposition_note ? `. ${oneLine(v.disposition_note, 2000)}` : ""}`);
    lines.push("");
  }
  writeAtomic(path, lines.join("\n"));
}

/**
 * TRIAGED.md at the top of /workbases: every triaged finding across runs, grouped by repository, so an agent can
 * check whether a bug it found was already reported, known, or judged weak or invalid before writing it up.
 */
export function writeTriaged() {
  if (!existsSync(config.workbasesDir)) return;
  const rows = db.query<TriagedRow, []>(`${TRIAGED_SQL} ORDER BY r.repo, f.run_id, CAST(SUBSTR(f.id, 2) AS INTEGER)`).all();
  const byRepo = new Map<string, TriagedRow[]>();
  for (const r of rows) byRepo.set(r.repo ?? "unknown", [...(byRepo.get(r.repo ?? "unknown") ?? []), r]);
  const cell = (s: string | null) => oneLine(s, 400).replace(/\|/g, "\\|");
  const lines = [
    "# Triaged findings",
    "",
    "Written by Pixel: every finding a human has triaged, across all runs, by repository. Before writing up a bug as new, look for its project here and compare the sink and the preconditions. The finding column links to its README (relative to this folder).",
    "",
    ...Object.values(DISPOSITION_TEXT).map((t) => `- ${t}`),
    "",
    "The severity is the triage's, with the agent's in brackets when they differ. It was judged for that bug's own preconditions; a neighbouring bug usually has different ones.",
    "",
  ];
  if (!rows.length) lines.push("Nothing triaged yet.", "");
  for (const [repo, list] of byRepo) {
    lines.push(`## ${repo}`, "", "| Finding | Triage | Location | Title | Note |", "|---|---|---|---|---|");
    for (const v of list) {
      const ref = `${v.run_id}/${v.id}`;
      const link = v.path ? `[${ref}](${`${v.run_id}/${v.path}`.replace(/ /g, "%20")})` : ref;
      lines.push(`| ${link} | ${cell(triageLine(v))} | ${cell(v.location)} | ${cell(v.title)} | ${cell(v.disposition_note)} |`);
    }
    lines.push("");
  }
  writeAtomic(join(config.workbasesDir, "TRIAGED.md"), lines.join("\n"));
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
  const verdicts = dispositionCounts();
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
    "One folder per audit run. Each has `.pixel/run.json` (facts about the run), usually `REPORT.md` (the agent's final report), `findings/` (one folder per finding: README.md with the details, PoCs next to it), `FINDINGS.md` (an index of those, by state) and sometimes `TRIAGE.md` (a human's triage of the findings and the report). `TRIAGED.md` next to this file lists every triaged finding across runs, by repository.",
    "",
    "| Run | Repository | Language | Status | Started | Model | Report | Triage |",
    "|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
  writeAtomic(join(config.workbasesDir, "INDEX.md"), body);
  writeTriaged();
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
