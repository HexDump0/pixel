/**
 * "Copy for LLM": one finding as a single markdown text to paste into another model (README, run and
 * target, PoC and small files inline), plus a download token for what didn't fit. Each copy mints a new
 * random token that only opens that finding's files (the folder as a .tar.gz, or one file) and expires
 * after a week. It is sent as `Authorization: Bearer`, never in the URL; Pixel keeps only its sha256.
 */
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { config } from "./config.ts";
import { db, getRun } from "./db.ts";
import { disclosureWord, dispositionWord, getFinding, listFindings, triageText, type FindingRow } from "./findings.ts";
import { safeWorkbasePath, workbasePath } from "./knowledge.ts";

const TOKEN_MS = 7 * 24 * 3_600_000;
const MAX_FILES = 200;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
/** What gets pasted inline: the PoC up to POC_BYTES, other text files up to FILE_BYTES each, INLINE_BYTES in all. */
const POC_BYTES = 32 * 1024;
const FILE_BYTES = 8 * 1024;
const INLINE_BYTES = 64 * 1024;

/** What the copied text asks the model to do. */
export const LLM_PURPOSES = ["verify", "disclose", "variants"] as const;
export type LlmPurpose = (typeof LLM_PURPOSES)[number];

const TASKS: Record<LlmPurpose | "triage" | "list", string> = {
  verify:
    "Check this finding independently. Reproduce it with the PoC against the target, confirm the root cause in the source, and say whether it is real, how severe it is and how it can be reached. Compare it with the findings already triaged in this project (above): if it has the same sink and preconditions as one of them, say which. Then look for variants: the same mistake elsewhere in the code.",
  disclose:
    "Write the security report to send to the project's maintainers (their security contact or a private advisory). First check that the bug is still present at the latest upstream commit. Then write: a one-paragraph summary; affected versions or commits; the root cause with file and line references; how it is reached and the preconditions; the impact; a severity with your reasoning (a CVSS vector if it fits); exact reproduction steps with the PoC; and a suggested fix. Stick to what the PoC and the code show. Plain markdown, no marketing tone.",
  variants:
    "Use this finding as a pattern. Find its root cause in the source, then search the rest of the codebase for the same mistake: other callers of the same function, copies of the same code, sibling parsers or handlers that make the same assumption. For each candidate say where it is, whether it is reachable, and how you would confirm it. Skip the ones already triaged in this project (above).",
  triage:
    "Triage each finding. For each, decide one of: report (a real, novel bug worth disclosing), known (the same bug is already public: say where), duplicate (same root cause as another finding here: say which), weak (real, but the preconditions or impact don't justify a disclosure) or invalid (not a bug). Give the severity you would assign (critical, high, medium, low, info or none) judged on this bug's own preconditions, and one line of why. Answer as a table: finding, disposition, severity, why.",
  list: "",
};

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

/** A new token for one finding's files. Expired tokens are dropped on the way. */
export function mintToken(run: string, fid: string, now = Date.now()) {
  db.query("DELETE FROM share_tokens WHERE expires < ?").run(now);
  const token = "pxf_" + randomBytes(32).toString("base64url");
  const expires = now + TOKEN_MS;
  db.query("INSERT INTO share_tokens (hash, run_id, finding_id, created, expires) VALUES (?, ?, ?, ?, ?)").run(hashOf(token), run, fid, now, expires);
  return { token, expires };
}

/** The finding a request's bearer token opens, or null if it is missing, unknown or expired. */
export function checkToken(req: Request, now = Date.now()) {
  const token = /^Bearer (pxf_[\w-]+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!token) return null;
  const row = db.query<{ run_id: string; finding_id: string; expires: number }, [string]>("SELECT run_id, finding_id, expires FROM share_tokens WHERE hash = ?").get(hashOf(token));
  if (!row || row.expires < now) return null;
  db.query("UPDATE share_tokens SET used_at = ? WHERE hash = ?").run(now, hashOf(token));
  return { run: row.run_id, fid: row.finding_id };
}

