/** PROGRESS.md: the agent's short status notes for you, live, with what changed since you last looked. */
import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { useAsync, useThrottled } from "../lib/hooks.ts";
import { useLive } from "../lib/live.ts";
import { ago, duration } from "../lib/format.ts";
import { lastSeen, markSeen, progressStale } from "../lib/progress.ts";
import type { Run } from "../lib/types.ts";
import { Markdown } from "./Markdown.tsx";
import { DiffView } from "./DiffView.tsx";

const counts = (lines: string[]) => ({ added: lines.filter((l) => l[0] === "+").length, removed: lines.filter((l) => l[0] === "-").length });
const shortTime = (ts: number) => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * `compact` is the run panel's version: no history picker, scrolls inside a fixed height.
 * Mount with `key={run.id}`: "since you last looked" is measured from when it mounted.
 */
export function ProgressNotes({ run, compact }: { run: Run; compact?: boolean }) {
  const p = useAsync(() => api.progress(run.id), [run.id]);
  const reload = useThrottled(() => void p.reload(), 500);
  useLive(run.id, (m) => m.type === "progress" && reload());

  // The version you had seen before opening this view; later updates are compared against it.
  // First look at this run: updates that land while you watch still count as new.
  const [baseline, setBaseline] = useState(() => lastSeen(run.id));
  const [view, setView] = useState<"text" | "changes">("text");
  /** An older version picked from the history; null = latest. */
  const [at, setAt] = useState<number | null>(null);

  const latest = p.data?.updated_at ?? null;
  const versions = p.data?.versions ?? [];
  useEffect(() => {
    if (!latest) return;
    if (baseline == null) setBaseline(latest);
    markSeen(run.id, latest);
  }, [run.id, latest]);

  const unseen = baseline != null && latest != null && latest > baseline;
  // Latest: changes since you last looked (or since the version before). Older: against the one before it.
  const from = at == null && unseen ? baseline : undefined;
  const needDiff = at != null || view === "changes" || unseen;
  const diff = useAsync(() => (needDiff && latest ? api.progressDiff(run.id, from, at ?? latest) : Promise.resolve(null)), [run.id, needDiff, from, at, latest]);
  const lines = diff.data?.lines ?? null;
  const since = unseen && lines && at == null ? counts(lines) : null;

  const text = at == null ? (p.data?.content ?? null) : lines ? lines.filter((l) => l[0] !== "-").map((l) => l.slice(1)).join("\n") : null;
  const stale = progressStale(run);
  const canDiff = versions.length > 1 || unseen;

  const status = !latest ? null : stale ? (
    <span style={{ color: "var(--warn)" }} title="Live run whose PROGRESS.md hasn't changed for an hour">
      not updated in {duration(Date.now() - latest).replace(/ \d+s$/, "")}
    </span>
  ) : (
    <span title={new Date(latest).toLocaleString()}>updated {ago(latest)}</span>
  );

  const controls = latest && (canDiff || (!compact && versions.length > 1)) && (
    <div className="progress-bar">
      {since && (since.added || since.removed) ? (
        <button className="progress-new" onClick={() => setView(view === "changes" ? "text" : "changes")} title="Lines changed since you last looked">
          +{since.added} −{since.removed} since you last looked
        </button>
      ) : null}
      {canDiff && (
        <div className="seg" role="tablist">
          {(["text", "changes"] as const).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
              {v === "text" ? "Text" : "Changes"}
            </button>
          ))}
        </div>
      )}
      {!compact && versions.length > 1 && (
        <select className="input progress-pick" value={at ?? ""} onChange={(e) => setAt(e.target.value ? Number(e.target.value) : null)} aria-label="Version">
          <option value="">Latest · {shortTime(versions[0].ts)}</option>
          {versions.slice(1).map((v) => (
            <option key={v.ts} value={v.ts}>
              {shortTime(v.ts)} · +{v.added} −{v.removed}
            </option>
          ))}
        </select>
      )}
    </div>
  );

  let body;
  if (p.error && !p.data) body = <span className="muted text-xs">{p.error}</span>;
  else if (!p.data) body = null;
  else if (!latest) body = <span className="muted text-xs">No PROGRESS.md yet.</span>;
  else if (view === "changes") body = lines ? <DiffView patch={lines.join("\n")} /> : null;
  else body = text != null ? <Markdown text={text} /> : null;

  return (
    <>
      {compact ? (
        <h3>
          Progress {status}
        </h3>
      ) : (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="text-sm font-semibold">Progress</h2>
          <span className="text-xs muted">{status}</span>
        </div>
      )}
      {controls}
      <div className={compact ? "progress-notes compact" : "progress-notes"}>{body}</div>
    </>
  );
}
