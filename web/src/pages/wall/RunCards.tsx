/**
 * How a run shows up on the Wall: a tile (live and problem runs), a compact tile (the run view's rail),
 * a row (finished runs) and a table row (list view). Each says a thing once: running shows only its age,
 * words only for problems.
 */
import type { ReactNode } from "react";
import { IconMessage, IconPlayerPause, IconPlayerPlay, IconRefresh } from "@tabler/icons-react";
import { api } from "../../lib/api.ts";
import { act, canPause, openRun } from "../../lib/actions.ts";
import { cn } from "../../lib/cn.ts";
import { rate, runName } from "../../lib/fleet.ts";
import { money } from "../../lib/format.ts";
import { byPriority, isOpen, sevOf, STATE_WORD } from "../../lib/findings.ts";
import { age, elapsed, runtimeOf, type Health } from "../../lib/health.ts";
import { reloadRuns, repoShort } from "../../lib/runs.ts";
import type { Finding, FleetRun, Run } from "../../lib/types.ts";
import { openPalette } from "../../components/CommandPalette.tsx";
import { RunMenuButton } from "../../components/RunMenu.tsx";
import { toast } from "../../components/Toast.tsx";
import { Button } from "../../components/ui.tsx";
import { Hue, IC_SM, Kbd, Sev, StatusChip, Unseen, Wave } from "../../components/ui/bits.tsx";

/** Everything the cards need about one run. */
export interface RunView {
  run: Run;
  fleet?: FleetRun;
  h: Health;
  /** suspected/confirmed findings, most important first */
  findings: Finding[];
  /** the newest lead (shown when there are no findings yet) */
  lead?: Finding;
  /** findings changed since you last looked */
  unseen: boolean;
}

export const TONE_BG: Record<string, string> = {
  warn: "bg-s1 bg-[image:linear-gradient(var(--warn-tint),var(--warn-tint))]",
  bad: "bg-s1 bg-[image:linear-gradient(var(--bad-tint),var(--bad-tint))]",
  "": "bg-s1",
};
export function buildView(run: Run, fleet: FleetRun | undefined, h: Health, all: Finding[], seen: number): RunView {
  const mine = all.filter((f) => f.run_id === run.id && !f.removed_at);
  const findings = mine.filter((f) => (f.state === "confirmed" || f.state === "suspected") && f.verdict !== "not_bug" && f.verdict !== "duplicate").sort(byPriority);
  const lead = mine.filter((f) => f.state === "lead").sort((a, b) => b.updated - a.updated)[0];
  return { run, fleet, h, findings, lead, unseen: mine.some((f) => f.updated > seen) };
}

const STOP = new Set(["the", "a", "an", "with", "and", "for", "of", "to", "against", "in", "on"]);
const shortTitle = (t: string) => t.split(" ").filter((w) => !STOP.has(w.toLowerCase())).slice(0, 2).join(" ");
const TICK_H: Record<string, number> = { shell: 12, edit: 8, task: 8, web: 8, read: 4 };

