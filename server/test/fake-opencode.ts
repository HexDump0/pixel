#!/usr/bin/env bun
/**
 * A tiny stand-in for `opencode serve` (opencode 2), for integration tests. Speaks the subset of the
 * HTTP API and event stream Pixel uses. Behaviour is scripted by the prompt text:
 *   "REPORT <path>"  write <path> then go idle
 *   "HANG"           stay busy forever
 *   "KEYCHECK"       a 402 "insufficient balance" error when any key in the config starts with "dead"
 *   "WRITE {json}"   write a file like the write tool does, one per line:
 *                    WRITE {"path":"/…/findings/F1-x/README.md","content":"…"}
 *   "BGSHELL <s>"    start a shell command in the background (running <s> seconds, listed by /api/shell) and
 *                    end the turn; when it ends, wake the session like opencode does (a REPORT is written then)
 *   "BGSUB <s>"      the same with a subagent in the background: a child session busy for <s> seconds
 *   "PROGRESS"       on this and each later prompt to the session, 12 tool calls then stop; the 4th writes the REPORT
 *   anything else    reply and go idle (no report)
 * Sessions on the fake provider's models (the speed and live tests) are scripted by model id instead:
 *   fake/fast    a ~300-token text answer
 *   fake/broken  a provider error
 *   fake/tool    asks for a shell permission and waits until it is answered
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const hostname = args.includes("--hostname") ? args[args.indexOf("--hostname") + 1] : "127.0.0.1";

type Session = { info: any; messages: any[]; busy: boolean; progress?: { report: string; n: number } };
const shells = new Map<string, { id: string; status: string; command: string; cwd: string; shell: string; file: string; metadata: {}; time: { started: number; completed?: number } }>();
const sessions = new Map<string, Session>();
const clients = new Set<ReadableStreamDefaultController<string>>();
const permissions = new Map<string, { id: string; sessionID: string; action: string; resources: string[]; reply?: string }>();
let n = 0;
const id = (p: string) => `${p}_${Date.now().toString(36)}${(n++).toString(36).padStart(4, "0")}`;
const zero = () => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });

function emit(type: string, data: unknown) {
  const line = `data: ${JSON.stringify({ id: id("evt"), created: Date.now(), type, data })}\n\n`;
  for (const c of clients) c.enqueue(line);
}

function setBusy(sid: string, busy: boolean, end: "succeeded" | "failed" | "interrupted" = "succeeded", extra: Record<string, unknown> = {}) {
  sessions.get(sid)!.busy = busy;
  if (busy) emit("session.execution.started", { sessionID: sid });
  else emit(`session.execution.${end}`, { sessionID: sid, ...extra });
}

/** Real opencode keeps sessions on disk across restarts; recreate unknown ones the same way. */
function ensureSession(sid: string) {
  if (!sessions.has(sid)) {
    const info = { id: sid, title: sid, projectID: "global", model: { providerID: "fake", id: "default" }, time: { created: Date.now(), updated: Date.now() }, cost: 0, tokens: zero() };
    sessions.set(sid, { info, messages: [], busy: false });
  }
  return sessions.get(sid)!;
}

/** Keys the agent got, from its config (opencode 2 reads keys from there). */
function configuredKeys(): string[] {
  try {
    const cfg = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}");
    return Object.values(cfg.providers ?? {}).map((p: any) => String(p?.settings?.apiKey ?? ""));
  } catch {
    return [];
  }
}

function startStep(s: Session) {
  const m = { id: id("msg"), type: "assistant", agent: "build", model: s.info.model, content: [] as any[], time: { created: Date.now() } as any, cost: 0, tokens: zero() };
  s.messages.push(m);
  emit("session.step.started", { sessionID: s.info.id, assistantMessageID: m.id, agent: "build", model: m.model, started: m.time.created });
  return m;
}

