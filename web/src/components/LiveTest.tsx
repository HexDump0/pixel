/**
 * Live test drawer: chat with a model and watch it answer, with first-token time, live output speed,
 * tokens and cost as they happen. Runs in a throwaway opencode with no files where every tool call
 * is refused, so it checks the key, the endpoint and the model's speed, not its agent skills.
 */
import { useEffect, useRef, useState } from "react";
import { IconArrowUp, IconLoader2, IconMessagePlus, IconPlayerStopFilled, IconX } from "@tabler/icons-react";
import { KeySelect } from "./KeySelect.tsx";
import { api } from "../lib/api.ts";
import { useLive } from "../lib/live.ts";
import { money, tokens as fmtTokens } from "../lib/format.ts";
import { cn } from "../lib/cn.ts";
import { Markdown } from "./Markdown.tsx";
import { ModelSelect, ThinkingSelect } from "./ModelSelect.tsx";
import { Button } from "./ui.tsx";
import { IC_SM, Join, Nil, Sep, Val } from "./ui/bits.tsx";
import { DialogClose, Sheet } from "./ui/overlay.tsx";
import { toast } from "./Toast.tsx";

type Status = "starting" | "waiting" | "streaming" | "done" | "error" | "stopped";
interface Part {
  id: string;
  type: string;
  text: string;
}
interface Turn {
  id: string;
  prompt: string;
  model: string;
  status: Status;
  /** When Send was pressed (sent = when opencode accepted it). */
  queued: number;
  sent: number | null;
  firstMs: number | null;
  firstAt: number | null;
  doneAt: number | null;
  parts: Part[];
  out: number | null;
  cost: number;
  error: string | null;
  retry: string | null;
  tools: string[];
  /** Output tokens/s, sampled while streaming. */
  rates: number[];
}

const PRESETS: { label: string; text: string }[] = [
  { label: "Hello", text: "Say hello and tell me which model you are, in one sentence." },
  { label: "Speed run", text: "Write about 250 words explaining how a hash table resolves collisions, comparing separate chaining and open addressing. Plain prose in two or three paragraphs, no lists, no code, no headings." },
  { label: "Spot the bug", text: "Here is a C function:\n\n```c\nvoid greet(const char *name) {\n  char buf[16];\n  strcpy(buf, \"Hi \");\n  strcat(buf, name);\n  puts(buf);\n}\n```\n\nWhat is the bug, how could an attacker use it, and how do you fix it? Be brief." },
  { label: "Code", text: "Write a Python function that converts an ISO 8601 duration like P3DT4H5M6S into seconds. Include a short docstring and two examples." },
  { label: "Reasoning", text: "A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost? Explain in two sentences." },
];

const STATUS: Record<Status, { dot: string; label: string }> = {
  starting: { dot: "bg-ink-4", label: "Starting opencode" },
  waiting: { dot: "bg-warning", label: "Waiting for the first token" },
  streaming: { dot: "bg-good", label: "Streaming" },
  done: { dot: "bg-ink-3", label: "Done" },
  error: { dot: "bg-critical", label: "Failed" },
  stopped: { dot: "bg-ink-4", label: "Stopped" },
};

const ms = (n: number | null | undefined) => (n == null ? "" : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)} s`);
const active = (t: Turn | undefined) => !!t && (t.status === "starting" || t.status === "waiting" || t.status === "streaming");
/** Rough output tokens while streaming (exact counts arrive when the message completes). */
const estimate = (t: Turn) => Math.round(t.parts.reduce((a, p) => a + p.text.length, 0) / 4);
const outTokens = (t: Turn) => t.out ?? estimate(t);
const speed = (t: Turn, now: number) => {
  if (!t.firstAt) return null;
  const s = ((t.doneAt ?? now) - t.firstAt) / 1000;
  return s > 0.25 ? outTokens(t) / s : null;
};

/** Output tokens/s while the answer streams, across the full width under the numbers. */
function SpeedArea({ values }: { values: number[] }) {
  const W = 600;
  const H = 34;
  if (values.length < 2) return <div className="h-[34px]" />;
  const max = Math.max(1, ...values);
  const step = W / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(H - 1 - (v / max) * (H - 4)).toFixed(1)}`);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-[34px] w-full" aria-hidden="true">
      <polygon points={`0,${H} ${pts.join(" ")} ${W},${H}`} style={{ fill: "var(--accent-soft)" }} />
      <polyline points={pts.join(" ")} fill="none" strokeWidth={1.5} vectorEffect="non-scaling-stroke" style={{ stroke: "var(--accent-c)" }} />
    </svg>
  );
}

