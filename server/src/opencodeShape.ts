/**
 * opencode 2 speaks in events about steps, text, reasoning and tool calls; Pixel stores transcripts as
 * messages with parts, the shape opencode 1.x used (and every run before 2026-10-20 is stored in).
 * This module turns opencode 2's messages and events into that shape, so storage, stats, the
 * archive, the fleet view and the dashboard read old and new runs the same way.
 *
 * Tool names and arguments are mapped to the 1.x ones Pixel already understands: shell is "bash",
 * subagent is "task" (child session in state.metadata.sessionId), read/write/edit's `path` is also
 * `filePath`. Parts get ids from their position in the message (`prt_<message>_<pos>`), which is the
 * order opencode appends them in, so ids built from live events match ids built from a fetch.
 */

/** An event in Pixel's (opencode 1.x) shape: `type` plus `properties`. */
export interface PixelEvent {
  type: string;
  properties: any;
}

/** opencode 2's SSE payload. */
export interface V2Event {
  id: string;
  type: string;
  created?: number;
  data: any;
}

const TOOL_NAMES: Record<string, string> = { shell: "bash", subagent: "task", patch: "apply_patch" };
export const v1ToolName = (name: string) => TOOL_NAMES[name] ?? name;

export const partId = (messageId: string, pos: number) => `prt_${messageId.replace(/^msg_/, "")}_${String(pos).padStart(4, "0")}`;

/** Tool arguments under the names opencode 1.x used (the new names stay too). */
export function v1Input(name: string, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const i = input as Record<string, unknown>;
  if ((name === "read" || name === "write" || name === "edit") && typeof i.path === "string" && i.filePath === undefined) return { ...i, filePath: i.path };
  if (name === "subagent") return { ...i, subagent_type: i.agent, ...(i.sessionID !== undefined && { task_id: i.sessionID }) };
  return i;
}

/** opencode 2 error ({type, message, status, response}) as opencode 1.x's ({name, data}). */
export function v1Error(err: any) {
  if (!err) return undefined;
  if (err.type === "aborted") return { name: "MessageAbortedError", data: { message: err.message ?? "aborted" } };
  return {
    name: String(err.type ?? "UnknownError"),
    data: { message: String(err.message ?? ""), ...(err.status && { statusCode: err.status }), ...(err.response?.body && { responseBody: err.response.body }) },
  };
}

const contentText = (content: any) =>
  Array.isArray(content)
    ? content
        .map((c: any) => (c?.type === "text" ? c.text : c?.type === "file" ? `[file ${c.name ?? c.uri ?? ""}]` : ""))
        .filter(Boolean)
        .join("\n")
    : "";

function toolMetadata(name: string, metadata: any, error?: any) {
  const m: Record<string, unknown> = { ...(metadata ?? {}) };
  if (name === "subagent" && typeof m.sessionID === "string") m.sessionId = m.sessionID;
  if (error?.type === "aborted") m.interrupted = true;
  return m;
}

/** One opencode 2 tool content item as a 1.x tool part. */
export function toolPart(sessionID: string, messageID: string, pos: number, t: any) {
  const st = t.state ?? {};
  const status = st.status === "streaming" ? "pending" : st.status;
  const input = typeof st.input === "string" ? parseJson(st.input) : st.input;
  const state: Record<string, unknown> = {
    status,
    input: v1Input(t.name, input),
    time: { start: t.time?.ran ?? t.time?.created ?? Date.now(), ...(t.time?.completed && { end: t.time.completed }) },
  };
  if (st.status === "streaming" && typeof st.input === "string") state.raw = st.input;
  if (st.metadata || st.error) state.metadata = toolMetadata(t.name, st.metadata, st.error);
  if (st.status === "completed") state.output = contentText(st.content);
  if (st.status === "error") {
    state.error = String(st.error?.message ?? "error");
    if (st.content) state.output = contentText(st.content);
  }
  if (typeof (st.metadata as any)?.title === "string") state.title = (st.metadata as any).title;
  return { id: partId(messageID, pos), sessionID, messageID, type: "tool", callID: t.id, tool: v1ToolName(t.name), state };
}

function parseJson(s: string) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function assistantInfo(sessionID: string, m: any) {
  return {
    id: m.id,
    sessionID,
    role: "assistant",
    mode: m.agent,
    agent: m.agent,
    providerID: m.model?.providerID,
    modelID: m.model?.id,
    ...(m.model?.variant && m.model.variant !== "default" && { variant: m.model.variant }),
    time: { created: m.time?.created ?? Date.now(), ...(m.time?.completed && { completed: m.time.completed }) },
    cost: m.cost ?? 0,
    tokens: m.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(m.finish && { finish: m.finish }),
    ...(m.error && { error: v1Error(m.error) }),
  };
}