function endStep(s: Session, m: any, tokens = { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }) {
  m.time.completed = Date.now();
  m.tokens = tokens;
  m.finish = "stop";
  emit("session.step.ended", { sessionID: s.info.id, assistantMessageID: m.id, finish: "stop", cost: 0, tokens });
  s.info.tokens = { ...s.info.tokens, input: s.info.tokens.input + tokens.input, output: s.info.tokens.output + tokens.output };
  emit("session.usage.updated", { sessionID: s.info.id, cost: 0, tokens: s.info.tokens });
}

function failStep(s: Session, m: any, error: any) {
  m.time.completed = Date.now();
  m.error = error;
  emit("session.step.failed", { sessionID: s.info.id, assistantMessageID: m.id, error });
}

function text(s: Session, m: any, value: string) {
  const ordinal = m.content.filter((c: any) => c.type === "text").length;
  m.content.push({ type: "text", text: value });
  emit("session.text.started", { sessionID: s.info.id, assistantMessageID: m.id, ordinal });
  emit("session.text.delta", { sessionID: s.info.id, assistantMessageID: m.id, ordinal, delta: value });
  emit("session.text.ended", { sessionID: s.info.id, assistantMessageID: m.id, ordinal, text: value });
}

function tool(s: Session, m: any, name: string, input: Record<string, unknown>, metadata: Record<string, unknown> = {}, output = "ok") {
  const callId = id("call");
  const t = Date.now();
  const item = { type: "tool", id: callId, name, state: { status: "completed", input, content: [{ type: "text", text: output }], metadata }, time: { created: t, ran: t, completed: Date.now() } };
  m.content.push(item);
  emit("session.tool.input.started", { sessionID: s.info.id, assistantMessageID: m.id, id: callId, name });
  emit("session.tool.called", { sessionID: s.info.id, assistantMessageID: m.id, id: callId, input, executed: false });
  emit("session.tool.success", { sessionID: s.info.id, assistantMessageID: m.id, id: callId, content: item.state.content, metadata, executed: false });
}

function writeReport(s: Session, m: any, report: string) {
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, "# Report\n\nNothing found.\n");
  tool(s, m, "write", { path: report, content: "# Report\n\nNothing found.\n" });
}

/** How opencode wakes a session when its background work ends: a synthetic message, then a new turn. */
async function wake(s: Session, notice: string, report?: string) {
  const sid = s.info.id;
  const note = { id: id("msg"), type: "synthetic", text: notice, time: { created: Date.now() } };
  s.messages.push(note);
  emit("session.inbox.enqueued", { sessionID: sid, inboxID: note.id, item: { type: "synthetic", payload: { text: notice } } });
  setBusy(sid, true);
  emit("session.inbox.delivered", { sessionID: sid, inboxID: note.id });
  await Bun.sleep(50);
  const m = startStep(s);
  if (report) writeReport(s, m, report);
  text(s, m, report ? "Report written." : "I stopped.");
  endStep(s, m);
  setBusy(sid, false);
}

/** BGSHELL / BGSUB: start the work in the background, end the turn, wake when it's done. */
async function background(s: Session, m: any, value: string, report?: string) {
  const shellRun = /BGSHELL (\d+)/.exec(value);
  const seconds = Number(shellRun?.[1] ?? /BGSUB (\d+)/.exec(value)?.[1]);
  let done: () => string;
  if (shellRun) {
    const sh = { id: id("sh"), status: "running", command: `sleep ${seconds} && make all`, cwd: "/", shell: "bash", file: "/dev/null", metadata: {}, time: { started: Date.now() } as { started: number; completed?: number } };
    shells.set(sh.id, sh);
    tool(s, m, "shell", { command: sh.command, background: true }, { status: "running", shellID: sh.id }, `Command moved to the background (shell ID: ${sh.id}).`);
    done = () => {
      sh.status = "exited";
      sh.time.completed = Date.now();
      return `<shell id="${sh.id}" state="completed" command="${sh.command}">\nbuilt\n</shell>`;
    };
  } else {
    const child = ensureSession(id("ses"));
    child.info.parentID = s.info.id;
    child.info.title = "slow child";
    emit("session.created", { sessionID: child.info.id, parentID: s.info.id, title: child.info.title, model: child.info.model });
    tool(s, m, "subagent", { agent: "general", description: "slow child", prompt: "work", background: true }, { sessionID: child.info.id, status: "running" }, `The subagent is working in the background (sessionID: ${child.info.id}).`);
    setBusy(child.info.id, true);
    done = () => {
      const cm = startStep(child);
      tool(child, cm, "read", { path: "/work/target/main.c" });
      text(child, cm, "child result");
      endStep(child, cm);
      setBusy(child.info.id, false);
      return `<subagent sessionID="${child.info.id}" state="completed" description="slow child">\nchild result\n</subagent>`;
    };
  }
  text(s, m, "Started it in the background; ending my turn.");
  endStep(s, m);
  setBusy(s.info.id, false);
  await Bun.sleep(seconds * 1000);
  await wake(s, done(), report);
}

