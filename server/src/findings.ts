/**
 * Findings: one folder per finding in the run's workbase, written by the agent with its normal file
 * tools (no plugin, no API): `findings/F3-short-name/README.md`, a few `key: value` header lines between
 * `---` (state, severity, location, poc, class) then free markdown, with PoCs and logs next to it.
 * Agents read each other's findings as plain files.
 *
 * Pixel polls `findings/` like it did PROGRESS.md (a readdir and one stat per finding per live run, read on
 * change) and re-reads it as soon as a write or edit under findings/ completes. Changes of state, severity,
 * title, location, PoC or class become finding events (and timeline entries). Pixel writes FINDINGS.md
 * (an index for people and peer agents), TRIAGE.md (the human's triage) and TRIAGED.md at the top of the
 * workbases (every triaged finding, for prior art); it never writes findings/.
 *
 * Triage is two things that change on different schedules: the disposition (report, known, duplicate, weak,
 * invalid; once, with a final severity) and, for the ones to report, the disclosure (ready, reported, fixed,
 * dropped), which only a person sets in the dashboard.
 */
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { ACTIVE_STATUSES, db, getRun, listRuns, type RunRow } from "./db.ts";
import { publish } from "./bus.ts";
import { outcomeText, refreshRunFiles, dispositionCounts, workbasePath, writeTriage, writeTriaged } from "./knowledge.ts";
import { timeline } from "./runs/state.ts";
import { getSettings } from "./settings.ts";
import { notify } from "./notify.ts";
import { config } from "./config.ts";

export const STATES = ["lead", "suspected", "confirmed", "ruled_out"] as const;
export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
/** The triage's judgement: a real novel bug to disclose, already public, same root cause as another finding, real but not worth disclosing, not a bug. */
export const DISPOSITIONS = ["report", "known", "duplicate", "weak", "invalid"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];
/** The final severity can also say "none": no security impact. */
export const FINAL_SEVERITIES = [...SEVERITIES, "none"] as const;
/** Only for disposition report: not sent yet, sent and waiting on upstream, fixed upstream, taken out (with a reason). */
export const DISCLOSURES = ["ready", "reported", "fixed", "dropped"] as const;
export type Disclosure = (typeof DISCLOSURES)[number];
/** The four lists of the Findings page (and the view filter): to triage, to report, resolved, reviewed. */
export const VIEWS = ["triage", "report", "resolved", "reviewed"] as const;

const DISPOSITION_WORDS: Record<string, string> = { report: "report", known: "known", duplicate: "duplicate", weak: "weak", invalid: "invalid" };
const DISCLOSURE_WORDS: Record<string, string> = { ready: "ready to report", reported: "reported upstream", fixed: "fixed upstream", dropped: "disclosure dropped" };
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
  /** Triage: `<run>/<id>` of the finding this one duplicates (disposition duplicate). */
  duplicate_of: string | null;
  /** The finding's README, relative to the workbase. */
  path: string | null;
  /** What Pixel couldn't read in the README (bad header, clashing number), shown on the finding. */
  problem: string | null;
  disposition: Disposition | null;
  disposition_note: string | null;
  disposition_at: number | null;
  /** Who triaged it: "dashboard" or "MCP: <token name>"; null for older verdicts and without one. */
  disposition_by: string | null;
  /** The triage's severity; null = agrees with the agent's `severity`. */
  severity_final: string | null;
  /** The agent's own `duplicate_of:` header, as `<run>/<id>`: a suggestion for the triage. */
  agent_duplicate_of: string | null;
  disclosure: Disclosure | null;
  disclosure_note: string | null;
  disclosure_at: number | null;
  reported_at: number | null;
  report_url: string | null;
  fixed_at: number | null;
  fix_ref: string | null;
  /** A deadline set by hand (extended); null = sent + Settings disclosureDays. */
  deadline_at: number | null;
  deadline_notified: "soon" | "over" | null;
  /** The latest check on latest upstream: present | fixed | changed | unclear, from the check run's UPSTREAM.md. */
  upstream_status: UpstreamStatus | null;
  upstream_commit: string | null;
  upstream_fixed_by: string | null;
  upstream_note: string | null;
  upstream_at: number | null;
  upstream_run: string | null;
  /** The run's repository (joined from runs). */
  repo: string | null;
  /** While sent upstream: the disclosure deadline, and when it starts to count as due soon. Computed. */
  deadline: number | null;
  deadline_warn_at: number | null;
}

export const UPSTREAM_STATUSES = ["present", "fixed", "changed", "unclear"] as const;
export type UpstreamStatus = (typeof UPSTREAM_STATUSES)[number];

