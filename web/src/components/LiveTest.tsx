/**
 * Live test drawer: chat with a model and watch it answer, with first-token time, live output speed,
 * tokens and cost as they happen. Runs in a throwaway opencode with no files where every tool call
 * is refused, so it checks the key, the endpoint and the model's speed, not its agent skills.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { useLive } from "../lib/live.ts";
import { money, tokens as fmtTokens } from "../lib/format.ts";
import { Markdown } from "./Markdown.tsx";
import { ModelSelect, ThinkingSelect } from "./ModelSelect.tsx";
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

const STATUS: Record<Status, { ring: string; label: string }> = {
  starting: { ring: "waiting", label: "starting opencode" },
  waiting: { ring: "running", label: "waiting for first token" },
  streaming: { ring: "running", label: "streaming" },
  done: { ring: "done", label: "done" },
  error: { ring: "failed", label: "failed" },
  stopped: { ring: "interrupted", label: "stopped" },
};

const ms = (n: number | null | undefined) => (n == null ? "–" : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)} s`);
const active = (t: Turn | undefined) => !!t && (t.status === "starting" || t.status === "waiting" || t.status === "streaming");
/** Rough output tokens while streaming (exact counts arrive when the message completes). */
const estimate = (t: Turn) => Math.round(t.parts.reduce((a, p) => a + p.text.length, 0) / 4);
const outTokens = (t: Turn) => t.out ?? estimate(t);
const speed = (t: Turn, now: number) => {
  if (!t.firstAt) return null;
  const s = ((t.doneAt ?? now) - t.firstAt) / 1000;
  return s > 0.25 ? outTokens(t) / s : null;
};

