/**
 * MCP server for agents outside Pixel (Claude Code, opencode or any MCP client on the user's own machine):
 * runs, findings, token usage, workbase files, and controlling runs.
 *
 * Streamable HTTP at POST /api/mcp, stateless, JSON responses only (no SSE stream: every tool answers at once).
 * Opened only by MCP access tokens made in Settings (mcpTokens.ts), sent as Authorization: Bearer pxm_...;
 * a read token sees only the tools that look, a full token everything. The dashboard password doesn't open it.
 * Tools call the API's own handlers through `dispatch`, so they behave exactly like the dashboard.
 * Not for Pixel's own run agents: they keep working from plain files in the workbases (decisions.md, 2026-10-15).
 */
import { dispatch, routeList } from "./api/router.ts";
import { markUsed, mcpTokenOf, type PublicMcpToken } from "./mcpTokens.ts";
import { matchSnippet } from "./findings.ts";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/** Longest tool answer, so one call can't flood the agent's context (opencode also cuts tool output at 60,000). */
const MAX_TEXT = 60_000;
/**
 * JSON answers stay under this whole: a list is cut to the rows that fit (with `next` to continue),
 * anything else too big is an error saying how to narrow it. JSON cut in the middle can't be parsed,
 * and a client would read it as text and see no results.
 */
const JSON_BUDGET = 55_000;

const INSTRUCTIONS = `Pixel runs many long-lived audit agents (opencode) against repositories. Each run has a workbase folder with its notes, findings (findings/F<n>-name/README.md) and REPORT.md.
Start with list_runs or list_findings. get_finding gives a finding as one self-contained markdown brief (with download commands for its files). token_usage covers tokens and cost.
Runs are controlled with send_message, control_run, answer_question and create_run. For anything without a tool, use pixel_api (it lists every route).

How to use it well:
- Lists come in pages. Each answer has total, offset, returned and next; pass offset = next until next is null. A page can hold fewer rows than your limit, because answers stay under 55,000 characters.
- To count or scan findings, use list_findings with brief: true (no summary or PoC, many rows per page), then get_finding for the ones you need in full. Don't ask for huge limits.
- Filter on the server instead of fetching everything: run, repo, severity (the agent's: critical, high, medium, low, info, or none), final_severity (after triage), state (lead, suspected, confirmed, ruled_out), disposition, disclosure, view, untriaged, triaged. Separate several values with commas; case doesn't matter.
- To find prior art ("has anyone reported an auth bypass in this file?"), use search_findings: words across title, location, class, text and repo of every run, best match first.
- An error result is an error, not an empty answer: read its text and adjust the call (an unknown filter value or an answer too big says what to change).
- Finding counts on runs (list_runs) leave out leads, which are ideas rather than findings to triage; they're counted apart as leads. list_findings includes leads unless you filter by state. In run counts, findings without a severity count as info.
- Triage has two parts. disposition is the judgement, given once: report (a real, novel bug worth disclosing), known (the same bug is already public), duplicate (same root cause as another finding; duplicateOf says which), weak (real, but the preconditions or impact don't justify a disclosure), invalid (not a bug), or null before triage. severityFinal is the triage's severity (null = agrees with the agent's severity). disclosure applies only to report: ready, reported (sent upstream), fixed, dropped; people set it in the dashboard, you can only read it. The agent's own state and severity stay as the agent wrote them.
- Only people and MCP clients triage, never the run agents; dispositionBy says who ("dashboard" or "MCP: <token name>"). agentDuplicateOf is the run agent's own claim that a finding repeats another one: a hint, not a triage.
- When triaging: before calling something report, search for the same sink in that repo; if a known or duplicate matches, use that. Don't copy severities from neighbouring findings: judge each bug's own preconditions. Use triage_findings for many at once. get_report is null until the agent writes REPORT.md.
- Workbase paths are relative to the workbase, e.g. findings/F3-name/README.md, with no leading slash.
- Times are ISO 8601 UTC.
- If a call fails with a connection error (such as ECONNRESET), retry it once before giving up.
- Prefer the dedicated tools. With pixel_api, always add limit and offset to list routes (GET /runs, /findings, /runs/<id>/findings).`;

interface Ctx {
  req: Request;
  token: PublicMcpToken;
}
interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Reads only. Tools without it change something. */
  readOnly?: boolean;
  destructive?: boolean;
  run: (args: any, ctx: Ctx) => Promise<unknown>;
}

