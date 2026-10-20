/**
 * One model over the window: tokens, cost, speed (output tok/s and first token, over time and as a
 * spread), what a typical call looks like against the model's context and prices, what went wrong,
 * and the runs that used it. Opened from Stats, By model.
 */
import { useEffect, type ReactNode } from "react";
import { IconArrowLeft } from "@tabler/icons-react";
import { api } from "../../lib/api.ts";
import { useAsync } from "../../lib/hooks.ts";
import { Link, navigate, useLocation } from "../../lib/router.tsx";
import { dateTime, duration, money, tokens } from "../../lib/format.ts";
import { rate, runName, useFleet } from "../../lib/fleet.ts";
import { isLive, useRuns } from "../../lib/runs.ts";
import { openRun } from "../../lib/actions.ts";
import { cn } from "../../lib/cn.ts";
import type { ModelStats } from "../../lib/types.ts";
import { ErrorBox, PageHeader, Segmented } from "../../components/ui.tsx";
import { IC_XS, Join } from "../../components/ui/bits.tsx";
import { Tip } from "../../components/ui/overlay.tsx";
import { Bars, Figure, Head, HitLine, Mini, MiniLine, Mix, Num, TokenArea, WINDOWS, allTokens, card, int, ms, pct, per } from "../Stats.tsx";

const tps = (v: number | null | undefined) => (v == null ? "" : `${Math.round(v)}`);

export function ModelStatsPage() {
  const loc = useLocation();
  const params = new URLSearchParams(loc.search);
  const key = params.get("key") ?? "";
  const days = Number(params.get("days")) || 7;
  const q = useAsync(() => api.modelStats(key, days), [key, days]);
  useEffect(() => {
    const t = setInterval(() => void q.reload(), 30_000);
    return () => clearInterval(t);
  }, [key, days]);
  const m = q.data;
  const slash = key.indexOf("/");

  return (
    <div className="pb-16">
      <Link to={days === 7 ? "/stats" : `/stats?days=${days}`} className="mt-4 inline-flex items-center gap-1.5 text-[12.5px] text-ink-3 no-underline hover:text-ink">
        <IconArrowLeft {...IC_XS} />
        Stats
      </Link>
      <PageHeader
        title={<span className="font-mono">{slash > 0 ? key.slice(slash + 1) : key}</span>}
        subtitle={<Join items={[slash > 0 ? key.slice(0, slash) : "", m?.catalog.name ?? ""].filter(Boolean)} />}
        actions={<Segmented label="Window" value={days} onChange={(d) => navigate(`/stats/model?key=${encodeURIComponent(key)}${d === 7 ? "" : `&days=${d}`}`, true)} options={WINDOWS} />}
      />
      {!m ? <ErrorBox error={q.error} /> : <Body m={m} />}
    </div>
  );
}

/** Output tokens/s right now, summed over the live runs set to this model. */
function useLiveTps(key: string) {
  const fleet = useFleet();
  const { runs } = useRuns();
  const live = (runs ?? []).filter((r) => r.model === key && isLive(r));
  const now = live.reduce((a, r) => a + rate(fleet?.runs.find((f) => f.id === r.id)?.tps ?? []), 0);
  return { runs: live.length, tps: now };
}

