/**
 * Findings: what the agent records with the finding tools (opencode-plugins/findings.ts). The tools write
 * FINDINGS.json in the run's workbase; Pixel polls it like PROGRESS.md (one stat per live run, read on
 * change) and re-reads it as soon as a finding_* tool call completes. Each change in a finding's history
 * becomes a finding event (and a timeline entry). The human's verdicts are Pixel's own: they are written
 * back to .pixel/triage.json (which finding_list shows the agent) and to TRIAGE.md (for peer agents).
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACTIVE_STATUSES, db, getRun, listRuns, type RunRow } from "./db.ts";
import { publish } from "./bus.ts";
import { workbasePath, writeTriage } from "./knowledge.ts";
import { timeline } from "./runs/state.ts";

export const STATES = ["lead", "suspected", "confirmed", "ruled_out"] as const;
export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export const VERDICTS = ["real", "not_bug", "duplicate", "needs_work"] as const;
export type Verdict = (typeof VERDICTS)[number];

const VERDICT_WORDS: Record<Verdict, string> = { real: "real", not_bug: "not a bug", duplicate: "duplicate", needs_work: "needs more work" };
const STATE_WORDS: Record<string, string> = { lead: "lead", suspected: "suspected", confirmed: "confirmed", ruled_out: "ruled out" };

/** Finished runs are still checked for a while, in case the last write landed just before the end. */
const AFTER_FINISH_MS = 10 * 60_000;
const MAX_BYTES = 4 * 1024 * 1024;

export const findingsPath = (runId: string) => join(workbasePath(runId), "FINDINGS.json");

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

const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const time = (v: unknown, fallback: number) => {
  const t = typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(t) ? t : fallback;
};

/** A finding from the file, checked and cut to size; null if it isn't one. */
function parseFinding(f: any, mtime: number) {
  const id = typeof f?.id === "string" && /^F\d+$/.test(f.id) ? f.id : null;
  const title = str(f?.title, 200);
  if (!id || !title) return null;
  return {
    id,
    title,
    state: (STATES as readonly string[]).includes(f.state) ? (f.state as string) : "lead",
    severity: (SEVERITIES as readonly string[]).includes(f.severity) ? (f.severity as string) : null,
    class: str(f.class, 100),
    location: str(f.location, 300),
    poc: str(f.poc, 500),
    summary: str(f.summary, 4000) ?? "",
    created: time(f.created, mtime),
    updated: time(f.updated, mtime),
    session_id: str(f.by, 100),
    removed_at: f.removed ? time(f.removed.at, mtime) : null,
    removed_reason: f.removed ? (str(f.removed.reason, 300) ?? "removed") : null,
    duplicate_of: f.removed ? str(f.removed.duplicate_of, 20) : null,
    history: Array.isArray(f.history) ? f.history : [],
  };
}

const upsert = db.query(`
  INSERT INTO findings (run_id, id, state, severity, title, class, location, poc, summary, created, updated, session_id, removed_at, removed_reason, duplicate_of)
  VALUES ($run, $id, $state, $severity, $title, $class, $location, $poc, $summary, $created, $updated, $session_id, $removed_at, $removed_reason, $duplicate_of)
  ON CONFLICT(run_id, id) DO UPDATE SET state = excluded.state, severity = excluded.severity, title = excluded.title, class = excluded.class,
    location = excluded.location, poc = excluded.poc, summary = excluded.summary, created = excluded.created, updated = excluded.updated,
    session_id = excluded.session_id, removed_at = excluded.removed_at, removed_reason = excluded.removed_reason, duplicate_of = excluded.duplicate_of`);
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
      return `${e.finding_id} triaged as ${e.changes?.verdict?.[1] ? VERDICT_WORDS[e.changes.verdict[1] as Verdict] : "untriaged"}: ${title}`;
    default: {
      const st = e.changes?.state;
      if (st) return `${e.finding_id} ${STATE_WORDS[String(st[1])] ?? st[1]}: ${title}${note}`;
      const sev = e.changes?.severity;
      if (sev) return `${e.finding_id} severity ${sev[0] ?? "none"} → ${sev[1]}: ${title}${note}`;
      return `${e.finding_id} updated: ${title}${note}`;
    }
  }
}