// ---- calling the API from inside ----

/** Headers that decide the public address in links (finding briefs), copied from the MCP request. */
const FORWARD = ["host", "x-forwarded-host", "x-forwarded-proto"];

async function api<T = any>(ctx: Ctx, method: string, path: string, body?: unknown): Promise<T> {
  const outer = new URL(ctx.req.url);
  const url = new URL(`${outer.origin}/api${path}`);
  const headers = new Headers({ "content-type": "application/json" });
  for (const h of FORWARD) {
    const v = ctx.req.headers.get(h);
    if (v) headers.set(h, v);
  }
  // So a triage records which token gave it.
  headers.set("x-pixel-mcp-token", encodeURIComponent(ctx.token.name));
  const res = await dispatch(new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), url);
  const type = res.headers.get("content-type") ?? "";
  const data: any = type.includes("json") ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) throw new Error(data?.error ?? `${method} ${path}: HTTP ${res.status}`);
  return data as T;
}

const enc = encodeURIComponent;
const iso = (ts: number | null | undefined) => (ts ? new Date(ts).toISOString().replace(/\.\d{3}Z$/, "Z") : null);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n[cut: ${s.length - n} more characters]` : s);
const str = { type: "string" } as const;
const num = { type: "number" } as const;
const bool = { type: "boolean" } as const;
const runArg = { type: "string", description: "Run id, as list_runs shows it" } as const;
const offsetArg = { type: "number", description: "Rows to skip; use the previous answer's next" } as const;
const wbPath = (p: unknown, what: string) => {
  const v = String(p ?? "");
  if (v.startsWith("/") || /^[a-z]:[\\/]/i.test(v)) throw new Error(`${what} is relative to the workbase, e.g. findings/F1-name/README.md; absolute paths aren't allowed`);
  return v;
};

/** One page of a list, cut further if needed so the answer stays under JSON_BUDGET. */
function fitPage<T>(key: string, all: T[], offset: unknown, limit: unknown, fallback: number, extra: Record<string, unknown> = {}) {
  const from = Math.max(0, Math.floor(Number(offset) || 0));
  const want = Math.max(0, Math.floor(limit === undefined || limit === null ? fallback : Number(limit)));
  const rows = all.slice(from, from + want);
  const make = (n: number) => ({ total: all.length, offset: from, returned: n, next: from + n < all.length ? from + n : null, ...extra, [key]: rows.slice(0, n) });
  let n = rows.length;
  while (n > 0 && JSON.stringify(make(n)).length > JSON_BUDGET) n = Math.min(n - 1, Math.floor(n * 0.85));
  return n < rows.length ? { ...make(n), note: `Cut to ${n} rows to stay under the size limit; continue with offset ${from + n}${key === "findings" ? " or pass brief: true" : ""}.` } : make(n);
}

/** The parts of a run worth an agent's context. */
function compactRun(r: any) {
  return {
    id: r.id,
    name: r.label ?? undefined,
    status: r.status,
    detail: r.status_detail ?? undefined,
    agent: r.agent_status ?? undefined,
    asleep: r.asleep ? true : undefined,
    repo: r.repo,
    ref: r.ref ?? undefined,
    commit: r.commit_sha ?? undefined,
    language: r.language ?? undefined,
    template: r.template_id ? `${r.template_id} v${r.template_version}` : undefined,
    model: r.variant ? `${r.model} (${r.variant})` : r.model,
    autopilot: !!r.autopilot,
    created: iso(r.created_at),
    started: iso(r.started_at),
    finished: iso(r.finished_at),
    lastActivity: iso(r.last_activity),
    tokens: { input: r.tokens_in, output: r.tokens_out, reasoning: r.tokens_reasoning, cache: r.tokens_cache },
    costUsd: Math.round(r.cost * 10000) / 10000,
    continues: r.continues || undefined,
    oomRestarts: r.oom_restarts || undefined,
    findings: r.findings ?? undefined,
    pendingQuestions: r.questions || undefined,
    parentRun: r.parent_run ?? undefined,
    report: r.report_ready ? true : undefined,
    triaged: iso(r.triaged_at) ?? undefined,
  };
}