/** One lane per working agent: the last 15 minutes of tool calls as ticks in the run's colour (height = kind). */
function AgentLanes({ v, max = 3 }: { v: RunView; max?: number }) {
  const f = v.fleet;
  if (!f) return null;
  const now = Date.now();
  const win = 15 * 60_000;
  const W = 300;
  const agents = [
    { id: v.run.session_id ?? "", title: "main", state: f.agents.main, kid: false, now: f.now },
    ...f.agents.subs.filter((s) => s.status === "running").map((s) => ({ id: s.id, title: shortTitle(s.title), full: s.title, state: s.status, kid: true, now: s.now })),
  ].slice(0, max);
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 px-[18px] pt-4 pb-1">
      {agents.map((a) => {
        const ticks = f.ticks.filter((t) => t[0] === a.id && now - t[1] < win);
        const last = ticks.reduce((m, t) => Math.max(m, t[1]), 0);
        const what = a.state === "waiting" ? "waiting on subagents" : a.state === "idle" ? "idle" : a.now ? `${a.now.tool} ${a.now.text}` : "thinking";
        return (
          <li key={a.id || a.title} title={`${"full" in a ? a.full : "Main agent"}: ${what}`} className="grid h-[18px] grid-cols-[minmax(0,7.5em)_minmax(0,1fr)] items-center gap-3.5 text-[12.5px]">
            <span className={cn("truncate", a.kid ? "text-ink-3" : "text-ink-2")}>{a.title}</span>
            <svg viewBox={`0 0 ${W} 16`} preserveAspectRatio="none" aria-hidden className="block h-4 w-full overflow-visible">
              <line x1="0" x2={W} y1="8" y2="8" className="stroke-line" strokeWidth={1} vectorEffect="non-scaling-stroke" strokeDasharray={a.state === "waiting" ? "2 4" : undefined} />
              {ticks.map((t, i) => {
                const x = (W - ((now - t[1]) / win) * W).toFixed(1);
                const th = TICK_H[t[2]] ?? 6;
                const fresh = t[1] === last && now - t[1] < 20_000;
                return <line key={i} x1={x} x2={x} y1={8 - th / 2} y2={8 + th / 2} strokeWidth={1.5} strokeLinecap="round" vectorEffect="non-scaling-stroke" style={{ stroke: `var(--r${v.run.hue ?? 0})`, strokeOpacity: fresh ? 1 : 0.55 }} />;
              })}
            </svg>
          </li>
        );
      })}
    </ul>
  );
}

