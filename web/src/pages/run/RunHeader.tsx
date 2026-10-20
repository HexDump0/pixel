/**
 * The run header, one thin row: colour · name · status · the numbers that matter (tok/s, tokens, cache
 * rate, cost and cost per hour, context, agents) · Pause, Stop, ⋯, ×. A one-line notice only when something is off.
 */
import type { ReactNode } from "react";
import { IconDatabasePlus, IconLayoutSidebarLeftExpand, IconPlayerPause, IconPlayerPlay, IconPlayerStop, IconRefresh, IconX } from "@tabler/icons-react";
import { act, canPause, canResume, canStop, diskFull } from "../../lib/actions.ts";
import { rate } from "../../lib/fleet.ts";
import { money, tokens } from "../../lib/format.ts";
import type { Health } from "../../lib/health.ts";
import { cn } from "../../lib/cn.ts";
import type { FleetRun, RunDetail } from "../../lib/types.ts";
import { RunMenuButton } from "../../components/RunMenu.tsx";
import { RunName } from "../../components/RunName.tsx";
import { Button } from "../../components/ui.tsx";
import { AgentDot, ContextRing, Hue, IC_SM, StatusChip, Wave } from "../../components/ui/bits.tsx";
import { Tip } from "../../components/ui/overlay.tsx";

function Kp({ value, unit, tip, pre, cls }: { value: ReactNode; unit: ReactNode; tip: ReactNode; pre?: ReactNode; cls?: string }) {
  return (
    <Tip content={tip}>
      <span className={cn("inline-flex h-7 items-center gap-1.5 px-3 font-mono text-[13px] whitespace-nowrap text-ink tabular-nums [&+&]:border-l [&+&]:border-line-2", cls)}>
        {pre}
        <b className="font-medium">{value}</b>
        <small className="font-sans text-xs text-ink-3">{unit}</small>
      </span>
    </Tip>
  );
}

