/** Thin client for an `opencode serve` instance (one per run). */

export interface OpencodeEvent {
  id?: string;
  type: string;
  properties: any;
}

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

  async healthy(): Promise<boolean> {
    try {
      const r = await this.req<{ healthy: boolean }>("GET", "/global/health", undefined, undefined, 5000);
      return !!r?.healthy;
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

  createSession(title: string) {
    return this.req<{ id: string }>("POST", "/session", { title });
  }

  getSession(id: string) {
    return this.req<any>("GET", `/session/${id}`);
  }

  prompt(sessionId: string, text: string, model?: string) {
    const body: any = { parts: [{ type: "text", text }] };
    if (model) {
      const i = model.indexOf("/");
      body.model = { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
    }
    return this.req("POST", `/session/${sessionId}/prompt_async`, body);
  }

  abort(sessionId: string) {
    return this.req<boolean>("POST", `/session/${sessionId}/abort`);
  }

  status() {
    return this.req<Record<string, { type: string; message?: string }>>("GET", "/session/status");
  }

  messages(sessionId: string) {
    return this.req<{ info: any; parts: any[] }[]>("GET", `/session/${sessionId}/message`, undefined, undefined, 60_000);
  }

  children(sessionId: string) {
    return this.req<any[]>("GET", `/session/${sessionId}/children`);
  }

  todos(sessionId: string) {
    return this.req<any[]>("GET", `/session/${sessionId}/todo`);
  }

  pendingPermissions() {
    return this.req<any[]>("GET", "/permission");
  }

  replyPermission(requestId: string, reply: "once" | "always" | "reject") {
    return this.req("POST", `/permission/${requestId}/reply`, { reply });
  }

  pendingQuestions() {
    return this.req<any[]>("GET", "/question");
  }

  replyQuestion(requestId: string, answers: string[][]) {
    return this.req("POST", `/question/${requestId}/reply`, { answers });
  }

  rejectQuestion(requestId: string) {
    return this.req("POST", `/question/${requestId}/reject`);
  }

  createPty(cwd: string) {
    return this.req<{ id: string }>("POST", "/pty", { command: "bash", args: ["-l"], cwd, title: "pixel" });
  }

  resizePty(id: string, rows: number, cols: number) {
    return this.req("PUT", `/pty/${id}`, { size: { rows, cols } });
  }

  removePty(id: string) {
    return this.req("DELETE", `/pty/${id}`).catch(() => {});
  }

  /**
   * WebSocket URL for a PTY. Pixel connects server-side with the basic-auth header (wsHeaders);
   * opencode's connect-token tickets are for browsers and refuse server-side requests.
   */
  ptyWebSocketUrl(id: string) {
    const u = new URL(this.url(`/pty/${id}/connect`));
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.toString();
  }

  wsHeaders() {
    return this.headers();
  }

  /**
   * Stream server-sent events until `signal` aborts or the connection drops.
   * Resolves when the stream ends; the caller decides whether to reconnect.
   */
  async streamEvents(onEvent: (e: OpencodeEvent) => void, signal: AbortSignal) {
    const res = await fetch(this.url("/event"), { headers: this.headers({ accept: "text/event-stream" }), signal });
    if (!res.ok || !res.body) throw new Error(`event stream: ${res.status}`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
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
        try {
          onEvent(JSON.parse(data));
        } catch (e) {
          console.error("bad opencode event", e);
        }
      }
    }
  }
}