export interface FindingEvent {
  seq: number;
  run_id: string;
  finding_id: string;
  at: number;
  /** verdict: older triage events (real, not_bug, duplicate). upstream: a check run's answer. */
  action: "add" | "update" | "remove" | "verdict" | "triage" | "disclosure" | "upstream";
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

/** A finding reference as `<run>/<id>`: "F3" means this run's F3. Anything else is null. */
export function dupRef(v: string | null | undefined, runId: string) {
  const m = /^\s*(?:([\w.:-]+)\/)?([Ff]\d[\w.-]*)\s*$/.exec(v ?? "");
  return m ? `${m[1] ?? runId}/${m[2][0].toUpperCase()}${m[2].slice(1)}` : null;
}

const titleOf = (body: string, fallback: string) => /^#\s+(.+?)\s*#*\s*$/m.exec(body)?.[1] ?? fallback;

function readEntry(runId: string, e: Entry, id: string, previous: FindingRow | undefined, clash: string | null) {
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
    agent_duplicate_of: dupRef(fields.duplicate_of, runId),
    summary,
    path: e.rel,
    problem: problems.join("; ") || null,
  };
}

const upsert = db.query(`
  INSERT INTO findings (run_id, id, state, severity, title, class, location, poc, summary, created, updated, session_id, removed_at, removed_reason, path, problem, agent_duplicate_of)
  VALUES ($run, $id, $state, $severity, $title, $class, $location, $poc, $summary, $created, $updated, $session_id, NULL, NULL, $path, $problem, $agent_duplicate_of)
  ON CONFLICT(run_id, id) DO UPDATE SET state = excluded.state, severity = excluded.severity, title = excluded.title, class = excluded.class,
    location = excluded.location, poc = excluded.poc, summary = excluded.summary, updated = excluded.updated, session_id = excluded.session_id,
    removed_at = NULL, removed_reason = NULL, path = excluded.path, problem = excluded.problem, agent_duplicate_of = excluded.agent_duplicate_of`);
const insertEvent = db.query(
  "INSERT OR IGNORE INTO finding_events (run_id, finding_id, at, action, changes, note, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
);

/** Findings with their run's repository. Filters use the `f.` prefix. */
const SELECT = "SELECT f.*, r.repo AS repo FROM findings f LEFT JOIN runs r ON r.id = f.run_id";
const DAY = 86_400_000;

/** The disclosure deadline of a sent finding: set by hand, else sent + disclosureDays. */
function withDeadline(f: FindingRow, s = getSettings()): FindingRow {
  const sent = f.disposition === "report" && f.disclosure === "reported" && f.reported_at;
  const deadline = sent ? (f.deadline_at ?? f.reported_at! + s.disclosureDays * DAY) : null;
  return { ...f, deadline, deadline_warn_at: deadline === null ? null : deadline - s.disclosureWarnDays * DAY };
}

export const getFinding = (runId: string, id: string) => {
  const f = db.query<FindingRow, [string, string]>(`${SELECT} WHERE f.run_id = ? AND f.id = ?`).get(runId, id);
  return f ? withDeadline(f) : null;
};

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
      return `${e.finding_id} triaged as ${e.changes?.verdict?.[1] ? String(e.changes.verdict[1]).replace("_", " ") : "untriaged"}: ${title}`;
    case "triage": {
      const d = e.changes?.disposition;
      const sev = e.changes?.severity_final;
      const dup = e.changes?.duplicate_of?.[1];
      if (d) return d[1] ? `${e.finding_id} triaged: ${DISPOSITION_WORDS[String(d[1])] ?? d[1]}${dup ? ` of ${dup}` : ""}${sev?.[1] ? `, ${sev[1]}` : ""}: ${title}` : `${e.finding_id} triage cleared: ${title}`;
      if (sev) return `${e.finding_id} final severity ${sev[1] ?? "back to the agent's"}: ${title}`;
      return `${e.finding_id} triage updated: ${title}`;
    }
    case "disclosure": {
      const d = e.changes?.disclosure?.[1];
      const dl = e.changes?.deadline?.[1];
      if (!d && dl) return `${e.finding_id} deadline moved to ${new Date(Number(dl)).toISOString().slice(0, 10)}: ${title}`;
      return `${e.finding_id} ${d ? DISCLOSURE_WORDS[String(d)] ?? d : "disclosure updated"}: ${title}${note}`;
    }
    case "upstream": {
      const st = e.changes?.upstream_status?.[1];
      return `${e.finding_id} on latest upstream: ${st === "present" ? "still present" : st === "fixed" ? "fixed" : st === "changed" ? "changed" : "unclear"}: ${title}`;
    }
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
const TRACKED = ["state", "severity", "title", "location", "poc", "class", "agent_duplicate_of"] as const;

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
          f = readEntry(run.id, e, id, prev, clash);
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