/** The finding's files, relative to the workbase: its whole folder, or the README alone for a flat F3-name.md, plus a PoC kept elsewhere. */
function findingFiles(f: FindingRow) {
  const out: { rel: string; size: number }[] = [];
  const add = (rel: string) => {
    try {
      const st = statSync(safeWorkbasePath(f.run_id, rel));
      if (st.isFile() && !out.some((x) => x.rel === rel)) out.push({ rel, size: st.size });
    } catch {
      // gone or outside the workbase
    }
  };
  const folder = f.path?.endsWith("/README.md") ? dirname(f.path) : null;
  if (folder) {
    const base = workbasePath(f.run_id);
    const walk = (dir: string) => {
      let entries;
      try {
        entries = readdirSync(join(base, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= MAX_FILES) return;
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (e.isFile()) add(join(dir, e.name));
      }
    };
    walk(folder);
  } else if (f.path) add(f.path);
  if (f.poc) add(f.poc);
  return { folder, files: out };
}

/** Where a file sits in the archive and in the text: relative to the finding's folder. */
const shortName = (rel: string, folder: string | null) => (folder && rel.startsWith(folder + "/") ? relative(folder, rel) : basename(rel));

function readText(runId: string, rel: string, max: number) {
  const buf = readFileSync(safeWorkbasePath(runId, rel));
  if (buf.subarray(0, 8000).includes(0)) return null;
  return { text: buf.subarray(0, max).toString("utf8"), cut: buf.length > max };
}

/** A fence longer than any run of backticks in the text, so pasted files can't close it early. */
function fenced(text: string, lang = "") {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((s) => s.length));
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${text.replace(/\n$/, "")}\n${f}`;
}

const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Everything about one finding as one markdown text. `origin` is where the download commands point. */
export function llmBrief(runId: string, fid: string, origin: string, purpose?: LlmPurpose) {
  const f = getFinding(runId, fid);
  if (!f) throw new Error(`no finding ${fid} in ${runId}`);
  const run = getRun(runId);
  const { folder, files } = findingFiles(f);
  const share = files.length ? mintToken(runId, fid) : null;

  // Default: write the disclosure for a finding that is ready to send, else check it.
  const task: LlmPurpose = purpose ?? (f.disposition === "report" && (f.disclosure ?? "ready") === "ready" ? "disclose" : "verify");
  const parts = [`# ${f.id}: ${f.title}`, factLines(f, run).join("\n")];

  let readme = f.summary;
  if (f.path) {
    try {
      readme = readText(runId, f.path, 1024 * 1024)?.text ?? readme;
    } catch {
      // the folder is gone; the stored summary is what's left
    }
  }
  parts.push(`## Report (${f.path ?? "README.md"})`, fenced(readme, "markdown"));

  let budget = INLINE_BYTES;
  const inline = (rel: string, max: number) => {
    const t = readText(runId, rel, Math.min(max, budget));
    if (!t) return null;
    budget -= t.text.length;
    return t;
  };
  if (f.poc) {
    const poc = files.find((x) => x.rel === f.poc);
    const name = shortName(f.poc, folder);
    if (!poc) parts.push(`## PoC: ${name}`, "Not found in the workbase.");
    else {
      const t = inline(poc.rel, POC_BYTES);
      parts.push(`## PoC: ${name} (${kb(poc.size)})`, t ? fenced(t.text) + (t.cut ? `\n\n(cut at ${kb(t.text.length)}; the whole file is in the download)` : "") : "Binary; it is in the download.");
    }
  }

  const others = files.filter((x) => x.rel !== f.path && x.rel !== f.poc);
  if (others.length) {
    const lines = others.map((x) => `- ${shortName(x.rel, folder)} (${kb(x.size)})`);
    const shown: string[] = [];
    for (const x of others) {
      if (budget <= 0 || x.size > FILE_BYTES) continue;
      const t = inline(x.rel, FILE_BYTES);
      if (t && !t.cut) shown.push(`### ${shortName(x.rel, folder)}\n\n${fenced(t.text)}`);
    }
    parts.push(`## Other files${shown.length < others.length ? " (the larger or binary ones are only in the download)" : ""}`, lines.join("\n"), ...shown);
  }

  if (share) {
    const base = `${origin}/api/share/${encodeURIComponent(fid)}`;
    const example = files.find((x) => x.rel !== f.path) ?? files[0];
    parts.push(
      "## Download",
      `The finding's files (${files.length}, ${kb(files.reduce((s, x) => s + x.size, 0))}) can be downloaded with this token. It opens only these files and expires on ${new Date(share.expires).toISOString().slice(0, 10)}.`,
      fenced(
        [
          `export PIXEL_TOKEN='${share.token}'`,
          "# everything, as a folder named after the finding",
          `curl -fL -H "Authorization: Bearer $PIXEL_TOKEN" '${base}.tar.gz' | tar xz`,
          "# or one file, by its name above",
          `curl -fL -H "Authorization: Bearer $PIXEL_TOKEN" '${base}/files/${shortName(example.rel, folder).split("/").map(encodeURIComponent).join("/")}' -O`,
        ].join("\n"),
        "sh",
      ),
    );
  }

  if (task !== "disclose") {
    const prior = priorArt(f);
    if (prior) parts.push(prior);
  }
  parts.push("## Task", TASKS[task]);
  return { text: parts.join("\n\n") + "\n", expires: share?.expires ?? null, purpose: task };
}

