/** The fleet at the top of the Wall: the stream, the Latest feed, and four small stats. */
import { useMemo } from "react";
import { IconAlertTriangle, IconArrowRight, IconBug, IconFileCheck, IconMessageQuestion, IconPlayerPlay, IconPointFilled } from "@tabler/icons-react";
import { rate, runName, streamSeries } from "../../lib/fleet.ts";
import { money } from "../../lib/format.ts";
import { feedKind, feedText, useFeed } from "../../lib/feed.ts";
import { age } from "../../lib/health.ts";
import { openRun } from "../../lib/actions.ts";
import { isOpen } from "../../lib/findings.ts";
import { cn } from "../../lib/cn.ts";
import type { Finding, FleetSnapshot, Run } from "../../lib/types.ts";
import { Stream, STREAM_N, STREAM_STEP, type StreamMark } from "../../components/charts/Stream.tsx";
import { CallBars, MemoryBar, SpendBars } from "../../components/charts/Mini.tsx";
import { IC_SM } from "../../components/ui/bits.tsx";

const panel = "rounded-2xl border border-line-2 bg-s1";
const ICON: Record<string, typeof IconBug> = { find: IconBug, ask: IconMessageQuestion, bad: IconAlertTriangle, warn: IconAlertTriangle, done: IconFileCheck, you: IconPointFilled, "": IconPlayerPlay };
const SEV_TEXT: Record<string, string> = { critical: "text-sev-high", high: "text-sev-high", medium: "text-sev-medium", low: "text-sev-low", info: "text-sev-low" };

function Mini({ label, small, value, children, onClick }: { label: string; small?: React.ReactNode; value: string; children?: React.ReactNode; onClick?: () => void }) {
  const Tag = onClick ? "button" : "section";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      aria-label={label}
      className={cn(panel, "flex min-h-0 min-w-0 flex-col gap-0.5 px-3.5 py-3 text-left text-ink", onClick && "cursor-pointer hover:border-line")}
    >
      <div className="flex items-baseline gap-1.5">
        <span className="mr-auto text-[12.5px] whitespace-nowrap text-ink-3">{label}</span>
        {small && <small className="font-mono text-[11.5px] whitespace-nowrap text-ink-3">{small}</small>}
      </div>
      <b className="text-xl leading-tight font-medium tracking-[-0.025em] tabular-nums">{value}</b>
      {children}
    </Tag>
  );
}

