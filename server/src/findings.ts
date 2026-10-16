/**
 * Findings: one folder per finding in the run's workbase, written by the agent with its normal file
 * tools (no plugin, no API): `findings/F3-short-name/README.md`, a few `key: value` header lines between
 * `---` (state, severity, location, poc, class) then free markdown, with PoCs and logs next to it.
 * Agents read each other's findings as plain files.
 *
 * Pixel polls `findings/` like it did PROGRESS.md (a readdir and one stat per finding per live run, read on
 * change) and re-reads it as soon as a write or edit under findings/ completes. Changes of state, severity,
 * title, location, PoC or class become finding events (and timeline entries). Pixel writes FINDINGS.md
 * (an index for people and peer agents) and TRIAGE.md (the human's verdicts); it never writes findings/.
 */
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { ACTIVE_STATUSES, db, getRun, listRuns, type RunRow } from "./db.ts";
import { publish } from "./bus.ts";
import { outcomeText, refreshRunFiles, verdictCounts, workbasePath, writeTriage } from "./knowledge.ts";
import { timeline } from "./runs/state.ts";

export const STATES = ["lead", "suspected", "confirmed", "ruled_out"] as const;
export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export const VERDICTS = ["real", "not_bug", "duplicate"] as const;
export type Verdict = (typeof VERDICTS)[number];

const VERDICT_WORDS: Record<string, string> = { real: "real", not_bug: "not a bug", duplicate: "duplicate", needs_work: "needs more work" };
const STATE_WORDS: Record<string, string> = { lead: "lead", suspected: "suspected", confirmed: "confirmed", ruled_out: "ruled out" };

/** Finished runs are still checked for a while, in case the last write landed just before the end. */
const AFTER_FINISH_MS = 10 * 60_000;
const MAX_BYTES = 1024 * 1024;
const MAX_FINDINGS = 500;

export const findingsDir = (runId: string) => join(workbasePath(runId), "findings");

export interface FindingRow {
  run_id: string;
  id: string;
  state: string;
  severity: string | null;
  title: string;
  class: string | null;
  location: string | null;
  poc: string | null;
  summary: string;
  created: number;
  updated: number;
  session_id: string | null;
  removed_at: number | null;
  removed_reason: string | null;
  duplicate_of: string | null;
  verdict: Verdict | null;
  verdict_note: string | null;
  verdict_at: number | null;
  /** The finding's README, relative to the workbase. */
  path: string | null;
  /** What Pixel couldn't read in the README (bad header, clashing number), shown on the finding. */
  problem: string | null;
}

export interface FindingEvent {
  seq: number;
  run_id: string;
  finding_id: string;
  at: number;
  action: "add" | "update" | "remove" | "verdict";
  changes: Record<string, [unknown, unknown]> | null;
  note: string | null;
  session_id: string | null;
}

const clip = (v: string | undefined, max: number) => (v?.trim() ? v.trim().slice(0, max) : null);

/** `---` header lines (`key: value`, `# comments` dropped, quotes stripped) and the markdown after them. */
export function parseReadme(text: string) {
  const fields: Record<string, string> = {};
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { fields, body: text, header: false };
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const value = kv[2].replace(/(^|\s)#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
    fields[kv[1].toLowerCase()] = value;
  }
  return { fields, body: text.slice(m[0].length), header: true };
}

type Entry = { num: number; name: string; readme: string; rel: string; folder: string; mtime: number; size: number };

/** The finding folders (or flat F3-name.md files) in findings/, lowest number first. */
function listEntries(runId: string): Entry[] | null {
  const dir = findingsDir(runId);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const out: Entry[] = [];
  for (const name of names.sort()) {
    const m = /^f(\d{1,5})(?:\b|[-_ ]|$)/i.exec(name);
    if (!m) continue;
    const flat = name.toLowerCase().endsWith(".md");
    const readme = flat ? join(dir, name) : join(dir, name, "README.md");
    try {
      const st = statSync(readme);
      if (!st.isFile() || st.size > MAX_BYTES) continue;
      out.push({ num: Number(m[1]), name, readme, rel: flat ? `findings/${name}` : `findings/${name}/README.md`, folder: flat ? "findings" : `findings/${name}`, mtime: Math.floor(st.mtimeMs), size: st.size });
    } catch {
      // a folder without README.md yet: skip until it has one
    }
    if (out.length >= MAX_FINDINGS) break;
  }
  return out.sort((a, b) => a.num - b.num || a.name.localeCompare(b.name));
}

