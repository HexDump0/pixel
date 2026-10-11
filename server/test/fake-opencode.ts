#!/usr/bin/env bun
/**
 * A tiny stand-in for `opencode serve`, for integration tests. Speaks the subset of the HTTP API
 * and event stream Pixel uses. Behaviour is scripted by the prompt text:
 *   "REPORT <path>"  write <path> then go idle
 *   "HANG"           stay busy forever
 *   anything else    reply and go idle (no report)
 * Synchronous `POST /session/:id/message` (the speed test) is scripted by model id instead:
 *   fake/fast    a ~300-token text answer
 *   fake/broken  a provider error
 *   fake/tool    asks for a bash permission and waits until it is answered
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const hostname = args.includes("--hostname") ? args[args.indexOf("--hostname") + 1] : "127.0.0.1";

type Msg = { info: any; parts: any[] };
const sessions = new Map<string, { info: any; messages: Msg[]; busy: boolean }>();
const clients = new Set<ReadableStreamDefaultController<string>>();
const permissions = new Map<string, { id: string; sessionID: string; permission: string; reply?: string }>();
let n = 0;
const id = (p: string) => `${p}_${Date.now().toString(36)}${(n++).toString(36)}`;

function emit(type: string, properties: unknown) {
  const line = `data: ${JSON.stringify({ id: id("evt"), type, properties })}\n\n`;
  for (const c of clients) c.enqueue(line);
}

function setStatus(sid: string, busy: boolean) {
  sessions.get(sid)!.busy = busy;
  emit("session.status", { sessionID: sid, status: { type: busy ? "busy" : "idle" } });
  if (!busy) emit("session.idle", { sessionID: sid });
}

/** Real opencode keeps sessions on disk across restarts; recreate unknown ones the same way. */
function ensureSession(sid: string) {
  if (!sessions.has(sid)) {
    const info = { id: sid, title: sid, time: { created: Date.now() }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
    sessions.set(sid, { info, messages: [], busy: false });
  }
  return sessions.get(sid)!;
}

async function handleSyncPrompt(sid: string, modelID: string) {
  const created = Date.now();
  const info: any = { id: id("msg"), sessionID: sid, role: "assistant", time: { created }, tokens: { input: 50, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
  if (modelID === "broken") return { info: { ...info, error: { name: "APIError", data: { message: "boom", statusCode: 500 } } }, parts: [] };
  if (modelID === "tool") {
    const perm = { id: id("per"), sessionID: sid, permission: "bash" };
    permissions.set(perm.id, perm);
    while (!permissions.get(perm.id)?.reply) await Bun.sleep(20);
    return { info: { ...info, time: { created, completed: Date.now() } }, parts: [] };
  }
  await Bun.sleep(30);
  const start = Date.now();
  await Bun.sleep(300);
  info.tokens.output = 300;
  info.time.completed = Date.now();
  return { info, parts: [{ id: id("prt"), sessionID: sid, messageID: info.id, type: "text", text: "Separate chaining keeps a list per bucket.", time: { start, end: info.time.completed } }] };
}

async function handlePrompt(sid: string, text: string) {
  const s = ensureSession(sid);
  const user: Msg = { info: { id: id("msg"), sessionID: sid, role: "user", time: { created: Date.now() } }, parts: [] };
  user.parts.push({ id: id("prt"), sessionID: sid, messageID: user.info.id, type: "text", text });
  s.messages.push(user);
  setStatus(sid, true);
  emit("message.updated", { sessionID: sid, info: user.info });
  for (const p of user.parts) emit("message.part.updated", { sessionID: sid, part: p });
  if (text.includes("HANG")) return;

  await Bun.sleep(100);
  const reply: Msg = { info: { id: id("msg"), sessionID: sid, role: "assistant", time: { created: Date.now() } }, parts: [] };
  const report = /REPORT (\S+)/.exec(text)?.[1];
  if (report) {
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(report, "# Report\n\nNothing found.\n");
    reply.parts.push({ id: id("prt"), sessionID: sid, messageID: reply.info.id, type: "tool", tool: "write", callID: id("call"), state: { status: "completed", input: { filePath: report }, output: "", title: report, metadata: {}, time: { start: Date.now(), end: Date.now() } } });
  }
  reply.parts.push({ id: id("prt"), sessionID: sid, messageID: reply.info.id, type: "text", text: report ? "Report written." : "I stopped." });
  s.messages.push(reply);
  s.info.tokens.input += 100;
  s.info.tokens.output += 10;
  emit("message.updated", { sessionID: sid, info: reply.info });
  for (const p of reply.parts) emit("message.part.updated", { sessionID: sid, part: p });
  emit("session.updated", { sessionID: sid, info: s.info });
  setStatus(sid, false);
}

Bun.serve({
  port,
  hostname,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    let m: RegExpExecArray | null;
    if (path === "/global/health") return Response.json({ healthy: true, version: "fake" });
    if (path === "/event") {
      let ctrl!: ReadableStreamDefaultController<string>;
      const stream = new ReadableStream<string>({
        start(c) {
          ctrl = c;
          clients.add(c);
          c.enqueue(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
        },
        cancel() {
          clients.delete(ctrl);
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    if (path === "/session" && req.method === "POST") {
      const body = await req.json();
      const { info } = ensureSession(id("ses"));
      info.title = body.title;
      emit("session.created", { sessionID: info.id, info });
      return Response.json(info);
    }
    if (path === "/session/status") {
      const out: Record<string, { type: string }> = {};
      for (const [sid, s] of sessions) if (s.busy) out[sid] = { type: "busy" };
      return Response.json(out);
    }
    if ((m = /^\/session\/([^/]+)\/prompt_async$/.exec(path))) {
      const body = await req.json();
      void handlePrompt(m[1], body.parts.map((p: any) => p.text).join("\n"));
      return new Response(null, { status: 204 });
    }
    if ((m = /^\/session\/([^/]+)\/abort$/.exec(path))) {
      if (sessions.get(m[1])?.busy) setStatus(m[1], false);
      return Response.json(true);
    }
    if ((m = /^\/session\/([^/]+)\/message$/.exec(path))) {
      if (req.method === "POST") return Response.json(await handleSyncPrompt(m[1], (await req.json()).model?.modelID));
      return Response.json(sessions.get(m[1])?.messages ?? []);
    }
    if (path === "/config/providers") return Response.json({ providers: [{ id: "fake", models: { fast: {}, broken: {}, tool: {} } }] });
    if (path === "/permission") return Response.json([...permissions.values()].filter((p) => !p.reply));
    if ((m = /^\/permission\/([^/]+)\/reply$/.exec(path))) {
      const p = permissions.get(m[1]);
      if (p) p.reply = (await req.json()).reply;
      return Response.json(true);
    }
    if ((m = /^\/session\/([^/]+)\/(children|todo)$/.exec(path))) return Response.json([]);
    if ((m = /^\/session\/([^/]+)$/.exec(path))) return Response.json(sessions.get(m[1])?.info ?? {});
    if (path === "/question") return Response.json([]);
    return new Response("not found", { status: 404 });
  },
});
