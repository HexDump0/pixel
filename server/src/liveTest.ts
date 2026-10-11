/**
 * Live model test: chat with any model from the Models page and watch the answer stream in.
 *
 * One warm throwaway opencode (see scratchOpencode.ts) serves every live chat; it starts on the
 * first prompt, restarts when the provider credentials change, and stops after 10 idle minutes.
 * Its event stream is relayed to the dashboard as `live` bus messages tagged with the turn they
 * belong to; tool calls are refused as they are asked, so the model can only answer in text.
 */
import { publish } from "./bus.ts";
import { agentCredentials } from "./providerAccounts.ts";
import { startScratchOpencode, type ScratchOpencode } from "./scratchOpencode.ts";

const IDLE_MS = 10 * 60_000;

interface Turn {
  id: string;
  session: string;
  model: string;
  sent: number;
  firstToken: number | null;
  assistant: Set<string>;
  done: boolean;
}

let oc: ScratchOpencode | null = null;
let starting: Promise<ScratchOpencode> | null = null;
let stream: AbortController | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/** Current turn per session. */
const turns = new Map<string, Turn>();

const send = (turn: Turn, kind: string, data: Record<string, unknown> = {}) => publish("*", "live", { turn: turn.id, session: turn.session, kind, ...data });

function finish(turn: Turn, kind: "done" | "error" | "stopped", data: Record<string, unknown> = {}) {
  if (turn.done) return;
  turn.done = true;
  send(turn, kind, { at: Date.now(), ...data });
}

function onEvent(e: { type: string; properties: any }) {
  const p = e.properties ?? {};
  const sid = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID;
  const turn = sid ? turns.get(sid) : undefined;
  if (!turn) return;
  switch (e.type) {
    case "message.updated": {
      const info = p.info;
      if (info?.role !== "assistant" || info.time?.created < turn.sent - 1000) return;
      turn.assistant.add(info.id);
      const err = info.error && info.error.name !== "MessageAbortedError" ? `${info.error.name}: ${info.error.data?.message ?? ""}`.slice(0, 500) : null;
      send(turn, "message", { message: info.id, tokens: info.tokens ?? null, cost: info.cost ?? 0, completed: info.time?.completed ?? null, error: err });
      if (err) finish(turn, "error", { error: err });
      break;
    }
    case "message.part.updated": {
      const part = p.part;
      if (!part || !turn.assistant.has(part.messageID) || (part.type !== "text" && part.type !== "reasoning")) return;
      send(turn, "part", { message: part.messageID, part: part.id, type: part.type, text: part.text ?? "" });
      break;
    }
    case "message.part.delta": {
      if (!turn.assistant.has(p.messageID) || p.field !== "text") return;
      if (!turn.firstToken) {
        turn.firstToken = Date.now();
        send(turn, "first", { at: turn.firstToken, ms: turn.firstToken - turn.sent });
      }
      send(turn, "delta", { message: p.messageID, part: p.partID, delta: p.delta });
      break;
    }
    case "session.status":
      if (p.status?.type === "retry") send(turn, "retry", { attempt: p.status.attempt, message: String(p.status.message ?? "") });
      else if (p.status?.type === "idle" && turn.assistant.size) finish(turn, "done");
      break;
    case "session.idle":
      if (turn.assistant.size) finish(turn, "done");
      break;
    case "session.error":
      if (p.error?.name === "MessageAbortedError") finish(turn, "stopped");
      else finish(turn, "error", { error: `${p.error?.name ?? "error"}: ${p.error?.data?.message ?? ""}`.slice(0, 500) });
      break;
    case "permission.asked":
      void oc?.client.replyPermission(p.id, "reject").catch(() => {});
      send(turn, "tool", { tool: p.permission ?? p.type ?? "tool" });
      break;
    case "question.asked":
      void oc?.client.rejectQuestion(p.id).catch(() => {});
      send(turn, "tool", { tool: "question" });
      break;
  }
}

async function streamLoop(inst: ScratchOpencode, ctl: AbortController) {
  while (!ctl.signal.aborted && oc === inst) {
    await inst.client.streamEvents(onEvent, ctl.signal).catch(() => {});
    if (!ctl.signal.aborted) await Bun.sleep(500);
  }
}

async function shutdown() {
  const inst = oc;
  oc = null;
  stream?.abort();
  stream = null;
  for (const t of turns.values()) finish(t, "stopped");
  turns.clear();
  await inst?.stop();
}

function touch() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void shutdown(), IDLE_MS);
}

async function instance(onStart: () => void) {
  if (oc && oc.creds !== JSON.stringify(agentCredentials())) await shutdown();
  if (oc) return oc;
  if (!starting) {
    onStart();
    starting = startScratchOpencode("livetest")
      .then((inst) => {
        oc = inst;
        stream = new AbortController();
        void streamLoop(inst, stream);
        return inst;
      })
      .finally(() => (starting = null));
  }
  return starting;
}

export function liveStatus() {
  return { ready: !!oc, starting: !!starting };
}

/** Send one prompt; continues `session` when it's still alive, else starts a new chat. */
export async function livePrompt(input: { model?: string; text?: string; session?: string; turn?: string }) {
  const model = input.model?.trim() ?? "";
  const text = input.text?.trim() ?? "";
  if (!model.includes("/")) throw new Error("pick a model (provider/model)");
  if (!text) throw new Error("type a prompt");
  const turnId = input.turn || `lt-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const early = (kind: string, data: Record<string, unknown> = {}) => publish("*", "live", { turn: turnId, session: input.session ?? null, kind, ...data });
  touch();
  const inst = await instance(() => early("starting"));
  const unknown = await inst.check(model);
  if (unknown) throw new Error(unknown);
  const known = input.session && turns.has(input.session) ? input.session : null;
  const session = known ?? (await inst.client.createSession(`live test ${model}`)).id;
  const prev = turns.get(session);
  if (prev && !prev.done) throw new Error("this chat is still answering; stop it first");
  const turn: Turn = { id: turnId, session, model, sent: Date.now(), firstToken: null, assistant: new Set(), done: false };
  turns.set(session, turn);
  send(turn, "sent", { at: turn.sent, model });
  await inst.client.prompt(session, text, model);
  return { session, turn: turn.id };
}

export async function liveAbort(session: string) {
  const turn = turns.get(session);
  if (!oc || !turn) return;
  await oc.client.abort(session).catch(() => {});
  finish(turn, "stopped");
}

/** Stop the warm opencode (Pixel shutting down, tests). */
export const liveShutdown = shutdown;