function Body({ m }: { m: ModelStats }) {
  const t = m.totals;
  const bucket = m.window.bucketMs;
  const sp = m.speedSummary;
  const live = useLiveTps(m.key);
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className={cn(card, "px-5 pt-4 pb-3")}>
          <div className="mb-4 grid grid-cols-2 gap-x-8 gap-y-3 sm:flex sm:flex-wrap">
            <Figure label="Tokens" value={tokens(allTokens(t))} sub={`${tokens(allTokens(m.allTime))} all time`} />
            <Figure label="Cost" value={money(t.cost)} sub={m.costPerMTokens == null ? undefined : `${money(m.costPerMTokens)} per million tokens`} />
            <Figure label="Output tok/s" value={tps(sp.tpsP50) || "none"} sub={sp.tpsP90 == null ? undefined : `p90 ${tps(sp.tpsP90)}`} />
            <Figure label="First token" value={ms(sp.ttftP50) || "none"} sub={sp.ttftP90 == null ? undefined : `p90 ${ms(sp.ttftP90)}`} />
            <Figure label="Model calls" value={int(t.calls)} sub={t.errors ? <span className="text-critical">{int(t.errors)} failed</span> : "none failed"} />
            {live.runs > 0 && <Figure label="Now" value={`${Math.round(live.tps)} tok/s`} sub={`${live.runs} live ${live.runs === 1 ? "run" : "runs"}`} />}
          </div>
          <TokenArea series={m.series} bucketMs={bucket} />
        </section>
        <Mix t={t} savings={m.savings.saved} />
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Mini title={`Cost per ${per(bucket)}`} value={money(t.cost)}>
          <Bars series={m.series} bucketMs={bucket} values={m.series.map((b) => b.cost)} color="var(--r5)" fmt={money} />
        </Mini>
        <Mini title="Cache hit rate" value={pct(t.hitRate)} unit="of prompt tokens">
          <HitLine series={m.series} bucketMs={bucket} />
        </Mini>
        <Mini title={`Model calls per ${per(bucket)}`} value={int(t.calls)} unit={t.errors ? `${pct(t.errors / Math.max(1, t.calls))} failed` : undefined}>
          <Bars series={m.series} bucketMs={bucket} values={m.series.map((b) => b.calls - b.errors)} bad={m.series.map((b) => b.errors)} color="var(--r1)" fmt={int} />
        </Mini>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section className={cn(card, "flex flex-col gap-4 px-5 py-4")}>
          <Head title="Speed" meta={`over ${int(sp.measured)} calls`} />
          <MiniLine label="Output tok/s, p50" series={m.series} bucketMs={bucket} values={m.speed.map((x) => x.tps)} color="var(--r1)" fmt={(v) => `${Math.round(v)} tok/s`} />
          <MiniLine label="Output tok/s, p90" series={m.series} bucketMs={bucket} values={m.speed.map((x) => x.tpsP90)} color="var(--r2)" fmt={(v) => `${Math.round(v)} tok/s`} />
          <MiniLine label="First token" series={m.series} bucketMs={bucket} values={m.speed.map((x) => x.ttft)} color="var(--r5)" fmt={ms} />
        </section>
        <Spread rows={m.tpsSpread} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <TypicalCall m={m} />
        <Trouble m={m} />
      </div>

      <RunsOnModel m={m} />
    </div>
  );
}

/** How output speed is spread over calls. */
function Spread({ rows }: { rows: ModelStats["tpsSpread"] }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  const total = rows.reduce((a, r) => a + r.n, 0);
  return (
    <section className={cn(card, "flex flex-col px-5 py-4")}>
      <Head title="Output speed spread" meta="calls by tok/s" />
      {total ? (
        <>
          <div className="flex h-[150px] items-end gap-[3px]">
            {rows.map((r) => (
              <Tip key={r.from} content={`${r.from} to ${r.to} tok/s: ${r.n} ${r.n === 1 ? "call" : "calls"}`}>
                <div className="flex h-full flex-1 items-end">
                  <i className={cn("block w-full rounded-t-[3px]", r.n ? "bg-[var(--r1)]" : "bg-s3")} style={{ height: r.n ? `${Math.max(3, (r.n / max) * 100)}%` : 2 }} />
                </div>
              </Tip>
            ))}
          </div>
          <div className="mt-1.5 flex justify-between font-mono text-[11px] text-ink-4">
            <span>0</span>
            <span>{rows[rows.length - 1].to} tok/s</span>
          </div>
        </>
      ) : (
        <div className="py-6 text-sm text-ink-3">No calls long enough to measure</div>
      )}
    </section>
  );
}

function Fact({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 border-t border-line-2 py-[7px] text-[13px] first:border-t-0">
      <span className="text-ink-3">{label}</span>
      <span className="text-right font-mono text-[12.5px] tabular-nums">
        {value}
        {sub && <span className="ml-2 text-ink-4">{sub}</span>}
      </span>
    </div>
  );
}

function TypicalCall({ m }: { m: ModelStats }) {
  const c = m.perCall;
  const ctx = m.catalog.context;
  const fill = ctx && c.prompt ? c.prompt / ctx : null;
  const sp = m.speedSummary;
  const price = (v: number | null) => (v == null ? "" : `${money(v)}`);
  return (
    <section className={cn(card, "px-5 py-4")}>
      <Head title="A typical call" meta="average over calls that ran" />
      {fill != null && (
        <div className="mb-3">
          <div className="mb-1.5 flex items-baseline gap-2 text-[12.5px] text-ink-3">
            Prompt fills
            <span className="font-mono text-ink">{pct(fill, 0)}</span>
            of the context
            <span className="ml-auto font-mono text-[11.5px]">{tokens(ctx!)} tokens</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-s3">
            <i className={cn("block h-full rounded-full", fill > 0.85 ? "bg-warning" : "bg-[var(--r1)]")} style={{ width: `${Math.min(100, fill * 100)}%` }} />
          </div>
        </div>
      )}
      <div className="flex flex-col">
        <Fact label="Prompt" value={c.prompt == null ? "" : `${tokens(Math.round(c.prompt))} tokens`} />
        <Fact label="Output" value={c.output == null ? "" : `${tokens(Math.round(c.output))} tokens`} sub={c.reasoning ? `${tokens(Math.round(c.reasoning))} reasoning` : undefined} />
        <Fact label="Cost" value={c.cost == null ? "" : money(c.cost)} />
        <Fact label="Time" value={ms(sp.durationP50)} sub={sp.durationP90 == null ? undefined : `p90 ${ms(sp.durationP90)}`} />
        {(m.catalog.costIn != null || m.catalog.costOut != null) && (
          <Fact
            label="Price per million"
            value={<Join items={[m.catalog.costIn != null && `${price(m.catalog.costIn)} in`, m.catalog.costOut != null && `${price(m.catalog.costOut)} out`, m.catalog.costCacheRead != null && `${price(m.catalog.costCacheRead)} cached`].filter(Boolean) as string[]} />}
          />
        )}
        {m.allTime.since && <Fact label="First used" value={dateTime(m.allTime.since)} />}
      </div>
    </section>
  );
}