/** A PoC path from the header, made relative to the workbase (relative paths are from the finding's folder). */
function pocPath(poc: string | null, folder: string) {
  if (!poc) return null;
  if (isAbsolute(poc)) {
    const i = poc.indexOf("/findings/");
    return i >= 0 ? poc.slice(i + 1) : poc;
  }
  const p = normalize(poc.startsWith("findings/") ? poc : join(folder, poc));
  return p.startsWith("..") ? poc : p;
}

const titleOf = (body: string, fallback: string) => /^#\s+(.+?)\s*#*\s*$/m.exec(body)?.[1] ?? fallback;

function readEntry(e: Entry, id: string, previous: FindingRow | undefined, clash: string | null) {
  const { fields, body, header } = parseReadme(readFileSync(e.readme, "utf8"));
  const problems: string[] = [];
  if (clash) problems.push(clash);
  let state = fields.state?.toLowerCase().replace(/[\s-]+/g, "_");
  if (!header) problems.push("no --- header at the top of the README");
  else if (!state) problems.push("the header has no state");
  else if (!(STATES as readonly string[]).includes(state)) problems.push(`state "${fields.state}" isn't one of lead, suspected, confirmed, ruled_out`);
  if (!state || !(STATES as readonly string[]).includes(state)) state = previous?.state ?? "lead";
  let severity: string | null = fields.severity?.toLowerCase() || null;
  if (severity && !(SEVERITIES as readonly string[]).includes(severity)) {
    problems.push(`severity "${fields.severity}" isn't one of ${SEVERITIES.join(", ")}`);
    severity = previous?.severity ?? null;
  }
  const slugTitle = e.name.replace(/\.md$/i, "").replace(/^f\d+[-_ ]*/i, "").replace(/[-_]+/g, " ") || id;
  const title = clip(titleOf(body, fields.title || slugTitle), 200)!;
  const summary = body.replace(/^#\s+.+$/m, "").trim().slice(0, 20_000);
  return {
    id,
    state,
    severity,
    title,
    class: clip(fields.class, 100),
    location: clip(fields.location, 300),
    poc: pocPath(clip(fields.poc, 500), e.folder),
    summary,
    path: e.rel,
    problem: problems.join("; ") || null,
  };
}

const upsert = db.query(`
  INSERT INTO findings (run_id, id, state, severity, title, class, location, poc, summary, created, updated, session_id, removed_at, removed_reason, duplicate_of, path, problem)
  VALUES ($run, $id, $state, $severity, $title, $class, $location, $poc, $summary, $created, $updated, $session_id, NULL, NULL, NULL, $path, $problem)
  ON CONFLICT(run_id, id) DO UPDATE SET state = excluded.state, severity = excluded.severity, title = excluded.title, class = excluded.class,
    location = excluded.location, poc = excluded.poc, summary = excluded.summary, updated = excluded.updated, session_id = excluded.session_id,
    removed_at = NULL, removed_reason = NULL, path = excluded.path, problem = excluded.problem`);
const insertEvent = db.query(
  "INSERT OR IGNORE INTO finding_events (run_id, finding_id, at, action, changes, note, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
);

export const getFinding = (runId: string, id: string) => db.query<FindingRow, [string, string]>("SELECT * FROM findings WHERE run_id = ? AND id = ?").get(runId, id);

const parseEvent = (e: any): FindingEvent => ({ ...e, changes: e.changes ? JSON.parse(e.changes) : null });

/** One line for the timeline and the Latest feed. */
export function describeEvent(e: Pick<FindingEvent, "action" | "changes" | "note" | "finding_id">, f: Pick<FindingRow, "title" | "state" | "severity"> | null) {
  const title = f?.title ?? "";
  const note = e.note ? `: ${e.note}` : "";
  switch (e.action) {
    case "add":
      return `${e.finding_id} added (${[STATE_WORDS[f?.state ?? "lead"], f?.severity].filter(Boolean).join(", ")}): ${title}`;
    case "remove":
      return `${e.finding_id} removed: ${title}${note}`;
    case "verdict":
      return `${e.finding_id} triaged as ${e.changes?.verdict?.[1] ? VERDICT_WORDS[String(e.changes.verdict[1])] : "untriaged"}: ${title}`;
    default: {
      const st = e.changes?.state;
      if (st) return `${e.finding_id} ${STATE_WORDS[String(st[1])] ?? st[1]}: ${title}${note}`;
      const sev = e.changes?.severity;
      if (sev) return `${e.finding_id} severity ${sev[0] ?? "none"} to ${sev[1]}: ${title}${note}`;
      return `${e.finding_id} updated: ${title}${note}`;
    }
  }
}

/** Fields whose changes are worth an event (summary edits happen all the time and only bump `updated`). */
const TRACKED = ["state", "severity", "title", "location", "poc", "class"] as const;

/** Read a run's findings/ into the table. Returns the number of new events. */
export function syncFindings(run: RunRow, by: string | null = null) {
  const entries = listEntries(run.id);
  if (!entries) return 0; // no findings/ folder: nothing to do (and nothing to mark removed)
  const before = new Map(db.query<FindingRow, [string]>("SELECT * FROM findings WHERE run_id = ?").all(run.id).map((r) => [r.id, r]));
  const fresh: { event: FindingEvent; id: string }[] = [];
  const event = (id: string, at: number, action: FindingEvent["action"], changes: Record<string, [unknown, unknown]> | null, note: string | null) => {
    const json = changes && Object.keys(changes).length ? JSON.stringify(changes).slice(0, 8000) : null;
    const res = insertEvent.run(run.id, id, at, action, json, note, by);
    if (res.changes) fresh.push({ id, event: parseEvent({ seq: Number(res.lastInsertRowid), run_id: run.id, finding_id: id, at, action, changes: json, note, session_id: by }) });
  };
  let changed = false;
  db.transaction(() => {
    // Two folders with the same number: the one Pixel already knows (else the first by name) keeps F<n>.
    const byNum = new Map<number, Entry[]>();
    for (const e of entries) byNum.set(e.num, [...(byNum.get(e.num) ?? []), e]);
    const seen = new Set<string>();
    for (const [num, group] of byNum) {
      const plain = `F${num}`;
      const owner = group.find((e) => before.get(plain)?.path === e.rel) ?? group[0];
      for (const e of group) {
        const id = e === owner ? plain : e.name.replace(/\.md$/i, "").slice(0, 60);
        if (seen.has(id)) continue;
        seen.add(id);
        const prev = before.get(id);
        const clash = e === owner ? null : `same number as ${owner.name}; rename this folder to a free number`;
        let f;
        try {
          f = readEntry(e, id, prev, clash);
        } catch (err) {
          console.error(`finding ${run.id}/${e.name}`, err);
          continue;
        }
        const live = prev && !prev.removed_at ? prev : undefined;
        const changes: Record<string, [unknown, unknown]> = {};
        if (live) for (const k of TRACKED) if ((live[k] ?? null) !== (f[k] ?? null)) changes[k] = [live[k] ?? null, f[k] ?? null];
        const same = live && !Object.keys(changes).length && live.summary === f.summary && live.path === f.path && live.problem === f.problem;
        if (same) continue;
        changed = true;
        const at = Math.max(e.mtime, (live?.updated ?? 0) + 1);
        upsert.run({ $run: run.id, ...Object.fromEntries(Object.entries(f).map(([k, v]) => [`$${k}`, v])), $created: prev?.created ?? at, $updated: at, $session_id: by ?? prev?.session_id ?? null } as any);
        if (!live) event(id, at, "add", null, prev ? "the folder is back" : null);
        else if (Object.keys(changes).length) event(id, at, "update", changes, null);
      }
    }
    // Folders that went away: keep the finding, marked removed.
    for (const r of before.values()) {
      if (seen.has(r.id) || r.removed_at) continue;
      changed = true;
      const at = Math.max(Date.now(), r.updated + 1);
      db.query("UPDATE findings SET removed_at = ?, removed_reason = 'folder deleted' WHERE run_id = ? AND id = ?").run(at, run.id, r.id);
      event(r.id, at, "remove", null, "folder deleted");
    }
  })();
  if (changed) {
    try {
      writeFindingsIndex(run.id);
    } catch (e) {
      console.error(`FINDINGS.md for ${run.id}`, e);
    }
    publish("*", "findings", { run: run.id });
  }
  fresh.sort((a, b) => a.event.at - b.event.at);
  for (const { event, id } of fresh) announce(run.id, event, getFinding(run.id, id)!);
  return fresh.length;
}

function announce(runId: string, event: FindingEvent, finding: FindingRow) {
  timeline(runId, event.action === "verdict" ? "user" : "agent", "finding", describeEvent(event, finding), { finding: event.finding_id, action: event.action, seq: event.seq, title: finding.title, severity: finding.severity, state: finding.state, note: event.note, changes: event.changes }, event.at);
  publish(runId, "finding", { event, finding });
  publish("*", "finding", { event, finding });
}

/** Last listing seen per run (names, mtimes, sizes), so an unchanged folder costs a readdir and some stats. */
const seenStamp = new Map<string, string>();

/** Read findings/ if anything in it changed since the last check. `force` skips the comparison. */
export function checkFindings(run: RunRow, force = false, by: string | null = null) {
  const entries = listEntries(run.id);
  if (!entries) return 0;
  const stamp = entries.map((e) => `${e.name}:${e.mtime}:${e.size}`).join("|");
  if (!force && seenStamp.get(run.id) === stamp) return 0;
  seenStamp.set(run.id, stamp);
  try {
    return syncFindings(run, by);
  } catch (e) {
    console.error(`findings ${run.id}`, e);
    return 0;
  }
}

/** Called for every tool part: a completed write or edit under findings/ means a finding just changed. */
export function onToolPart(runId: string, part: any) {
  if (part?.type !== "tool" || part.state?.status !== "completed" || part.tool === "read") return;
  if (!/(^|\/)findings\/[Ff]\d/.test(JSON.stringify(part.state?.input ?? {}))) return;
  const run = getRun(runId);
  if (run) checkFindings(run, true, part.sessionID ?? null);
}

export function checkAllFindings() {
  const now = Date.now();
  for (const r of listRuns()) {
    if (ACTIVE_STATUSES.includes(r.status) || (r.finished_at && now - r.finished_at < AFTER_FINISH_MS)) checkFindings(r);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startFindingsWatch(everyMs = 5000) {
  // Once at start for every run, so findings written while Pixel was down are picked up.
  for (const r of listRuns()) checkFindings(r);
  timer ??= setInterval(checkAllFindings, everyMs);
}
export function stopFindingsWatch() {
  if (timer) clearInterval(timer);
  timer = null;
}

// ---- reading ----

export interface FindingQuery {
  run?: string;
  untriaged?: boolean;
  severity?: string;
  includeRemoved?: boolean;
}

/** Findings, newest change first. Untriaged = not removed, not ruled out, no verdict yet. */
export function listFindings(q: FindingQuery = {}) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.run) {
    where.push("run_id = ?");
    params.push(q.run);
  }
  if (!q.includeRemoved) where.push("removed_at IS NULL");
  if (q.untriaged) where.push("verdict IS NULL AND state != 'ruled_out'");
  if (q.severity) {
    where.push("severity = ?");
    params.push(q.severity);
  }
  return db.query<FindingRow, any[]>(`SELECT * FROM findings ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated DESC`).all(...params);
}

export function findingEvents(opts: { run?: string; finding?: string; since?: number; limit?: number } = {}) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.run) {
    where.push("run_id = ?");
    params.push(opts.run);
  }
  if (opts.finding) {
    where.push("finding_id = ?");
    params.push(opts.finding);
  }
  if (opts.since) {
    where.push("at > ?");
    params.push(opts.since);
  }
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000);
  return db
    .query<any, any[]>(`SELECT * FROM finding_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC, seq DESC LIMIT ${limit}`)
    .all(...params)
    .map(parseEvent);
}