function compactFinding(f: any, brief = false) {
  return {
    run: f.run_id,
    id: f.id,
    repo: f.repo ?? undefined,
    title: f.title,
    state: f.state,
    severity: f.severity,
    class: f.class ?? undefined,
    location: f.location ?? undefined,
    poc: f.poc && !brief ? clip(f.poc, 400) : undefined,
    summary: f.summary && !brief ? clip(f.summary, 400) : undefined,
    disposition: f.disposition ?? null,
    severityFinal: f.severity_final ?? undefined,
    duplicateOf: f.duplicate_of ?? undefined,
    dispositionNote: f.disposition_note ? (brief ? clip(f.disposition_note, 300) : f.disposition_note) : undefined,
    dispositionBy: f.disposition ? (f.disposition_by ?? "dashboard") : undefined,
    agentDuplicateOf: f.agent_duplicate_of ?? undefined,
    disclosure: f.disclosure ?? undefined,
    reported: iso(f.reported_at) ?? undefined,
    reportUrl: f.report_url ?? undefined,
    fixed: iso(f.fixed_at) ?? undefined,
    fixRef: f.fix_ref ?? undefined,
    disclosureNote: f.disclosure_note ?? undefined,
    problem: f.problem ? clip(f.problem, 300) : undefined,
    removed: f.removed_at ? (f.removed_reason ?? "removed") : undefined,
    path: f.path ?? undefined,
    created: iso(f.created),
    updated: iso(f.updated),
  };
}

/** The finding filters list_findings and search_findings share, as query parameters. */
const FILTER_ARGS = {
  run: { type: "string", description: "Only this run" },
  repo: { type: "string", description: "Only runs whose repository contains this text, e.g. libpng" },
  severity: { type: "string", description: "The agent's severity: critical, high, medium, low, info, or none; comma-separated for several" },
  final_severity: { type: "string", description: "The severity after triage (the final one, else the agent's): critical, high, medium, low, info, none" },
  state: { type: "string", description: "lead, suspected, confirmed or ruled_out; comma-separated for several" },
  disposition: { type: "string", description: "report, known, duplicate, weak, invalid, or none (not triaged); comma-separated for several" },
  disclosure: { type: "string", description: "ready, reported, fixed, dropped, or none; comma-separated for several" },
  view: { type: "string", enum: ["triage", "report", "resolved", "reviewed"], description: "The dashboard's lists: triage (suspected or confirmed, no disposition), report (to report: ready or reported), resolved (fixed or dropped), reviewed (any disposition)" },
  duplicate_of: { type: "string", description: "Only findings triaged as duplicates of this one (<run>/<id>)" },
  untriaged: { type: "boolean", description: "Only findings without a disposition (and not ruled out)" },
  triaged: { type: "boolean", description: "Only findings with a disposition" },
} as const;

function filterQuery(a: any) {
  const q = new URLSearchParams();
  for (const k of ["run", "repo", "severity", "final_severity", "state", "disposition", "disclosure", "view", "duplicate_of"]) if (a[k]) q.set(k, String(a[k]));
  if (a.untriaged) q.set("untriaged", "1");
  if (a.triaged) q.set("triaged", "1");
  return q;
}

const TRIAGE_ITEM = {
  disposition: { type: ["string", "null"], enum: ["report", "known", "duplicate", "weak", "invalid", null], description: "null clears the triage; leave out to keep it" },
  severity: { type: ["string", "null"], enum: ["critical", "high", "medium", "low", "info", "none", null], description: "The final severity; null agrees with the agent. Leave out to keep it" },
  duplicate_of: { type: ["string", "null"], description: "Needed for duplicate: the finding it repeats, <run>/<id> or an id in the same run" },
  note: { type: ["string", "null"], description: "Why; for known, where it's public (CVE, issue). Leave out to keep it" },
} as const;