const userInfo = (sessionID: string, id: string, created: number) => ({ id, sessionID, role: "user", time: { created } });
const textPart = (sessionID: string, messageID: string, pos: number, text: string, extra: Record<string, unknown> = {}) => ({
  id: partId(messageID, pos),
  sessionID,
  messageID,
  type: "text",
  text,
  ...extra,
});

/** A message from `GET /api/session/:id/message` as {info, parts}; null for markers Pixel doesn't keep (idle, switches). */
export function fromMessage(sessionID: string, m: any): { info: any; parts: any[] } | null {
  const created = m.time?.created ?? Date.now();
  switch (m.type) {
    case "user":
      return { info: userInfo(sessionID, m.id, created), parts: [textPart(sessionID, m.id, 0, m.text ?? "")] };
    case "synthetic":
      return { info: userInfo(sessionID, m.id, created), parts: [textPart(sessionID, m.id, 0, m.text ?? "", { synthetic: true, ...(m.description && { description: m.description }) })] };
    case "assistant": {
      const parts: any[] = (m.content ?? []).map((c: any, pos: number) => {
        if (c.type === "tool") return toolPart(sessionID, m.id, pos, c);
        const time = c.type === "reasoning" ? { start: c.time?.created ?? created, ...(c.time?.completed && { end: c.time.completed }) } : { start: created, ...(m.time?.completed && { end: m.time.completed }) };
        return { ...textPart(sessionID, m.id, pos, c.text ?? ""), type: c.type, time };
      });
      if (m.time?.completed && m.snapshot?.files?.length) parts.push({ id: partId(m.id, parts.length), sessionID, messageID: m.id, type: "patch", files: m.snapshot.files, hash: m.snapshot.end });
      return { info: assistantInfo(sessionID, m), parts };
    }
    case "compaction": {
      if (m.status === "running") return null;
      const info = {
        ...assistantInfo(sessionID, { ...m, agent: "compaction", time: { created, completed: created } }),
        summary: true,
        ...(m.status === "failed" && { error: v1Error(m.error) }),
      };
      return { info, parts: m.status === "completed" ? [{ ...textPart(sessionID, m.id, 0, m.summary ?? ""), time: { start: created, end: created } }] : [] };
    }
    default:
      return null;
  }
}

/** A session from opencode 2 as the 1.x session info Pixel stores. */
export function sessionInfo(s: any) {
  return {
    id: s.id,
    ...(s.parentID && { parentID: s.parentID }),
    title: s.title,
    agent: s.agent,
    cost: s.cost ?? 0,
    tokens: s.tokens,
    time: { created: s.time?.created ?? Date.now(), updated: s.time?.updated ?? Date.now() },
  };
}

/** A question form (opencode 2 forms) as 1.x's question.asked payload. */
export function questionOf(form: any) {
  const fields: any[] = form.fields ?? [];
  return {
    id: form.id,
    sessionID: form.sessionID,
    questions: fields
      .filter((f) => f.type !== "external")
      .map((f) => ({
        question: f.description ?? f.title ?? f.key,
        header: f.title ?? "",
        options: (f.options ?? []).map((o: any) => ({ label: o.label ?? o.value, description: o.description ?? "" })),
        ...(f.type === "multiselect" && { multiple: true }),
      })),
    ...(form.metadata?.tool && { tool: { messageID: form.metadata.tool.messageID, callID: form.metadata.tool.id } }),
    /** The form's field keys, in question order, for answering. */
    fields: fields.filter((f) => f.type !== "external").map((f) => ({ key: f.key, type: f.type })),
  };
}

/** Answers in 1.x's shape (one list of chosen labels per question) as an opencode 2 form answer. */
export function formAnswer(fields: { key: string; type: string }[], answers: string[][]) {
  const out: Record<string, string | number | boolean | string[]> = {};
  fields.forEach((f, i) => {
    const a = answers[i] ?? [];
    if (!a.length) return;
    if (f.type === "multiselect") out[f.key] = a;
    else if (f.type === "boolean") out[f.key] = /^(y|yes|true)$/i.test(a[0]);
    else if (f.type === "number" || f.type === "integer") out[f.key] = Number(a[0]);
    else out[f.key] = a.join(", ");
  });
  return out;
}

/** The todo list a todowrite part set, if it is one. */
export function todosOf(part: any): any[] | null {
  if (part?.type !== "tool" || part.tool !== "todowrite" || part.state?.status !== "completed") return null;
  const t = part.state.metadata?.todos ?? part.state.input?.todos;
  return Array.isArray(t) ? t : null;
}