/** Events people make (triage, disclosure), not the agent. */
const PEOPLE_ACTIONS = new Set(["verdict", "triage", "disclosure"]);
/** Events Pixel makes from a run started from the finding. */
const PIXEL_ACTIONS = new Set(["upstream"]);

function announce(runId: string, event: FindingEvent, finding: FindingRow) {
  timeline(runId, PEOPLE_ACTIONS.has(event.action) ? "user" : PIXEL_ACTIONS.has(event.action) ? "pixel" : "agent", "finding", describeEvent(event, finding), { finding: event.finding_id, action: event.action, seq: event.seq, title: finding.title, severity: finding.severity, state: finding.state, disposition: finding.disposition, note: event.note, changes: event.changes }, event.at);
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
  try {
    writeTriaged();
  } catch (e) {
    console.error("writing TRIAGED.md", e);
  }
  timer ??= setInterval(checkAllFindings, everyMs);
}
export function stopFindingsWatch() {
  if (timer) clearInterval(timer);
  timer = null;
}

// ---- reading ----

export interface FindingQuery {
  run?: string;
  /** Not triaged yet: no disposition, not ruled out by the agent (leads included). */
  untriaged?: boolean;
  /** The agent's severity: one or more, comma-separated; "none" = no severity set. */
  severity?: string;
  /** The severity after triage (the final one, else the agent's); "none" matches neither set or final none. */
  finalSeverity?: string;
  /** One or more, comma-separated. */
  state?: string;
  /** Only findings with a disposition (from you or an MCP client). */
  triaged?: boolean;
  /** These dispositions only, comma-separated; "none" = not triaged. */
  disposition?: string;
  /** These disclosure states only, comma-separated; "none" = no disclosure. */
  disclosure?: string;
  /** Findings that duplicate this one (`<run>/<id>`). */
  duplicateOf?: string;
  /** Runs whose repository contains this text (case doesn't matter). */
  repo?: string;
  /** One of VIEWS: the Findings page's lists. */
  view?: string;
  /** Words that must all appear in the title, location, class, summary or repo. */
  q?: string;
  includeRemoved?: boolean;
}

/** Severity filter values: the severities, plus "none" for findings without one. */
export const SEVERITY_FILTERS = [...SEVERITIES, "none"] as const;
export const DISPOSITION_FILTERS = [...DISPOSITIONS, "none"] as const;
export const DISCLOSURE_FILTERS = [...DISCLOSURES, "none"] as const;

/** A comma-separated filter, lowercased and checked, so "High" works and a typo is an error rather than an empty answer. */
export function enumFilter(name: string, value: string | null | undefined, allowed: readonly string[]) {
  if (!value?.trim()) return undefined;
  const list = value.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  const bad = list.filter((v) => !allowed.includes(v));
  if (bad.length) throw new Error(`${name} must be one of ${allowed.join(", ")} (got ${bad.join(", ")})`);
  return list.join(",");
}

/** SQL for one view of the Findings page (removed findings are never in one). */
const VIEW_SQL: Record<(typeof VIEWS)[number], string> = {
  triage: "f.disposition IS NULL AND f.state IN ('suspected', 'confirmed')",
  report: "f.disposition = 'report' AND COALESCE(f.disclosure, 'ready') IN ('ready', 'reported')",
  resolved: "f.disposition = 'report' AND f.disclosure IN ('fixed', 'dropped')",
  reviewed: "f.disposition IS NOT NULL",
};

/** "a,none" as `col IN (?) OR col IS NULL`. */
function inList(col: string, csv: string, where: string[], params: (string | number)[]) {
  const list = csv.split(",");
  const named = list.filter((v) => v !== "none");
  const parts = [named.length ? `${col} IN (${named.map(() => "?").join(", ")})` : "", list.includes("none") ? `${col} IS NULL` : ""].filter(Boolean);
  where.push(`(${parts.join(" OR ")})`);
  params.push(...named);
}

const SEARCHED = ["f.title", "f.location", "f.class", "f.summary", "r.repo", "f.run_id || '/' || f.id"];