/** One transcript message as short text: what was said, and each tool call with its input and output cut down. */
function renderMessage(m: { info: any; parts: any[] }, reasoning: boolean) {
  const i = m.info ?? {};
  const t = i.tokens;
  const head = [i.role ?? "?", iso(i.time?.created), i.modelID && `${i.providerID}/${i.modelID}`, t && `in ${t.input ?? 0} out ${t.output ?? 0} cache ${t.cache?.read ?? 0}`]
    .filter(Boolean)
    .join("  ");
  const out = [`### ${head}`];
  for (const p of m.parts) {
    if (p.type === "text" && p.text?.trim()) out.push(clip(p.text.trim(), 4000));
    else if (p.type === "reasoning" && reasoning && p.text?.trim()) out.push(`(thinking) ${clip(p.text.trim(), 2000)}`);
    else if (p.type === "tool") {
      const s = p.state ?? {};
      const input = s.input ? clip(JSON.stringify(s.input), 600) : "";
      const res = s.status === "error" ? `error: ${s.error ?? ""}` : typeof s.output === "string" ? s.output : "";
      out.push(`[${p.tool} ${s.status ?? ""}] ${input}${res.trim() ? `\n  -> ${clip(res.trim(), 1500).replace(/\n/g, "\n     ")}` : ""}`);
    }
  }
  if (i.error) out.push(`error: ${i.error.name ?? ""} ${i.error.data?.message ?? ""}`);
  return out.join("\n");
}

const CONTROL_ACTIONS = ["continue", "abort", "pause", "resume", "stop", "done", "retry", "restart-opencode"] as const;

// ---- tools ----

