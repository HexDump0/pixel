/**
 * Live transcript of one session (the main agent or a subagent), as a readable stream: the agent's text as
 * prose, tool calls as one-line rows (open one for its command, output or diff), thinking folded away, a
 * divider only when time jumps or the model changes. Follows the bottom while you're there.
 */
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IconAlertTriangle, IconArrowDown, IconChevronDown, IconChevronRight, IconDots, IconLoader2, IconSearch, IconX } from "@tabler/icons-react";
import { api } from "../../lib/api.ts";
import { useAsync } from "../../lib/hooks.ts";
import { useLive } from "../../lib/live.ts";
import { duration } from "../../lib/format.ts";
import { kindColor } from "../../lib/fleet.ts";
import { kindOf } from "../../../../server/src/kinds.ts";
import { highlight, langForPath } from "../../lib/highlight.ts";
import { cn } from "../../lib/cn.ts";
import type { Message, Part, RunDetail } from "../../lib/types.ts";
import { Markdown } from "../../components/Markdown.tsx";
import { Button, ErrorBox } from "../../components/ui.tsx";
import { Menu } from "../../components/ui/overlay.tsx";
import { IC_SM, IC_XS, Kbd, Nothing, Sep } from "../../components/ui/bits.tsx";

/** A gap this long, or a model change, gets a divider with the time. */
const GAP_MS = 5 * 60_000;
const PAGE = 400;

type Filter = "all" | "text" | "tools" | "errors";
const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["text", "Text"],
  ["tools", "Tools"],
  ["errors", "Errors"],
];

type Entry =
  | { k: "prompt" | "you"; id: string; ts: number; text: string }
  | { k: "text" | "thinking"; id: string; ts: number; text: string }
  | { k: "tool"; id: string; ts: number; part: Part }
  | { k: "patch"; id: string; ts: number; files: string[] }
  | { k: "error"; id: string; ts: number; text: string; name: string }
  | { k: "divider"; id: string; ts: number; model?: string };

const textOf = (m: Message) => m.parts.filter((p) => p.type === "text" && p.text && !p.synthetic).map((p) => p.text).join("\n\n");

/** What the provider said: HTTP status, message, and its response body when that adds anything. */
function errorDetail(err: { name: string; data?: any }) {
  const d = err.data ?? {};
  const msg = String(d.message ?? "");
  const body = d.responseBody && !msg.includes(String(d.responseBody)) ? String(d.responseBody) : "";
  return [d.statusCode && `HTTP ${d.statusCode}`, msg, body.slice(0, 1000)].filter(Boolean).join(", ") || "no details from the provider";
}

function entriesOf(msgs: Message[]): Entry[] {
  const out: Entry[] = [];
  let last = 0;
  let model: string | undefined;
  let firstUser = true;
  for (const m of msgs) {
    const ts = m.info.time.created;
    const newModel = m.info.role === "assistant" && m.info.modelID && m.info.modelID !== model;
    if (!last || ts - last > GAP_MS || (newModel && model)) out.push({ k: "divider", id: `d-${m.info.id}`, ts, model: newModel ? m.info.modelID : undefined });
    if (m.info.modelID) model = m.info.modelID;
    last = ts;
    if (m.info.role === "user") {
      out.push({ k: firstUser ? "prompt" : "you", id: m.info.id, ts, text: textOf(m) });
      firstUser = false;
      continue;
    }
    for (const p of m.parts) {
      const t = p.state?.time?.start ?? ts;
      if (p.type === "text" && p.text && !p.synthetic) out.push({ k: "text", id: p.id, ts: t, text: p.text });
      else if (p.type === "reasoning" && p.text?.trim()) out.push({ k: "thinking", id: p.id, ts: t, text: p.text });
      else if (p.type === "tool") out.push({ k: "tool", id: p.id, ts: t, part: p });
      else if (p.type === "patch") out.push({ k: "patch", id: p.id, ts: t, files: (p.files as string[] | undefined) ?? [] });
    }
    if (m.info.error && m.info.error.name !== "MessageAbortedError") out.push({ k: "error", id: `e-${m.info.id}`, ts, name: m.info.error.name, text: errorDetail(m.info.error) });
  }
  return out;
}

/** Paths inside the machine, shortened: the target is the starting point, the workbase and scratch are named. */
function shortener(paths: RunDetail["paths"]) {
  const pre: [string, string][] = [
    [paths.target.replace(/\/$/, "") + "/", ""],
    [paths.workbase.replace(/\/$/, "") + "/", "workbase/"],
    [paths.scratch.replace(/\/$/, "") + "/", "scratch/"],
  ];
  return (s: string) => {
    let out = s;
    for (const [from, to] of pre) out = out.split(from).join(to);
    return out;
  };
}

