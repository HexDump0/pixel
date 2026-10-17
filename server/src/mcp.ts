/**
 * MCP server for agents outside Pixel (Claude Code, opencode or any MCP client on the user's own machine):
 * runs, findings, token usage, workbase files, and controlling runs.
 *
 * Streamable HTTP at POST /api/mcp, stateless, JSON responses only (no SSE stream: every tool answers at once).
 * Same login as the API (Authorization: Bearer <PIXEL_PASSWORD>), checked before it gets here.
 * Tools call the API's own handlers through `dispatch`, so they behave exactly like the dashboard.
 * Not for Pixel's own run agents: they keep working from plain files in the workbases (decisions.md, 2026-10-15).
 */
import { dispatch, routeList } from "./api/router.ts";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/** Longest tool answer, so one call can't flood the agent's context. */
const MAX_TEXT = 60_000;

const INSTRUCTIONS = `Pixel runs many long-lived audit agents (opencode) against repositories. Each run has a workbase folder with its notes, findings (findings/F<n>-name/README.md) and REPORT.md.
Start with list_runs or list_findings. get_finding gives a finding as one self-contained markdown brief (with download commands for its files). token_usage covers tokens and cost.
Runs are controlled with send_message, control_run, answer_question and create_run. For anything without a tool, use pixel_api (it lists every route).`;

interface Ctx {
  req: Request;
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
  const res = await dispatch(new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), url);
  const type = res.headers.get("content-type") ?? "";
  const data: any = type.includes("json") ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) throw new Error(data?.error ?? `${method} ${path}: HTTP ${res.status}`);
  return data as T;
}

