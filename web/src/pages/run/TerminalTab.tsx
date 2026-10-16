/** Web terminal into the run's machine (a PTY opened by opencode, proxied by Pixel), filling the panel, plus the commands to connect from outside. */
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { IconCopy, IconPlus, IconRefresh } from "@tabler/icons-react";
import type { RunDetail } from "../../lib/types.ts";
import { Button } from "../../components/ui.tsx";
import { Menu } from "../../components/ui/overlay.tsx";
import { IC_SM, Nothing } from "../../components/ui/bits.tsx";
import { toast } from "../../components/Toast.tsx";

/** xterm's colours from the theme tokens, so the terminal matches the rest of the page. */
function themeFromTokens() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    background: v("--term-bg"),
    foreground: v("--term-ink"),
    cursor: v("--term-ink"),
    selectionBackground: v("--line"),
    black: v("--s3"),
    red: v("--critical"),
    green: v("--good"),
    yellow: v("--r5"),
    blue: v("--r1"),
    magenta: v("--r2"),
    cyan: v("--r0"),
    white: v("--ink-2"),
    brightBlack: v("--ink-4"),
    brightRed: v("--r3"),
    brightGreen: v("--r4"),
    brightYellow: v("--sev-medium"),
    brightBlue: v("--r1"),
    brightMagenta: v("--r2"),
    brightCyan: v("--r0"),
    brightWhite: v("--ink"),
  };
}

const copy = (text: string, what: string) => void navigator.clipboard.writeText(text).then(() => toast(`${what} copied`));

export function TerminalTab({ detail }: { detail: RunDetail }) {
  const el = useRef<HTMLDivElement>(null);
  const [session, setSession] = useState(0);
  const [state, setState] = useState<"connecting" | "open" | "closed">("connecting");
  const available = !!detail.run.endpoint;

  useEffect(() => {
    if (!available || !el.current) return;
    setState("connecting");
    const mono = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "ui-monospace, monospace";
    const term = new Terminal({ fontFamily: mono, fontSize: 13, lineHeight: 1.25, cursorBlink: true, scrollback: 10_000, theme: themeFromTokens() });
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
    ws.onclose = () => setState("closed");
    const input = term.onData((d) => ws.readyState === WebSocket.OPEN && ws.send(d));
    // Refit whenever the panel changes size (window, run list hidden, focus mode).
    const ro = new ResizeObserver(() => {
      fit.fit();
      sendSize();
    });
    ro.observe(el.current);
    term.focus();
    return () => {
      ro.disconnect();
      input.dispose();
      ws.close();
      term.dispose();
    };
  }, [available, detail.run.id, session]);

  if (!available) return <div className="p-7"><Nothing>The machine isn't running, so there's no shell. Start it from the Machine tab.</Nothing></div>;
  const connect = [
    detail.attach ? { label: "Copy the opencode attach command", hint: "your TUI on this agent", icon: <IconCopy {...IC_SM} />, onSelect: () => copy(detail.attach!, "Attach command") } : null,
    detail.shell ? { label: "Copy the shell command", hint: "from the Pixel host", icon: <IconCopy {...IC_SM} />, onSelect: () => copy(detail.shell!, "Shell command") } : null,
  ];
  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)] bg-term-bg">
      <div className="flex items-center gap-1.5 border-b border-line-2 bg-s1 px-4 py-1.5 text-[12.5px]">
        <span className="min-w-0 truncate font-mono text-[12px] text-ink-3">
          {detail.paths.target}
        </span>
        {state === "connecting" && <span className="text-ink-3">connecting…</span>}
        {state === "closed" && (
          <>
            <span className="text-warning">connection closed</span>
            <Button size="xs" variant="ghost" onClick={() => setSession((s) => s + 1)}>
              <IconRefresh size={12} stroke={2} />
              Reconnect
            </Button>
          </>
        )}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" title="Open a fresh shell" onClick={() => setSession((s) => s + 1)}>
          <IconPlus {...IC_SM} />
          New shell
        </Button>
        {connect.some(Boolean) && (
          <Menu
            trigger={
              <Button size="sm" variant="ghost">
                Connect
              </Button>
            }
            items={connect}
          />
        )}
      </div>
      <div ref={el} className="min-h-0 px-3 py-2 [&_.xterm-viewport]:[scrollbar-width:thin]" />
    </div>
  );
}