/** One line saying what the call did. */
function summary(p: Part, short: (s: string) => string) {
  const i = p.state?.input ?? {};
  const title = p.state?.title && p.state.title !== p.tool ? p.state.title : "";
  switch (p.tool) {
    case "bash":
      return short(String(i.command ?? title).split("\n")[0]);
    case "read":
    case "edit":
    case "write":
    case "patch":
    case "multiedit":
      return short(String(i.filePath ?? title));
    case "grep":
      return `${i.pattern ?? ""}${i.path ? `  ${short(String(i.path))}` : ""}${i.include ? `  ${i.include}` : ""}`;
    case "glob":
      return `${i.pattern ?? ""}${i.path ? `  ${short(String(i.path))}` : ""}`;
    case "task":
      return String(i.description ?? title);
    case "webfetch":
      return String(i.url ?? title);
    case "todowrite":
      return Array.isArray(i.todos) ? `${i.todos.length} todos` : title;
    default:
      return short(title || String(i.command ?? i.filePath ?? i.path ?? i.url ?? i.query ?? i.description ?? ""));
  }
}

function matches(e: Entry, q: string, short: (s: string) => string) {
  const hay = e.k === "tool" ? `${e.part.tool} ${summary(e.part, short)} ${e.part.state?.output ?? ""} ${e.part.state?.error ?? ""}` : "text" in e ? e.text : "files" in e ? e.files.join(" ") : "";
  return hay.toLowerCase().includes(q);
}

function keep(e: Entry, f: Filter) {
  if (f === "all" || e.k === "divider") return true;
  if (f === "text") return e.k === "text" || e.k === "you" || e.k === "prompt";
  if (f === "tools") return e.k === "tool" || e.k === "patch";
  return e.k === "error" || (e.k === "tool" && e.part.state?.status === "error");
}

const Code = ({ html, className }: { html: string; className?: string }) => (
  <pre className={cn("m-0 max-h-96 overflow-auto rounded-lg bg-term-bg px-3 py-2.5 font-mono text-[12px] leading-[1.55] whitespace-pre-wrap text-term-ink [scrollbar-width:thin]", className)}>
    <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
  </pre>
);

/** The opened tool call: what went in and what came out, in the form that reads best for that tool. */
function ToolBody({ p, short, onOpenSession, hasChild }: { p: Part; short: (s: string) => string; onOpenSession: (id: string) => void; hasChild: boolean }) {
  const st = p.state ?? ({} as NonNullable<Part["state"]>);
  const i = st.input ?? {};
  const out = st.output ? short(String(st.output)) : "";
  const blocks: ReactNode[] = [];
  if (p.tool === "bash") {
    if (String(i.command ?? "").includes("\n") || String(i.command ?? "").length > 90) blocks.push(<Code key="cmd" html={highlight(short(String(i.command)), "bash")} />);
    if (i.description) blocks.push(<div key="desc" className="text-[12.5px] text-ink-3">{String(i.description)}</div>);
  } else if (p.tool === "write" && typeof i.content === "string") {
    blocks.push(<Code key="content" html={highlight(i.content, langForPath(String(i.filePath ?? "")))} />);
  } else if (typeof st.metadata?.diff === "string" && st.metadata.diff) {
    blocks.push(<Code key="diff" html={highlight(short(st.metadata.diff), "diff")} />);
  } else if (p.tool === "task") {
    if (hasChild) {
      blocks.push(
        <div key="open">
          <Button size="xs" onClick={() => onOpenSession(st.metadata!.sessionId)}>
            Open the subagent's transcript
          </Button>
        </div>,
      );
    }
  } else if (!["read", "grep", "glob"].includes(p.tool ?? "")) {
    blocks.push(<Code key="input" html={highlight(JSON.stringify(i, null, 2), "json")} />);
  }
  if (st.error) blocks.push(<Code key="err" className="text-critical" html={highlight(short(st.error), null)} />);
  else if (out && p.tool === "task") blocks.push(<Markdown key="out" text={out} className="text-[13.5px]" />);
  else if (out && !(p.tool === "write" || (p.tool === "edit" && st.metadata?.diff))) blocks.push(<Code key="out" html={highlight(out.slice(0, 100_000), null)} />);
  if (!blocks.length) blocks.push(<div key="none" className="text-[12.5px] text-ink-3">No output.</div>);
  return <div className="flex flex-col gap-2 px-3 pt-1 pb-3 pl-[38px]">{blocks}</div>;
}