const enc = encodeURIComponent;
const iso = (ts: number | null | undefined) => (ts ? new Date(ts).toISOString().slice(0, 19).replace("T", " ") + "Z" : null);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n[cut: ${s.length - n} more characters]` : s);
const str = { type: "string" } as const;
const num = { type: "number" } as const;
const bool = { type: "boolean" } as const;
const runArg = { type: "string", description: "Run id, as list_runs shows it" } as const;

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

function compactFinding(f: any) {
  return {
    run: f.run_id,
    id: f.id,
    title: f.title,
    state: f.state,
    severity: f.severity,
    class: f.class ?? undefined,
    location: f.location ?? undefined,
    poc: f.poc ?? undefined,
    summary: f.summary ? clip(f.summary, 400) : undefined,
    verdict: f.verdict ?? undefined,
    verdictNote: f.verdict_note ?? undefined,
    duplicateOf: f.duplicate_of ?? undefined,
    problem: f.problem ?? undefined,
    removed: f.removed_at ? (f.removed_reason ?? "removed") : undefined,
    path: f.path ?? undefined,
    created: iso(f.created),
    updated: iso(f.updated),
  };
}

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
    description: "Runs with status, repo, model, token totals, cost, finding counts and pending questions; most recently active first.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Comma-separated statuses to keep, e.g. running,paused (others: queued, preparing, recovering, stopped, done, failed)" },
        repo: { type: "string", description: "Keep runs whose repo contains this text" },
        limit: { type: "number", description: "Default 50" },
      },
    },
    async run(a, ctx) {
      const want = a.status ? new Set(String(a.status).split(",").map((s) => s.trim())) : null;
      const runs = (await api<any[]>(ctx, "GET", "/runs"))
        .filter((r) => !want || want.has(r.status))
        .filter((r) => !a.repo || r.repo.toLowerCase().includes(String(a.repo).toLowerCase()))
        .sort((x, y) => (y.last_activity ?? y.created_at) - (x.last_activity ?? x.created_at));
      return { total: runs.length, runs: runs.slice(0, a.limit ?? 50).map(compactRun) };
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
    description: "Findings the agents wrote (findings/F<n>-name/README.md in each workbase): title, state (lead, suspected, confirmed, ruled_out), severity, location, verdict.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        run: { type: "string", description: "Only this run" },
        severity: { type: "string", description: "critical, high, medium, low or info" },
        state: { type: "string", description: "lead, suspected, confirmed or ruled_out" },
        untriaged: { type: "boolean", description: "Only findings without a verdict" },
        limit: { type: "number", description: "Default 100" },
      },
    },
    async run(a, ctx) {
      const q = new URLSearchParams();
      if (a.run) q.set("run", a.run);
      if (a.severity) q.set("severity", a.severity);
      if (a.untriaged) q.set("untriaged", "1");
      const all = (await api<any[]>(ctx, "GET", `/findings?${q}`)).filter((f) => !a.state || f.state === a.state);
      return { total: all.length, findings: all.slice(0, a.limit ?? 100).map(compactFinding) };
    },
  },
  {
    name: "get_finding",
    title: "Finding brief",
    description:
      "Everything about one finding as markdown: target, state, severity, the README, the PoC and small files inline, and curl commands (with a one-week token) to download the rest.",
    readOnly: true,
    inputSchema: { type: "object", properties: { run: runArg, finding: { type: "string", description: "Finding id, e.g. F3" } }, required: ["run", "finding"] },
    async run(a, ctx) {
      return (await api(ctx, "GET", `/runs/${enc(a.run)}/findings/${enc(a.finding)}/llm`)).text;
    },
  },
  {
    name: "finding_history",
    title: "Finding history",
    description: "Changes to findings over time (created, state or severity changed, verdicts). Pixel-wide unless a run is given.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { run: { type: "string" }, finding: { type: "string", description: "Only this finding (needs run)" }, limit: { type: "number", description: "Default 200" } },
    },
    async run(a, ctx) {
      const q = new URLSearchParams({ limit: String(a.limit ?? 200) });
      if (a.finding) q.set("finding", a.finding);
      return api(ctx, "GET", a.run ? `/runs/${enc(a.run)}/findings/events?${q}` : `/findings/events?${q}`);
    },
  },
  {
    name: "set_finding_verdict",
    title: "Set finding verdict",
    description: "Record the human's verdict on a finding (goes into the run's TRIAGE.md). It does not message the agent. verdict null clears it.",
    inputSchema: {
      type: "object",
      properties: {
        run: runArg,
        finding: str,
        verdict: { type: ["string", "null"], enum: ["real", "not_bug", "duplicate", null] },
        note: { type: "string" },
      },
      required: ["run", "finding", "verdict"],
    },
    async run(a, ctx) {
      return compactFinding(await api(ctx, "POST", `/runs/${enc(a.run)}/findings/${enc(a.finding)}/verdict`, { verdict: a.verdict, note: a.note ?? null }));
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
    description: "The run's REPORT.md, or null if the agent hasn't written one.",
    readOnly: true,
    inputSchema: { type: "object", properties: { run: runArg }, required: ["run"] },
    async run(a, ctx) {
      return (await api(ctx, "GET", `/runs/${enc(a.run)}/report`)).content ?? "No REPORT.md yet.";
    },
  },
  {
    name: "list_files",
    title: "List workbase files",
    description: "A folder of a run's workbase (its notes, findings, report and scratch files). Path is relative to the workbase; empty = its top.",
    readOnly: true,
    inputSchema: { type: "object", properties: { run: runArg, path: { type: "string", description: "Folder, default the workbase itself" } }, required: ["run"] },
    async run(a, ctx) {
      const rows = await api<any[]>(ctx, "GET", `/runs/${enc(a.run)}/files?path=${enc(a.path ?? "")}`);
      return rows.map((f) => (f.dir ? `${f.path}/` : `${f.path}  ${f.size} B  ${iso(f.mtime)}`)).join("\n") || "(empty)";
    },
  },
  {
    name: "read_file",
    title: "Read workbase file",
    description: "A text file from a run's workbase. Path is relative to the workbase.",
    readOnly: true,
    inputSchema: { type: "object", properties: { run: runArg, path: str }, required: ["run", "path"] },
    async run(a, ctx) {
      const f = await api(ctx, "GET", `/runs/${enc(a.run)}/file?path=${enc(a.path)}`);
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
    description: "Call any Pixel API route directly, for whatever the other tools don't cover. Paths are relative to /api, e.g. GET /fleet. Query strings go in the path.",
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
function toolList() {
  return TOOLS.map((t) => ({
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
  try {
    const out = await tool.run(params.arguments ?? {}, ctx);
    const text = typeof out === "string" ? out : JSON.stringify(out, null, 1);
    return { content: [{ type: "text", text: clip(text, MAX_TEXT) }] };
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
      return reply(m.id, { tools: toolList() });
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
  // A browser page from another site must not reach this through a logged-in or password-less Pixel.
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (origin && URL.parse(origin)?.host !== host)
    return Response.json(fail(null, -32600, "cross-origin request refused"), { status: 403 });
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });

  let body: RpcMessage | RpcMessage[];
  try {
    body = await req.json();
  } catch {
    return Response.json(fail(null, -32700, "parse error"), { status: 400 });
  }
  const ctx = { req };
  const batch = Array.isArray(body);
  const messages: RpcMessage[] = Array.isArray(body) ? body : [body];
  const replies = (await Promise.all(messages.map((m) => handle(m, ctx)))).filter((r) => r !== null);
  if (!replies.length) return new Response(null, { status: 202 });
  return Response.json(batch ? replies : replies[0]);
}