/** Per run: untriaged findings by severity (Wall tiles, toolbar counts, To triage stat), and the run's result from the verdicts. */
export function findingCounts() {
  const rows = db
    .query<{ run_id: string; state: string; severity: string | null; verdict: string | null; n: number }, []>(
      "SELECT run_id, state, severity, verdict, COUNT(*) AS n FROM findings WHERE removed_at IS NULL GROUP BY run_id, state, severity, verdict",
    )
    .all();
  type Counts = { total: number; untriaged: number; confirmed: number; bySeverity: Record<string, number>; untriagedBySeverity: Record<string, number>; real: number; outcome: string | null };
  const out: Record<string, Counts> = {};
  const blank = (): Counts => ({ total: 0, untriaged: 0, confirmed: 0, bySeverity: {}, untriagedBySeverity: {}, real: 0, outcome: null });
  for (const r of rows) {
    const c = (out[r.run_id] ??= blank());
    if (r.state === "lead") continue; // leads are ideas, not findings to triage
    c.total += r.n;
    if (r.state === "confirmed") c.confirmed += r.n;
    const sev = r.severity ?? "info";
    c.bySeverity[sev] = (c.bySeverity[sev] ?? 0) + r.n;
    if (!r.verdict && r.state !== "ruled_out") {
      c.untriaged += r.n;
      c.untriagedBySeverity[sev] = (c.untriagedBySeverity[sev] ?? 0) + r.n;
    }
  }
  for (const [run, v] of Object.entries(verdictCounts())) {
    const c = (out[run] ??= blank());
    c.real = v.real;
    c.outcome = outcomeText(v);
  }
  return out;
}