/** Sessions on the fake provider: the speed and live tests. */
async function modelScript(s: Session) {
  const model = s.info.model.id;
  const m = startStep(s);
  if (model === "broken") {
    const error = { type: "provider.api", message: "boom", status: 500 };
    failStep(s, m, error);
    return setBusy(s.info.id, false, "failed", { error });
  }
  if (model === "tool") {
    const perm = { id: id("per"), sessionID: s.info.id, action: "shell", resources: ["ls"] };
    permissions.set(perm.id, perm);
    emit("permission.asked", perm);
    while (!permissions.get(perm.id)?.reply) await Bun.sleep(20);
    failStep(s, m, { type: "permission.rejected", message: "rejected" });
    return setBusy(s.info.id, false, "interrupted", { reason: "shutdown" });
  }
  await Bun.sleep(30);
  const ordinal = 0;
  m.content.push({ type: "text", text: "" });
  emit("session.text.started", { sessionID: s.info.id, assistantMessageID: m.id, ordinal });
  emit("session.text.delta", { sessionID: s.info.id, assistantMessageID: m.id, ordinal, delta: "Separate chaining " });
  await Bun.sleep(300);
  m.content[0].text = "Separate chaining keeps a list per bucket.";
  emit("session.text.ended", { sessionID: s.info.id, assistantMessageID: m.id, ordinal, text: m.content[0].text });
  endStep(s, m, { input: 50, output: 300, reasoning: 0, cache: { read: 0, write: 0 } });
  setBusy(s.info.id, false);
}

async function handlePrompt(sid: string, value: string) {
  const s = ensureSession(sid);
  const user = { id: id("msg"), type: "user", text: value, time: { created: Date.now() } };
  emit("session.inbox.enqueued", { sessionID: sid, inboxID: user.id, item: { type: "user", payload: { text: value }, delivery: "steer" } });
  setBusy(sid, true);
  s.messages.push(user);
  emit("session.inbox.delivered", { sessionID: sid, inboxID: user.id });
  if (s.info.model.providerID === "fake" && s.info.model.id !== "default") return modelScript(s);
  if (value.includes("HANG")) return;

  await Bun.sleep(100);
  const m = startStep(s);
  if (value.includes("KEYCHECK") && configuredKeys().some((k) => k.startsWith("dead"))) {
    m.model = { providerID: "kp", id: "m" };
    const error = { type: "provider.billing", message: "insufficient balance", status: 402 };
    failStep(s, m, error);
    setBusy(sid, false, "failed", { error });
    return;
  }
  for (const w of value.matchAll(/^WRITE (\{.*\})$/gm)) {
    const call = JSON.parse(w[1]);
    mkdirSync(dirname(call.path), { recursive: true });
    writeFileSync(call.path, call.content);
    tool(s, m, "write", { path: call.path, content: call.content });
  }
  const report = /REPORT (\S+)/.exec(value)?.[1];
  if (/BGSHELL|BGSUB/.test(value)) return background(s, m, value, report);
  if (value.includes("PROGRESS") && report) s.progress = { report, n: 0 };
  if (s.progress) {
    if (++s.progress.n >= 4) writeReport(s, m, s.progress.report);
    else for (let i = 0; i < 12; i++) tool(s, m, "read", { path: `/work/target/file${i}.c` });
    text(s, m, s.progress.n >= 4 ? "Report written." : "I stopped.");
    endStep(s, m);
    return setBusy(sid, false);
  }
  if (report) writeReport(s, m, report);
  text(s, m, report ? "Report written." : "I stopped.");
  endStep(s, m);
  setBusy(sid, false);
}

