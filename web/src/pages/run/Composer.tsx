/** The one-line message box at the bottom of a run. Quick messages show only while it has focus; ⌘↵ sends. */
import { useRef, useState } from "react";
import { IconArrowUp, IconCommand, IconCornerDownLeft, IconTerminal2 } from "@tabler/icons-react";
import { api } from "../../lib/api.ts";
import { runName } from "../../lib/fleet.ts";
import type { Run } from "../../lib/types.ts";
import { toast } from "../../components/Toast.tsx";
import { Button } from "../../components/ui.tsx";
import { IC_SM, Kbd } from "../../components/ui/bits.tsx";

const QUICK = ["What are you doing right now?", "Write up what you have so far", "Wrap up and write the report"];

export function Composer({ run }: { run: Run }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  if (!run.session_id) return null;
  const live = run.status === "running" || run.status === "recovering";
  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      await api.message(run.id, t);
      setText("");
      toast("Sent");
    } catch (e: any) {
      toast(e.message ?? String(e), "error");
    } finally {
      setSending(false);
    }
  };
  return (
    <form
      className="group/c relative px-5 pb-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      {live && (
        <div aria-label="Quick messages" className="pointer-events-none absolute right-5 bottom-[calc(100%-6px)] left-5 flex translate-y-1 gap-1.5 overflow-x-auto pb-2 opacity-0 transition-[opacity,transform] duration-100 [scrollbar-width:none] group-focus-within/c:pointer-events-auto group-focus-within/c:translate-y-0 group-focus-within/c:opacity-100">
          {QUICK.map((q) => (
            <button
              key={q}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => (setText(q), ta.current?.focus())}
              className="h-7 shrink-0 rounded-full border border-line-2 bg-s2 px-[11px] text-[12.5px] text-ink-3 hover:border-line hover:text-ink"
            >
              {q}
            </button>
          ))}
        </div>
      )}
      <div className="flex min-h-11 items-center gap-2.5 rounded-xl border border-line bg-s2 py-1 pr-1 pl-3.5 focus-within:border-ink-3">
        <IconTerminal2 {...IC_SM} className="text-ink-3" />
        <textarea
          ref={ta}
          id={`compose-${run.id}`}
          data-composer
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(160, e.target.scrollHeight)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
            if (e.key === "Escape") e.currentTarget.blur();
          }}
          placeholder={`Message ${runName(run)}`}
          aria-label="Message the agent"
          className="max-h-40 min-h-[22px] flex-1 resize-none border-0 bg-transparent py-1.5 leading-snug text-ink outline-none placeholder:text-ink-3"
        />
        <span className="hidden items-center gap-[3px] group-focus-within/c:flex">
          <Kbd>
            <IconCommand size={12} stroke={2} />
          </Kbd>
          <Kbd>
            <IconCornerDownLeft size={12} stroke={2} />
          </Kbd>
        </span>
        <Button type="submit" size="sm" icon variant="primary" aria-label="Send" disabled={!text.trim() || sending}>
          <IconArrowUp {...IC_SM} />
        </Button>
      </div>
    </form>
  );
}