function Stat({ label, value, unit }: { label: string; value: React.ReactNode; unit?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-ink-3">{label}</div>
      <div className="mt-0.5 font-mono text-[19px] font-medium tracking-[-0.01em] tabular-nums">
        {value}
        {unit && <small className="ml-1 font-sans text-[11px] font-normal text-ink-3">{unit}</small>}
      </div>
    </div>
  );
}

function TurnView({ t, now }: { t: Turn; now: number }) {
  const answer = t.parts.filter((p) => p.type === "text");
  const thinking = t.parts.filter((p) => p.type === "reasoning" && p.text.trim());
  const text = answer.map((p) => p.text).join("\n\n");
  const live = active(t);
  const v = speed(t, now);
  return (
    <div className="flex flex-col gap-3">
      <div className="ml-auto max-w-[85%] rounded-xl rounded-br-md bg-s3 px-3.5 py-2.5 text-[13.5px]">
        <Markdown text={t.prompt} />
      </div>
      <div className="min-w-0">
        <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          {live ? <IconLoader2 size={12} className="animate-spin text-ink-3" /> : <i className={cn("size-1.5 rounded-full", STATUS[t.status].dot)} />}
          <span className="font-mono text-ink-2">{t.model}</span>
          {t.status === "done" || t.status === "stopped" ? (
            <span className="font-mono text-ink-3 tabular-nums">
              <Join items={[`${ms(t.firstMs) || "no"} first token`, v == null ? "" : `${Math.round(v)} tok/s`, `${fmtTokens(outTokens(t))} tok`, ms(t.doneAt && t.sent ? t.doneAt - t.sent : null), t.cost > 0 && money(t.cost)]} />
            </span>
          ) : (
            <span className="text-ink-3">{t.retry ? `Retrying: ${t.retry}` : STATUS[t.status].label}</span>
          )}
        </div>
        {thinking.length > 0 && (
          <details className="group mb-2 rounded-lg border border-line-2 bg-s2/50" open={live && !text}>
            <summary className="cursor-pointer list-none px-3 py-1.5 text-xs text-ink-3 select-none hover:text-ink [&::-webkit-details-marker]:hidden">
              Thinking <Sep /> <span className="font-mono">{fmtTokens(Math.round(thinking.reduce((a, p) => a + p.text.length, 0) / 4))} tok</span>
            </summary>
            <div className="max-h-64 overflow-y-auto border-t border-line-2 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-3">{thinking.map((p) => p.text).join("\n\n")}</div>
          </details>
        )}
        {text ? <Markdown text={text} /> : null}
        {t.tools.length > 0 && <div className="mt-2 text-xs text-ink-3">Tried to call {[...new Set(t.tools)].join(", ")}; refused, live tests are text only.</div>}
        {t.error && <div className="mt-2 rounded-lg border border-critical/40 bg-critical/10 px-3 py-2 text-[13px] text-critical">{t.error}</div>}
      </div>
    </div>
  );
}