const TOOLS: Tool[] = [
  {
    name: "list_runs",
    title: "List runs",
    description:
      "Runs with status, repo, model, token totals, cost, finding counts and pending questions; most recently active first. Paged: pass offset = next for more. Finding counts leave out leads (counted on their own as leads); findings without a severity count as info.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Comma-separated statuses to keep, e.g. running,paused (others: queued, preparing, recovering, stopped, done, failed)" },
        repo: { type: "string", description: "Keep runs whose repo contains this text" },
        limit: { type: "number", description: "Default 50" },
        offset: offsetArg,
      },
    },
    async run(a, ctx) {
      const want = a.status ? new Set(String(a.status).split(",").map((s) => s.trim())) : null;
      const runs = (await api<any[]>(ctx, "GET", "/runs"))
        .filter((r) => !want || want.has(r.status))
        .filter((r) => !a.repo || r.repo.toLowerCase().includes(String(a.repo).toLowerCase()))
        .sort((x, y) => (y.last_activity ?? y.created_at) - (x.last_activity ?? x.created_at));
      return fitPage("runs", runs.map(compactRun), a.offset, a.limit, 50);
    },
  },
  {
    name: "get_run",
    title: "Run details",
    description: "One run: its state, prompt, sessions (subagents), todo lists, questions asked, paths, attach command and cache totals.",
    readOnly: true,
    inputSchema: { type: "object", properties: { run: runArg }, required: ["run"] },
    async run(a, ctx) {
      const d = await api(ctx, "GET", `/runs/${enc(a.run)}`);
      // The attach and shell commands hand over the agent's machine: full tokens only.
      if (ctx.token.access !== "full") delete d.attach, delete d.shell;
      return {
        ...d,
        run: compactRun(d.run),
        prompt: d.prompt ? clip(d.prompt, 8000) : null,
        sessions: d.sessions.map((s: any) => ({ id: s.id, parent: s.parent_id, title: s.title, agent: s.agent, cost: s.cost, tokens: JSON.parse(s.tokens || "{}"), created: iso(s.created_at) })),
      };
    },
  },
  {
    name: "get_timeline",
    title: "Run timeline",
    description: "What happened to a run, newest last: status changes, restarts, messages, findings, questions.",
    readOnly: true,
    inputSchema: { type: "object", properties: { run: runArg, limit: { type: "number", description: "Last N entries, default 100" } }, required: ["run"] },
    async run(a, ctx) {
      const rows = await api<any[]>(ctx, "GET", `/runs/${enc(a.run)}/timeline`);
      return rows
        .slice(-(a.limit ?? 100))
        .map((t) => `${iso(t.ts)}  ${t.actor}  ${t.kind}  ${t.message}`)
        .join("\n");
    },
  },
  {
    name: "get_transcript",
    title: "Run transcript",
    description: "The agent's conversation as text (its messages and tool calls, long outputs cut). Main session unless a session id is given (get_run lists subagent sessions).",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        run: runArg,
        session: { type: "string", description: "Session id; default the run's main session" },
        last: { type: "number", description: "Last N messages, default 30" },
        reasoning: { type: "boolean", description: "Include the model's thinking; default false" },
      },
      required: ["run"],
    },
    async run(a, ctx) {
      const msgs = await api<any[]>(ctx, "GET", `/runs/${enc(a.run)}/transcript${a.session ? `?session=${enc(a.session)}` : ""}`);
      const n = Math.max(1, a.last ?? 30);
      const shown = msgs.slice(-n);
      const head = msgs.length > shown.length ? `(${msgs.length - shown.length} earlier messages not shown)\n\n` : "";
      return head + shown.map((m) => renderMessage(m, !!a.reasoning)).join("\n\n");
    },
  },
  {
    name: "list_findings",
    title: "List findings",
    description:
      "Findings the agents wrote (findings/F<n>-name/README.md in each workbase), newest change first: title, repo, state and severity (the agent's), location, the triage (disposition, severityFinal, duplicateOf, note), disclosure, the start of the summary and PoC. brief: true leaves the summary and PoC out (many more rows per page). Removed findings aren't listed. Paged: pass offset = next until next is null. To count or scan many, use brief: true. For words in the text, use search_findings.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        ...FILTER_ARGS,
        brief: { type: "boolean", description: "Leave out the summary and PoC" },
        limit: { type: "number", description: "Default 100" },
        offset: offsetArg,
      },
    },
    async run(a, ctx) {
      const all = await api<any[]>(ctx, "GET", `/findings?${filterQuery(a)}`);
      return fitPage("findings", all.map((f) => compactFinding(f, !!a.brief)), a.offset, a.limit, 100);
    },
  },
  {
    name: "search_findings",
    title: "Search findings",
    description:
      "Findings of every run whose title, location, class, text or repository contain all the words, best match first (title, then location), with where the text matched. Quotes keep a phrase together: \"heap overflow\" pngrutil. Takes the same filters as list_findings, e.g. disposition: \"report,known,duplicate\" for prior art. Brief rows; use get_finding for one in full.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Words to look for" }, ...FILTER_ARGS, limit: { type: "number", description: "Default 30" }, offset: offsetArg },
      required: ["query"],
    },
    async run(a, ctx) {
      const q = filterQuery(a);
      q.set("q", String(a.query ?? ""));
      const all = await api<any[]>(ctx, "GET", `/findings?${q}`);
      return fitPage("findings", all.map((f) => ({ ...compactFinding(f, true), match: matchSnippet(f, a.query) || undefined })), a.offset, a.limit, 30);
    },
  },
  {
    name: "get_finding",
    title: "Finding brief",
    description:
      "Everything about one finding as markdown: target, the agent's state and severity, the triage and disclosure, the README, the PoC and small files inline, findings already triaged in the same project, and curl commands (with a one-week token) to download the rest. Ends with a task for the purpose: verify (check it, the default), disclose (write the report for the maintainers; the default for a finding ready to report) or variants (look for the same mistake elsewhere).",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { run: runArg, finding: { type: "string", description: "Finding id, e.g. F3" }, purpose: { type: "string", enum: ["verify", "disclose", "variants"] } },
      required: ["run", "finding"],
    },
    async run(a, ctx) {
      return (await api(ctx, "GET", `/runs/${enc(a.run)}/findings/${enc(a.finding)}/llm${a.purpose ? `?purpose=${enc(a.purpose)}` : ""}`)).text;
    },
  },
  {
    name: "finding_history",
    title: "Finding history",
    description: "Changes to findings over time (created, state or severity changed, triage, disclosure). Pixel-wide unless a run is given.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { run: { type: "string" }, finding: { type: "string", description: "Only this finding (needs run)" }, limit: { type: "number", description: "Default 200" } },
    },
    async run(a, ctx) {
      const q = new URLSearchParams({ limit: String(a.limit ?? 200) });
      if (a.finding) q.set("finding", a.finding);
      const events = await api<any[]>(ctx, "GET", a.run ? `/runs/${enc(a.run)}/findings/events?${q}` : `/findings/events?${q}`);
      return fitPage("events", events.map((e) => ({ ...e, at: iso(e.at) })), 0, events.length, events.length);
    },
  },
  {
    name: "triage_finding",
    title: "Triage a finding",
    description:
      "Triage one finding: disposition (report, known, duplicate, weak, invalid; null clears), the final severity (null = agrees with the agent), duplicate_of (needed for duplicate) and a note. Fields you leave out stay as they are. Goes into the run's TRIAGE.md and TRIAGED.md; it doesn't message the agent. Disclosure (reported, fixed) is set by people in the dashboard. For many, use triage_findings.",
    inputSchema: { type: "object", properties: { run: runArg, finding: str, ...TRIAGE_ITEM }, required: ["run", "finding"] },
    async run(a, ctx) {
      const { run, finding, ...rest } = a;
      return compactFinding(await api(ctx, "POST", `/runs/${enc(run)}/findings/${enc(finding)}/triage`, rest), true);
    },
  },
  {
    name: "triage_findings",
    title: "Triage many findings",
    description:
      "Triage up to 500 findings in one call (an import, or a batch you reviewed). Each item is {run, finding, disposition, severity, duplicate_of, note} as in triage_finding; each is applied on its own and reported as ok or with its error, so fix and resend only the failed ones. A duplicate_of must point at a finding that exists.",
    inputSchema: {
      type: "object",
      properties: { items: { type: "array", maxItems: 500, items: { type: "object", properties: { run: runArg, finding: str, ...TRIAGE_ITEM }, required: ["run", "finding"] } } },
      required: ["items"],
    },
    async run(a, ctx) {
      const res = await api(ctx, "POST", "/findings/triage", { items: a.items });
      return { ok: res.ok, failed: res.failed, errors: res.results.filter((r: any) => !r.ok).map((r: any) => ({ run: r.run, finding: r.finding, error: r.error })) };
    },
  },
  {
    name: "token_usage",
    title: "Token usage",
    description:
      "Tokens and cost. Without a run: totals for the last N days and all time, cache hit rate and savings, per model (with median call time), the top 20 runs, run and finding counts. With a run: that run's totals, cache split and cost per API key.",
    readOnly: true,
    inputSchema: { type: "object", properties: { days: { type: "number", description: "1 to 90, default 7" }, run: { type: "string" } } },
    async run(a, ctx) {
      if (a.run) {
        const [d, keys] = await Promise.all([api(ctx, "GET", `/runs/${enc(a.run)}`), api(ctx, "GET", `/runs/${enc(a.run)}/keys`).catch(() => null)]);
        const c = d.cache;
        const prompt = c.input + c.read + c.write;
        return {
          run: a.run,
          model: d.run.model,
          tokens: compactRun(d.run).tokens,
          prompt: { input: c.input, cacheRead: c.read, cacheWrite: c.write, hitRate: prompt ? c.read / prompt : null },
          costUsd: d.run.cost,
          costByKey: keys?.costs ?? [],
          sessions: d.sessions.map((s: any) => ({ id: s.id, title: s.title, agent: s.agent, cost: s.cost, tokens: JSON.parse(s.tokens || "{}") })),
        };
      }
      const s = await api(ctx, "GET", `/stats?days=${a.days ?? 7}`);
      return {
        window: { days: s.window.days, from: iso(s.window.from), to: iso(s.window.to) },
        totals: s.totals,
        allTime: s.allTime,
        cacheSavings: s.savings,
        byModel: s.byModel,
        byRun: s.byRun.map(({ hue, ...r }: any) => r),
        runs: s.runs,
        findings: s.findings,
        providerEvents: s.providerEvents,
      };
    },
  },
  {
    name: "get_report",
    title: "Run report",
    description: "The run's REPORT.md, or null (not an error) if the agent hasn't written one yet.",
    readOnly: true,
    inputSchema: { type: "object", properties: { run: runArg }, required: ["run"] },
    async run(a, ctx) {
      return (await api(ctx, "GET", `/runs/${enc(a.run)}/report`)).content ?? null;
    },
  },
  {
    name: "list_files",
    title: "List workbase files",
    description: "A folder of a run's workbase (its notes, findings, report and scratch files). Path is relative to the workbase (no leading slash); empty = its top.",
    readOnly: true,
    inputSchema: { type: "object", properties: { run: runArg, path: { type: "string", description: "Folder, default the workbase itself" } }, required: ["run"] },
    async run(a, ctx) {
      const rows = await api<any[]>(ctx, "GET", `/runs/${enc(a.run)}/files?path=${enc(wbPath(a.path, "path"))}`);
      return rows.map((f) => (f.dir ? `${f.path}/` : `${f.path}  ${f.size} B  ${iso(f.mtime)}`)).join("\n") || "(empty)";
    },
  },
  {
    name: "read_file",
    title: "Read workbase file",
    description: "A text file from a run's workbase. Path is relative to the workbase, e.g. findings/F3-name/README.md (no leading slash).",
    readOnly: true,
    inputSchema: { type: "object", properties: { run: runArg, path: str }, required: ["run", "path"] },
    async run(a, ctx) {
      const f = await api(ctx, "GET", `/runs/${enc(a.run)}/file?path=${enc(wbPath(a.path, "path"))}`);
      if (f.binary) return `Binary file, ${f.size} bytes. Download it with get_finding's commands or the dashboard.`;
      return f.truncated ? `${f.content}\n[file is ${f.size} bytes; only the first part is shown]` : f.content;
    },
  },
  {
    name: "search_workbases",
    title: "Search workbases",
    description: "Find files across every run's workbase that contain all the given words; newest first, with the first matching line.",
    readOnly: true,
    inputSchema: { type: "object", properties: { query: str, limit: { type: "number", description: "Default 30" } }, required: ["query"] },
    async run(a, ctx) {
      return api(ctx, "GET", `/search?q=${enc(a.query)}&limit=${a.limit ?? 30}`);
    },
  },
  {
    name: "new_run_options",
    title: "Models and templates",
    description: "What create_run accepts: the offered models (with context size and prices) and the prompt templates.",
    readOnly: true,
    inputSchema: { type: "object", properties: {} },
    async run(_, ctx) {
      const [m, t] = await Promise.all([api(ctx, "GET", "/models"), api<any[]>(ctx, "GET", "/templates")]);
      return { defaultModel: m.defaultModel, models: m.models, templates: t.map((x) => ({ id: x.id, name: x.name, version: x.version, runs: x.runs })) };
    },
  },
  {
    name: "create_run",
    title: "Start a run",
    description: "Start a new agent run on a repository. Template and model ids come from new_run_options.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Git URL or owner/name" },
        templateId: str,
        ref: { type: "string", description: "Branch, tag or commit" },
        model: { type: "string", description: "provider/model; default the Settings default" },
        variant: { type: "string", description: "Thinking level, if the model has them" },
        size: { type: "string", description: "Machine size preset" },
        name: str,
        autopilot: { type: "boolean", description: "Keep the agent going on its own; default true" },
        parentRun: { type: "string", description: "Earlier run whose workbase this one starts from" },
      },
      required: ["repo", "templateId"],
    },
    async run(a, ctx) {
      const created = await api<any[]>(ctx, "POST", "/runs", a);
      return created.map(compactRun);
    },
  },
  {
    name: "send_message",
    title: "Message a run's agent",
    description: "Send a message to the run's agent, as the dashboard does. A paused or sleeping run wakes up for it.",
    inputSchema: { type: "object", properties: { run: runArg, text: str }, required: ["run", "text"] },
    async run(a, ctx) {
      return api(ctx, "POST", `/runs/${enc(a.run)}/message`, { text: a.text });
    },
  },
  {
    name: "control_run",
    title: "Control a run",
    description:
      "continue (send the usual continue message), abort (stop the current turn), pause, resume, stop, done (mark finished), retry (a failed prepare), restart-opencode.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: { run: runArg, action: { type: "string", enum: [...CONTROL_ACTIONS] }, message: { type: "string", description: "resume only: message to resume with" } },
      required: ["run", "action"],
    },
    async run(a, ctx) {
      if (!CONTROL_ACTIONS.includes(a.action)) throw new Error(`action must be one of ${CONTROL_ACTIONS.join(", ")}`);
      return api(ctx, "POST", `/runs/${enc(a.run)}/${a.action}`, a.action === "resume" ? { message: a.message } : {});
    },
  },
  {
    name: "answer_question",
    title: "Answer an agent's question",
    description: "Answer a pending question from a run's agent (get_run lists them with their options). One list of chosen labels or typed answers per question, or reject.",
    inputSchema: {
      type: "object",
      properties: {
        run: runArg,
        question: { type: "string", description: "The question request id" },
        answers: { type: "array", items: { type: "array", items: str } },
        reject: bool,
      },
      required: ["run", "question"],
    },
    async run(a, ctx) {
      return api(ctx, "POST", `/runs/${enc(a.run)}/question/${enc(a.question)}`, { answers: a.answers ?? [], reject: !!a.reject });
    },
  },
  {
    name: "pixel_api",
    title: "Pixel API",
    description:
      "Call any Pixel API route directly, for whatever the other tools don't cover. Paths are relative to /api, e.g. GET /fleet. Query strings go in the path. GET /runs, /findings and /runs/<id>/findings take limit and offset (the findings ones also the list_findings filters and q); an answer over 55,000 characters is refused, so page big lists.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"] },
        path: { type: "string", description: "Starts with /, e.g. /runs/<id>/metrics" },
        body: { type: "object", description: "JSON body for POST and PUT" },
      },
      required: ["method", "path"],
    },
    async run(a, ctx) {
      if (!String(a.path).startsWith("/") || String(a.path).startsWith("/mcp")) throw new Error("path must start with / and not be /mcp");
      return api(ctx, a.method, a.path, a.method === "GET" || a.method === "DELETE" ? undefined : (a.body ?? {}));
    },
  },
];