const ok = (data: unknown) => Response.json({ data });

Bun.serve({
  port,
  hostname,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    let m: RegExpExecArray | null;
    if (path === "/api/info") return Response.json({ version: "fake", pid: process.pid, urls: [] });
    if (path === "/api/event") {
      let ctrl!: ReadableStreamDefaultController<string>;
      const stream = new ReadableStream<string>({
        start(c) {
          ctrl = c;
          clients.add(c);
          c.enqueue(`data: ${JSON.stringify({ id: id("evt"), type: "server.connected", data: {} })}\n\n`);
        },
        cancel() {
          clients.delete(ctrl);
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    if (path === "/api/session" && req.method === "POST") {
      const body = await req.json();
      const { info } = ensureSession(id("ses"));
      info.title = body.title;
      if (body.model) info.model = body.model;
      emit("session.created", { sessionID: info.id, title: info.title, model: info.model });
      return ok(info);
    }
    if (path === "/api/session") {
      const parent = url.searchParams.get("parentID");
      return Response.json({ data: [...sessions.values()].map((s) => s.info).filter((i) => i.parentID === parent), cursor: { previous: null, next: null } });
    }
    if (path === "/api/session/active") {
      const out: Record<string, { type: string }> = {};
      for (const [sid, s] of sessions) if (s.busy) out[sid] = { type: "running" };
      return ok(out);
    }
    if ((m = /^\/api\/session\/([^/]+)\/prompt$/.exec(path))) {
      const body = await req.json();
      void handlePrompt(m[1], body.text);
      return ok({ id: id("msg"), sessionID: m[1], type: "user", payload: { text: body.text }, delivery: "steer" });
    }
    if ((m = /^\/api\/session\/([^/]+)\/model$/.exec(path))) {
      const s = ensureSession(m[1]);
      s.info.model = (await req.json()).model;
      return ok(s.info);
    }
    if ((m = /^\/api\/session\/([^/]+)\/interrupt$/.exec(path))) {
      const busy = !!sessions.get(m[1])?.busy;
      if (busy) setBusy(m[1], false, "interrupted", { reason: "user" });
      return Response.json({ interrupted: busy });
    }
    if ((m = /^\/api\/session\/([^/]+)\/message\/([^/]+)$/.exec(path))) {
      const msg = sessions.get(m[1])?.messages.find((x) => x.id === m![2]);
      return msg ? ok(msg) : new Response("not found", { status: 404 });
    }
    if ((m = /^\/api\/session\/([^/]+)\/message$/.exec(path))) {
      let list = [...(sessions.get(m[1])?.messages ?? [])];
      const type = url.searchParams.get("type");
      if (type) list = list.filter((x) => x.type === type);
      if (url.searchParams.get("order") === "desc") list.reverse();
      const limit = Number(url.searchParams.get("limit") ?? 0);
      if (limit) list = list.slice(0, limit);
      return Response.json({ data: list, cursor: { previous: null, next: null } });
    }
    if ((m = /^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/.exec(path))) {
      const p = permissions.get(m[2]);
      if (p) p.reply = (await req.json()).decision;
      return new Response(null, { status: 204 });
    }
    if ((m = /^\/api\/session\/([^/]+)$/.exec(path))) return ok(ensureSession(m[1]).info);
    if (path === "/api/model") return ok(["fast", "broken", "tool"].map((x) => ({ providerID: "fake", id: x, limit: { context: 100000, output: 4000 }, variants: [] })));
    if (path === "/api/permission/request") return ok([...permissions.values()].filter((p) => !p.reply));
    if (path === "/api/form") return ok([]);
    if (path === "/api/shell") return ok([...shells.values()].filter((x) => x.status === "running"));
    return new Response("not found", { status: 404 });
  },
});
