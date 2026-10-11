/**
 * Websockets: the live update feed (bus → dashboard) and the web terminal,
 * which proxies a PTY that opencode opens inside the run's machine.
 */
import type { ServerWebSocket, WebSocketHandler } from "bun";
import { getRun } from "./db.ts";
import { subscribe } from "./bus.ts";
import { clientFor } from "./runs/index.ts";
import { runtime } from "./runtime/index.ts";

interface FeedSocket {
  kind: "feed";
  /** Run ids this socket wants updates for; "*" = fleet-wide updates. */
  runs: Set<string>;
}

interface TerminalSocket {
  kind: "terminal";
  runId: string;
  ptyId?: string;
  upstream?: WebSocket;
  /** Input typed before the upstream connection opened. */
  pending: (string | Uint8Array<ArrayBuffer>)[];
}

export type SocketData = FeedSocket | TerminalSocket;

export const feedData = (): SocketData => ({ kind: "feed", runs: new Set(["*"]) });
export const terminalData = (runId: string): SocketData => ({ kind: "terminal", runId, pending: [] });

const feeds = new Set<ServerWebSocket<SocketData>>();

subscribe((msg) => {
  const text = JSON.stringify(msg);
  for (const ws of feeds) if ((ws.data as FeedSocket).runs.has(msg.run)) ws.send(text);
});

async function openTerminal(ws: ServerWebSocket<SocketData>, d: TerminalSocket) {
  const run = getRun(d.runId);
  if (!run?.endpoint) return ws.close(1011, "the run has no machine");
  try {
    const client = clientFor(run);
    const pty = await client.createPty(runtime.paths(run).target);
    d.ptyId = pty.id;
    const up = new WebSocket(client.ptyWebSocketUrl(pty.id), { headers: client.wsHeaders() } as any);
    up.binaryType = "arraybuffer";
    d.upstream = up;
    up.onopen = () => {
      for (const m of d.pending) up.send(m);
      d.pending = [];
    };
    up.onmessage = (e) => ws.send(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer));
    up.onclose = () => ws.close();
    up.onerror = () => ws.close(1011, "terminal connection failed");
  } catch (e: any) {
    ws.send(`\r\n[pixel] could not open a terminal: ${e.message}\r\n`);
    ws.close(1011, "terminal failed");
  }
}

/** Terminal text frames starting with \x00 carry JSON control messages, e.g. {"resize":{"rows":40,"cols":120}}. */
function terminalControl(d: TerminalSocket, raw: string) {
  try {
    const ctl = JSON.parse(raw.slice(1));
    const run = getRun(d.runId);
    if (ctl.resize && d.ptyId && run) clientFor(run).resizePty(d.ptyId, ctl.resize.rows, ctl.resize.cols).catch(() => {});
  } catch {}
}

export const websocket: WebSocketHandler<SocketData> = {
  open(ws) {
    if (ws.data.kind === "feed") feeds.add(ws);
    else void openTerminal(ws, ws.data);
  },
  message(ws, msg) {
    const d = ws.data;
    if (d.kind === "feed") {
      // {subscribe: [runIds]} / {unsubscribe: [runIds]}
      try {
        const m = JSON.parse(String(msg));
        for (const r of m.subscribe ?? []) d.runs.add(r);
        for (const r of m.unsubscribe ?? []) d.runs.delete(r);
      } catch {}
      return;
    }
    if (typeof msg === "string" && msg.startsWith("\x00")) return terminalControl(d, msg);
    const data = typeof msg === "string" ? msg : new Uint8Array(msg);
    if (d.upstream?.readyState === WebSocket.OPEN) d.upstream.send(data);
    else d.pending.push(data);
  },
  close(ws) {
    feeds.delete(ws);
    const d = ws.data;
    if (d.kind !== "terminal") return;
    d.upstream?.close();
    const run = getRun(d.runId);
    if (run?.endpoint && d.ptyId) void clientFor(run).removePty(d.ptyId);
  },
};