function Spark({ values }: { values: number[] }) {
  const W = 120;
  const H = 22;
  if (values.length < 2) return <svg width={W} height={H} aria-hidden="true" />;
  const max = Math.max(1, ...values);
  const step = W / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(H - 2 - (v / max) * (H - 4)).toFixed(1)}`);
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <polygon points={`0,${H} ${pts.join(" ")} ${W},${H}`} style={{ fill: "var(--accent-soft)" }} />
      <polyline points={pts.join(" ")} fill="none" strokeWidth={1.4} style={{ stroke: "var(--accent)" }} />
    </svg>
  );
}

function Meter({ label, value, sub, wide }: { label: string; value: React.ReactNode; sub?: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`lt-meter ${wide ? "wide" : ""}`}>
      <div className="eyebrow">{label}</div>
      <div className="v num">{value}</div>
      {sub && <div className="s">{sub}</div>}
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
    <div className="lt-turn">
      <div className="lt-prompt">
        <span className="caret">›</span>
        <Markdown text={t.prompt} className="txt" />
      </div>
      <div className="lt-answer">
        <div className="lt-who">
          <span className={`ring ${STATUS[t.status].ring}`} />
          <span className="mono">{t.model}</span>
          {t.status === "done" || t.status === "stopped" ? (
            <span className="muted num">
              {ms(t.firstMs)} first · {v == null ? "–" : `${Math.round(v)} tok/s`} · {fmtTokens(outTokens(t))} tok · {ms(t.doneAt && t.sent ? t.doneAt - t.sent : null)}
              {t.cost > 0 ? ` · ${money(t.cost)}` : ""}
            </span>
          ) : (
            <span className="muted">{t.retry ? `retrying: ${t.retry}` : STATUS[t.status].label}…</span>
          )}
        </div>
        {thinking.length > 0 && (
          <details className="lt-think" open={live && !text}>
            <summary>
              thinking <span className="num">· {fmtTokens(Math.round(thinking.reduce((a, p) => a + p.text.length, 0) / 4))} tok</span>
            </summary>
            <div className="body">{thinking.map((p) => p.text).join("\n\n")}</div>
          </details>
        )}
        {text ? (
          <div className={live ? "lt-streaming" : ""}>
            <Markdown text={text} />
          </div>
        ) : live ? (
          <div className="lt-wait">
            <i />
            <i />
            <i />
          </div>
        ) : null}
        {t.tools.length > 0 && <div className="lt-note">Tried to call {[...new Set(t.tools)].join(", ")}; refused, live tests are text only.</div>}
        {t.error && <div className="lt-err">{t.error}</div>}
      </div>
    </div>
  );
}

export function LiveTest({ model: initial, models, onClose }: { model: string; models: string[]; onClose: () => void }) {
  const [model, setModel] = useState(initial);
  const [variant, setVariant] = useState("");
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

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    box.current?.focus();
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

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
      { id, prompt, model: variant ? `${model} · ${variant}` : model, status: "waiting", queued: Date.now(), sent: null, firstMs: null, firstAt: null, doneAt: null, parts: [], out: null, cost: 0, error: null, retry: null, tools: [], rates: [] },
    ]);
    setInput("");
    try {
      const r = await api.livePrompt({ model, variant: variant || undefined, text: prompt, session: session ?? undefined, turn: id });
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
    <div className="sheet-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Live test">
        <header>
          <div className="min-w-0 flex-1">
            <div className="eyebrow">Live test</div>
            <ModelSelect value={model} onChange={setModel} compact />
          </div>
          <button className="btn btn-sm" onClick={reset} disabled={!turns.length}>
            New chat
          </button>
          <button className="btn btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="lt-think-row">
          <span className="eyebrow">Thinking</span>
          <ThinkingSelect model={model} value={variant} onChange={setVariant} />
        </div>

        <div className="lt-meters">
          <Meter
            label="Status"
            value={
              <span className="flex items-center gap-2">
                <span className={`ring ${cur ? STATUS[cur.status].ring : "idle"}`} />
                <span style={{ fontFamily: "var(--font-sans)", fontSize: 13 }}>{cur ? STATUS[cur.status].label : "ready"}</span>
              </span>
            }
            sub={cur && busy ? `${ms(now - cur.queued)} elapsed` : turns.length ? `${turns.length} message${turns.length === 1 ? "" : "s"} in this chat` : "nothing sent yet"}
          />
          <Meter label="First token" value={ms(cur?.firstMs ?? (cur?.status === "waiting" && cur.sent ? Math.max(0, now - cur.sent) : null))} sub={cur?.firstMs == null && busy ? "waiting…" : "time to first output"} />
          <Meter
            label="Output speed"
            wide
            value={
              <span className="flex items-end gap-3">
                <span>
                  {v == null ? "–" : Math.round(v)}
                  <small> tok/s{cur && cur.out == null && v != null ? " ~" : ""}</small>
                </span>
                <Spark values={cur?.rates ?? []} />
              </span>
            }
          />
          <Meter label="Output" value={cur ? `${fmtTokens(outTokens(cur))}` : "–"} sub={cur?.out == null && busy ? "estimated" : "tokens"} />
          <Meter label="Cost" value={totals.cost > 0 ? money(totals.cost) : cur ? "$0" : "–"} sub="this chat" />
        </div>

        <div
          className="lt-log"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          }}
        >
          {turns.length === 0 ? (
            <div className="lt-empty">
              <div className="big">
                Ask <span className="mono">{model}</span> anything
              </div>
              <div className="muted">Answers stream in live, timed to the millisecond. Pick a starter or type your own.</div>
              <div className="lt-presets">
                {PRESETS.map((p) => (
                  <button key={p.label} className="btn btn-sm" onClick={() => void sendText(p.text)}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            turns.map((t) => <TurnView key={t.id} t={t} now={now} />)
          )}
        </div>

        <form
          className="lt-compose"
          onSubmit={(e) => {
            e.preventDefault();
            void sendText(input);
          }}
        >
          {turns.length > 0 && (
            <div className="lt-presets small">
              {PRESETS.map((p) => (
                <button key={p.label} type="button" className="chip" disabled={busy} onClick={() => void sendText(p.text)}>
                  {p.label}
                </button>
              ))}
            </div>
          )}
          <div className="row">
            <span className="caret">›</span>
            <textarea
              ref={box}
              rows={Math.min(8, Math.max(1, input.split("\n").length))}
              placeholder={busy ? "answering…" : turns.length ? "Follow up…" : "Type a prompt"}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void sendText(input);
                }
              }}
              aria-label="Prompt"
            />
            {busy ? (
              <button type="button" className="btn btn-sm btn-danger" onClick={() => void stop()} disabled={!session}>
                ■ Stop
              </button>
            ) : (
              <button type="submit" className="btn btn-sm btn-primary" disabled={!input.trim()}>
                Send <kbd>⏎</kbd>
              </button>
            )}
          </div>
          <div className="foot">
            <span>Throwaway opencode · no files · tool calls refused</span>
            <span>Each message is a real API call{totals.out ? ` · ${fmtTokens(totals.out)} tokens out so far` : ""}</span>
          </div>
        </form>
      </aside>
    </div>
  );
}