/** Findings, newest change first (best match first with q). Untriaged = not removed, not ruled out, no disposition yet. */
export function listFindings(q: FindingQuery = {}) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.run) {
    where.push("f.run_id = ?");
    params.push(q.run);
  }
  if (!q.includeRemoved || q.view) where.push("f.removed_at IS NULL");
  if (q.untriaged) where.push("f.disposition IS NULL AND f.state != 'ruled_out'");
  if (q.severity) inList("f.severity", q.severity, where, params);
  if (q.finalSeverity) {
    // An explicit final "none" means no impact; otherwise the final one, else the agent's.
    const list = q.finalSeverity.split(",");
    const named = list.filter((v) => v !== "none");
    const parts = [named.length ? `COALESCE(f.severity_final, f.severity) IN (${named.map(() => "?").join(", ")})` : "", list.includes("none") ? "(f.severity_final = 'none' OR (f.severity_final IS NULL AND f.severity IS NULL))" : ""].filter(Boolean);
    where.push(`(${parts.join(" OR ")})`);
    params.push(...named);
  }
  if (q.triaged) where.push("f.disposition IS NOT NULL");
  if (q.disposition) inList("f.disposition", q.disposition, where, params);
  if (q.disclosure) inList("f.disclosure", q.disclosure, where, params);
  if (q.state) inList("f.state", q.state, where, params);
  if (q.duplicateOf) {
    where.push("f.duplicate_of = ?");
    params.push(q.duplicateOf);
  }
  if (q.repo?.trim()) {
    where.push("instr(lower(r.repo), ?) > 0");
    params.push(q.repo.trim().toLowerCase());
  }
  if (q.view) {
    if (!(VIEWS as readonly string[]).includes(q.view)) throw new Error(`view must be one of ${VIEWS.join(", ")}`);
    where.push(VIEW_SQL[q.view as (typeof VIEWS)[number]]);
  }
  const words = searchWords(q.q);
  for (const w of words) {
    where.push(`(${SEARCHED.map((c) => `instr(lower(COALESCE(${c}, '')), ?) > 0`).join(" OR ")})`);
    params.push(...SEARCHED.map(() => w));
  }
  const settings = getSettings();
  const rows = db.query<FindingRow, any[]>(`${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY f.updated DESC`).all(...params).map((f) => withDeadline(f, settings));
  if (!words.length) return rows;
  // Best match first: words in the title, then the location, count most.
  const score = (f: FindingRow) => words.reduce((n, w) => n + (f.title.toLowerCase().includes(w) ? 4 : 0) + (f.location?.toLowerCase().includes(w) ? 2 : 0) + (f.class?.toLowerCase().includes(w) ? 1 : 0), 0);
  return rows.map((f) => [score(f), f] as const).sort((a, b) => b[0] - a[0]).map(([, f]) => f);
}

/** Search words: lowercased, quotes keep a phrase together ("heap overflow" png). */
export function searchWords(q: string | undefined) {
  if (!q?.trim()) return [];
  return [...q.toLowerCase().matchAll(/"([^"]+)"|(\S+)/g)].map((m) => (m[1] ?? m[2]).trim()).filter(Boolean).slice(0, 8);
}

