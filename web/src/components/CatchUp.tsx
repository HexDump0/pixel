/** "Since you last looked": per run, the notable events since you last cleared it, with the one thing to do about each. */
import { IconRefresh } from "@tabler/icons-react";
import { useRuns } from "../lib/runs.ts";
import { useFeed, feedKind, feedText } from "../lib/feed.ts";
import { useLastLooked } from "../lib/seen.ts";
import { act, openRun } from "../lib/actions.ts";
import { runName } from "../lib/fleet.ts";
import { age, elapsed } from "../lib/health.ts";
import type { FeedEntry, Run } from "../lib/types.ts";
import { Button } from "./ui.tsx";
import { Hue, IC_XS } from "./ui/bits.tsx";
import { Dialog } from "./ui/overlay.tsx";
import { cn } from "../lib/cn.ts";

const listeners = new Set<() => void>();
/** Open the catch-up dialog from anywhere (the top bar mounts it). */
export const openCatchUp = () => listeners.forEach((l) => l());
export const onOpenCatchUp = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

export interface CatchUpData {
  since: number;
  count: number;
  runs: { run: Run; events: FeedEntry[] }[];
  markSeen: () => void;
}

export function useCatchUp(): CatchUpData {
  const [since, markSeen] = useLastLooked();
  const { runs } = useRuns();
  const feed = useFeed(500, since) ?? [];
  const byRun = new Map<string, FeedEntry[]>();
  for (const e of feed) byRun.set(e.run_id, [...(byRun.get(e.run_id) ?? []), e]);
  const list = [...byRun].flatMap(([id, events]) => {
    const run = runs?.find((r) => r.id === id);
    return run ? [{ run, events }] : [];
  });
  return { since, count: feed.length, runs: list, markSeen };
}

const DOT: Record<string, string> = { find: "bg-sev-high", warn: "bg-warning", ask: "bg-warning", bad: "bg-critical", done: "bg-ink" };

export function CatchUp({ open, onOpenChange, data }: { open: boolean; onOpenChange: (o: boolean) => void; data: CatchUpData }) {
  const close = () => onOpenChange(false);
  const all = data.runs.flatMap((x) => x.events);
  const sum = {
    found: all.filter((e) => e.kind === "finding" && e.data?.action === "add").length,
    confirmed: all.filter((e) => e.kind === "finding" && e.data?.changes?.state?.[1] === "confirmed").length,
    finished: all.filter((e) => e.kind === "done").length,
    failed: all.filter((e) => e.kind === "failed" || e.kind === "stopped").length,
    asks: all.filter((e) => e.kind === "question" && e.actor === "agent").length,
  };
  const action = (r: Run, events: FeedEntry[]) => {
    if (r.question) return <Button size="xs" variant="warn" onClick={() => (close(), openRun(r.id))}>Answer</Button>;
    if (r.status === "failed") return <Button size="xs" onClick={() => void act.retry(r.id)}><IconRefresh {...IC_XS} />Retry</Button>;
    if ((r.findings?.untriaged ?? 0) > 0 && (r.status === "done" || events.some((e) => e.kind === "finding"))) return <Button size="xs" variant="primary" onClick={() => (close(), openRun(r.id, "findings"))}>Triage</Button>;
    return <Button size="xs" variant="ghost" onClick={() => (close(), openRun(r.id))}>Open</Button>;
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Since you last looked" hideTitle>
      <div className="flex flex-wrap items-center gap-3.5 pb-3.5">
        <h2 className="m-0 text-[17px] font-medium">{data.count ? "Since you last looked" : "All caught up"}</h2>
        <span className="font-mono text-xs text-ink-3">{elapsed(Date.now() - data.since)} ago</span>
        {data.count > 0 && (
          <div className="ml-auto">
            <Button size="xs" onClick={() => (data.markSeen(), close())}>
              Mark all seen
            </Button>
          </div>
        )}
      </div>
      {data.count > 0 && (
        <>
          <div className="flex flex-wrap gap-3.5 pb-3 text-[13px] text-ink-2 [&_b]:font-mono [&_b]:font-medium [&_b]:text-ink">
            {sum.found > 0 && <span><b>{sum.found}</b> new findings</span>}
            {sum.confirmed > 0 && <span><b>{sum.confirmed}</b> confirmed</span>}
            {sum.finished > 0 && <span><b>{sum.finished}</b> finished</span>}
            {sum.failed > 0 && <span><b>{sum.failed}</b> failed or stopped</span>}
            {sum.asks > 0 && <span><b>{sum.asks}</b> {sum.asks === 1 ? "question" : "questions"}</span>}
          </div>
          <ul className="m-0 list-none border-t border-line-2 p-0">
            {data.runs.map(({ run, events }) => (
              <li key={run.id} className="grid grid-cols-[10px_minmax(0,11em)_minmax(0,1fr)_auto] items-start gap-3 border-t border-line-2 py-3 first:border-t-0 max-md:grid-cols-[10px_minmax(0,1fr)]">
                <Hue hue={run.hue} className="mt-1.5" />
                <button type="button" className="truncate border-0 bg-transparent p-0 text-left font-medium text-ink hover:underline" onClick={() => (close(), openRun(run.id))}>
                  {runName(run)}
                </button>
                <div className="flex min-w-0 flex-col gap-[3px] text-[13px] text-ink-2 max-md:col-start-2">
                  {events.slice(0, 4).map((e) => {
                    const k = feedKind(e).k;
                    return (
                      <span key={e.id} className="flex min-w-0 items-center gap-2">
                        <i className={cn("size-[5px] shrink-0 rounded-full bg-ink-4", DOT[k])} />
                        <span className="truncate">{feedText(e)}</span>
                        <em className="shrink-0 font-mono text-[11.5px] text-ink-3 not-italic">{age(e.ts)}</em>
                      </span>
                    );
                  })}
                  {events.length > 4 && <span className="text-ink-3">{events.length - 4} more</span>}
                </div>
                <div className="max-md:col-start-2">{action(run, events)}</div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}