/** The question on a tile, with its options as numbered answer buttons. */
function TileQuestion({ run }: { run: Run }) {
  const q = run.question!;
  const first = q.questions[0];
  const answer = (label: string) =>
    api.answer(run.id, q.id, [[label]]).then(
      () => (toast("Answered"), reloadRuns()),
      (e) => toast(e.message, "error"),
    );
  return (
    <div className="flex flex-col gap-3 px-[18px] pt-3.5 pb-1">
      <p className="m-0 line-clamp-3 text-[13.5px] leading-normal text-ink">{q.questions.map((x) => x.question).join(" / ")}</p>
      {q.questions.length === 1 && first.options.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {first.options.slice(0, 4).map((o, i) => (
            <button
              key={o.label}
              type="button"
              title={o.description}
              onClick={(e) => (e.stopPropagation(), void answer(o.label))}
              className="inline-flex min-h-[30px] items-center gap-2 rounded-lg border border-line bg-s2 py-1 pr-2.5 pl-1.5 text-left text-[12.5px] font-medium text-ink hover:border-warning"
            >
              <Kbd>{i + 1}</Kbd>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TileBody({ v }: { v: RunView }) {
  const r = v.run;
  if (v.h.s === "asking") return <TileQuestion run={r} />;
  if (r.status === "recovering")
    return (
      <>
        <div className="flex flex-col gap-3 px-[18px] pt-3.5 pb-1">
          {r.status_detail && <p className="m-0 text-[13.5px] text-ink">{r.status_detail}</p>}
          <div className="flex items-center gap-1" title={v.h.label}>
            {[1, 2, 3].map((i) => (
              <i key={i} className={cn("h-[3px] w-[22px] rounded-sm bg-s3", i <= Math.max(1, r.oom_restarts) && "bg-warning")} />
            ))}
          </div>
        </div>
        <AgentLanes v={v} />
      </>
    );
  if (r.status === "failed")
    return (
      <div className="flex flex-col gap-3 px-[18px] pt-3.5 pb-1">
        {r.status_detail && <p className="m-0 font-mono text-[12.5px] leading-normal break-words text-ink-2">{r.status_detail}</p>}
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" onClick={(e) => (e.stopPropagation(), act.retry(r.id))}>
            <IconRefresh {...IC_SM} />
            Retry
          </Button>
          <Button size="sm" variant="ghost" onClick={(e) => (e.stopPropagation(), act.editRetry(r))}>
            Edit
          </Button>
        </div>
      </div>
    );
  if (r.status === "paused" || r.status === "stopped")
    return (
      <div className="px-[18px] pt-3.5 pb-1">
        <Button size="sm" onClick={(e) => (e.stopPropagation(), act.resume(r.id))}>
          <IconPlayerPlay {...IC_SM} />
          Resume
        </Button>
      </div>
    );
  return <AgentLanes v={v} />;
}

function FindingLine({ v }: { v: RunView }) {
  const f = v.findings[0];
  if (f)
    return (
      <div className="flex min-w-0 items-baseline gap-2.5 px-[18px] pt-2.5 text-[13.5px] leading-[1.45]" title={`${f.id} · ${f.severity ?? ""} · ${STATE_WORD[f.state]}`}>
        <Sev sev={sevOf(f)} done={!!f.verdict} className="translate-y-[-1px]" />
        <span className="line-clamp-2 min-w-0 flex-1">{f.title}</span>
        {v.findings.length > 1 && <span className="shrink-0 font-mono text-xs text-ink-3">+{v.findings.length - 1}</span>}
      </div>
    );
  if (v.lead) return <div className="line-clamp-2 px-[18px] pt-2.5 text-[13.5px] leading-[1.45] text-ink-2">{v.lead.title}</div>;
  return null;
}

/** Hover actions: Message, Pause/Resume, ⋯ (they replace the status chip while hovered). */
export function RunActions({ run }: { run: Run }) {
  return (
    <>
      <Button size="xs" icon variant="ghost" aria-label="Message" title="Message (m)" disabled={!run.session_id} onClick={(e) => (e.stopPropagation(), openPalette(run.id))}>
        <IconMessage {...IC_SM} />
      </Button>
      {run.status === "paused" ? (
        <Button size="xs" icon variant="ghost" aria-label="Resume" title="Resume" onClick={(e) => (e.stopPropagation(), act.resume(run.id))}>
          <IconPlayerPlay {...IC_SM} />
        </Button>
      ) : canPause(run) ? (
        <Button size="xs" icon variant="ghost" aria-label="Pause" title="Pause" onClick={(e) => (e.stopPropagation(), act.pause(run.id))}>
          <IconPlayerPause {...IC_SM} />
        </Button>
      ) : null}
      <RunMenuButton run={run} />
    </>
  );
}

export function Tile({ v, selected, onSelect }: { v: RunView; selected: boolean; onSelect?: () => void }) {
  const r = v.run;
  const f = v.fleet;
  const live = r.status === "running" || r.status === "recovering";
  const tps = f ? rate(f.tps) : 0;
  const done = f?.todos.filter((s) => s === "completed").length ?? 0;
  return (
    <article
      data-run={r.id}
      tabIndex={0}
      aria-selected={selected}
      aria-label={`${runName(r)}, ${v.h.label}`}
      title={repoShort(r.repo)}
      onClick={() => openRun(r.id)}
      onFocus={onSelect}
      className={cn(
        "group relative flex min-h-[232px] min-w-0 cursor-pointer flex-col overflow-hidden rounded-2xl border border-line-2 outline-none transition-colors hover:border-line focus-visible:border-ink-3 aria-selected:border-ink-4 max-md:min-h-0",
        TONE_BG[v.h.tone],
      )}
    >
      <div className="grid min-h-[46px] grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-x-2.5 px-[18px] pt-4">
        <Hue hue={r.hue} />
        <div className="flex min-w-0 items-center gap-2 text-[15px] font-medium tracking-[-0.012em]">
          <span className="truncate">{runName(r)}</span>
          {v.unseen && <Unseen title="Findings changed since you looked" />}
        </div>
        <div className="flex h-[26px] items-center gap-1">
          <StatusChip h={v.h} className="group-hover:hidden group-focus-within:hidden group-aria-selected:hidden" />
          <div className="hidden gap-0.5 group-hover:flex group-focus-within:flex group-aria-selected:flex">
            <RunActions run={r} />
          </div>
        </div>
      </div>
      <TileBody v={v} />
      {v.h.s !== "asking" && <FindingLine v={v} />}
      <div className="mt-auto flex min-w-0 items-center gap-3.5 px-[18px] pt-3 font-mono text-xs text-ink-3 tabular-nums">
        {f && f.todos.length > 0 && (
          <span className="inline-flex items-center gap-[3px]" title={`Todos: ${done} of ${f.todos.length} done`}>
            {f.todos.map((s, i) => (
              <i key={i} className={cn("h-[3px] w-3 rounded-sm bg-s3", s === "completed" && "bg-ink-3", s === "in_progress" && "bg-ink")} />
            ))}
          </span>
        )}
        <span className="flex-1" />
        {live && tps >= 1 && (
          <span className="inline-flex items-baseline gap-1 whitespace-nowrap" title="Output tokens per second">
            <b className="text-[12.5px] font-medium text-ink">{Math.round(tps)}</b> tok/s
          </span>
        )}
        {r.cost > 0 && (
          <span className="whitespace-nowrap" title="Cost so far">
            <b className="text-[12.5px] font-medium text-ink">{money(r.cost)}</b>
          </span>
        )}
      </div>
      <div className="mt-1 h-10 shrink-0">
        <Wave values={live && f ? f.tps.slice(-90) : []} hue={r.hue} />
      </div>
    </article>
  );
}

/** Compact tile for the run view's rail: name, state (or open findings), one line under it. */
export function MiniTile({ v, current }: { v: RunView; current: boolean }) {
  const r = v.run;
  const open = v.findings.filter(isOpen);
  const busy = v.fleet && [v.fleet.now ? { now: v.fleet.now } : null, ...v.fleet.agents.subs.filter((s) => s.status === "running")].filter(Boolean).sort((a, b) => (b!.now?.ts ?? 0) - (a!.now?.ts ?? 0))[0];
  let line: ReactNode = null;
  if (v.h.s === "asking") line = <span className="truncate font-sans text-ink-2">{r.question?.questions[0]?.question}</span>;
  else if ((r.status === "recovering" || r.status === "failed") && r.status_detail) line = <span className="truncate font-sans text-ink-2">{r.status_detail}</span>;
  else if (r.status === "running" && busy?.now)
    line = (
      <>
        <span className="shrink-0">{busy.now.tool}</span>
        <span className="truncate">{busy.now.text}</span>
      </>
    );
  return (
    <article
      data-run={r.id}
      tabIndex={0}
      aria-current={current ? "page" : undefined}
      onClick={() => openRun(r.id)}
      onKeyDown={(e) => e.key === "Enter" && openRun(r.id)}
      className={cn(
        "cursor-pointer rounded-xl border border-line-2 px-3.5 py-[11px] outline-none hover:border-line focus-visible:border-ink-3 aria-[current=page]:border-ink-4",
        TONE_BG[v.h.tone],
      )}
    >
      <div className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5">
        <Hue hue={r.hue} />
        <div className="flex min-w-0 items-center gap-2 text-[13.5px] font-medium">
          <span className="truncate">{runName(r)}</span>
          {v.unseen && <Unseen />}
        </div>
        <div className="flex h-5 items-center gap-1.5">
          {v.h.s === "running" ? (
            open.length ? (
              <>
                <Sev sev={sevOf(open[0])} />
                <span className="font-mono text-xs text-ink-3">{open.length}</span>
              </>
            ) : null
          ) : (
            <StatusChip h={v.h} />
          )}
        </div>
        {line && <div className="col-start-2 col-end-4 flex min-w-0 items-center gap-1.5 font-mono text-xs text-ink-3">{line}</div>}
      </div>
    </article>
  );
}

/** A finished run: finding dots (hollow when triaged), verdict, age, runtime, cost, and Triage or Open. */
export function FinishedRow({ v, selected, onSelect }: { v: RunView; selected: boolean; onSelect?: () => void }) {
  const r = v.run;
  const open = v.findings.filter(isOpen).length;
  return (
    <div
      data-run={r.id}
      tabIndex={0}
      aria-selected={selected}
      onClick={() => openRun(r.id)}
      onFocus={onSelect}
      className="grid h-12 cursor-pointer grid-cols-[10px_minmax(120px,260px)_56px_minmax(0,1fr)_110px_72px_72px_96px] items-center gap-4 rounded-xl px-[18px] outline-none hover:bg-s1 focus-visible:bg-s1 aria-selected:bg-s1 max-lg:grid-cols-[10px_minmax(0,1fr)_auto_auto]"
    >
      <Hue hue={r.hue} />
      <span className="truncate font-medium">{runName(r)}</span>
      <span className="inline-flex items-center gap-1" title={`${v.findings.length} finding${v.findings.length === 1 ? "" : "s"}`}>
        {v.findings.map((f) => (
          <Sev key={f.id} sev={sevOf(f)} done={!!f.verdict} />
        ))}
      </span>
      <span className="min-w-0 truncate text-[12.5px] text-ink-3 max-lg:hidden">{r.findings?.outcome ?? (r.status === "triaged" ? r.triage_verdict : "")}</span>
      <span className="text-right font-mono text-xs whitespace-nowrap text-ink-3 tabular-nums max-lg:hidden">{r.finished_at ? `${age(r.finished_at)} ago` : ""}</span>
      <span className="text-right font-mono text-xs text-ink-3 tabular-nums max-lg:hidden">{elapsed(runtimeOf(r))}</span>
      <span className="text-right font-mono text-xs text-ink-3 tabular-nums max-lg:hidden">{money(r.cost)}</span>
      <span className="justify-self-end">
        {open > 0 ? (
          <Button size="sm" variant="primary" onClick={(e) => (e.stopPropagation(), openRun(r.id, "findings"))}>
            Triage {open}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={(e) => (e.stopPropagation(), openRun(r.id))}>
            Open
          </Button>
        )}
      </span>
    </div>
  );
}

export const LIST_COLS = "grid grid-cols-[24px_10px_minmax(160px,1.4fr)_minmax(110px,0.8fr)_minmax(100px,1fr)_64px_110px_56px_72px_64px_92px] items-center gap-3.5 px-4 max-lg:grid-cols-[24px_10px_minmax(0,1fr)_auto]";

/** One table row of the list view, with a checkbox for bulk actions. */
export function ListRow({ v, picked, onPick, selected, onSelect }: { v: RunView; picked: boolean; onPick: (on: boolean) => void; selected: boolean; onSelect?: () => void }) {
  const r = v.run;
  const live = r.status === "running" || r.status === "recovering";
  const tps = v.fleet ? rate(v.fleet.tps) : 0;
  return (
    <div
      data-run={r.id}
      role="row"
      tabIndex={0}
      aria-selected={selected}
      onClick={() => openRun(r.id)}
      onFocus={onSelect}
      className={cn(
        LIST_COLS,
        "group min-h-14 cursor-pointer border-t border-line-2 outline-none first:border-t-0 hover:bg-s2 aria-selected:bg-s2",
        v.h.tone && TONE_BG[v.h.tone],
        picked && "bg-[color-mix(in_srgb,var(--accent-c)_7%,var(--s1))]",
      )}
    >
      <label className="flex cursor-pointer items-center justify-center" onClick={(e) => e.stopPropagation()} title="Select (x)">
        <input type="checkbox" checked={picked} onChange={(e) => onPick(e.target.checked)} aria-label={`Select ${runName(r)}`} className="size-4 cursor-pointer accent-[var(--accent-c)]" />
      </label>
      <Hue hue={r.hue} />
      <span className="grid min-w-0 grid-cols-[auto_auto_1fr] items-center gap-x-2">
        <b className="truncate font-medium">{runName(r)}</b>
        {v.unseen ? <Unseen /> : <span />}
        <span />
        <small className="col-span-3 truncate font-mono text-xs text-ink-3">{repoShort(r.repo)}</small>
      </span>
      <span>
        <StatusChip h={v.h} />
      </span>
      <span className="h-6 max-lg:hidden">{live && v.fleet ? <Wave values={v.fleet.tps.slice(-90)} hue={r.hue} /> : null}</span>
      <span className="inline-flex items-center gap-1 max-lg:hidden">
        {v.findings.map((f) => (
          <Sev key={f.id} sev={sevOf(f)} done={!!f.verdict} />
        ))}
      </span>
      <span className="truncate font-mono text-xs text-ink-2 max-lg:hidden">{r.model.split("/").slice(1).join("/").replace(/^claude-/, "")}</span>
      <span className="text-right font-mono text-xs text-ink-2 tabular-nums max-lg:hidden">{live && tps >= 1 ? Math.round(tps) : "–"}</span>
      <span className="text-right font-mono text-xs text-ink-2 tabular-nums max-lg:hidden">{money(r.cost)}</span>
      <span className="text-right font-mono text-xs text-ink-2 tabular-nums max-lg:hidden">{elapsed(runtimeOf(r))}</span>
      <span className="flex justify-end gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 group-aria-selected:opacity-100 max-lg:hidden">
        <RunActions run={r} />
      </span>
    </div>
  );
}