export function LiveTest({ model: initial, models, onClose }: { model: string; models: string[]; onClose: () => void }) {
  const [model, setModel] = useState(initial);
  const [variant, setVariant] = useState("");
  // "" = the provider's default key, a key id, or "none" to call without a key.
  const [keyChoice, setKeyChoice] = useState("");
  const [session, setSession] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [now, setNow] = useState(Date.now());
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastChars = useRef<{ at: number; chars: number } | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  const cur = turns[turns.length - 1];
  const busy = active(cur);


  const patch = (id: string, f: (t: Turn) => Turn) => setTurns((ts) => ts.map((t) => (t.id === id ? f(t) : t)));

  useLive("*", (m) => {
    if (m.type !== "live") return;
    const d = m.data as any;
    setTurns((ts) => {
      const i = ts.findIndex((t) => t.id === d.turn);
      if (i < 0) return ts;
      const t = { ...ts[i] };
      switch (d.kind) {
        case "starting":
          t.status = "starting";
          break;
        case "sent":
          t.status = "waiting";
          t.sent = d.at;
          break;
        case "first":
          t.firstMs = d.ms;
          t.firstAt = d.at;
          t.status = "streaming";
          break;
        case "part": {
          const j = t.parts.findIndex((p) => p.id === d.part);
          const part = { id: d.part, type: d.type, text: d.text };
          // A part update carries the full text; keep the longer one so a late update can't erase deltas.
          t.parts = j < 0 ? [...t.parts, part] : t.parts.map((p, k) => (k === j ? { ...part, text: d.text.length >= p.text.length ? d.text : p.text } : p));
          break;
        }
        case "delta": {
          const j = t.parts.findIndex((p) => p.id === d.part);
          t.parts = j < 0 ? [...t.parts, { id: d.part, type: "text", text: d.delta }] : t.parts.map((p, k) => (k === j ? { ...p, text: p.text + d.delta } : p));
          if (t.status === "waiting") t.status = "streaming";
          break;
        }
        case "message":
          if (d.tokens && (d.tokens.output || d.tokens.reasoning)) t.out = (d.tokens.output ?? 0) + (d.tokens.reasoning ?? 0);
          t.cost = d.cost ?? t.cost;
          if (d.error) t.error = d.error;
          break;
        case "retry":
          t.retry = `attempt ${d.attempt}: ${d.message}`.slice(0, 160);
          break;
        case "tool":
          t.tools = [...t.tools, d.tool];
          break;
        case "done":
        case "error":
        case "stopped":
          t.status = d.kind;
          t.doneAt = d.at ?? Date.now();
          t.retry = null;
          if (d.error) t.error = d.error;
          break;
      }
      const out = [...ts];
      out[i] = t;
      return out;
    });
  });

  // Tick while answering: elapsed time, live speed, and a speed sample every quarter second.
  useEffect(() => {
    if (!busy) return;
    lastChars.current = null;
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      setTurns((ts) => {
        const c = ts[ts.length - 1];
        if (!c || c.status !== "streaming") return ts;
        const chars = c.parts.reduce((a, p) => a + p.text.length, 0);
        const prev = lastChars.current;
        lastChars.current = { at: t, chars };
        if (!prev) return ts;
        const rate = (chars - prev.chars) / 4 / ((t - prev.at) / 1000);
        return [...ts.slice(0, -1), { ...c, rates: [...c.rates.slice(-119), Math.max(0, rate)] }];
      });
    }, 250);
    return () => clearInterval(timer);
  }, [busy]);

  // Follow the answer unless the reader scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const sendText = async (text: string) => {
    const prompt = text.trim();
    if (!prompt || busy) return;
    const id = `lt-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    stick.current = true;
    setTurns((ts) => [
      ...ts,
      { id, prompt, model: variant ? `${model}, ${variant}` : model, status: "waiting", queued: Date.now(), sent: null, firstMs: null, firstAt: null, doneAt: null, parts: [], out: null, cost: 0, error: null, retry: null, tools: [], rates: [] },
    ]);
    setInput("");
    try {
      const r = await api.livePrompt({ model, variant: variant || undefined, text: prompt, session: session ?? undefined, turn: id, key: keyChoice || undefined });
      setSession(r.session);
    } catch (e: any) {
      patch(id, (t) => ({ ...t, status: "error", error: e.message ?? String(e), doneAt: Date.now() }));
    }
  };
  const stop = async () => {
    if (!session) return;
    try {
      await api.liveAbort(session);
    } catch (e: any) {
      toast(e.message ?? String(e), "error");
    }
  };
  const reset = () => {
    if (busy) void stop();
    setSession(null);
    setTurns([]);
    box.current?.focus();
  };

  const v = cur ? speed(cur, now) : null;
  const totals = turns.reduce((a, t) => ({ cost: a.cost + t.cost, out: a.out + (t.status === "done" ? outTokens(t) : 0) }), { cost: 0, out: 0 });

  return (
    <Sheet onOpenChange={(o) => !o && onClose()} title="Live test">
      <header className="flex h-14 shrink-0 items-center gap-1.5 border-b border-line-2 pr-3 pl-3.5">
        <div className="min-w-0 flex-1">
          <ModelSelect value={model} onChange={(m) => (setModel(m), setKeyChoice(""))} compact />
        </div>
        <Button size="sm" variant="ghost" onClick={reset} disabled={!turns.length}>
          <IconMessagePlus {...IC_SM} />
          New chat
        </Button>
        <DialogClose aria-label="Close" className="inline-flex size-8 cursor-pointer items-center justify-center rounded-lg text-ink-3 hover:bg-s3 hover:text-ink">
          <IconX {...IC_SM} />
        </DialogClose>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-b border-line-2 px-5 py-2.5">
        <span className="inline-flex items-center gap-2.5">
          <span className="text-xs text-ink-3">Key</span>
          <KeySelect
            model={model}
            value={keyChoice}
            onChange={(k) => {
              setKeyChoice(k);
              // Another key means another opencode; the next message starts a new chat.
              setSession(null);
            }}
          />
        </span>
        <span className="inline-flex min-w-0 items-center gap-2.5">
          <span className="text-xs text-ink-3">Thinking</span>
          <ThinkingSelect model={model} value={variant} onChange={setVariant} />
        </span>
      </div>

      <div className="shrink-0 border-b border-line-2 px-5 pt-3.5">
        <div className="flex items-center gap-2 text-[12.5px]">
          {busy ? <IconLoader2 size={13} className="animate-spin text-ink-3" /> : <i className={cn("size-2 rounded-full", cur ? STATUS[cur.status].dot : "bg-ink-4")} />}
          <span className={cur?.status === "error" ? "text-critical" : "text-ink-2"}>{cur ? (cur.retry ? `Retrying: ${cur.retry}` : STATUS[cur.status].label) : "Ready"}</span>
          <span className="ml-auto font-mono text-[11.5px] text-ink-4">{cur && busy ? `${ms(now - cur.queued)}` : turns.length ? `${turns.length} message${turns.length === 1 ? "" : "s"}` : keyChoice === "none" ? "no key" : ""}</span>
        </div>
        <div className="mt-3 grid grid-cols-4 gap-4">
          <Stat label="First token" value={<Val v={ms(cur?.firstMs ?? (cur?.status === "waiting" && cur.sent ? Math.max(0, now - cur.sent) : null))} />} />
          <Stat label="Output speed" value={v == null ? <Nil /> : Math.round(v)} unit={`tok/s${cur && cur.out == null && v != null ? " ~" : ""}`} />
          <Stat label="Output" value={cur ? fmtTokens(outTokens(cur)) : <Nil />} unit={cur ? "tok" : undefined} />
          <Stat label="Cost" value={totals.cost > 0 ? money(totals.cost) : cur ? "$0" : <Nil />} />
        </div>
        <div className="-mx-5 mt-2.5">
          <SpeedArea values={cur?.rates ?? []} />
        </div>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-5 py-5"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {turns.length === 0 ? (
          <div className="mx-auto flex min-h-full max-w-[560px] flex-col justify-center gap-4 py-4">
            <div>
              <div className="text-[17px] font-medium">Try {model.split("/").slice(1).join("/")}</div>
              <div className="mt-1 text-[13px] text-ink-3">Answers stream in live, timed to the millisecond. Pick a starter or type your own.</div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => void sendText(p.text)}
                  className="flex cursor-pointer flex-col gap-1 rounded-xl border border-line-2 bg-s1 px-3.5 py-3 text-left hover:border-line hover:bg-s2"
                >
                  <span className="text-[13px] font-medium text-ink">{p.label}</span>
                  <span className="line-clamp-2 text-xs text-ink-3">{p.text.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ")}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-7">
            {turns.map((t) => (
              <TurnView key={t.id} t={t} now={now} />
            ))}
          </div>
        )}
      </div>

      <form
        className="shrink-0 border-t border-line-2 px-5 pt-3 pb-4"
        onSubmit={(e) => {
          e.preventDefault();
          void sendText(input);
        }}
      >
        {turns.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {PRESETS.map((p) => (
              <button key={p.label} type="button" disabled={busy} onClick={() => void sendText(p.text)} className="h-6 cursor-pointer rounded-md border border-line-2 bg-transparent px-2 text-xs text-ink-3 hover:text-ink disabled:cursor-default disabled:opacity-40">
                {p.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-xl border border-line bg-[color-mix(in_srgb,var(--bg)_70%,var(--s1))] p-1.5 pl-3.5 focus-within:border-[color-mix(in_srgb,var(--accent-c)_65%,var(--line))] focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
          <textarea
            ref={box}
            data-autofocus
            rows={Math.min(8, Math.max(1, input.split("\n").length))}
            placeholder={busy ? "Answering" : turns.length ? "Follow up" : "Type a prompt"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void sendText(input);
              }
            }}
            aria-label="Prompt"
            className="min-h-8 flex-1 resize-none self-center border-0 bg-transparent py-1.5 text-[13.5px] text-ink outline-none placeholder:text-ink-4"
          />
          {busy ? (
            <Button size="sm" icon variant="danger" onClick={stop} disabled={!session} aria-label="Stop" title="Stop">
              <IconPlayerStopFilled size={13} />
            </Button>
          ) : (
            <Button size="sm" icon variant="primary" type="submit" disabled={!input.trim()} aria-label="Send" title="Send (Enter)">
              <IconArrowUp {...IC_SM} />
            </Button>
          )}
        </div>
        <div className="mt-2 flex justify-between gap-3 text-[11.5px] text-ink-4">
          <Join items={["Throwaway opencode", "no files", "tool calls refused"]} />
          <span className="max-sm:hidden">Each message is a real API call{totals.out ? `, ${fmtTokens(totals.out)} tokens out` : ""}</span>
        </div>
      </form>
    </Sheet>
  );
}