// ---- FINDINGS.md and verdicts ----

function writeAtomic(path: string, text: string) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

const STATE_ORDER = ["confirmed", "suspected", "lead", "ruled_out"];
const cell = (s: string | null | undefined) => (s ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/** FINDINGS.md at the workbase root: one line per finding, for people and peer agents. Pixel's file. */
export function writeFindingsIndex(runId: string) {
  const rows = listFindings({ run: runId }).sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || Number(a.id.slice(1).split(/\D/)[0]) - Number(b.id.slice(1).split(/\D/)[0]));
  const lines = [
    "# Findings",
    "",
    "Written by Pixel from `findings/` (one folder per finding; its README.md has the details, PoCs sit next to it). The verdict is the human's triage; notes are in TRIAGE.md.",
    "",
  ];
  if (!rows.length) lines.push("None yet.", "");
  else {
    lines.push("| Id | State | Severity | Title | Location | Verdict |", "|---|---|---|---|---|---|");
    for (const f of rows) {
      const link = f.path ? `[${cell(f.title)}](${f.path.replace(/ /g, "%20")})` : cell(f.title);
      lines.push(`| ${f.id} | ${STATE_WORDS[f.state] ?? f.state} | ${f.severity ?? ""} | ${link} | ${cell(f.location)} | ${f.verdict ? VERDICT_WORDS[f.verdict] : ""} |`);
    }
    lines.push("");
  }
  writeAtomic(join(workbasePath(runId), "FINDINGS.md"), lines.join("\n"));
}

