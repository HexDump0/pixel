/** Live transcript: messages, reasoning and tool calls, for the root session or any subagent session. */
import { memo, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { useAsync } from "../../lib/hooks.ts";
import { useLive } from "../../lib/live.ts";
import { duration, time } from "../../lib/format.ts";
import type { Message, Part, RunDetail } from "../../lib/types.ts";
import { Markdown } from "../../components/Markdown.tsx";
import { Empty, ErrorBox } from "../../components/ui.tsx";

function toolSummary(p: Part) {
  const i = p.state?.input ?? {};
  return p.state?.title || i.command || i.filePath || i.pattern || i.url || i.description || i.query || "";
}

const ToolCall = memo(function ToolCall({ part }: { part: Part }) {
  const st = part.state;
  const failed = st?.status === "error";
  const took = st?.time?.end && st.time.start ? duration(st.time.end - st.time.start) : st?.status === "running" ? "running…" : "";
  return (
    <details className="rounded-md border border-zinc-200 bg-zinc-50 text-xs dark:border-zinc-800 dark:bg-zinc-900/60">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5">
        <span className={`font-mono ${failed ? "text-red-500" : "text-violet-600 dark:text-violet-400"}`}>{part.tool}</span>
        <span className="min-w-0 flex-1 truncate font-mono muted">{toolSummary(part)}</span>
        <span className="muted">{took}</span>
      </summary>
      <div className="max-h-[28rem] overflow-auto border-t border-zinc-200 px-2.5 py-2 dark:border-zinc-800">
        <div className="mb-1 muted">input</div>
        <pre className="font-mono whitespace-pre-wrap">{JSON.stringify(st?.input, null, 2)}</pre>
        {(st?.output || st?.error) && (
          <>
            <div className="mt-2 mb-1 muted">{failed ? "error" : "output"}</div>
            <pre className="font-mono whitespace-pre-wrap">{st?.error ?? st?.output}</pre>
          </>
        )}
      </div>
    </details>
  );
});

function PartView({ part, sessions, onOpenSession }: { part: Part; sessions: RunDetail["sessions"]; onOpenSession: (id: string) => void }) {
  switch (part.type) {
    case "text":
      return part.text ? <Markdown text={part.text} /> : null;
    case "reasoning":
      return part.text ? <div className="border-l-2 border-zinc-300 pl-2 text-sm italic muted dark:border-zinc-700">{part.text}</div> : null;
    case "tool": {
      const child = part.tool === "task" ? (part.state?.metadata?.sessionId as string | undefined) : undefined;
      return (
        <div>
          <ToolCall part={part} />
          {child && sessions.some((s) => s.id === child) && (
            <button className="mt-1 cursor-pointer text-xs text-accent hover:underline" onClick={() => onOpenSession(child)}>
              Open subagent transcript →
            </button>
          )}
        </div>
      );
    }
    case "patch":
      return <div className="text-xs muted">changed {(part.files as string[] | undefined)?.length ?? 0} file(s)</div>;
    default:
      return null;
  }
}

/** What the provider said: HTTP status, message, and its response body when that adds anything. */
function errorDetail(err: { name: string; data?: any }) {
  const d = err.data ?? {};
  const msg = String(d.message ?? "");
  const body = d.responseBody && !msg.includes(String(d.responseBody)) ? String(d.responseBody) : "";
  return [d.statusCode && `HTTP ${d.statusCode}`, msg, body.slice(0, 1000)].filter(Boolean).join(" · ") || "no details from the provider";
}

function MessageView({ m, sessions, onOpenSession }: { m: Message; sessions: RunDetail["sessions"]; onOpenSession: (id: string) => void }) {
  const user = m.info.role === "user";
  return (
    <div className={`border-l-[3px] py-1 pl-3 ${user ? "border-accent" : "border-emerald-500"}`}>
      <div className="mb-1 text-xs muted">
        {user ? "prompt" : (m.info.agent ?? "assistant")} · {time(m.info.time.created)}
        {m.info.modelID && ` · ${m.info.modelID}`}
        {m.info.error && <span className="text-red-500"> · {m.info.error.name}</span>}
      </div>
      {m.info.error && m.info.error.name !== "MessageAbortedError" && <div className="mb-1 whitespace-pre-wrap break-words text-xs text-red-500">{errorDetail(m.info.error)}</div>}
      <div className="flex flex-col gap-1.5 text-sm">
        {m.parts.map((p) => (
          <PartView key={p.id} part={p} sessions={sessions} onOpenSession={onOpenSession} />
        ))}
      </div>
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

export function TranscriptTab({ detail }: { detail: RunDetail }) {
  const runId = detail.run.id;
  const [session, setSession] = useState<string | null>(detail.run.session_id);
  const msgs = useAsync(() => (session ? api.transcript(runId, session) : Promise.resolve([])), [runId, session]);
  const [follow, setFollow] = useState(true);
  const bottom = useRef<HTMLDivElement>(null);

  useLive(runId, (m) => {
    const sid = m.data?.sessionID ?? m.data?.info?.sessionID;
    if (m.type === "synced") return void msgs.reload();
    if (sid !== session) return;
    if (m.type === "message") {
      msgs.setData((xs = []) => (xs.some((x) => x.info.id === m.data.id) ? xs.map((x) => (x.info.id === m.data.id ? { ...x, info: m.data } : x)) : [...xs, { info: m.data, parts: [] }]));
    } else if (m.type === "part") msgs.setData((xs = []) => applyPart(xs, m.data));
    else if (m.type === "delta") msgs.setData((xs = []) => applyDelta(xs, m.data));
  });

  useEffect(() => {
    if (follow) bottom.current?.scrollIntoView({ block: "end" });
  }, [msgs.data, follow]);

  const children = detail.sessions.filter((s) => s.id !== detail.run.session_id);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <select className="input" value={session ?? ""} onChange={(e) => setSession(e.target.value)}>
          <option value={detail.run.session_id ?? ""}>Main session</option>
          {children.map((s) => (
            <option key={s.id} value={s.id}>
              ↳ {s.title ?? s.id} ({s.agent ?? "subagent"})
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
        </label>
        <span className="muted">{msgs.data?.length ?? 0} messages</span>
        <button className="btn btn-sm ml-auto" onClick={() => api.control(runId, "sync").then(() => msgs.reload())}>
          Resync from opencode
        </button>
      </div>
      <ErrorBox error={msgs.error} />
      {msgs.data && !msgs.data.length && <Empty>No messages yet.</Empty>}
      <div className="flex flex-col gap-3">
        {msgs.data?.map((m) => (
          <MessageView key={m.info.id} m={m} sessions={detail.sessions} onOpenSession={setSession} />
        ))}
      </div>
      <div ref={bottom} />
    </div>
  );
}
