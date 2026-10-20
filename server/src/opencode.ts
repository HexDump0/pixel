/**
 * Thin client for an `opencode serve` instance (one per run), opencode 2's HTTP API.
 *
 * Callers get transcripts, events, questions and permissions in the shape Pixel stores (opencode
 * 1.x's); opencodeShape.ts does the translating.
 */
import { Translator, formAnswer, fromMessage, permissionOf, questionOf, sessionInfo, todosOf, type PixelEvent, type V2Event } from "./opencodeShape.ts";

export { todosOf };

export type OpencodeEvent = PixelEvent;

/** A model as opencode knows it: its limits and thinking levels (variants). */
export interface ModelInfo {
  providerID: string;
  id: string;
  limit?: { context?: number; output?: number };
  variants?: { id: string }[];
}

/** Messages per request when reading a whole session. */
const MESSAGE_PAGE = 200;

export class OpencodeClient {
  constructor(
    readonly baseUrl: string,
    readonly password: string | null,
    /** Project directory the agent works in; opencode scopes sessions by it. */
    readonly directory: string,
  ) {}

  private headers(extra: Record<string, string> = {}) {
    const h: Record<string, string> = { ...extra };
    if (this.password) h.authorization = "Basic " + btoa(`opencode:${this.password}`);
    return h;
  }

