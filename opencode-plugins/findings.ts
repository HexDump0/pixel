/**
 * opencode plugin: the finding tools. The agent records what it finds as it goes (leads, suspected
 * bugs, confirmed bugs, things ruled out) instead of writing PROGRESS.md, so the dashboard can count,
 * mark and triage findings one by one.
 *
 * Agents can't reach Pixel's API, so the tools write the run's workbase: FINDINGS.json is the source of
 * truth and FINDINGS.md is regenerated after every change (for peer agents and the Files tab). Pixel
 * reads the file. The human's verdicts come back in .pixel/triage.json, which `finding_list` shows.
 *
 * The workbase comes from PIXEL_WORKBASE (set by every Pixel runtime). The main agent and its subagents
 * share one opencode process, so writes are serialised in-process and written atomically.
 *
 * `@opencode-ai/plugin` is installed into the config dir by opencode itself at startup.
 * Only the plugin itself is exported: opencode calls every exported function in a plugin file as a plugin.
 */
import { tool } from "@opencode-ai/plugin";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

type State = "lead" | "suspected" | "confirmed" | "ruled_out";
type Severity = "critical" | "high" | "medium" | "low" | "info";

interface Change {
  at: string;
  by: string;
  action: "add" | "update" | "remove";
  changes: Record<string, [unknown, unknown]>;
  note?: string;
}

interface Finding {
  id: string;
  title: string;
  state: State;
  severity?: Severity;
  class?: string;
  location?: string;
  poc?: string;
  summary: string;
  created: string;
  updated: string;
  by: string;
  agent?: string;
  removed: null | { at: string; reason: string; duplicate_of?: string };
  history: Change[];
}

interface FindingsFile {
  version: 1;
  next: number;
  findings: Finding[];
}

interface Verdict {
  verdict: string;
  note?: string | null;
  at?: string | number;
}

const STATES: State[] = ["lead", "suspected", "confirmed", "ruled_out"];
const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];
const FIELDS = ["title", "state", "severity", "class", "location", "poc", "summary"] as const;

const workbase = () => {
  const w = process.env.PIXEL_WORKBASE;
  if (!w) throw new Error("PIXEL_WORKBASE is not set: the finding tools only work inside a Pixel run");
  return w;
};
const jsonPath = () => join(workbase(), "FINDINGS.json");

function load(): FindingsFile {
  const p = jsonPath();
  if (!existsSync(p)) return { version: 1, next: 1, findings: [] };
  const data = JSON.parse(readFileSync(p, "utf8"));
  if (!Array.isArray(data?.findings)) throw new Error("FINDINGS.json is damaged (no findings list); fix or delete it");
  const maxId = Math.max(0, ...data.findings.map((f: Finding) => Number(String(f.id).replace(/^F/, "")) || 0));
  return { version: 1, next: Math.max(Number(data.next) || 1, maxId + 1), findings: data.findings };
}