const ToolRow = memo(function ToolRow({ p, short, onOpenSession, hasChild }: { p: Part; short: (s: string) => string; onOpenSession: (id: string) => void; hasChild: boolean }) {
  const st = p.state;
  const failed = st?.status === "error";
  const running = st?.status === "running" || st?.status === "pending";
  const [open, setOpen] = useState(failed);
  const took = st?.time?.end && st.time.start ? tookText(st.time.end - st.time.start) : "";
  const text = summary(p, short);
  return (
    <div className={cn(open && "bg-s2/60")}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={p.tool === "bash" && st?.input?.description ? String(st.input.description) : text}
        className="grid h-8 w-full cursor-pointer grid-cols-[16px_76px_minmax(0,1fr)_auto] items-center gap-2.5 px-3 text-left hover:bg-s2"
      >
        {open ? <IconChevronDown {...IC_XS} className="text-ink-3" /> : <IconChevronRight {...IC_XS} className="text-ink-4" />}
        <span className="truncate font-mono text-[12.5px]" style={{ color: kindColor(kindOf(p.tool ?? "")) }}>
          {p.tool === "task" ? "subagent" : p.tool}
        </span>
        <span className={cn("truncate font-mono text-[12.5px]", failed ? "text-critical" : "text-ink-2")}>{text}</span>
        <span className="flex items-center gap-1.5 font-mono text-[11.5px] text-ink-4 tabular-nums">
          {failed && <span className="text-critical">failed</span>}
          {running ? <IconLoader2 {...IC_XS} className="animate-spin text-ink-3" /> : took}
        </span>
      </button>
      {open && <ToolBody p={p} short={short} onOpenSession={onOpenSession} hasChild={hasChild} />}
    </div>
  );
});

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="inline-flex cursor-pointer items-center gap-1.5 text-[12.5px] text-ink-3 hover:text-ink-2">
        {open ? <IconChevronDown {...IC_XS} /> : <IconChevronRight {...IC_XS} />}
        Thinking
      </button>
      {open && <p className="mt-1.5 mb-0 border-l border-line pl-3.5 text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink-3 italic">{text}</p>}
    </div>
  );
}

function Prompt({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-line-2">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full cursor-pointer items-center gap-2 px-3.5 py-2.5 text-left text-[13px] text-ink-2 hover:text-ink">
        {open ? <IconChevronDown {...IC_XS} /> : <IconChevronRight {...IC_XS} />}
        Prompt
        <span className="font-mono text-xs text-ink-4">{text.length.toLocaleString()} chars</span>
      </button>
      {open && <Markdown text={text} className="border-t border-line-2 px-4 pb-3 text-[13.5px]" />}
    </div>
  );
}

/** 0.9s, 14s, 3m 10s: short calls are most calls, so they keep a decimal. */
const tookText = (ms: number) => (ms < 10_000 ? `${(Math.max(ms, 0) / 1000).toFixed(1)}s` : duration(ms));

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

type Block = { k: "tools"; id: string; items: Extract<Entry, { k: "tool" | "patch" }>[] } | Entry;

/** Consecutive tool calls form one block, so a burst of calls reads as one list. */
function blocksOf(entries: Entry[]): Block[] {
  const out: Block[] = [];
  for (const e of entries) {
    const prev = out[out.length - 1];
    if (e.k === "tool" || e.k === "patch") {
      if (prev && prev.k === "tools") prev.items.push(e);
      else out.push({ k: "tools", id: `g-${e.id}`, items: [e] });
    } else out.push(e);
  }
  return out;
}