/** A permission request in 1.x's shape. */
export const permissionOf = (r: any) => ({
  id: r.id,
  sessionID: r.sessionID,
  permission: r.action,
  patterns: r.resources ?? [],
  metadata: r.metadata ?? {},
  ...(r.source?.type === "tool" && { tool: { messageID: r.source.messageID, callID: r.source.id } }),
});

interface MessageState {
  sessionID: string;
  info: any;
  parts: any[];
  /** "text:<ordinal>", "reasoning:<ordinal>", "tool:<call id>" -> position */
  keys: Map<string, number>;
  /** Tool calls as opencode 2 content items, by call id, so each event can rebuild the part. */
  tools: Map<string, any>;
}

/** What the translator needs from the client: fetching things it missed. */
export interface Fetcher {
  message(sessionID: string, messageID: string): Promise<any | null>;
  session(sessionID: string): Promise<any | null>;
  latestCompaction(sessionID: string): Promise<any | null>;
}

/**
 * Turns opencode 2's event stream into Pixel's. Stateful (one per event-stream connection): it builds
 * each streaming message from its events and fetches what it joined too late to see. At the end of
 * every step the message is fetched once and becomes the authoritative copy.
 */
export class Translator {
  private messages = new Map<string, MessageState>();
  private sessions = new Map<string, any>();
  private inbox = new Map<string, { text: string; sessionID: string }>();

  constructor(private fetch: Fetcher) {}

  private seed(sessionID: string, m: any): MessageState | null {
    const conv = fromMessage(sessionID, m);
    if (!conv) return null;
    const st: MessageState = { sessionID, info: conv.info, parts: conv.parts, keys: new Map(), tools: new Map() };
    let text = 0;
    let reasoning = 0;
    (m.content ?? []).forEach((c: any, pos: number) => {
      if (c.type === "text") st.keys.set(`text:${text++}`, pos);
      else if (c.type === "reasoning") st.keys.set(`reasoning:${reasoning++}`, pos);
      else if (c.type === "tool") {
        st.keys.set(`tool:${c.id}`, pos);
        st.tools.set(c.id, c);
      }
    });
    this.messages.set(m.id, st);
    this.trim();
    return st;
  }

  private trim() {
    if (this.messages.size > 200) for (const k of [...this.messages.keys()].slice(0, 100)) this.messages.delete(k);
    if (this.inbox.size > 200) for (const k of [...this.inbox.keys()].slice(0, 100)) this.inbox.delete(k);
  }

  /** The message an event is about, fetching it if this stream joined after it started. */
  private async message(sessionID: string, id: string): Promise<MessageState | null> {
    const known = this.messages.get(id);
    if (known) return known;
    const m = await this.fetch.message(sessionID, id).catch(() => null);
    return m ? this.seed(sessionID, m) : null;
  }

  private async session(sessionID: string) {
    let s = this.sessions.get(sessionID);
    if (!s) {
      const fetched = await this.fetch.session(sessionID).catch(() => null);
      s = fetched ? sessionInfo(fetched) : { id: sessionID, time: { created: Date.now(), updated: Date.now() } };
      this.sessions.set(sessionID, s);
    }
    return s;
  }

  // Copies: the translator keeps changing its own objects as more events arrive.
  private partEvent = (part: any): PixelEvent => ({ type: "message.part.updated", properties: { part: structuredClone(part) } });
  private messageEvent = (info: any): PixelEvent => ({ type: "message.updated", properties: { info: structuredClone(info) } });

  /** Position of the part at `key`; a new key takes the next position, filled by `make`. */
  private place(st: MessageState, key: string, make: (pos: number) => any): number {
    let pos = st.keys.get(key);
    if (pos === undefined) {
      pos = st.keys.size;
      st.keys.set(key, pos);
      st.parts[pos] = make(pos);
    }
    return pos;
  }

  /** The text or reasoning part at `key`, created empty when it's new. */
  private textAt(st: MessageState, type: "text" | "reasoning", ordinal: number, at: number) {
    const pos = this.place(st, `${type}:${ordinal}`, (p) => ({ ...textPart(st.sessionID, st.info.id, p, ""), type, time: { start: at } }));
    return st.parts[pos];
  }