export function FleetRow({ snap, runs, findings, onTriage, onCatchUp }: { snap: FleetSnapshot | null; runs: Run[]; findings: Finding[]; onTriage: () => void; onCatchUp: () => void }) {
  const feed = useFeed(30);
  const named = useMemo(() => new Map(runs.map((r) => [r.id, { id: r.id, name: runName(r), hue: r.hue }])), [runs]);
  const fleetRuns = snap?.runs ?? [];
  const streamRuns = fleetRuns
    .filter((f) => named.has(f.id))
    .map((f) => ({ id: f.id, name: named.get(f.id)!.name, hue: f.hue, series: streamSeries(f) }))
    .sort((a, b) => (runs.find((r) => r.id === a.id)?.created_at ?? 0) - (runs.find((r) => r.id === b.id)?.created_at ?? 0));
  const marks: StreamMark[] = (feed ?? [])
    .filter((e) => Date.now() - e.ts < STREAM_N * STREAM_STEP)
    .flatMap((e): StreamMark[] => {
      if (e.kind === "finding" && e.data?.action === "add") return [{ run: e.run_id, at: e.ts, kind: "find", sev: e.data?.severity, text: e.data?.title ?? e.message }];
      if (e.kind === "question" && e.actor === "agent") return [{ run: e.run_id, at: e.ts, kind: "ask", text: feedText(e) }];
      if (e.kind === "recover" && /not answering/.test(e.message)) return [{ run: e.run_id, at: e.ts, kind: "crash", text: e.message }];
      return [];
    });
  const tpsNow = fleetRuns.reduce((a, r) => a + (r.tps.length ? rate(r.tps) : (r.tps30.at(-1) ?? 0)), 0);
  const calls = fleetRuns.reduce((a, r) => a + (r.activity.at(-1)?.n ?? 0) + (r.activity.at(-2)?.n ?? 0), 0);
  const open = findings.filter(isOpen);
  const bySev = ["critical", "high", "medium", "low", "info"].map((s) => [s, open.filter((f) => (f.severity ?? "low") === s).length] as const).filter(([, n]) => n);
  const runsMem = fleetRuns.reduce((a, r) => a + (r.mem.used ?? 0), 0);

  return (
    <div className="grid grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,340px)] grid-rows-[220px] gap-3 max-xl:grid-cols-2 max-xl:grid-rows-[220px_auto] max-lg:grid-cols-1 max-lg:grid-rows-[220px_240px_auto]">
      <section className={cn(panel, "relative overflow-hidden")} aria-label="Output tokens per second by run, last 30 minutes">
        <div className="pointer-events-none absolute top-3.5 left-5 z-[1] flex items-baseline gap-[7px]">
          <span className="text-[30px] leading-none font-medium tracking-[-0.04em] tabular-nums">{Math.round(tpsNow)}</span>
          <span className="text-[12.5px] text-ink-3">tok/s</span>
        </div>
        <Stream runs={streamRuns} marks={marks} onOpen={(id) => openRun(id)} />
      </section>

      <section className={cn(panel, "flex min-h-0 min-w-0 flex-col px-2 pt-3.5 pb-2")} aria-label="Latest across all runs">
        <div className="flex items-baseline justify-between px-2.5 pb-1.5">
          <span className="text-[12.5px] text-ink-3">Latest</span>
          <button type="button" onClick={onCatchUp} className="cursor-pointer border-0 bg-transparent p-0 text-[12.5px] text-ink-3 hover:text-ink hover:underline">
            Since you looked
          </button>
        </div>
        <ul className="m-0 flex list-none flex-col overflow-hidden p-0">
          {(feed ?? []).slice(0, 7).map((e) => {
            const { k, finding } = feedKind(e);
            const Icon = ICON[k] ?? IconPointFilled;
            const run = named.get(e.run_id);
            return (
              <li
                key={e.id}
                tabIndex={0}
                onClick={() => openRun(e.run_id, finding ? `findings/${finding}` : undefined)}
                onKeyDown={(ev) => ev.key === "Enter" && openRun(e.run_id, finding ? `findings/${finding}` : undefined)}
                className="grid h-[26px] cursor-pointer grid-cols-[16px_minmax(0,1fr)_8px_30px] items-center gap-2.5 rounded-lg px-2.5 text-[13px] outline-none hover:bg-s2 focus-visible:bg-s2"
              >
                <span className={cn("flex text-ink-3", k === "find" && (SEV_TEXT[e.data?.severity] ?? "text-sev-low"), (k === "ask" || k === "bad" || k === "warn") && "text-warning")}>
                  <Icon {...IC_SM} />
                </span>
                <span className={cn("truncate", k === "find" || k === "ask" ? "text-ink" : "text-ink-2")}>{feedText(e)}</span>
                <i title={run?.name} className="block size-2 rounded-[2px]" style={{ background: `var(--r${run?.hue ?? 0})` }} />
                <span className="text-right font-mono text-[11.5px] text-ink-3 tabular-nums">{age(e.ts)}</span>
              </li>
            );
          })}
          {feed && !feed.length && <li className="px-2.5 py-1 text-[13px] text-ink-3">Nothing yet</li>}
        </ul>
      </section>

      <div className="grid min-h-0 grid-cols-2 grid-rows-2 gap-3 max-xl:col-span-full max-xl:grid-cols-4 max-xl:grid-rows-[112px] max-md:grid-cols-2 max-md:grid-rows-[108px_108px]">
        <Mini label="Spend today" small={snap ? <span className="inline-flex items-center gap-1"><IconArrowRight size={11} />{money(snap.spend.projected)}</span> : undefined} value={money(snap?.spend.total ?? 0)}>
          <div className="relative mt-1.5 min-h-0 flex-1">{snap && <SpendBars spend={snap.spend} runs={[...named.values()]} />}</div>
        </Mini>
        <Mini label="Tool calls" small="/ min" value={String(Math.round(calls))}>
          <div className="relative mt-1.5 min-h-0 flex-1">
            <CallBars runs={fleetRuns} names={named} />
          </div>
        </Mini>
        <Mini label="Memory" small={snap ? `of ${(snap.memory.total / 1024 ** 3).toFixed(0)} GB` : undefined} value={((snap?.memory.used ?? runsMem) / 1024 ** 3).toFixed(1)}>
          <div className="relative mt-1.5 min-h-0 flex-1">{snap && <MemoryBar snap={snap} names={named} />}</div>
        </Mini>
        <Mini label="To triage" small={`${new Set(open.map((f) => f.run_id)).size} runs`} value={String(open.length)} onClick={onTriage}>
          <div className="mt-auto flex h-[18px] gap-[3px]">
            {bySev.map(([s, n]) => (
              <span
                key={s}
                title={`${n} ${s}`}
                style={{ flex: n }}
                className={cn(
                  "flex min-w-[18px] items-center rounded pl-1.5 font-mono text-[11px] font-medium text-ink",
                  s === "critical" || s === "high" ? "bg-sev-high/30" : s === "medium" ? "bg-sev-medium/25" : "bg-sev-low/20",
                )}
              >
                {n}
              </span>
            ))}
          </div>
        </Mini>
      </div>
    </div>
  );
}