/** pixel_api's description gets the live route list, so the agent can see everything there is. */
const allowed = (t: Tool, ctx: Ctx) => ctx.token.access === "full" || !!t.readOnly;

function toolList(ctx: Ctx) {
  return TOOLS.filter((t) => allowed(t, ctx)).map((t) => ({
    name: t.name,
    title: t.title,
    description: t.name === "pixel_api" ? `${t.description}\n\nRoutes:\n${routeList().filter((r) => !r.includes("/mcp")).join("\n")}` : t.description,
    inputSchema: t.inputSchema,
    annotations: { title: t.title, readOnlyHint: !!t.readOnly, destructiveHint: !!t.destructive, openWorldHint: false },
  }));
}

// ---- JSON-RPC ----

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

const reply = (id: RpcMessage["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const fail = (id: RpcMessage["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function callTool(params: any, ctx: Ctx) {
  const tool = TOOLS.find((t) => t.name === params?.name);
  if (!tool) return null;
  if (!allowed(tool, ctx)) return { content: [{ type: "text", text: `The token "${ctx.token.name}" is read only; ${tool.name} needs a full-control token (Settings, Agent access).` }], isError: true };
  markUsed(ctx.token.id, tool.name);
  try {
    const out = await tool.run(params.arguments ?? {}, ctx);
    if (typeof out === "string") return { content: [{ type: "text", text: clip(out, MAX_TEXT) }] };
    const text = JSON.stringify(out ?? null);
    if (text.length > JSON_BUDGET)
      return {
        content: [{ type: "text", text: `The answer is ${text.length.toLocaleString("en")} characters, over the ${JSON_BUDGET.toLocaleString("en")} limit. Narrow it: filters, limit and offset, or a more specific tool.` }],
        isError: true,
      };
    return { content: [{ type: "text", text }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: e?.message ?? String(e) }], isError: true };
  }
}

async function handle(m: RpcMessage, ctx: Ctx) {
  if (m.method === undefined) return null; // a response to us; we never ask anything
  const isNotification = m.id === undefined;
  switch (m.method) {
    case "initialize": {
      const asked = m.params?.protocolVersion;
      return reply(m.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "pixel", title: "Pixel", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply(m.id, {});
    case "tools/list":
      return reply(m.id, { tools: toolList(ctx) });
    case "tools/call": {
      const out = await callTool(m.params, ctx);
      return out ? reply(m.id, out) : fail(m.id, -32602, `unknown tool ${m.params?.name}`);
    }
    default:
      return isNotification ? null : fail(m.id, -32601, `method not found: ${m.method}`);
  }
}

/** POST /api/mcp (the request is already logged in). */
export async function serveMcp(req: Request): Promise<Response> {
  // A browser page from another site has no business here.
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (origin && URL.parse(origin)?.host !== host)
    return Response.json(fail(null, -32600, "cross-origin request refused"), { status: 403 });
  const token = mcpTokenOf(req);
  if (!token) return Response.json(fail(null, -32001, "send an MCP access token as Authorization: Bearer pxm_... (make one in Pixel's Settings, Agent access); it may have expired or been revoked"), { status: 401 });
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });

  let body: RpcMessage | RpcMessage[];
  try {
    body = await req.json();
  } catch {
    return Response.json(fail(null, -32700, "parse error"), { status: 400 });
  }
  const ctx = { req, token };
  const batch = Array.isArray(body);
  const messages: RpcMessage[] = Array.isArray(body) ? body : [body];
  const replies = (await Promise.all(messages.map((m) => handle(m, ctx)))).filter((r) => r !== null);
  if (!replies.length) return new Response(null, { status: 202 });
  return Response.json(batch ? replies : replies[0]);
}
