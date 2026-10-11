/** Live updates from the server's /api/ws feed, as React hooks. */
import { useEffect, useRef } from "react";

export interface LiveMessage {
  run: string;
  type: string;
  data: any;
}

type Listener = (m: LiveMessage) => void;

/** One shared websocket for the whole app, reconnecting with backoff. */
class Feed {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private runs = new Map<string, number>();
  private backoff = 1000;

  constructor() {
    this.connect();
  }

  private connect() {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      if (this.runs.size) ws.send(JSON.stringify({ subscribe: [...this.runs.keys()] }));
      this.emit({ run: "*", type: "connected", data: null });
    };
    ws.onmessage = (e) => {
      try {
        this.emit(JSON.parse(e.data));
      } catch {}
    };
    ws.onclose = () => {
      this.emit({ run: "*", type: "disconnected", data: null });
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15_000);
    };
  }

  private emit(m: LiveMessage) {
    for (const l of this.listeners) l(m);
  }

  listen(l: Listener) {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }

  /** Reference-counted subscription to one run's updates. */
  subscribe(run: string) {
    const n = this.runs.get(run) ?? 0;
    this.runs.set(run, n + 1);
    if (n === 0 && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ subscribe: [run] }));
    return () => {
      const left = (this.runs.get(run) ?? 1) - 1;
      if (left > 0) return void this.runs.set(run, left);
      this.runs.delete(run);
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ unsubscribe: [run] }));
    };
  }
}

let feed: Feed | null = null;
const getFeed = () => (feed ??= new Feed());

/** Listen to every live message outside React (shared stores). */
export const listenLive = (l: (m: LiveMessage) => void) => getFeed().listen(l);

/**
 * Call `handler` for every live message about `run` ("*" = fleet-wide).
 * The handler can change between renders without resubscribing.
 */
export function useLive(run: string | null, handler: (m: LiveMessage) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!run) return;
    const f = getFeed();
    const unsub = run === "*" ? () => {} : f.subscribe(run);
    const unlisten = f.listen((m) => {
      if (m.run === run || (m.run === "*" && (run === "*" || m.type === "connected"))) ref.current(m);
    });
    return () => {
      unlisten();
      unsub();
    };
  }, [run]);
}