function Trouble({ m }: { m: ModelStats }) {
  const errs = Object.entries(m.errors).sort((a, b) => b[1] - a[1]);
  const p = m.providerEvents;
  const r = m.runs;
  return (
    <section className={cn(card, "flex flex-col gap-4 px-5 py-4")}>
      <Head title="Reliability" />
      <div className="grid grid-cols-3 gap-x-4 gap-y-4">
        <Num label="Failed calls" value={int(m.totals.errors)} tone={m.totals.errors ? "bad" : undefined} />
        <Num label="Rate limits" value={int(p.ratelimit ?? 0)} tone={p.ratelimit ? "warn" : undefined} />
        <Num label="Retries" value={int(p.retry ?? 0)} />
        {r && r.finishRate != null && <Num label="Runs finished" value={pct(r.finishRate, 0)} />}
        {r && <Num label="Real findings" value={int(r.real)} />}
        {r && r.costPerReal != null && <Num label="Per real finding" value={money(r.costPerReal)} />}
      </div>
      {errs.length > 0 && (
        <div className="border-t border-line-2 pt-3">
          <div className="mb-1.5 text-xs text-ink-3">Errors</div>
          {errs.map(([name, n]) => (
            <div key={name} className="flex items-baseline gap-2 py-0.5 text-[12.5px]">
              <span className="truncate font-mono text-ink-2">{name}</span>
              <span className="ml-auto font-mono text-critical tabular-nums">{n}</span>
            </div>
          ))}
        </div>
      )}
      {(m.aborted > 0 || (r && r.medianDuration != null)) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line-2 pt-3 text-[12.5px] text-ink-3">
          {m.aborted > 0 && (
            <span>
              Aborted <span className="font-mono text-ink">{m.aborted}</span>
            </span>
          )}
          {r && r.medianDuration != null && (
            <span>
              Median run <span className="font-mono text-ink">{duration(r.medianDuration)}</span>
            </span>
          )}
          {r && (
            <span>
              Runs on it now <span className="font-mono text-ink">{r.active}</span>
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function RunsOnModel({ m }: { m: ModelStats }) {
  const rows = m.byRun;
  const max = Math.max(1, ...rows.map(allTokens));
  return (
    <section className={cn(card, "px-2 py-4")}>
      <div className="px-3">
        <Head title="Runs that used it" meta={`${rows.length} by tokens`} right={<span className="font-mono text-[11px] text-ink-4 max-sm:hidden">tok/s, cache hits, cost</span>} />
      </div>
      <div className="flex flex-col">
        {rows.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => openRun(r.id)}
            className="grid min-h-11 cursor-pointer grid-cols-[10px_minmax(0,1fr)_minmax(80px,1fr)_52px_52px_68px] items-center gap-3.5 rounded-xl border-0 bg-transparent px-3 py-1.5 text-left hover:bg-s2 max-sm:grid-cols-[10px_minmax(0,1fr)_68px]"
          >
            <i className="size-2.5 rounded-[3px]" style={{ background: `var(--r${r.hue ?? 0})` }} />
            <span className="min-w-0">
              <span className="block truncate text-[13.5px] text-ink">{runName(r)}</span>
              <span className="block truncate text-[11.5px] text-ink-3">
                <Join items={[r.status ?? "deleted", `${int(r.calls)} calls`]} />
              </span>
            </span>
            <span className="flex items-center gap-2 max-sm:hidden">
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-s3">
                <i className="block h-full rounded-full" style={{ width: `${(allTokens(r) / max) * 100}%`, background: `var(--r${r.hue ?? 0})` }} />
              </span>
              <span className="w-12 text-right font-mono text-xs tabular-nums">{tokens(allTokens(r))}</span>
            </span>
            <span className="text-right font-mono text-xs text-ink-2 tabular-nums max-sm:hidden">{tps(r.tpsP50)}</span>
            <span className="text-right font-mono text-xs text-ink-3 tabular-nums max-sm:hidden">{pct(r.hitRate, 0)}</span>
            <span className="text-right font-mono text-xs tabular-nums">{money(r.cost)}</span>
          </button>
        ))}
        {!rows.length && <div className="px-3 py-6 text-sm text-ink-3">No runs called this model in this window</div>}
      </div>
    </section>
  );
}