export function TranscriptTab({ detail }: { detail: RunDetail }) {
  const runId = detail.run.id;
  const root = detail.run.session_id;
  const [session, setSession] = useState<string | null>(root);
  const msgs = useAsync(() => (session ? api.transcript(runId, session) : Promise.resolve([])), [runId, session]);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [atBottom, setAtBottom] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const short = useMemo(() => shortener(detail.paths), [detail.paths]);

  useLive(runId, (m) => {
    const sid = m.data?.sessionID ?? m.data?.info?.sessionID;
    if (m.type === "synced") return void msgs.reload();
    if (sid !== session) return;
    if (m.type === "message") {
      msgs.setData((xs = []) => (xs.some((x) => x.info.id === m.data.id) ? xs.map((x) => (x.info.id === m.data.id ? { ...x, info: m.data } : x)) : [...xs, { info: m.data, parts: [] }]));
    } else if (m.type === "part") msgs.setData((xs = []) => applyPart(xs, m.data));
    else if (m.type === "delta") msgs.setData((xs = []) => applyDelta(xs, m.data));
  });

  const entries = useMemo(() => entriesOf(msgs.data ?? []), [msgs.data]);
  const needle = q.trim().toLowerCase();
  const visible = useMemo(() => {
    const kept = entries.filter((e) => keep(e, filter) && (!needle || e.k === "divider" || matches(e, needle, short)));
    // Dividers with nothing after them (filtered away) go too.
    return kept.filter((e, i) => e.k !== "divider" || (kept[i + 1] && kept[i + 1].k !== "divider"));
  }, [entries, filter, needle, short]);
  const blocks = useMemo(() => blocksOf(visible), [visible]);
  const hidden = Math.max(0, blocks.length - shown);
  const hits = needle ? visible.filter((e) => e.k !== "divider").length : 0;

  // Stay at the bottom while you're there; leave you alone once you scroll up.
  useEffect(() => {
    if (atBottom && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [blocks, atBottom]);
  useEffect(() => setShown(PAGE), [session, filter, needle]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || (e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      search.current?.focus();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const children = detail.sessions.filter((s) => s.id !== root);
  const current = children.find((s) => s.id === session);
  const sessionIds = new Set(detail.sessions.map((s) => s.id));
  const childOf = (p: Part) => (p.tool === "task" && typeof p.state?.metadata?.sessionId === "string" && sessionIds.has(p.state.metadata.sessionId) ? p.state.metadata.sessionId : null);
  const toBottom = () => scroller.current?.scrollTo({ top: scroller.current.scrollHeight });

  return (
    <div className="relative h-full">
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
        }}
        className="h-full overflow-y-auto [scrollbar-width:thin]"
      >
        <div className="sticky top-0 z-10 border-b border-line-2 bg-s1/95 backdrop-blur-sm">
          <div className="mx-auto flex max-w-[808px] flex-wrap items-center gap-2 px-6 py-2.5 max-md:px-4">
            <div className="flex min-w-0 items-center gap-1 text-[13px]">
              {current ? (
                <>
                  <button type="button" className="cursor-pointer text-ink-3 hover:text-ink" onClick={() => setSession(root)}>
                    Main
                  </button>
                  <IconChevronRight {...IC_XS} className="text-ink-4" />
                </>
              ) : null}
              {children.length ? (
                <Menu
                  align="start"
                  trigger={
                    <Button size="sm" variant="ghost" className="min-w-0">
                      <span className="truncate">{current ? (current.title ?? current.id) : "Main agent"}</span>
                      <IconChevronDown {...IC_XS} className="text-ink-3" />
                    </Button>
                  }
                  items={[
                    { label: "Main agent", checked: session === root, onSelect: () => setSession(root) },
                    "-",
                    { head: `Subagents (${children.length})` },
                    ...children.map((s) => ({ label: s.title ?? s.id, hint: s.agent ?? undefined, checked: session === s.id, onSelect: () => setSession(s.id) })),
                  ]}
                />
              ) : (
                <span className="px-1 text-ink-2">Main agent</span>
              )}
            </div>
            <span className="flex-1" />
            <div role="radiogroup" aria-label="Show" className="flex items-center gap-0.5 rounded-lg bg-s2 p-0.5">
              {FILTERS.map(([f, label]) => (
                <button
                  key={f}
                  type="button"
                  role="radio"
                  aria-checked={filter === f}
                  onClick={() => setFilter(f)}
                  className="h-[26px] cursor-pointer rounded-md px-2.5 text-[12.5px] text-ink-3 hover:text-ink aria-checked:bg-s3 aria-checked:text-ink"
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="flex h-[30px] w-52 items-center gap-1.5 rounded-lg border border-line-2 bg-s1 px-2 focus-within:border-ink-4 max-md:w-full">
              <IconSearch {...IC_XS} className="shrink-0 text-ink-4" />
              <input
                ref={search}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && (setQ(""), e.currentTarget.blur())}
                placeholder="Search"
                aria-label="Search the transcript"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-4"
              />
              {q ? (
                <button type="button" aria-label="Clear search" className="cursor-pointer text-ink-4 hover:text-ink" onClick={() => setQ("")}>
                  <IconX {...IC_XS} />
                </button>
              ) : (
                <Kbd>/</Kbd>
              )}
            </label>
            <Menu
              trigger={
                <Button size="sm" icon variant="ghost" aria-label="More">
                  <IconDots {...IC_SM} />
                </Button>
              }
              items={[{ label: "Resync from opencode", hint: "reload the session", onSelect: () => void api.control(runId, "sync").then(() => msgs.reload()) }]}
            />
          </div>
        </div>

        <div className="mx-auto flex max-w-[808px] flex-col gap-4 px-6 pt-5 pb-16 max-md:px-4">
          <ErrorBox error={msgs.error} />
          {needle && <div className="text-[12.5px] text-ink-3">{hits ? `${hits} match${hits === 1 ? "" : "es"}` : "No matches"}</div>}
          {msgs.data && !entries.length && <Nothing>No messages yet.</Nothing>}
          {hidden > 0 && (
            <div>
              <Button size="sm" variant="ghost" onClick={() => setShown(shown + PAGE)}>
                Show {Math.min(PAGE, hidden)} earlier
              </Button>
            </div>
          )}
          {blocks.slice(hidden).map((b) => {
            switch (b.k) {
              case "divider":
                return (
                  <div key={b.id} className="flex items-center gap-3 pt-2 font-mono text-[11.5px] text-ink-4 tabular-nums">
                    <span className="h-px flex-1 bg-line-2" />
                    {clock(b.ts)}
                    {b.model && <><Sep />{b.model}</>}
                    <span className="h-px flex-1 bg-line-2" />
                  </div>
                );
              case "prompt":
                return <Prompt key={b.id} text={b.text} />;
              case "you":
                return (
                  <div key={b.id} className="ml-auto max-w-[85%] rounded-xl bg-s2 px-3.5 py-2.5">
                    <div className="mb-1 text-xs text-ink-3">You</div>
                    <div className="text-[14px] leading-relaxed whitespace-pre-wrap text-ink">{b.text}</div>
                  </div>
                );
              case "text":
                return <Markdown key={b.id} text={b.text} className="text-[14.5px] leading-[1.65] text-ink" />;
              case "thinking":
                return <Thinking key={b.id} text={b.text} />;
              case "error":
                return (
                  <div key={b.id} className="flex items-start gap-2 text-[13px] text-critical">
                    <IconAlertTriangle {...IC_XS} className="mt-1 shrink-0" />
                    <span className="break-words">
                      {b.name}: {b.text}
                    </span>
                  </div>
                );
              case "tools":
                return (
                  <div key={b.id} className="divide-y divide-line-2 overflow-hidden rounded-xl border border-line-2">
                    {b.items.map((e) =>
                      e.k === "tool" ? (
                        <ToolRow key={e.id} p={e.part} short={short} onOpenSession={setSession} hasChild={!!childOf(e.part)} />
                      ) : (
                        <div key={e.id} className="flex h-8 items-center gap-2.5 px-3 pl-[38px] font-mono text-[12.5px] text-ink-3">
                          changed {e.files.length} file{e.files.length === 1 ? "" : "s"}
                        </div>
                      ),
                    )}
                  </div>
                );
              default:
                return null;
            }
          })}
        </div>
      </div>
      {!atBottom && (
        <button
          type="button"
          onClick={toBottom}
          className="absolute bottom-4 left-1/2 inline-flex h-8 -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-s3 px-3.5 text-[12.5px] text-ink shadow-pop hover:bg-s2"
        >
          <IconArrowDown {...IC_XS} />
          Jump to latest
        </button>
      )}
    </div>
  );
}

/** Apply a live part update to the message list. */
function applyPart(list: Message[], part: Part): Message[] {
  const idx = list.findIndex((m) => m.info.id === part.messageID);
  if (idx < 0) return list;
  const m = list[idx];
  const pi = m.parts.findIndex((p) => p.id === part.id);
  const parts = pi < 0 ? [...m.parts, part] : m.parts.map((p, i) => (i === pi ? part : p));
  const out = list.slice();
  out[idx] = { ...m, parts };
  return out;
}

function applyDelta(list: Message[], d: { messageID: string; partID: string; field: string; delta: string }): Message[] {
  const idx = list.findIndex((m) => m.info.id === d.messageID);
  if (idx < 0) return list;
  const m = list[idx];
  const pi = m.parts.findIndex((p) => p.id === d.partID);
  if (pi < 0) return list;
  const p = m.parts[pi];
  const out = list.slice();
  out[idx] = { ...m, parts: m.parts.map((x, i) => (i === pi ? { ...p, [d.field]: String(p[d.field] ?? "") + d.delta } : x)) };
  return out;
}