const day = (ts: number | null) => (ts ? new Date(ts).toISOString().slice(0, 10) : "");

/** The facts about a finding as markdown list lines: target, the agent's claim, and the human's triage and disclosure. */
function factLines(f: FindingRow, run: ReturnType<typeof getRun>, withRun = true) {
  const agentSev = f.severity ? `, ${f.severity} severity` : "";
  return [
    withRun && run && `- Target: ${run.repo}${run.ref ? ` (${run.ref})` : ""}${run.commit_sha ? ` at commit ${run.commit_sha}` : ""}`,
    `- Finding: ${f.run_id}/${f.id}, the agent says ${f.state.replace("_", " ")}${agentSev}${f.class ? `, ${f.class}` : ""}`,
    f.location && `- Location: ${f.location}`,
    f.removed_at && `- Removed: ${f.removed_reason ?? "its folder was deleted"} (kept for the record)`,
    f.disposition && `- Triage (human): ${triageText(f)}${f.severity_final && f.severity_final !== f.severity ? ` (the agent said ${f.severity ?? "no severity"})` : ""}`,
    f.disposition === "duplicate" && f.duplicate_of && dupTitle(f.duplicate_of) && `- Duplicate of: ${f.duplicate_of}, ${dupTitle(f.duplicate_of)}`,
    f.disposition_note && `- Triage note: ${f.disposition_note.replace(/\s+/g, " ").trim()}`,
    !f.disposition && f.agent_duplicate_of && `- The agent says it duplicates ${f.agent_duplicate_of}`,
    f.disposition === "report" && f.disclosure && `- Disclosure: ${disclosureWord(f.disclosure)}${f.reported_at ? `, sent ${day(f.reported_at)}` : ""}${f.report_url ? ` (${f.report_url})` : ""}${f.fix_ref ? `, fix ${f.fix_ref}` : ""}${f.fixed_at ? ` on ${day(f.fixed_at)}` : ""}${f.disclosure_note ? `: ${f.disclosure_note}` : ""}`,
    withRun && run && `- Found by: ${run.model}, Pixel run ${run.label ?? run.id}`,
  ].filter(Boolean) as string[];
}

function dupTitle(ref: string) {
  const i = ref.lastIndexOf("/");
  return getFinding(ref.slice(0, i), ref.slice(i + 1))?.title ?? null;
}

/** Findings already triaged in the same repository (other than this one), so the model can spot a repeat. */
function priorArt(f: FindingRow, max = 40) {
  if (!f.repo) return null;
  const rows = listFindings({ triaged: true }).filter((x) => x.repo === f.repo && !(x.run_id === f.run_id && x.id === f.id));
  if (!rows.length) return null;
  const lines = rows.slice(0, max).map((x) => `- ${x.run_id}/${x.id} (${triageText(x)}${x.severity_final ? "" : x.severity ? `, ${x.severity}` : ""}): ${x.title}${x.location ? `, at ${x.location}` : ""}`);
  return [`## Already triaged in this project (${rows.length})`, lines.join("\n") + (rows.length > max ? `\n- and ${rows.length - max} more` : "")].join("\n\n");
}

/** Per finding in a list copy: the README up to this much, shrinking when the list is long. */
const LIST_BYTES = 160 * 1024;

/**
 * Several findings as one markdown text: the facts and README of each (cut to share LIST_BYTES), grouped by
 * project, and a task for the purpose. No download tokens: copy one finding on its own for its files.
 */