export function RunHeader({ detail, fleet, h, railHidden, onShowRail, onClose }: { detail: RunDetail; fleet?: FleetRun; h: Health; railHidden: boolean; onShowRail: () => void; onClose: () => void }) {
  const r = detail.run;
  const live = r.status === "running" || r.status === "recovering";
  const tps = fleet ? rate(fleet.tps) : 0;
  const gen = live && tps >= 1;
  const total = r.tokens_in + r.tokens_out + r.tokens_reasoning + r.tokens_cache;
  const c = detail.cache;
  const prompt = c ? c.input + c.read + c.write : 0;
  const cacheRate = prompt ? Math.round((c!.read / prompt) * 100) : null;
  const hours = Math.max(0.25, ((r.finished_at ?? Date.now()) - (r.started_at ?? r.created_at)) / 3_600_000);
  const ctx = fleet?.context;
  const ctxPct = ctx?.used && ctx.limit ? Math.round((ctx.used / ctx.limit) * 100) : null;
  const subs = fleet?.agents.subs ?? [];
  const states = [fleet?.agents.main ?? (live ? "working" : "done"), ...subs.map((s) => s.status)];
  const working = states.filter((s) => s === "working" || s === "running").length;
  const notice = r.status_detail && ["recovering", "failed", "preparing", "stopped"].includes(r.status);

  return (
    <div className="flex flex-col pt-3 pr-4 pl-[22px]">
      <div className="flex min-h-10 min-w-0 items-center gap-2.5 max-md:flex-wrap">
        {railHidden && (
          <Button size="sm" icon variant="ghost" className="-ml-2 max-lg:hidden" title="Show the run list ([)" aria-label="Show the run list" onClick={onShowRail}>
            <IconLayoutSidebarLeftExpand {...IC_SM} />
          </Button>
        )}
        <Hue hue={r.hue} className="size-[11px]" />
        <h1 className="m-0 min-w-0 truncate text-[19px] font-medium tracking-[-0.018em]">
          <RunName run={r} editable />
        </h1>
        <StatusChip h={h} />
        <div className="ml-auto flex min-w-0 items-center overflow-hidden max-lg:hidden">
          {live && (
            <Kp
              value={gen ? Math.round(tps) : 0}
              unit="tok/s"
              cls={gen ? "" : "[&_b]:text-ink-3"}
              tip={gen ? "Output tokens per second" : "Not generating"}
              pre={
                gen && fleet ? (
                  <span className="mr-0.5 block h-4 w-14">
                    <Wave values={fleet.tps.slice(-60)} hue={r.hue} />
                  </span>
                ) : undefined
              }
            />
          )}
          <Kp value={tokens(total)} unit="tokens" tip={`${tokens(r.tokens_in)} in, ${tokens(r.tokens_out + r.tokens_reasoning)} out, ${tokens(r.tokens_cache)} cache`} />
          {cacheRate != null && <Kp value={`${cacheRate}%`} unit="cached" tip="Share of prompt tokens read from the cache: cache read / (input + cache read + cache write)" cls="max-xl:hidden" />}
          <Kp value={money(r.cost)} unit={`${money(r.cost / hours)}/h`} tip="Cost so far and per hour" />
          {live && ctxPct != null && <Kp value={`${ctxPct}%`} unit="context" cls={cn("max-xl:hidden", ctxPct > 80 && "[&_b]:text-warning")} tip={`${tokens(ctx!.used)} of ${tokens(ctx!.limit)} context window`} pre={<ContextRing pct={ctxPct} warn={ctxPct > 80} />} />}
          {fleet && (
            <Kp
              value={`${working}/${states.length}`}
              unit="agents"
              tip={`${working} of ${states.length} agents working`}
              pre={
                <span className="inline-flex gap-[3px]">
                  {states.slice(0, 8).map((s, i) => (
                    <AgentDot key={i} s={s} />
                  ))}
                </span>
              }
            />
          )}
        </div>
        <div className="ml-2 flex shrink-0 gap-1.5 border-l border-line-2 pl-3 max-lg:ml-auto">
          {r.status === "failed" ? (
            <Button size="sm" onClick={() => act.retry(r.id)}>
              <IconRefresh {...IC_SM} />
              Retry
            </Button>
          ) : canResume(r) && r.status !== "done" ? (
            <Button size="sm" onClick={() => act.resume(r.id)} disabled={!r.session_id}>
              <IconPlayerPlay {...IC_SM} />
              Resume
            </Button>
          ) : (
            <>
              {canPause(r) && (
                <Button size="sm" icon title="Pause" aria-label="Pause" onClick={() => act.pause(r.id)}>
                  <IconPlayerPause {...IC_SM} />
                </Button>
              )}
              {canStop(r) && (
                <Button size="sm" icon variant="danger" title="Stop" aria-label="Stop" onClick={() => act.stop(r.id)}>
                  <IconPlayerStop {...IC_SM} />
                </Button>
              )}
            </>
          )}
          <RunMenuButton run={r} size="sm" ghost={false} />
          <Button size="sm" icon variant="ghost" title="Close (Esc)" aria-label="Close" onClick={onClose}>
            <IconX {...IC_SM} />
          </Button>
        </div>
      </div>
      {notice && (
        <div className={cn("mt-2 flex items-center gap-3 rounded-[10px] px-3 py-2 font-mono text-[12.5px] leading-normal text-ink", r.status === "failed" ? "bg-[var(--bad-tint)]" : "bg-[var(--warn-tint)]")}>
          <span className="min-w-0 flex-1">{r.status_detail}</span>
          {diskFull(r) && (
            <Button size="xs" className="font-sans" onClick={() => void act.boostDisk(r.id)}>
              <IconDatabasePlus {...IC_SM} />
              Give more disk
            </Button>
          )}
        </div>
      )}
      {r.disk_boost && (
        <div className="mt-2 flex items-center gap-3 rounded-[10px] bg-[var(--warn-tint)] px-3 py-2 text-[13px] leading-normal text-ink">
          <IconDatabasePlus {...IC_SM} className="shrink-0 text-warning" />
          <span className="min-w-0 flex-1">
            Cleaning up a full disk with {r.disk_boost.extraGiB} GB extra; back to {r.disk_boost.baseGiB} GB once it's under the limit
          </span>
          <Button size="xs" variant="ghost" onClick={() => act.endBoost(r.id)}>
            Back to normal now
          </Button>
        </div>
      )}
    </div>
  );
}
