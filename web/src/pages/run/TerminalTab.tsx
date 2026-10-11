/** Web terminal into the run's machine (a PTY opened by opencode, proxied by Pixel). */
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { RunDetail } from "../../lib/types.ts";
import { Button, Empty } from "../../components/ui.tsx";

export function TerminalTab({ detail }: { detail: RunDetail }) {
  const el = useRef<HTMLDivElement>(null);
  const [session, setSession] = useState(0);
  const [state, setState] = useState<"connecting" | "open" | "closed">("connecting");
  const available = !!detail.run.endpoint;

  useEffect(() => {
    if (!available || !el.current) return;
    const term = new Terminal({ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, cursorBlink: true, theme: { background: "#09090b" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el.current);
    fit.fit();

    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/runs/${encodeURIComponent(detail.run.id)}/terminal`);
    ws.binaryType = "arraybuffer";
    const sendSize = () => ws.readyState === WebSocket.OPEN && ws.send("\x00" + JSON.stringify({ resize: { rows: term.rows, cols: term.cols } }));
    ws.onopen = () => {
      setState("open");
      sendSize();
    };
    ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
    ws.onclose = () => {
      setState("closed");
      term.write("\r\n[connection closed]\r\n");
    };
    const input = term.onData((d) => ws.readyState === WebSocket.OPEN && ws.send(d));
    const onResize = () => {
      fit.fit();
      sendSize();
    };
    window.addEventListener("resize", onResize);
    term.focus();
    return () => {
      window.removeEventListener("resize", onResize);
      input.dispose();
      ws.close();
      term.dispose();
    };
  }, [available, detail.run.id, session]);

  if (!available) return <Empty>The run has no machine running opencode.</Empty>;
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs muted">
        <span>Root shell in the run's machine, starting in the target directory. {state}</span>
        <Button small className="ml-auto" onClick={() => setSession((s) => s + 1)}>
          New shell
        </Button>
      </div>
      <div ref={el} className="h-[70vh] rounded-md bg-zinc-950 p-1.5" />
    </div>
  );
}