  /** Apply a tool event to its call and send the call's part. */
  private async tool(e: V2Event, update: (t: any) => void): Promise<PixelEvent[]> {
    const d = e.data;
    const st = await this.message(d.sessionID, d.assistantMessageID);
    if (!st) return [];
    let item = st.tools.get(d.id);
    if (!item) st.tools.set(d.id, (item = { type: "tool", id: d.id, name: d.name ?? "tool", time: { created: e.created ?? Date.now() }, state: { status: "streaming", input: "" } }));
    update(item);
    const pos = this.place(st, `tool:${d.id}`, () => null);
    const part = toolPart(d.sessionID, d.assistantMessageID, pos, item);
    st.parts[pos] = part;
    const todos = todosOf(part);
    return todos ? [this.partEvent(part), { type: "todo.updated", properties: { sessionID: d.sessionID, todos } }] : [this.partEvent(part)];
  }

  async handle(e: V2Event): Promise<PixelEvent[]> {
    const d = e.data ?? {};
    const at = e.created ?? Date.now();
    switch (e.type) {
      case "session.created": {
        const info = sessionInfo({ id: d.sessionID, parentID: d.parentID, title: d.title, agent: d.agent, cost: 0, tokens: undefined, time: { created: at, updated: at } });
        this.sessions.set(d.sessionID, info);
        return [{ type: "session.created", properties: { info: { ...info } } }];
      }
      case "session.renamed":
      case "session.usage.updated":
      case "session.agent.selected": {
        const s = await this.session(d.sessionID);
        if (e.type === "session.renamed") s.title = d.title;
        if (e.type === "session.agent.selected") s.agent = d.agent;
        if (e.type === "session.usage.updated") {
          s.cost = d.cost;
          s.tokens = d.tokens;
        }
        s.time = { ...s.time, updated: at };
        return [{ type: "session.updated", properties: { info: { ...s } } }];
      }
      case "session.inbox.enqueued":
        if (d.item?.type === "user") this.inbox.set(d.inboxID, { text: d.item.payload?.text ?? "", sessionID: d.sessionID });
        return [];
      case "session.inbox.delivered": {
        const queued = this.inbox.get(d.inboxID);
        this.inbox.delete(d.inboxID);
        let conv = queued ? { info: userInfo(d.sessionID, d.inboxID, at), parts: [textPart(d.sessionID, d.inboxID, 0, queued.text)] } : null;
        if (!conv) {
          const m = await this.fetch.message(d.sessionID, d.inboxID).catch(() => null);
          conv = m ? fromMessage(d.sessionID, m) : null;
        }
        return conv ? [this.messageEvent(conv.info), ...conv.parts.map(this.partEvent)] : [];
      }
      case "session.synthetic": {
        const id = String(e.id).replace(/^evt_/, "msg_");
        const conv = fromMessage(d.sessionID, { type: "synthetic", id, text: d.text, description: d.description, time: { created: at } })!;
        return [this.messageEvent(conv.info), ...conv.parts.map(this.partEvent)];
      }
      case "session.execution.started":
        return [{ type: "session.status", properties: { sessionID: d.sessionID, status: { type: "busy" } } }];
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        // A newer prompt replaced the running turn: the session stays busy.
        if (e.type === "session.execution.interrupted" && d.reason === "superseded") return [];
        const out: PixelEvent[] = [];
        if (e.type === "session.execution.failed") out.push({ type: "session.error", properties: { sessionID: d.sessionID, error: v1Error(d.error) } });
        if (e.type === "session.execution.interrupted" && d.reason === "user") out.push({ type: "session.error", properties: { sessionID: d.sessionID, error: v1Error({ type: "aborted", message: "Interrupted" }) } });
        out.push({ type: "session.status", properties: { sessionID: d.sessionID, status: { type: "idle" } } });
        out.push({ type: "session.idle", properties: { sessionID: d.sessionID } });
        return out;
      }
      case "session.retry.scheduled":
        return [{ type: "session.status", properties: { sessionID: d.sessionID, status: { type: "retry", attempt: d.attempt, message: String(d.error?.message ?? "retry"), next: d.at, error: v1Error(d.error) } } }];
      case "session.step.started": {
        const st: MessageState = {
          sessionID: d.sessionID,
          info: assistantInfo(d.sessionID, { id: d.assistantMessageID, agent: d.agent, model: d.model, time: { created: d.started ?? at } }),
          parts: [],
          keys: new Map(),
          tools: new Map(),
        };
        this.messages.set(d.assistantMessageID, st);
        this.trim();
        return [this.messageEvent(st.info)];
      }
      case "session.text.started":
      case "session.reasoning.started": {
        const st = await this.message(d.sessionID, d.assistantMessageID);
        if (!st) return [];
        const part = this.textAt(st, e.type === "session.text.started" ? "text" : "reasoning", d.ordinal, at);
        return [this.partEvent(part)];
      }
      case "session.text.delta":
      case "session.reasoning.delta": {
        const st = await this.message(d.sessionID, d.assistantMessageID);
        if (!st) return [];
        const part = this.textAt(st, e.type === "session.text.delta" ? "text" : "reasoning", d.ordinal, at);
        part.text = (part.text ?? "") + d.delta;
        return [{ type: "message.part.delta", properties: { sessionID: d.sessionID, messageID: d.assistantMessageID, partID: part.id, field: "text", delta: d.delta } }];
      }
      case "session.text.ended":
      case "session.reasoning.ended": {
        const st = await this.message(d.sessionID, d.assistantMessageID);
        if (!st) return [];
        const part = this.textAt(st, e.type === "session.text.ended" ? "text" : "reasoning", d.ordinal, at);
        part.text = d.text;
        part.time = { ...part.time, end: at };
        return [this.partEvent(part)];
      }
      case "session.tool.input.started":
        return this.tool(e, () => {});
      case "session.tool.input.delta":
        // Tool arguments streaming in: counted as output (tokens per second), not shown.
        return [{ type: "tool.input.delta", properties: { sessionID: d.sessionID, messageID: d.assistantMessageID, delta: d.delta } }];
      case "session.tool.input.ended":
        return this.tool(e, (t) => {
          if (t.state.status === "streaming") t.state.input = d.text;
        });
      case "session.tool.called":
        return this.tool(e, (t) => {
          t.time.ran = at;
          t.state = { status: "running", input: d.input, metadata: {} };
        });
      case "session.tool.progress":
        return this.tool(e, (t) => {
          if (t.state.status === "running") t.state.metadata = { ...t.state.metadata, ...d.metadata };
        });
      case "session.tool.success":
        return this.tool(e, (t) => {
          t.time.completed = at;
          t.state = { status: "completed", input: typeof t.state.input === "string" ? parseJson(t.state.input) : t.state.input, content: d.content, metadata: d.metadata };
        });
      case "session.tool.failed":
        return this.tool(e, (t) => {
          t.time.completed = at;
          t.state = { status: "error", input: typeof t.state.input === "string" ? parseJson(t.state.input) : t.state.input, error: d.error, content: d.content, metadata: d.metadata ?? t.state.metadata };
        });
      case "session.step.ended":
      case "session.step.failed": {
        const st = await this.message(d.sessionID, d.assistantMessageID);
        const out: PixelEvent[] = [];
        if (st) {
          st.info = {
            ...st.info,
            time: { ...st.info.time, completed: at },
            ...(d.cost !== undefined && { cost: d.cost }),
            ...(d.tokens && { tokens: d.tokens }),
            ...(d.finish && { finish: d.finish }),
            ...(d.error && { error: v1Error(d.error) }),
          };
          out.push(this.messageEvent(st.info));
        }
        // The step is over: the stored message is the truth from here on.
        const m = await this.fetch.message(d.sessionID, d.assistantMessageID).catch(() => null);
        if (m) {
          const before = st?.parts.filter(Boolean).map((p) => p.id) ?? [];
          const fresh = this.seed(d.sessionID, m);
          if (fresh) {
            out.push(this.messageEvent(fresh.info), ...fresh.parts.map(this.partEvent));
            const now = new Set(fresh.parts.map((p) => p.id));
            for (const id of before) if (!now.has(id)) out.push({ type: "message.part.removed", properties: { sessionID: d.sessionID, messageID: d.assistantMessageID, partID: id } });
          }
        }
        this.messages.delete(d.assistantMessageID);
        return out;
      }
      case "session.compaction.ended":
      case "session.compaction.failed": {
        const m = await this.fetch.latestCompaction(d.sessionID).catch(() => null);
        const conv = m ? fromMessage(d.sessionID, m) : null;
        return conv ? [this.messageEvent(conv.info), ...conv.parts.map(this.partEvent)] : [];
      }
      case "form.created":
        return [{ type: "question.asked", properties: questionOf(d.form) }];
      case "form.replied":
        return [{ type: "question.replied", properties: { sessionID: d.sessionID, requestID: d.id, answers: d.answer } }];
      case "form.cancelled":
        return [{ type: "question.rejected", properties: { sessionID: d.sessionID, requestID: d.id } }];
      case "permission.asked":
        return [{ type: "permission.asked", properties: permissionOf(d) }];
      case "permission.replied":
        return [{ type: "permission.replied", properties: { sessionID: d.sessionID, requestID: d.requestID, reply: d.reply } }];
      default:
        return [];
    }
  }
}