  url(path: string, query: Record<string, string | undefined> = {}) {
    const u = new URL(path, this.baseUrl);
    u.searchParams.set("directory", this.directory);
    u.searchParams.set("location[directory]", this.directory);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, v);
    return u.toString();
  }

  async req<T = any>(method: string, path: string, body?: unknown, query?: Record<string, string | undefined>, timeoutMs = 30_000): Promise<T> {
    const res = await fetch(this.url(path, query), {
      method,
      headers: this.headers(body === undefined ? {} : { "content-type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`opencode ${method} ${path}: ${res.status} ${await res.text().catch(() => "")}`.slice(0, 500));
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** `req` for endpoints that wrap their answer in `{data}`. */
  private async data<T = any>(method: string, path: string, body?: unknown, query?: Record<string, string | undefined>, timeoutMs?: number): Promise<T> {
    return (await this.req<{ data: T }>(method, path, body, query, timeoutMs))?.data as T;
  }

  async healthy(): Promise<boolean> {
    try {
      const r = await this.req<{ version?: string }>("GET", "/api/info", undefined, undefined, 5000);
      return !!r?.version;
    } catch {
      return false;
    }
  }

  async waitHealthy(timeoutMs = 120_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await this.healthy()) return;
      await Bun.sleep(1000);
    }
    throw new Error(`opencode at ${this.baseUrl} did not become healthy within ${timeoutMs / 1000}s`);
  }

  async createSession(title: string, model?: string, variant?: string | null) {
    const s = await this.data<any>("POST", "/api/session", { title, ...(model && { model: modelRef(model, variant) }) });
    return { id: s.id as string };
  }

  async getSession(id: string) {
    return sessionInfo(await this.data<any>("GET", `/api/session/${id}`));
  }

  /**
   * Send a prompt. opencode 2 keeps the model on the session, so a different model or thinking level
   * is switched first. `delivery`: "steer" goes into the work in progress at the next step (opencode's
   * default), "queue" waits until the current turn ends.
   */
  async prompt(sessionId: string, text: string, model?: string, variant?: string | null, delivery?: "steer" | "queue") {
    if (model) {
      const s = await this.data<any>("GET", `/api/session/${sessionId}`).catch(() => null);
      const want = modelRef(model, variant);
      const cur = s?.model;
      const curVariant = cur?.variant && cur.variant !== "default" ? cur.variant : undefined;
      if (!cur || cur.providerID !== want.providerID || cur.id !== want.id || curVariant !== want.variant) await this.req("POST", `/api/session/${sessionId}/model`, { model: want });
    }
    return this.data("POST", `/api/session/${sessionId}/prompt`, { text, ...(delivery && { delivery }) });
  }

  /** Compact the session's context now ("queue": after the current turn). */
  compact(sessionId: string, delivery: "steer" | "queue" = "queue") {
    return this.data("POST", `/api/session/${sessionId}/compact`, { delivery });
  }

  /** Output of a shell a tool call started (its id comes in the call's metadata), from byte `cursor` on. */
  shellOutput(shellId: string, cursor = 0, limit = 65_536) {
    return this.data<{ output: string; cursor: number; size: number; truncated: boolean }>("GET", `/api/shell/${shellId}/output`, undefined, { cursor: String(cursor), limit: String(limit) });
  }

  abort(sessionId: string) {
    return this.req<{ interrupted: boolean }>("POST", `/api/session/${sessionId}/interrupt`);
  }

  /** Busy sessions, as 1.x's status map (sessionID -> {type: "busy"}); idle ones are left out. */
  async status() {
    const active = await this.data<Record<string, { type: string }>>("GET", "/api/session/active");
    return Object.fromEntries(Object.keys(active ?? {}).map((id) => [id, { type: "busy" }])) as Record<string, { type: string; message?: string }>;
  }

  /** The session's messages oldest first, each as {info, parts}. */
  async messages(sessionId: string) {
    const out: { info: any; parts: any[] }[] = [];
    let cursor: string | undefined;
    const raw: any[] = [];
    for (let page = 0; page < 1000; page++) {
      const r = await this.req<{ data: any[]; cursor?: { next?: string | null } }>(
        "GET",
        `/api/session/${sessionId}/message`,
        undefined,
        cursor ? { cursor, limit: String(MESSAGE_PAGE) } : { order: "asc", limit: String(MESSAGE_PAGE) },
        60_000,
      );
      raw.push(...(r?.data ?? []));
      cursor = r?.cursor?.next ?? undefined;
      if (!cursor || !r?.data?.length) break;
    }
    for (const m of raw) {
      const conv = fromMessage(sessionId, m);
      if (conv) out.push(conv);
    }
    return out;
  }

  async rawMessage(sessionId: string, messageId: string) {
    return this.data<any>("GET", `/api/session/${sessionId}/message/${messageId}`, undefined, undefined, 60_000);
  }

  async children(sessionId: string) {
    const out: any[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const r = await this.req<{ data: any[]; cursor?: { next?: string | null } }>("GET", "/api/session", undefined, cursor ? { cursor } : { parentID: sessionId, order: "asc", limit: "200" });
      out.push(...(r?.data ?? []));
      cursor = r?.cursor?.next ?? undefined;
      if (!cursor || !r?.data?.length) break;
    }
    return out.filter((s) => s.parentID === sessionId).map(sessionInfo);
  }

  async pendingPermissions() {
    return ((await this.data<any[]>("GET", "/api/permission/request")) ?? []).map(permissionOf);
  }

  async replyPermission(requestId: string, reply: "once" | "always" | "reject", sessionId?: string) {
    const sid = sessionId ?? (await this.pendingPermissions()).find((p) => p.id === requestId)?.sessionID;
    if (!sid) throw new Error(`no pending permission ${requestId}`);
    return this.req("POST", `/api/session/${sid}/permission/${requestId}/reply`, { decision: reply });
  }

  /** Pending questions (opencode's question tool asks through forms). */
  async pendingQuestions() {
    return ((await this.data<any[]>("GET", "/api/form")) ?? []).map(questionOf);
  }

  async replyQuestion(requestId: string, answers: string[][]) {
    const q = (await this.pendingQuestions()).find((x) => x.id === requestId);
    if (!q) throw new Error(`no pending question ${requestId}`);
    return this.req("POST", `/api/session/${q.sessionID}/form/${requestId}/reply`, { answer: formAnswer(q.fields, answers) });
  }

  /** Dismiss a question. With a message the agent reads it and carries on; without, its step ends. */
  async rejectQuestion(requestId: string, message?: string) {
    const q = (await this.pendingQuestions()).find((x) => x.id === requestId);
    if (!q) return;
    return this.req("DELETE", `/api/session/${q.sessionID}/form/${requestId}`, undefined, message ? { message } : undefined);
  }

  /** opencode's models (only providers it can use), with their limits and thinking levels. */
  async models(): Promise<ModelInfo[]> {
    return (await this.data<ModelInfo[]>("GET", "/api/model", undefined, undefined, 15_000)) ?? [];
  }

  async createPty(cwd: string) {
    // opencode starts the shell as a login shell itself.
    return this.data<{ id: string }>("POST", "/api/pty", { command: "bash", args: [], cwd, title: "pixel" });
  }

  resizePty(id: string, rows: number, cols: number) {
    return this.req("PUT", `/api/pty/${id}`, { size: { rows, cols } });
  }

  removePty(id: string) {
    return this.req("DELETE", `/api/pty/${id}`).catch(() => {});
  }

  /**
   * WebSocket URL for a PTY. Pixel connects server-side with the basic-auth header (wsHeaders);
   * opencode's connect-token tickets are for browsers.
   */
  ptyWebSocketUrl(id: string) {
    const u = new URL(this.url(`/api/pty/${id}/connect`));
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.toString();
  }

  wsHeaders() {
    return this.headers();
  }

  /**
   * Stream events (in Pixel's shape) until `signal` aborts or the connection drops. Events are
   * translated one at a time, in order; a translation may fetch what the stream joined too late for.
   * Resolves when the stream ends; the caller decides whether to reconnect.
   */
  async streamEvents(onEvent: (e: OpencodeEvent) => void, signal: AbortSignal) {
    const res = await fetch(this.url("/api/event"), { headers: this.headers({ accept: "text/event-stream" }), signal });
    if (!res.ok || !res.body) throw new Error(`event stream: ${res.status}`);
    const translator = new Translator({
      message: (sid, mid) => this.rawMessage(sid, mid),
      session: (sid) => this.data("GET", `/api/session/${sid}`),
      latestCompaction: async (sid) => (await this.data<any[]>("GET", `/api/session/${sid}/message`, undefined, { type: "compaction", order: "desc", limit: "1" }))?.[0] ?? null,
    });
    let queue = Promise.resolve();
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    // The first event says the stream is up, so the caller can resync even before anything happens.
    onEvent({ type: "server.connected", properties: {} });
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = chunk
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        let e: V2Event;
        try {
          e = JSON.parse(data);
        } catch (err) {
          console.error("bad opencode event", err);
          continue;
        }
        queue = queue
          .then(() => translator.handle(e))
          .then((out) => {
            for (const x of out) onEvent(x);
          })
          .catch((err) => console.error(`opencode event ${e.type} failed`, err));
      }
    }
    await queue;
  }
}

/** "provider/model" (+ thinking level) as opencode 2's model reference. */
export function modelRef(model: string, variant?: string | null) {
  const i = model.indexOf("/");
  return { providerID: model.slice(0, i), id: model.slice(i + 1), ...(variant && { variant }) };
}