function atomicWrite(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function verdicts(): Record<string, Verdict> {
  try {
    return JSON.parse(readFileSync(join(workbase(), ".pixel", "triage.json"), "utf8"))?.findings ?? {};
  } catch {
    return {};
  }
}

const STATE_TITLES: Record<State, string> = { confirmed: "Confirmed", suspected: "Suspected", lead: "Leads", ruled_out: "Ruled out" };

function markdown(file: FindingsFile) {
  const v = verdicts();
  const out = ["# Findings", "", "Written by the finding tools; FINDINGS.json is the source of truth. Don't edit by hand.", ""];
  for (const state of ["confirmed", "suspected", "lead", "ruled_out"] as State[]) {
    const list = file.findings.filter((f) => !f.removed && f.state === state);
    if (!list.length) continue;
    out.push(`## ${STATE_TITLES[state]}`, "");
    for (const f of list) {
      const meta = [f.severity, f.class, f.location && `\`${f.location}\``, f.poc && `PoC \`${f.poc}\``, v[f.id] && `triage: ${v[f.id].verdict}`].filter(Boolean).join(" · ");
      out.push(`### ${f.id}: ${f.title}`, "", ...(meta ? [meta, ""] : []), f.summary, "");
      const last = [...f.history].reverse().find((h) => h.note);
      if (state === "ruled_out" && last?.note) out.push(`Ruled out: ${last.note}`, "");
    }
  }
  const removed = file.findings.filter((f) => f.removed);
  if (removed.length) {
    out.push("## Removed", "");
    for (const f of removed) out.push(`- ${f.id}: ${f.title} (${f.removed!.duplicate_of ? `duplicate of ${f.removed!.duplicate_of}` : f.removed!.reason})`);
    out.push("");
  }
  return out.join("\n");
}

function save(file: FindingsFile) {
  atomicWrite(jsonPath(), JSON.stringify(file, null, 2) + "\n");
  atomicWrite(join(workbase(), "FINDINGS.md"), markdown(file));
}

/** One write at a time: the main agent and its subagents share this process. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => T): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

function find(file: FindingsFile, id: string) {
  const norm = /^\d+$/.test(id.trim()) ? `F${id.trim()}` : id.trim().toUpperCase();
  const f = file.findings.find((x) => x.id === norm);
  if (!f) throw new Error(`No finding ${id}. finding_list shows the ids.`);
  return f;
}

function check(args: Record<string, any>) {
  if (args.state !== undefined && !STATES.includes(args.state)) throw new Error(`state must be one of ${STATES.join(", ")}`);
  if (args.severity !== undefined && args.severity !== null && !SEVERITIES.includes(args.severity)) throw new Error(`severity must be one of ${SEVERITIES.join(", ")}`);
  if (args.title !== undefined && (!String(args.title).trim() || String(args.title).length > 120)) throw new Error("title must be 1 to 120 characters");
  if (args.summary !== undefined && (!String(args.summary).trim() || String(args.summary).length > 1500)) throw new Error("summary must be 1 to 1500 characters");
}

/** PoC path relative to the workbase, plus a warning when it doesn't exist. */
function pocPath(poc: string | undefined) {
  if (!poc) return { poc: undefined, warn: "" };
  const wb = workbase();
  const full = isAbsolute(poc) ? poc : resolve(wb, poc);
  const rel = relative(wb, full);
  if (rel.startsWith("..")) return { poc, warn: ` Note: the PoC ${poc} is outside your workbase; copy it into the workbase so the human can get it.` };
  return { poc: rel, warn: existsSync(full) ? "" : ` Note: ${rel} doesn't exist in your workbase yet.` };
}

function line(f: Finding, v?: Verdict) {
  const head = `${f.id} ${f.state.padEnd(9)} ${(f.severity ?? "").padEnd(8)} ${f.title}`;
  const rest = [f.location, f.poc].filter(Boolean).join(" · ");
  const triage = v ? `  [triage: ${v.verdict}${v.note ? `: ${v.note}` : ""}]` : "";
  const removed = f.removed ? `  [removed: ${f.removed.duplicate_of ? `duplicate of ${f.removed.duplicate_of}` : f.removed.reason}]` : "";
  return `${head}${rest ? ` · ${rest}` : ""}${triage}${removed}`;
}

const now = () => new Date().toISOString();

export const Findings = async () => {
  const z = tool.schema;
  const state = z.enum(STATES as [State, ...State[]]);
  const severity = z.enum(SEVERITIES as [Severity, ...Severity[]]);
  const by = (ctx: { sessionID: string }) => ctx.sessionID;

  return {
    tool: {
      finding_add: tool({
        description:
          "Record a finding as soon as you have it: a lead worth checking (state lead), a suspected bug (suspected), or a reproduced bug (confirmed, with a PoC). The human watches this list while you work. Returns the new id (F1, F2, …).",
        args: {
          title: z.string().describe("Short title, at most 120 characters, e.g. 'Heap overflow in iCCP decompression'"),
          summary: z.string().describe("What it is and why you think so, at most 1500 characters"),
          state: state.optional().describe("lead (default), suspected or confirmed"),
          severity: severity.optional().describe("critical, high, medium, low or info; optional for leads"),
          class: z.string().optional().describe("Bug class, e.g. heap-buffer-overflow, use-after-free, integer-overflow"),
          location: z.string().optional().describe("Where: file:line or function name"),
          poc: z.string().optional().describe("Proof of concept path, relative to your workbase"),
        },
        async execute(args, ctx) {
          check(args);
          if (args.state === "ruled_out") throw new Error("Add it as a lead or suspected, then rule it out with finding_update and a note");
          return serial(() => {
            const file = load();
            const { poc, warn } = pocPath(args.poc);
            const f: Finding = {
              id: `F${file.next++}`,
              title: args.title.trim(),
              state: args.state ?? "lead",
              ...(args.severity && { severity: args.severity }),
              ...(args.class && { class: args.class }),
              ...(args.location && { location: args.location }),
              ...(poc && { poc }),
              summary: args.summary.trim(),
              created: now(),
              updated: now(),
              by: by(ctx),
              agent: ctx.agent,
              removed: null,
              history: [{ at: now(), by: by(ctx), action: "add", changes: {} }],
            };
            file.findings.push(f);
            save(file);
            const pocWarn = f.state === "confirmed" && !f.poc ? " Note: confirmed without a PoC; add one with finding_update when you have it." : "";
            return `Added ${f.id} (${f.state}${f.severity ? `, ${f.severity}` : ""}): ${f.title}.${warn}${pocWarn}`;
          });
        },
      }),

      finding_update: tool({
        description:
          "Change a finding: confirm it (give the PoC path), rule it out (say why in note), change its severity, or correct its text. A note is required when the state changes.",
        args: {
          id: z.string().describe("Finding id, e.g. F3"),
          note: z.string().optional().describe("Why it changed; required when state changes (e.g. 'reproduced with the ASan build', 'length is checked in png_check_chunk_length')"),
          title: z.string().optional(),
          summary: z.string().optional(),
          state: state.optional().describe("lead, suspected, confirmed or ruled_out"),
          severity: severity.optional(),
          class: z.string().optional(),
          location: z.string().optional(),
          poc: z.string().optional().describe("Proof of concept path, relative to your workbase"),
        },
        async execute(args, ctx) {
          check(args);
          return serial(() => {
            const file = load();
            const f = find(file, args.id);
            if (f.removed) throw new Error(`${f.id} was removed (${f.removed.reason}); add a new finding instead`);
            const { poc, warn } = pocPath(args.poc);
            const next: Record<string, unknown> = { ...args, poc };
            const changes: Record<string, [unknown, unknown]> = {};
            for (const k of FIELDS) {
              const v = next[k];
              if (v === undefined || v === (f as any)[k]) continue;
              changes[k] = [(f as any)[k] ?? null, v];
            }
            if (!Object.keys(changes).length && !args.note) return `${f.id} unchanged.`;
            if (changes.state && !args.note?.trim()) throw new Error("Say why the state changes: pass a note");
            for (const [k, [, v]] of Object.entries(changes)) (f as any)[k] = typeof v === "string" ? v.trim() : v;
            f.updated = now();
            f.by = by(ctx);
            f.agent = ctx.agent;
            f.history.push({ at: f.updated, by: f.by, action: "update", changes, ...(args.note && { note: args.note.trim() }) });
            save(file);
            const what = Object.entries(changes).map(([k, [a, b]]) => (k === "summary" || k === "title" ? k : `${k} ${a ?? "none"} → ${b}`));
            const pocWarn = f.state === "confirmed" && !f.poc ? " Note: confirmed without a PoC; add one when you have it." : "";
            return `Updated ${f.id}${what.length ? `: ${what.join(", ")}` : " (note added)"}.${warn}${pocWarn}`;
          });
        },
      }),

      finding_remove: tool({
        description: "Remove a finding that was a mistake or a duplicate (kept in history, hidden from the list). To say a finding is not a bug, use finding_update with state ruled_out instead.",
        args: {
          id: z.string().describe("Finding id, e.g. F3"),
          reason: z.string().describe("Why, e.g. 'duplicate', 'recorded by mistake'"),
          duplicate_of: z.string().optional().describe("The finding this duplicates, e.g. F2"),
        },
        async execute(args, ctx) {
          return serial(() => {
            const file = load();
            const f = find(file, args.id);
            if (f.removed) return `${f.id} was already removed.`;
            const dup = args.duplicate_of ? find(file, args.duplicate_of).id : undefined;
            if (dup === f.id) throw new Error("A finding can't duplicate itself");
            f.removed = { at: now(), reason: args.reason.trim() || "removed", ...(dup && { duplicate_of: dup }) };
            f.updated = f.removed.at;
            f.by = by(ctx);
            f.history.push({ at: f.updated, by: f.by, action: "remove", changes: {}, note: dup ? `${f.removed.reason} (duplicate of ${dup})` : f.removed.reason });
            save(file);
            return `Removed ${f.id}.`;
          });
        },
      }),

      finding_list: tool({
        description:
          "List the findings with the human's triage verdicts and notes. Check it when you start, after a restart, and before you write the report.",
        args: {
          state: state.optional().describe("Only this state"),
          include_removed: z.boolean().optional().describe("Also list removed findings"),
        },
        async execute(args) {
          const file = load();
          const v = verdicts();
          const list = file.findings.filter((f) => (args.include_removed || !f.removed) && (!args.state || f.state === args.state));
          if (!list.length) return file.findings.length ? "No findings match." : "No findings yet.";
          const order = { confirmed: 0, suspected: 1, lead: 2, ruled_out: 3 };
          list.sort((a, b) => order[a.state] - order[b.state] || Number(a.id.slice(1)) - Number(b.id.slice(1)));
          return list.map((f) => line(f, v[f.id])).join("\n");
        },
      }),
    },
  };
};
