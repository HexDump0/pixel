/**
 * Runs started from a finding: a check on the latest upstream code (is the bug still there?) or a hunt for
 * variants (the same root cause elsewhere). Both are ordinary runs of the same repository with a prompt built
 * from the finding; `runs.source_finding` and `source_kind` link them back.
 *
 * A check run answers in its REPORT.md with a header (`result: present | fixed | changed | unclear`, `commit`,
 * `fixed_by`); Pixel reads it as the agent writes it and records it on the finding as its upstream check.
 * A variants run is a normal audit with its own findings.
 */
import { readFileSync, statSync } from "node:fs";
import { getRun, listRuns, ACTIVE_STATUSES, type RunRow } from "./db.ts";
import { getFinding, parseReadme, recordUpstream, UPSTREAM_STATUSES, type FindingRow, type UpstreamStatus } from "./findings.ts";
import { reportPath } from "./knowledge.ts";
import { createRun } from "./runs/create.ts";
import { setRun } from "./runs/state.ts";
import { getSettings } from "./settings.ts";
import { latestVersion } from "./templates.ts";

export const FINDING_RUN_KINDS = ["check", "variants"] as const;
export type FindingRunKind = (typeof FINDING_RUN_KINDS)[number];

export interface FindingRunInput {
  kind: FindingRunKind;
  /** Branch or tag to check out; empty = the repository's default branch. */
  ref?: string | null;
  model?: string;
  size?: string;
  keyId?: string;
}

/** Text from a finding going into a prompt: no template braces, one line. */
const plain = (s: string | null | undefined) => (s ?? "").replace(/[{}]/g, "").replace(/\s+/g, " ").trim();

function where(src: RunRow, f: FindingRow) {
  const folder = f.path?.endsWith("/README.md") ? f.path.slice(0, -"/README.md".length) : null;
  const file = f.location?.split(/[:\s]/)[0] || null;
  return [
    `- Finding: ${src.id}/${f.id}, "${plain(f.title)}"${f.severity ? ` (${f.severity})` : ""}`,
    f.path && `- Its write-up: \`{{workbases}}/${src.id}/${f.path}\` (read it first)`,
    folder && `- Its folder, with the PoC and logs: \`{{workbases}}/${src.id}/${folder}/\``,
    f.location && `- Where: \`${plain(f.location)}\``,
    `- Found at commit \`${src.commit_sha ?? "unknown"}\`${src.ref ? ` (${plain(src.ref)})` : ""}`,
    f.disposition && `- Human triage: ${f.disposition}${f.disposition_note ? `, ${plain(f.disposition_note)}` : ""}`,
    file && `- File: \`${plain(file)}\``,
  ]
    .filter(Boolean)
    .join("\n");
}

export function checkPrompt(src: RunRow, f: FindingRow) {
  const file = plain(f.location?.split(/[:\s]/)[0]) || "<the file>";
  return `{{> environment}}

## Your task: is this bug still in the latest code?

An earlier audit of this project found the bug below. The target is a fresh clone of the latest code. Find out whether the bug is still there, and nothing else: don't audit for new bugs.

${where(src, f)}

1. Build the target the way the write-up says (same sanitizers and options).
2. Run the PoC the same way and compare with the original crash or output.
3. If it doesn't reproduce, find out why: \`git log --oneline ${src.commit_sha ?? "<old commit>"}..HEAD -- ${file}\` and the diffs around the location usually show the fix; name the commit. If the code changed but the bug may still be reachable another way, try that.

Write your answer to \`{{workbase}}/REPORT.md\`, starting with this header:

\`\`\`
---
result: present      # present | fixed | changed | unclear
commit: <the commit you tested>
fixed_by: <the commit that fixed it, if fixed>
---
\`\`\`

Then one or two short paragraphs: what you built and ran, what happened (the trace, trimmed), and for fixed or changed, the commit and what it changed. \`changed\` means the code moved or changed so the original PoC no longer applies, but the bug may still be there; \`unclear\` means you couldn't build or run it. Then stop.
`;
}