export function llmList(ids: string[], purpose: LlmPurpose | "triage" | "list", title?: string) {
  const found: FindingRow[] = [];
  const missing: string[] = [];
  for (const ref of [...new Set(ids)]) {
    const i = ref.lastIndexOf("/");
    const f = i > 0 ? getFinding(ref.slice(0, i), ref.slice(i + 1)) : null;
    if (f) found.push(f);
    else missing.push(ref);
  }
  if (!found.length) throw new Error(`no such findings: ${missing.slice(0, 5).join(", ")}`);
  const per = Math.max(1500, Math.floor(LIST_BYTES / found.length));
  const runs = new Map(found.map((f) => [f.run_id, getRun(f.run_id)]));
  const byRepo = new Map<string, FindingRow[]>();
  for (const f of found) byRepo.set(f.repo ?? "unknown", [...(byRepo.get(f.repo ?? "unknown") ?? []), f]);
  const parts = [`# ${title?.trim() || "Findings"} (${found.length})`];
  if (purpose === "list") parts.push("Findings from Pixel's audit runs, each with the agent's claim and the human's triage where there is one. Each README is cut to fit; ask for one finding on its own for the full text and its files.");
  for (const [repo, list] of byRepo) {
    parts.push(`## ${repo}`);
    for (const f of list) {
      const run = runs.get(f.run_id) ?? null;
      const target = run ? `- Commit: ${run.commit_sha ?? run.ref ?? "unknown"}` : null;
      const body = f.summary.length > per ? `${f.summary.slice(0, per)}\n\n[cut: ${f.summary.length - per} more characters]` : f.summary;
      parts.push(`### ${f.run_id}/${f.id}: ${f.title}`, [...factLines(f, run, false), target].filter(Boolean).join("\n"), fenced(body || "(no text)", "markdown"));
    }
  }
  if (missing.length) parts.push(`(Not found: ${missing.join(", ")})`);
  if (TASKS[purpose]) parts.push("## Task", TASKS[purpose]);
  return { text: parts.join("\n\n") + "\n", count: found.length };
}

/** The .tar.gz of a finding: `<fid>/…` with its files. */
function findingArchive(f: FindingRow) {
  const { folder, files } = findingFiles(f);
  // Read into memory: Bun.Archive writes a Bun.file() entry as empty.
  const entries: Record<string, Uint8Array> = {};
  let total = 0;
  for (const x of files) {
    if ((total += x.size) > MAX_ARCHIVE_BYTES) break;
    entries[`${f.id}/${shortName(x.rel, folder)}`] = readFileSync(safeWorkbasePath(f.run_id, x.rel));
  }
  return new Bun.Archive(entries, { compress: "gzip" }).blob();
}

/**
 * GET /api/share/<fid>.tar.gz and /api/share/<fid>/files/<name>: answered before the login check, the token
 * is the permission. Only the files the copied text lists can be fetched, whatever the path says.
 */
export async function serveShare(req: Request, path: string) {
  const m = /^\/api\/share\/([^/]+?)(?:\.tar\.gz|\/files\/(.+))$/.exec(path);
  if (!m) return Response.json({ error: "not found" }, { status: 404 });
  const s = checkToken(req);
  if (!s) return Response.json({ error: "send a valid token as Authorization: Bearer pxf_...; it may have expired" }, { status: 401 });
  const f = getFinding(s.run, s.fid);
  if (!f || decodeURIComponent(m[1]) !== s.fid) return Response.json({ error: "this token is for another finding" }, { status: 403 });
  if (!m[2]) return new Response(await findingArchive(f), { headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="${f.id}.tar.gz"` } });
  const { folder, files } = findingFiles(f);
  const name = decodeURIComponent(m[2]);
  const file = files.find((x) => shortName(x.rel, folder) === name);
  if (!file) return Response.json({ error: `no file ${name} in ${f.id}` }, { status: 404 });
  return new Response(Bun.file(safeWorkbasePath(f.run_id, file.rel)), { headers: { "content-disposition": `attachment; filename="${basename(name)}"` } });
}

/** Where the download commands point: PIXEL_PUBLIC_URL, else the host the request came in on (behind a proxy, its forwarded host). */
export function originOf(req: Request) {
  if (config.publicUrl) return config.publicUrl.replace(/\/$/, "");
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}