/** Where the search matched in the summary, as a short line ("" when only the title or location matched). */
export function matchSnippet(f: Pick<FindingRow, "summary">, q: string | undefined, width = 220) {
  const text = f.summary.replace(/\s+/g, " ");
  const lower = text.toLowerCase();
  for (const w of searchWords(q)) {
    const i = lower.indexOf(w);
    if (i < 0) continue;
    const from = Math.max(0, i - Math.floor(width / 3));
    return `${from ? "..." : ""}${text.slice(from, from + width).trim()}${from + width < text.length ? "..." : ""}`;
  }
  return "";
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

/** Per run: untriaged findings by severity (Wall tiles, toolbar counts, To triage stat), and the run's result from the triage. */
export function findingCounts() {
  const rows = db
    .query<{ run_id: string; state: string; severity: string | null; disposition: string | null; n: number }, []>(
      "SELECT run_id, state, COALESCE(severity_final, severity) AS severity, disposition, COUNT(*) AS n FROM findings WHERE removed_at IS NULL GROUP BY run_id, state, 3, disposition",
    )
    .all();
  /** Leads are ideas, not findings to triage: they're only in `leads`. Findings without a severity count as info. */
  type Counts = { total: number; leads: number; untriaged: number; confirmed: number; bySeverity: Record<string, number>; untriagedBySeverity: Record<string, number>; report: number; outcome: string | null };
  const out: Record<string, Counts> = {};
  const blank = (): Counts => ({ total: 0, leads: 0, untriaged: 0, confirmed: 0, bySeverity: {}, untriagedBySeverity: {}, report: 0, outcome: null });
  for (const r of rows) {
    const c = (out[r.run_id] ??= blank());
    if (r.state === "lead") {
      c.leads += r.n;
      continue;
    }
    c.total += r.n;
    if (r.state === "confirmed") c.confirmed += r.n;
    const sev = !r.severity || r.severity === "none" ? "info" : r.severity;
    c.bySeverity[sev] = (c.bySeverity[sev] ?? 0) + r.n;
    if (!r.disposition && r.state !== "ruled_out") {
      c.untriaged += r.n;
      c.untriagedBySeverity[sev] = (c.untriagedBySeverity[sev] ?? 0) + r.n;
    }
  }
  for (const [run, v] of Object.entries(dispositionCounts())) {
    const c = (out[run] ??= blank());
    c.report = v.report;
    c.outcome = outcomeText(v);
  }
  return out;
}

// ---- FINDINGS.md, triage and disclosure ----

function writeAtomic(path: string, text: string) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

const STATE_ORDER = ["confirmed", "suspected", "lead", "ruled_out"];
const cell = (s: string | null | undefined) => (s ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const numOf = (id: string) => Number(id.slice(1).split(/\D/)[0]);

/** The triage in a few words: "report, high", "duplicate of r1/F3", "weak". */
export function triageText(f: Pick<FindingRow, "disposition" | "severity_final" | "severity" | "duplicate_of" | "disclosure">) {
  if (!f.disposition) return "";
  const parts = [DISPOSITION_WORDS[f.disposition] ?? f.disposition];
  if (f.disposition === "duplicate" && f.duplicate_of) parts[0] += ` of ${f.duplicate_of}`;
  if (f.severity_final && f.severity_final !== f.severity) parts.push(f.severity_final === "none" ? "no impact" : f.severity_final);
  if (f.disposition === "report" && f.disclosure && f.disclosure !== "ready") parts.push(f.disclosure);
  return parts.join(", ");
}

/** FINDINGS.md at the workbase root: one line per finding, for people and peer agents. Pixel's file. */
export function writeFindingsIndex(runId: string) {
  const rows = listFindings({ run: runId }).sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || numOf(a.id) - numOf(b.id));
  const lines = [
    "# Findings",
    "",
    "Written by Pixel from `findings/` (one folder per finding; its README.md has the details, PoCs sit next to it). Triage is the human's: report (a real, novel bug to disclose), known (already public), duplicate (same root cause as another finding), weak (real, not worth disclosing), invalid (not a bug); notes are in TRIAGE.md.",
    "",
  ];
  if (!rows.length) lines.push("None yet.", "");
  else {
    lines.push("| Id | State | Severity | Title | Location | Triage |", "|---|---|---|---|---|---|");
    for (const f of rows) {
      const link = f.path ? `[${cell(f.title)}](${f.path.replace(/ /g, "%20")})` : cell(f.title);
      lines.push(`| ${f.id} | ${STATE_WORDS[f.state] ?? f.state} | ${f.severity ?? ""} | ${link} | ${cell(f.location)} | ${cell(triageText(f))} |`);
    }
    lines.push("");
  }
  writeAtomic(join(workbasePath(runId), "FINDINGS.md"), lines.join("\n"));
}

/** After triage or disclosure changes: the run's FINDINGS.md, TRIAGE.md, run.json, INDEX.md and TRIAGED.md. */
function writeTriageFiles(runIds: Iterable<string>) {
  for (const runId of new Set(runIds)) {
    try {
      writeFindingsIndex(runId);
      const run = getRun(runId);
      if (run) writeTriage(run);
      refreshRunFiles(runId);
    } catch (e) {
      console.error(`writing triage for ${runId}`, e);
    }
  }
}

export interface TriageInput {
  /** null clears the triage (and a disclosure that hasn't been sent). Left out: unchanged. */
  disposition?: Disposition | null;
  /** The final severity; null or the agent's own = agrees with the agent. Left out: unchanged. */
  severity?: string | null;
  /** `<run>/<id>` or an id in the same run; needed for duplicate. Left out: unchanged (or the agent's suggestion). */
  duplicate_of?: string | null;
  /** Left out: unchanged. */
  note?: string | null;
}

class TriageError extends Error {}

/** Check and work out one triage change, without writing. */
function planTriage(runId: string, id: string, input: TriageInput) {
  const before = getFinding(runId, id);
  if (!before) throw new TriageError(`no finding ${id} in ${runId}`);
  const has = (k: keyof TriageInput) => Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined;
  const disposition = has("disposition") ? (input.disposition?.toString().trim().toLowerCase() || null) : before.disposition;
  if (disposition !== null && !(DISPOSITIONS as readonly string[]).includes(disposition))
    throw new TriageError(`disposition must be one of ${DISPOSITIONS.join(", ")}, or null to clear it (got ${disposition})`);
  let severity = has("severity") ? (input.severity?.toString().trim().toLowerCase() || null) : before.severity_final;
  if (severity !== null && !(FINAL_SEVERITIES as readonly string[]).includes(severity)) throw new TriageError(`severity must be one of ${FINAL_SEVERITIES.join(", ")}, or null to agree with the agent (got ${severity})`);
  if (severity === before.severity) severity = null;
  let dup: string | null = has("duplicate_of") ? input.duplicate_of?.trim() || null : before.duplicate_of;
  if (disposition === "duplicate") {
    dup ??= before.agent_duplicate_of;
    if (!dup) throw new TriageError(`${id}: a duplicate needs duplicate_of, the finding it repeats (<run>/<id>, or an id in the same run)`);
    const ref = dupRef(dup, runId);
    if (!ref) throw new TriageError(`duplicate_of must look like <run>/F3 or F3 (got ${dup})`);
    const [r, f] = [ref.slice(0, ref.lastIndexOf("/")), ref.slice(ref.lastIndexOf("/") + 1)];
    if (r === runId && f === id) throw new TriageError(`${id} can't be a duplicate of itself`);
    if (!getFinding(r, f)) throw new TriageError(`duplicate_of: no finding ${ref}`);
    dup = ref;
  } else dup = null;
  // Leaving report: a disclosure that's under way has to be taken back by hand first.
  if (before.disposition === "report" && disposition !== "report" && (before.disclosure === "reported" || before.disclosure === "fixed"))
    throw new TriageError(`${id} is already ${before.disclosure === "fixed" ? "fixed" : "reported"} upstream; set its disclosure back in the dashboard before changing its disposition`);
  const note = has("note") ? input.note?.trim() || null : before.disposition_note;
  return { before, disposition: disposition as Disposition | null, severity, dup, note };
}

/**
 * Triage findings: disposition, final severity, duplicate_of, note (each left out stays as it is). Runs every
 * item and reports each; the files are written once at the end. `by`: "dashboard" or "MCP: <token name>".
 * Run agents can't triage.
 */
export function triageFindings(items: (TriageInput & { run: string; finding: string })[], by = "dashboard") {
  const results: ({ run: string; finding: string; ok: true; finding_row: FindingRow } | { run: string; finding: string; ok: false; error: string })[] = [];
  const touched: string[] = [];
  for (const it of items) {
    try {
      const p = planTriage(it.run, it.finding, it);
      const b = p.before;
      const changes: Record<string, [unknown, unknown]> = {};
      if (b.disposition !== p.disposition) changes.disposition = [b.disposition, p.disposition];
      if (b.severity_final !== p.severity) changes.severity_final = [b.severity_final, p.severity];
      if (b.duplicate_of !== p.dup) changes.duplicate_of = [b.duplicate_of, p.dup];
      const noteChanged = b.disposition_note !== p.note;
      if (!Object.keys(changes).length && !noteChanged) {
        results.push({ run: it.run, finding: it.finding, ok: true, finding_row: b });
        continue;
      }
      // Report starts the disclosure as ready; leaving report drops a disclosure that wasn't sent.
      const disclosure = p.disposition === "report" ? (b.disclosure ?? "ready") : null;
      const at = Math.max(Date.now(), (b.disposition_at ?? 0) + 1);
      db.query(
        `UPDATE findings SET disposition = ?, disposition_note = ?, disposition_at = ?, disposition_by = ?, severity_final = ?, duplicate_of = ?,
          disclosure = ?, disclosure_at = CASE WHEN ? IS NULL THEN NULL WHEN disclosure IS NULL THEN ? ELSE disclosure_at END
          ${disclosure === null ? ", disclosure_note = NULL, reported_at = NULL, report_url = NULL, fixed_at = NULL, fix_ref = NULL" : ""}
         WHERE run_id = ? AND id = ?`,
      ).run(p.disposition, p.note, p.disposition || p.severity ? at : null, p.disposition || p.severity ? by : null, p.severity, p.dup, disclosure, disclosure, at, it.run, it.finding);
      changes.by = [b.disposition_by, by];
      const json = JSON.stringify(changes);
      const res = insertEvent.run(it.run, it.finding, at, "triage", json, p.note, null);
      const row = getFinding(it.run, it.finding)!;
      announce(it.run, parseEvent({ seq: Number(res.lastInsertRowid), run_id: it.run, finding_id: it.finding, at, action: "triage", changes: json, note: p.note, session_id: null }), row);
      touched.push(it.run);
      results.push({ run: it.run, finding: it.finding, ok: true, finding_row: row });
    } catch (e) {
      if (!(e instanceof TriageError)) console.error(`triage ${it.run}/${it.finding}`, e);
      results.push({ run: it.run, finding: it.finding, ok: false, error: (e as Error).message });
    }
  }
  if (touched.length) {
    publish("*", "findings", { run: touched.length === 1 ? touched[0] : null });
    writeTriageFiles(touched);
  }
  return results;
}

/** One finding's triage; throws on a bad input. */
export function triageFinding(runId: string, id: string, input: TriageInput, by = "dashboard") {
  const [r] = triageFindings([{ ...input, run: runId, finding: id }], by);
  if (!r.ok) throw new Error(r.error);
  return r.finding_row;
}

export interface DisclosureInput {
  /** ready, reported, fixed, dropped; null clears it (back to ready). Left out: unchanged. */
  disclosure?: Disclosure | null;
  /** Why it was dropped (needed for dropped), or anything about the report. Left out: unchanged. */
  note?: string | null;
  report_url?: string | null;
  /** When it was sent; defaults to now when it becomes reported. */
  reported_at?: number | null;
  /** Version or commit with the fix. */
  fix_ref?: string | null;
  fixed_at?: number | null;
  /** Move the deadline of a sent finding by this many days (from its current deadline). */
  extend_days?: number;
}

/** The disclosure of a finding triaged as report. Only people set it, from the dashboard (the API refuses MCP clients). */
export function setDisclosure(runId: string, id: string, input: DisclosureInput) {
  const b = getFinding(runId, id);
  if (!b) throw new Error(`no finding ${id} in ${runId}`);
  if (b.disposition !== "report") throw new Error(`${id} isn't triaged as report; only findings to report have a disclosure`);
  const has = (k: keyof DisclosureInput) => Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined;
  const state = (has("disclosure") ? input.disclosure ?? "ready" : b.disclosure ?? "ready") as string;
  if (!(DISCLOSURES as readonly string[]).includes(state)) throw new Error(`disclosure must be one of ${DISCLOSURES.join(", ")} (got ${state})`);
  const note = has("note") ? input.note?.trim() || null : b.disclosure_note;
  if (state === "dropped" && !note) throw new Error("say why it's dropped (note)");
  const url = has("report_url") ? input.report_url?.trim() || null : b.report_url;
  if (url && !/^https?:\/\/\S+$/i.test(url)) throw new Error("report_url must be an http(s) link");
  const now = Date.now();
  const sent = state === "reported" || state === "fixed";
  const reportedAt = has("reported_at") ? input.reported_at ?? null : sent ? (b.reported_at ?? now) : b.reported_at;
  const fixRef = has("fix_ref") ? input.fix_ref?.trim() || null : b.fix_ref;
  const fixedAt = has("fixed_at") ? input.fixed_at ?? null : state === "fixed" ? (b.fixed_at ?? now) : null;
  const at = Math.max(now, (b.disclosure_at ?? 0) + 1);
  // A deadline set by hand only means something while sent; extending moves the current one.
  let deadlineAt = state === "reported" ? b.deadline_at : null;
  if (input.extend_days !== undefined) {
    const days = Number(input.extend_days);
    if (state !== "reported") throw new Error("only a sent finding has a deadline to extend");
    if (!Number.isFinite(days) || days === 0 || Math.abs(days) > 365) throw new Error("extend_days must be a number of days, up to 365");
    deadlineAt = (b.deadline ?? (reportedAt ?? now) + getSettings().disclosureDays * DAY) + days * DAY;
  }
  if (state === "reported" && b.reported_at && reportedAt !== b.reported_at && input.extend_days === undefined) deadlineAt = null;
  // A new or moved deadline can be announced again.
  const notified = deadlineAt === b.deadline_at && state === b.disclosure ? b.deadline_notified : null;
  db.query(
    "UPDATE findings SET disclosure = ?, disclosure_note = ?, disclosure_at = ?, reported_at = ?, report_url = ?, fixed_at = ?, fix_ref = ?, deadline_at = ?, deadline_notified = ? WHERE run_id = ? AND id = ?",
  ).run(state, note, state !== b.disclosure ? at : (b.disclosure_at ?? at), reportedAt, url, fixedAt, fixRef?.slice(0, 300) ?? null, deadlineAt, notified, runId, id);
  const changes: Record<string, [unknown, unknown]> = {};
  if (deadlineAt !== b.deadline_at && deadlineAt !== null) changes.deadline = [b.deadline, deadlineAt];
  if (state !== (b.disclosure ?? "ready")) changes.disclosure = [b.disclosure, state];
  if (url !== b.report_url) changes.report_url = [b.report_url, url];
  if (fixRef !== b.fix_ref) changes.fix_ref = [b.fix_ref, fixRef];
  const row = getFinding(runId, id)!;
  if (Object.keys(changes).length || note !== b.disclosure_note) {
    const json = JSON.stringify(changes);
    const res = insertEvent.run(runId, id, at, "disclosure", json, note, null);
    announce(runId, parseEvent({ seq: Number(res.lastInsertRowid), run_id: runId, finding_id: id, at, action: "disclosure", changes: json, note, session_id: null }), row);
    publish("*", "findings", { run: runId });
    writeTriageFiles([runId]);
  }
  return row;
}

export const dispositionWord = (v: string) => DISPOSITION_WORDS[v] ?? v;
export const disclosureWord = (v: string) => DISCLOSURE_WORDS[v] ?? v;

// ---- upstream checks ----

/** A check run's answer on the finding it came from; older answers than the one recorded are ignored. */
export function recordUpstream(runId: string, id: string, u: { status: UpstreamStatus; commit: string | null; fixedBy: string | null; note: string | null; at: number; run: string }) {
  const b = getFinding(runId, id);
  if (!b) return false;
  if (b.upstream_at && b.upstream_at > u.at && b.upstream_run !== u.run) return false;
  // Already recorded (Pixel restarted and read the same answer again).
  if (b.upstream_run === u.run && b.upstream_at === u.at && b.upstream_status === u.status) return false;
  db.query("UPDATE findings SET upstream_status = ?, upstream_commit = ?, upstream_fixed_by = ?, upstream_note = ?, upstream_at = ?, upstream_run = ? WHERE run_id = ? AND id = ?").run(
    u.status, u.commit, u.fixedBy, u.note, u.at, u.run, runId, id,
  );
  const changes = JSON.stringify({ upstream_status: [b.upstream_status, u.status], commit: [b.upstream_commit, u.commit], run: [b.upstream_run, u.run] });
  const at = Math.max(Date.now(), (b.updated ?? 0) + 1);
  const res = insertEvent.run(runId, id, at, "upstream", changes, u.fixedBy ? `fixed by ${u.fixedBy}` : null, null);
  const row = getFinding(runId, id)!;
  announce(runId, parseEvent({ seq: Number(res.lastInsertRowid), run_id: runId, finding_id: id, at, action: "upstream", changes, note: u.fixedBy ? `fixed by ${u.fixedBy}` : null, session_id: null }), row);
  publish("*", "findings", { run: runId });
  return true;
}

// ---- deadlines ----

/** Sent findings whose deadline is near or past and not yet announced: one notification each, per stage. */
export async function checkDeadlines(now = Date.now()) {
  const s = getSettings();
  const sent = listFindings({ disposition: "report", disclosure: "reported" });
  for (const f of sent) {
    if (f.deadline === null || f.deadline_warn_at === null) continue;
    const stage = now >= f.deadline ? "over" : now >= f.deadline_warn_at ? "soon" : null;
    if (!stage || f.deadline_notified === stage || (stage === "soon" && f.deadline_notified === "over")) continue;
    db.query("UPDATE findings SET deadline_notified = ? WHERE run_id = ? AND id = ?").run(stage, f.run_id, f.id);
    const days = Math.round(Math.abs(f.deadline - now) / DAY);
    const when = stage === "over" ? `${days} day${days === 1 ? "" : "s"} past its deadline` : `deadline in ${days} day${days === 1 ? "" : "s"}`;
    const body = `${f.title}\n${f.repo ?? f.run_id}, sent ${new Date(f.reported_at!).toISOString().slice(0, 10)}${f.report_url ? `\n${f.report_url}` : ""}\nDeadline ${new Date(f.deadline).toISOString().slice(0, 10)} (${s.disclosureDays}-day policy)`;
    const link = config.publicUrl ? `${config.publicUrl.replace(/\/$/, "")}/findings#${encodeURIComponent(`${f.run_id}/${f.id}`)}` : undefined;
    await notify("deadline", `${f.id} ${when}`, body, link).catch((e) => console.error("deadline notify failed", e));
  }
}

let deadlineTimer: ReturnType<typeof setInterval> | null = null;
export function startDeadlineWatch(everyMs = 3_600_000) {
  void checkDeadlines();
  deadlineTimer ??= setInterval(() => void checkDeadlines(), everyMs);
}
export function stopDeadlineWatch() {
  if (deadlineTimer) clearInterval(deadlineTimer);
  deadlineTimer = null;
}