/** The human's verdict on one finding (null clears it). Returns the updated finding. */
export function setVerdict(runId: string, id: string, verdict: Verdict | null, note: string | null) {
  if (verdict !== null && !VERDICTS.includes(verdict)) throw new Error(`verdict must be one of ${VERDICTS.join(", ")}`);
  const before = getFinding(runId, id);
  if (!before) throw new Error(`no finding ${id}`);
  const at = Math.max(Date.now(), (before.verdict_at ?? 0) + 1);
  const cleanNote = note?.trim() || null;
  db.query("UPDATE findings SET verdict = ?, verdict_note = ?, verdict_at = ? WHERE run_id = ? AND id = ?").run(verdict, cleanNote, verdict ? at : null, runId, id);
  const res = insertEvent.run(runId, id, at, "verdict", JSON.stringify({ verdict: [before.verdict, verdict] }), cleanNote, null);
  const finding = getFinding(runId, id)!;
  announce(runId, parseEvent({ seq: Number(res.lastInsertRowid), run_id: runId, finding_id: id, at, action: "verdict", changes: JSON.stringify({ verdict: [before.verdict, verdict] }), note: cleanNote, session_id: null }), finding);
  publish("*", "findings", { run: runId });
  try {
    writeFindingsIndex(runId);
    const run = getRun(runId);
    if (run) writeTriage(run);
    refreshRunFiles(runId);
  } catch (e) {
    console.error(`writing verdicts for ${runId}`, e);
  }
  return finding;
}

export const verdictWord = (v: string) => VERDICT_WORDS[v] ?? v;