/** Store a run's FINDINGS.json. Returns the number of new events. */
export function syncFindings(run: RunRow, text: string, mtime = Date.now()) {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return 0;
  }
  if (!Array.isArray(data?.findings)) return 0;
  const fresh: { event: FindingEvent; finding: FindingRow }[] = [];
  db.transaction(() => {
    const seen = new Set<string>();
    for (const raw of data.findings) {
      const f = parseFinding(raw, mtime);
      if (!f || seen.has(f.id)) continue;
      seen.add(f.id);
      const { history, ...row } = f;
      upsert.run(Object.fromEntries(Object.entries({ run: run.id, ...row }).map(([k, v]) => [`$${k}`, v])) as any);
      for (const h of history.slice(-500)) {
        const action = ["add", "update", "remove"].includes(h?.action) ? h.action : "update";
        const at = time(h?.at, f.updated);
        const changes = h?.changes && typeof h.changes === "object" && Object.keys(h.changes).length ? JSON.stringify(h.changes).slice(0, 8000) : null;
        const res = insertEvent.run(run.id, f.id, at, action, changes, str(h?.note, 2000), str(h?.by, 100));
        if (res.changes) fresh.push({ event: parseEvent({ seq: Number(res.lastInsertRowid), run_id: run.id, finding_id: f.id, at, action, changes, note: str(h?.note, 2000), session_id: str(h?.by, 100) }), finding: getFinding(run.id, f.id)! });
      }
    }
    // Findings deleted from the file by hand: keep them, marked removed.
    const gone = db.query<{ id: string }, [string]>("SELECT id FROM findings WHERE run_id = ? AND removed_at IS NULL").all(run.id).filter((r) => !seen.has(r.id));
    for (const g of gone) db.query("UPDATE findings SET removed_at = ?, removed_reason = 'deleted from FINDINGS.json' WHERE run_id = ? AND id = ?").run(Date.now(), run.id, g.id);
  })();
  fresh.sort((a, b) => a.event.at - b.event.at);
  for (const { event, finding } of fresh) announce(run.id, event, finding);
  if (fresh.length) publish("*", "findings", { run: run.id });
  return fresh.length;
}

function announce(runId: string, event: FindingEvent, finding: FindingRow) {
  timeline(runId, event.action === "verdict" ? "user" : "agent", "finding", describeEvent(event, finding), { finding: event.finding_id, action: event.action, seq: event.seq }, event.at);
  publish(runId, "finding", { event, finding });
  publish("*", "finding", { event, finding });
}

/** Last stat seen per run, so an unchanged file costs one stat per poll. */
const seenStat = new Map<string, string>();

/** Read FINDINGS.json if it changed since the last check. `force` skips the stat comparison. */
export function checkFindings(run: RunRow, force = false) {
  let st;
  try {
    st = statSync(findingsPath(run.id));
  } catch {
    return 0;
  }
  if (!st.isFile() || st.size > MAX_BYTES) return 0;
  const stamp = `${st.mtimeMs}:${st.size}`;
  if (!force && seenStat.get(run.id) === stamp) return 0;
  seenStat.set(run.id, stamp);
  try {
    return syncFindings(run, readFileSync(findingsPath(run.id), "utf8"), st.mtimeMs);
  } catch (e) {
    console.error(`findings ${run.id}`, e);
    return 0;
  }
}

/** Called for every tool part: a completed finding_* call means the file just changed. */
export function onToolPart(runId: string, part: any) {
  if (part?.type !== "tool" || !String(part.tool ?? "").startsWith("finding_") || part.state?.status !== "completed") return;
  const run = getRun(runId);
  if (run) checkFindings(run, true);
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

/** Per run: untriaged findings by severity, for the Wall (tiles, toolbar counts, To triage stat). */
export function findingCounts() {
  const rows = db
    .query<{ run_id: string; state: string; severity: string | null; verdict: string | null; n: number }, []>(
      "SELECT run_id, state, severity, verdict, COUNT(*) AS n FROM findings WHERE removed_at IS NULL GROUP BY run_id, state, severity, verdict",
    )
    .all();
  const out: Record<string, { total: number; untriaged: number; confirmed: number; bySeverity: Record<string, number>; untriagedBySeverity: Record<string, number> }> = {};
  for (const r of rows) {
    const c = (out[r.run_id] ??= { total: 0, untriaged: 0, confirmed: 0, bySeverity: {}, untriagedBySeverity: {} });
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
  return out;
}

// ---- verdicts ----

function writeAtomic(path: string, text: string) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** .pixel/triage.json: the verdicts, for finding_list. */
export function writeVerdicts(runId: string) {
  const rows = db
    .query<{ id: string; verdict: string; verdict_note: string | null; verdict_at: number }, [string]>(
      "SELECT id, verdict, verdict_note, verdict_at FROM findings WHERE run_id = ? AND verdict IS NOT NULL",
    )
    .all(runId);
  const findings = Object.fromEntries(rows.map((r) => [r.id, { verdict: VERDICT_WORDS[r.verdict as Verdict] ?? r.verdict, note: r.verdict_note, at: new Date(r.verdict_at).toISOString() }]));
  const dir = join(workbasePath(runId), ".pixel");
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, "triage.json"), JSON.stringify({ findings }, null, 2) + "\n");
}

/** The human's verdict on one finding (null clears it). Returns the updated finding. */
export async function setVerdict(runId: string, id: string, verdict: Verdict | null, note: string | null, send?: (runId: string, text: string) => Promise<unknown>) {
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
    writeVerdicts(runId);
    const run = getRun(runId);
    if (run) writeTriage(run);
  } catch (e) {
    console.error(`writing verdicts for ${runId}`, e);
  }
  const run = getRun(runId);
  if (verdict === "needs_work" && send && run && (run.status === "running" || run.status === "recovering")) {
    await send(runId, `Triage on ${id} “${finding.title}”: needs more work.${cleanNote ? ` ${cleanNote}` : ""}`).catch((e) => console.error("needs-work message failed", e));
  }
  return finding;
}

export const verdictWord = (v: string) => VERDICT_WORDS[v as Verdict] ?? v;