export function variantsPrompt(src: RunRow, f: FindingRow) {
  return `{{> environment}}

## Your task: variants of a known bug

An earlier audit of this project found the bug below. Use it as a pattern and find the same root cause elsewhere in the target.

${where(src, f)}

Read the write-up and the PoC and find the root cause in the source. Then look for the same mistake: other callers of the same function, copies of the same code, sibling handlers or parsers that make the same assumption, the same pattern in other files. Check each candidate for reachability and try to trigger it. Record each one as a finding and say in its README how it relates to ${src.id}/${f.id}. Don't record the original bug again; if a candidate turns out to be the same bug, put \`duplicate_of: ${src.id}/${f.id}\` in its header.

{{> findings}}

{{> report}}
`;
}

const KIND_LABEL: Record<FindingRunKind, string> = { check: "on latest", variants: "variants" };

/** Start a check or a variants run from a finding. */
export function startFindingRun(runId: string, fid: string, o: FindingRunInput) {
  if (!FINDING_RUN_KINDS.includes(o.kind)) throw new Error(`kind must be one of ${FINDING_RUN_KINDS.join(", ")}`);
  const src = getRun(runId);
  if (!src) throw new Error(`no run ${runId}`);
  const f = getFinding(runId, fid);
  if (!f) throw new Error(`no finding ${fid} in ${runId}`);
  const s = getSettings();
  const size = o.size || (o.kind === "check" && s.sizePresets.light ? "light" : undefined);
  const run = createRun({
    repo: src.repo,
    ref: o.ref?.trim() || undefined,
    templateId: src.template_id && latestVersion(src.template_id) ? src.template_id : "audit",
    model: o.model || src.model,
    variant: o.model ? undefined : (src.variant ?? undefined),
    size,
    keyId: o.keyId,
    parentRun: src.id,
    promptOverride: o.kind === "check" ? checkPrompt(src, f) : variantsPrompt(src, f),
  });
  return setRun(run.id, { label: `${src.label ?? src.id} ${f.id} ${KIND_LABEL[o.kind]}`.slice(0, 80), source_finding: `${src.id}/${f.id}`, source_kind: o.kind })!;
}

/** REPORT.md mtimes already read, per check run. */
const seen = new Map<string, number>();

/** Read a check run's answer (REPORT.md header) onto its finding when it changes. */
export function readCheck(run: RunRow) {
  if (run.source_kind !== "check" || !run.source_finding) return false;
  let mtime: number;
  try {
    mtime = Math.floor(statSync(reportPath(run.id)).mtimeMs);
  } catch {
    return false;
  }
  if (seen.get(run.id) === mtime) return false;
  seen.set(run.id, mtime);
  const { fields, body } = parseReadme(readFileSync(reportPath(run.id), "utf8"));
  const result = fields.result?.toLowerCase();
  if (!result || !(UPSTREAM_STATUSES as readonly string[]).includes(result)) return false;
  const i = run.source_finding.lastIndexOf("/");
  return recordUpstream(run.source_finding.slice(0, i), run.source_finding.slice(i + 1), {
    status: result as UpstreamStatus,
    commit: fields.commit?.slice(0, 64) || run.commit_sha,
    fixedBy: fields.fixed_by?.slice(0, 64) || null,
    note: body.trim().slice(0, 4000) || null,
    at: mtime,
    run: run.id,
  });
}

/** Check runs that are live or just finished (and all of them once at start). */
export function readChecks(all = false) {
  const now = Date.now();
  for (const r of listRuns()) {
    if (r.source_kind !== "check") continue;
    if (all || ACTIVE_STATUSES.includes(r.status) || (r.finished_at && now - r.finished_at < 15 * 60_000)) {
      try {
        readCheck(r);
      } catch (e) {
        console.error(`check run ${r.id}`, e);
      }
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startCheckWatch(everyMs = 5000) {
  readChecks(true);
  timer ??= setInterval(() => readChecks(), everyMs);
}
export function stopCheckWatch() {
  if (timer) clearInterval(timer);
  timer = null;
}
