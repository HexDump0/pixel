/**
 * Stats: tokens over time stacked by kind beside the token mix (cache hit rate in the middle), cost,
 * cache and call charts, when agents work (weekday × hour), then per model, per run, per tool, and how
 * runs and providers held up. Health checks sit in one strip on top; Pixel's own numbers are on the
 * System page.
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { arc, area, curveMonotoneX, line, pie, stack } from "d3-shape";
import { IconAlertTriangle, IconArrowRight, IconCircleCheck } from "@tabler/icons-react";
import { api } from "../lib/api.ts";
import { useAsync } from "../lib/hooks.ts";
import { Link, navigate, useLocation } from "../lib/router.tsx";
import { duration, money, tokens } from "../lib/format.ts";
import { kindColor, runName } from "../lib/fleet.ts";
import { openRun } from "../lib/actions.ts";
import { cn } from "../lib/cn.ts";
import type { Stats } from "../lib/types.ts";
import { ErrorBox, PageHeader, Segmented } from "../components/ui.tsx";
import { IC_SM, IC_XS, Join, Nil, Sep, Val } from "../components/ui/bits.tsx";
import { Tip } from "../components/ui/overlay.tsx";
import { ChartTip, TipRow, TipTitle, niceMax, useSize, type TipState } from "../components/charts/common.tsx";

type Totals = Stats["totals"];
type Bucket = Stats["series"][number];

const WINDOWS: [number, string][] = [
  [1, "24h"],
  [7, "7d"],
  [30, "30d"],
  [90, "90d"],
];

/** Token kinds in stack order (bottom up), in the token colours. */
const KINDS = [
  { key: "cacheRead", label: "Cache read", color: "var(--t-cr)" },
  { key: "input", label: "Input", color: "var(--t-in)" },
  { key: "cacheWrite", label: "Cache write", color: "var(--t-cw)" },
  { key: "output", label: "Output", color: "var(--t-out)" },
] as const;

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const pct = (v: number | null | undefined, digits = 1) => (v == null ? "" : `${(v * 100).toFixed(digits)}%`);
const ms = (n: number | null | undefined) => (n == null ? "" : n < 1000 ? `${Math.round(n)} ms` : n < 60_000 ? `${(n / 1000).toFixed(1)} s` : duration(n));
const int = (n: number) => n.toLocaleString();
const allTokens = (t: Pick<Totals, "input" | "output" | "cacheRead" | "cacheWrite">) => t.input + t.output + t.cacheRead + t.cacheWrite;

function bucketLabel(t: number, size: number) {
  const d = new Date(t);
  if (size < 6 * 3600_000) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (size < 24 * 3600_000) return d.toLocaleString([], { weekday: "short", hour: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

const card = "min-w-0 rounded-2xl border border-line-2 bg-s1";

export function StatsPage() {
  const loc = useLocation();
  const days = Number(new URLSearchParams(loc.search).get("days")) || 7;
  const stats = useAsync(() => api.stats(days), [days]);
  useEffect(() => {
    const t = setInterval(() => void stats.reload(), 30_000);
    return () => clearInterval(t);
  }, []);
  const s = stats.data;

  return (
    <div className="pb-16">
      <PageHeader title="Stats" actions={<Segmented label="Window" value={days} onChange={(d) => navigate(d === 7 ? "/stats" : `/stats?days=${d}`, true)} options={WINDOWS} />} />
      {!s ? <ErrorBox error={stats.error} /> : <Body s={s} />}
    </div>
  );
}

function Body({ s }: { s: Stats }) {
  const t = s.totals;
  const bucket = s.window.bucketMs;
  return (
    <div className="flex flex-col gap-3">
      <Health checks={s.system.checks} />

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className={cn(card, "px-5 pt-4 pb-3")}>
          <div className="mb-4 grid grid-cols-2 gap-x-8 gap-y-3 sm:flex sm:flex-wrap">
            <Figure label="Tokens" value={tokens(allTokens(t))} sub={`${tokens(allTokens(s.allTime))} all time`} />
            <Figure label="Cost" value={money(t.cost)} sub={`about ${money((t.cost / Math.max(1, s.window.days)) * 30)} per 30 days`} />
            <Figure label="Model calls" value={int(t.calls)} sub={t.errors ? <span className="text-critical">{int(t.errors)} failed</span> : "none failed"} />
            <Figure label="Agent time" value={duration(s.runs.agentMs).replace(/ \d+s$/, "")} sub={<Join items={[`${s.runs.sessions} sessions`, `${s.runs.subagents} subagents`]} />} />
          </div>
          <TokenArea series={s.series} bucketMs={bucket} />
        </section>
        <Mix t={t} savings={s.savings.saved} />
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Mini title={`Cost per ${bucket >= 86_400_000 ? "day" : bucket >= 6 * 3600_000 ? "6 h" : "hour"}`} value={money(t.cost)}>
          <Bars series={s.series} bucketMs={bucket} values={s.series.map((b) => b.cost)} color="var(--r5)" fmt={money} />
        </Mini>
        <Mini title="Cache hit rate" value={pct(t.hitRate)} unit="of prompt tokens">
          <HitLine series={s.series} bucketMs={bucket} />
        </Mini>
        <Mini title={`Model calls per ${bucket >= 86_400_000 ? "day" : bucket >= 6 * 3600_000 ? "6 h" : "hour"}`} value={int(t.calls)} unit={t.errors ? `${pct(t.errors / Math.max(1, t.calls))} failed` : undefined}>
          <Bars series={s.series} bucketMs={bucket} values={s.series.map((b) => b.calls - b.errors)} bad={s.series.map((b) => b.errors)} color="var(--r1)" fmt={int} />
        </Mini>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section className={cn(card, "px-5 py-4")}>
          <Head title="Cost by model" meta={`per ${per(bucket)}`} />
          <StackBars
            series={s.series}
            bucketMs={bucket}
            height={150}
            fmt={money}
            layers={s.modelSeries.map((m, i) => ({ key: m.key, label: m.key === "other" ? "Other models" : m.key.split("/").slice(1).join("/"), color: m.key === "other" ? "var(--ink-4)" : `var(--r${i % 6})`, values: m.cost }))}
          />
        </section>
        <section className={cn(card, "flex flex-col gap-4 px-5 py-4")}>
          <Head title="Model speed" meta="p50 over every call" />
          <MiniLine label="First token" series={s.series} bucketMs={bucket} values={s.speed.map((x) => x.ttft)} color="var(--r5)" fmt={ms} />
          <MiniLine label="Output tok/s" series={s.series} bucketMs={bucket} values={s.speed.map((x) => x.tps)} color="var(--r1)" fmt={(v) => `${Math.round(v)} tok/s`} />
        </section>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <section className={cn(card, "px-5 py-4")}>
          <Head title="Tool calls by kind" meta={`per ${per(bucket)}`} />
          <StackBars
            series={s.series}
            bucketMs={bucket}
            height={96}
            fmt={int}
            layers={Object.entries(s.toolSeries)
              .sort((a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0))
              .map(([k, values]) => ({ key: k, label: KIND_LABEL[k] ?? k, color: kindColor(k), values }))}
          />
        </section>
        <section className={cn(card, "px-5 py-4")}>
          <Head title="Findings" meta={`${s.findings.total} new`} />
          <StackBars series={s.series} bucketMs={bucket} height={96} fmt={int} layers={SEV.map(([k, c]) => ({ key: k, label: k, color: c, values: s.findingSeries[k] ?? [] })).filter((l) => l.values.some(Boolean))} />
        </section>
        <section className={cn(card, "px-5 py-4")}>
          <Head title="Runs started and finished" />
          <StackBars
            series={s.series}
            bucketMs={bucket}
            height={96}
            fmt={int}
            layers={[
              { key: "started", label: "Started", color: "var(--r0)", values: s.runSeries.started },
              { key: "finished", label: "Finished", color: "var(--r2)", values: s.runSeries.finished },
            ]}
          />
        </section>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Heatmap grid={s.heatmap} />
        <Tools rows={s.tools} />
      </div>

      <Models rows={s.byModel} />

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <TopRuns rows={s.byRun} />
        <RunsCard s={s} />
      </div>
    </div>
  );
}

// ---- small pieces ----

function Figure({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[12.5px] text-ink-3">{label}</div>
      <div className="mt-0.5 text-[26px] leading-tight font-medium tracking-[-0.02em] tabular-nums">{value}</div>
      {sub && <div className="truncate font-mono text-[11.5px] text-ink-4">{sub}</div>}
    </div>
  );
}

function Head({ title, meta, right }: { title: ReactNode; meta?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline gap-2.5">
      <h2 className="m-0 text-[13.5px] font-medium">{title}</h2>
      {meta && <span className="text-[12.5px] text-ink-3">{meta}</span>}
      {right && <div className="ml-auto">{right}</div>}
    </div>
  );
}

const CHECK = { ok: "bg-good", warn: "bg-warning", bad: "bg-critical" } as const;

/** Every health check as a dot and its name; problems also say what's wrong. */
function Health({ checks }: { checks: Stats["system"]["checks"] }) {
  const bad = checks.filter((c) => c.state !== "ok");
  return (
    <div className={cn(card, "flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3")}>
      <span className={cn("inline-flex items-center gap-2 text-[13px] font-medium", bad.some((c) => c.state === "bad") ? "text-critical" : bad.length ? "text-warning" : "text-good")}>
        {bad.length ? <IconAlertTriangle {...IC_SM} /> : <IconCircleCheck {...IC_SM} />}
        {bad.length ? `${bad.length} to look at` : "All good"}
      </span>
      {checks.map((c) => (
        <Tip key={c.name} content={c.detail}>
          <span className="inline-flex min-w-0 items-center gap-2 text-[12.5px]">
            <i className={cn("size-1.5 shrink-0 rounded-full", CHECK[c.state])} />
            <span className={c.state === "ok" ? "text-ink-3" : "text-ink"}>{c.name}</span>
            {c.state !== "ok" && <span className="truncate text-ink-3 max-sm:hidden">{c.detail}</span>}
          </span>
        </Tip>
      ))}
      <Link to="/system" className="ml-auto inline-flex items-center gap-1 text-xs text-ink-3 no-underline hover:text-ink">
        System <IconArrowRight {...IC_XS} />
      </Link>
    </div>
  );
}

// ---- tokens over time ----

function TokenArea({ series, bucketMs }: { series: Bucket[]; bucketMs: number }) {
  const [ref, { w }] = useSize<HTMLDivElement>();
  const gid = useId().replace(/:/g, "");
  const [hi, setHi] = useState<number | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const H = 220;
  const B = 18;
  const n = series.length;
  const geo = useMemo(() => {
    const layers = stack<Bucket>().keys(KINDS.map((k) => k.key))(series);
    const max = niceMax(Math.max(1, ...series.map(allTokens)) * 1.08);
    return { layers, max };
  }, [series]);
  const X = (i: number) => (n > 1 ? (i / (n - 1)) * w : 0);
  const Y = (v: number) => H - B - (v / geo.max) * (H - B - 8);
  const ar = area<[number, number]>()
    .x((_, i) => X(i))
    .y0((d) => Y(d[0]))
    .y1((d) => Y(d[1]))
    .curve(curveMonotoneX);
  const top = line<[number, number]>()
    .x((_, i) => X(i))
    .y((d) => Y(d[1]))
    .curve(curveMonotoneX);
  const empty = !series.some((b) => b.calls);

  return (
    <div ref={ref} className="relative" style={{ height: H }}>
      {w > 0 && (
        <svg
          width={w}
          height={H}
          className="block overflow-visible"
          role="img"
          aria-label="Tokens over time, stacked by kind"
          onMouseMove={(e) => {
            const b = e.currentTarget.getBoundingClientRect();
            const i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - b.left) / w) * (n - 1))));
            const x = series[i];
            setHi(i);
            setTip({
              x: e.clientX,
              y: e.clientY,
              content: (
                <>
                  <TipTitle>{bucketLabel(x.t, bucketMs)}</TipTitle>
                  {[...KINDS].reverse().map((k) => (
                    <TipRow key={k.key} color={k.color} label={k.label} value={tokens(x[k.key])} />
                  ))}
                  <div className="mt-1.5 flex justify-between border-t border-line pt-1.5 font-mono text-xs">
                    <span className="text-ink-3">{int(x.calls)} calls</span>
                    <span>{money(x.cost)}</span>
                  </div>
                </>
              ),
            });
          }}
          onMouseLeave={() => (setHi(null), setTip(null))}
        >
          <defs>
            {KINDS.map((k) => (
              <linearGradient key={k.key} id={`${gid}-${k.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" style={{ stopColor: k.color, stopOpacity: 0.55 }} />
                <stop offset="100%" style={{ stopColor: k.color, stopOpacity: 0.12 }} />
              </linearGradient>
            ))}
          </defs>
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <line key={f} x1={0} x2={w} y1={Y(geo.max * f)} y2={Y(geo.max * f)} strokeDasharray="2 5" style={{ stroke: "var(--grid)" }} />
          ))}
          {geo.layers.map((l, k) => (
            <g key={l.key}>
              <path d={ar(l as unknown as [number, number][]) ?? ""} fill={`url(#${gid}-${l.key})`} />
              <path d={top(l as unknown as [number, number][]) ?? ""} fill="none" strokeWidth={1.25} style={{ stroke: KINDS[k].color, strokeOpacity: 0.9 }} />
            </g>
          ))}
          {hi != null && (
            <>
              <line x1={X(hi)} x2={X(hi)} y1={4} y2={H - B} className="stroke-ink/30" />
              <circle cx={X(hi)} cy={Y(allTokens(series[hi]))} r={3.5} style={{ fill: "var(--s1)", stroke: "var(--ink)", strokeWidth: 1.5 }} />
            </>
          )}
          <text x={w} y={Y(geo.max) - 3} textAnchor="end" className="fill-ink-4 font-mono text-[10px]">
            {tokens(geo.max)}
          </text>
          {n > 1 &&
            [0, Math.floor((n - 1) / 2), n - 1].map((i, k) => (
              <text key={i} x={X(i)} y={H - 3} textAnchor={k === 0 ? "start" : k === 2 ? "end" : "middle"} className="fill-ink-4 font-mono text-[10.5px]">
                {k === 2 ? "now" : bucketLabel(series[i].t, bucketMs)}
              </text>
            ))}
        </svg>
      )}
      {empty && <div className="absolute inset-0 flex items-center justify-center text-sm text-ink-3">No model calls in this window</div>}
      <ChartTip tip={tip} />
    </div>
  );
}

/** The token mix as a ring with the cache hit rate in the middle. */
function Mix({ t, savings }: { t: Totals; savings: number }) {
  const [hi, setHi] = useState<string | null>(null);
  const total = allTokens(t);
  const S = 152;
  const arcs = pie<(typeof KINDS)[number]>()
    .value((k) => t[k.key])
    .sort(null)
    .padAngle(0.025)(KINDS.filter((k) => t[k.key] > 0) as unknown as (typeof KINDS)[number][]);
  const ring = arc<(typeof arcs)[number]>()
    .innerRadius(S / 2 - 16)
    .outerRadius(S / 2)
    .cornerRadius(3);
  const focus = KINDS.find((k) => k.key === hi);
  return (
    <section className={cn(card, "flex flex-col px-5 py-4")}>
      <Head title="Token mix" />
      <div className="flex items-center gap-5 max-sm:flex-col xl:flex-col xl:gap-4">
        <svg width={S} height={S} viewBox={`${-S / 2} ${-S / 2} ${S} ${S}`} className="shrink-0" role="img" aria-label="Token mix">
          {total ? (
            arcs.map((a) => <path key={a.data.key} d={ring(a) ?? ""} style={{ fill: a.data.color, opacity: hi && hi !== a.data.key ? 0.3 : 1 }} onMouseEnter={() => setHi(a.data.key)} onMouseLeave={() => setHi(null)} />)
          ) : (
            <circle r={S / 2 - 8} fill="none" strokeWidth={16} style={{ stroke: "var(--s3)" }} />
          )}
          <text y={-2} textAnchor="middle" className="fill-ink text-[24px] font-medium tabular-nums">
            {focus ? pct(t[focus.key] / Math.max(1, total), 0) : pct(t.hitRate, 0)}
          </text>
          <text y={18} textAnchor="middle" className="fill-ink-3 text-[11.5px]">
            {focus ? focus.label.toLowerCase() : "cache hits"}
          </text>
        </svg>
        <div className="flex w-full min-w-0 flex-1 flex-col gap-1.5 self-stretch">
          {[...KINDS].reverse().map((k) => (
            <div key={k.key} className={cn("grid grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-2.5 text-[13px]", hi && hi !== k.key && "opacity-50")} onMouseEnter={() => setHi(k.key)} onMouseLeave={() => setHi(null)}>
              <i className="size-2.5 rounded-[3px]" style={{ background: k.color }} />
              <span className="text-ink-2">{k.label}</span>
              <span className="font-mono text-xs tabular-nums">{tokens(t[k.key])}</span>
            </div>
          ))}
          {t.reasoning > 0 && <div className="pl-[20px] font-mono text-[11.5px] text-ink-4">{tokens(t.reasoning)} of output was reasoning</div>}
        </div>
      </div>
      {savings > 0 && (
        <div className="mt-auto border-t border-line-2 pt-3 text-[13px] text-ink-2">
          About <span className="font-mono text-good">{money(savings)}</span> saved by cache reads
        </div>
      )}
    </section>
  );
}

// ---- small charts ----

function Mini({ title, value, unit, children }: { title: string; value: ReactNode; unit?: ReactNode; children: ReactNode }) {
  return (
    <section className={cn(card, "px-5 pt-4 pb-3")}>
      <div className="mb-3 flex items-baseline gap-2">
        <span className="mr-auto text-[12.5px] text-ink-3">{title}</span>
        <b className="text-[17px] font-medium tabular-nums">{value}</b>
        {unit && <small className="font-mono text-[11px] text-ink-3">{unit}</small>}
      </div>
      {children}
    </section>
  );
}

function Bars({ series, bucketMs, values, bad, color, fmt }: { series: Bucket[]; bucketMs: number; values: number[]; bad?: number[]; color: string; fmt: (n: number) => string }) {
  const [ref, { w }] = useSize<HTMLDivElement>();
  const [hi, setHi] = useState<number | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const H = 76;
  const n = values.length;
  const tot = values.map((v, i) => v + (bad?.[i] ?? 0));
  const max = Math.max(1e-9, ...tot);
  const slot = w / Math.max(1, n);
  const bw = Math.max(1.5, Math.min(14, slot - (slot > 6 ? 2 : 0.5)));
  const Y = (v: number) => (v / max) * (H - 4);
  return (
    <div ref={ref} className="relative" style={{ height: H }}>
      {w > 0 && (
        <svg
          width={w}
          height={H}
          className="block"
          onMouseMove={(e) => {
            const b = e.currentTarget.getBoundingClientRect();
            const i = Math.max(0, Math.min(n - 1, Math.floor((e.clientX - b.left) / slot)));
            setHi(i);
            setTip({
              x: e.clientX,
              y: e.clientY,
              content: (
                <>
                  <TipTitle>{bucketLabel(series[i].t, bucketMs)}</TipTitle>
                  <TipRow color={color} label={fmt(values[i])} />
                  {bad?.[i] ? <TipRow color="var(--critical)" label={`${fmt(bad[i])} failed`} /> : null}
                </>
              ),
            });
          }}
          onMouseLeave={() => (setHi(null), setTip(null))}
        >
          {values.map((v, i) => {
            const x = i * slot + (slot - bw) / 2;
            const e = bad?.[i] ?? 0;
            return (
              <g key={i} opacity={hi == null || hi === i ? 1 : 0.45}>
                {v > 0 && <rect x={x} y={H - Y(v)} width={bw} height={Math.max(1, Y(v))} rx={Math.min(2, bw / 3)} style={{ fill: color }} />}
                {e > 0 && <rect x={x} y={H - Y(v) - Y(e) - (v > 0 ? 1 : 0)} width={bw} height={Math.max(1.5, Y(e))} rx={Math.min(2, bw / 3)} style={{ fill: "var(--critical)" }} />}
                {v + e === 0 && <rect x={x} y={H - 1} width={bw} height={1} style={{ fill: "var(--line)" }} />}
              </g>
            );
          })}
        </svg>
      )}
      <ChartTip tip={tip} />
    </div>
  );
}

function HitLine({ series, bucketMs }: { series: Bucket[]; bucketMs: number }) {
  const [ref, { w }] = useSize<HTMLDivElement>();
  const gid = useId().replace(/:/g, "");
  const [hi, setHi] = useState<number | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const H = 76;
  const n = series.length;
  const X = (i: number) => (n > 1 ? (i / (n - 1)) * w : 0);
  const Y = (v: number) => H - 2 - v * (H - 6);
  const pts = series.map((b, i) => [i, b.hitRate] as [number, number | null]);
  const ln = line<[number, number | null]>()
    .defined((d) => d[1] != null)
    .x((d) => X(d[0]))
    .y((d) => Y(d[1]!))
    .curve(curveMonotoneX);
  const ar = area<[number, number | null]>()
    .defined((d) => d[1] != null)
    .x((d) => X(d[0]))
    .y0(H)
    .y1((d) => Y(d[1]!))
    .curve(curveMonotoneX);
  return (
    <div ref={ref} className="relative" style={{ height: H }}>
      {w > 0 && (
        <svg
          width={w}
          height={H}
          className="block overflow-visible"
          onMouseMove={(e) => {
            const b = e.currentTarget.getBoundingClientRect();
            const i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - b.left) / w) * (n - 1))));
            setHi(i);
            setTip({ x: e.clientX, y: e.clientY, content: <><TipTitle>{bucketLabel(series[i].t, bucketMs)}</TipTitle><TipRow color="var(--t-cr)" label={series[i].hitRate == null ? "no calls" : `${pct(series[i].hitRate)} cache hits`} /></> });
          }}
          onMouseLeave={() => (setHi(null), setTip(null))}
        >
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: "var(--t-cr)", stopOpacity: 0.35 }} />
              <stop offset="100%" style={{ stopColor: "var(--t-cr)", stopOpacity: 0 }} />
            </linearGradient>
          </defs>
          {[0.5, 1].map((f) => (
            <line key={f} x1={0} x2={w} y1={Y(f)} y2={Y(f)} strokeDasharray="2 5" style={{ stroke: "var(--grid)" }} />
          ))}
          <path d={ar(pts) ?? ""} fill={`url(#${gid})`} />
          <path d={ln(pts) ?? ""} fill="none" strokeWidth={1.75} style={{ stroke: "var(--t-cr)" }} />
          {/* A bucket with no neighbours draws no line; show it as a dot. */}
          {pts.map(([i, v]) => (v != null && pts[i - 1]?.[1] == null && pts[i + 1]?.[1] == null ? <circle key={i} cx={X(i)} cy={Y(v)} r={2} style={{ fill: "var(--t-cr)" }} /> : null))}
          {hi != null && series[hi].hitRate != null && <circle cx={X(hi)} cy={Y(series[hi].hitRate!)} r={3.5} style={{ fill: "var(--s1)", stroke: "var(--t-cr)", strokeWidth: 1.5 }} />}
        </svg>
      )}
      <ChartTip tip={tip} />
    </div>
  );
}

const per = (bucket: number) => (bucket >= 86_400_000 ? "day" : bucket >= 6 * 3600_000 ? "6 h" : "hour");
const KIND_LABEL: Record<string, string> = { shell: "Shell", read: "Read", edit: "Edit", task: "Subagents", web: "Web", other: "Other" };

/** Bars per bucket stacked by layer, with a legend of the layers that have anything. */
function StackBars({ series, bucketMs, layers, height, fmt }: { series: Bucket[]; bucketMs: number; layers: { key: string; label: string; color: string; values: number[] }[]; height: number; fmt: (n: number) => string }) {
  const [ref, { w }] = useSize<HTMLDivElement>();
  const [hi, setHi] = useState<number | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const n = series.length;
  const totals = series.map((_, i) => layers.reduce((a, l) => a + (l.values[i] ?? 0), 0));
  const max = Math.max(1e-9, ...totals);
  const slot = w / Math.max(1, n);
  const bw = Math.max(1.5, Math.min(16, slot - (slot > 6 ? 2 : 0.5)));
  const Y = (v: number) => (v / max) * (height - 4);
  const shown = layers.filter((l) => l.values.some(Boolean));
  return (
    <div>
      <div ref={ref} className="relative" style={{ height }}>
        {w > 0 && (
          <svg
            width={w}
            height={height}
            className="block"
            onMouseMove={(e) => {
              const b = e.currentTarget.getBoundingClientRect();
              const i = Math.max(0, Math.min(n - 1, Math.floor((e.clientX - b.left) / slot)));
              setHi(i);
              setTip({
                x: e.clientX,
                y: e.clientY,
                content: (
                  <>
                    <TipTitle>
                      {bucketLabel(series[i].t, bucketMs)} <Sep /> {fmt(totals[i])}
                    </TipTitle>
                    {shown.filter((l) => l.values[i]).map((l) => (
                      <TipRow key={l.key} color={l.color} label={l.label} value={fmt(l.values[i])} />
                    ))}
                  </>
                ),
              });
            }}
            onMouseLeave={() => (setHi(null), setTip(null))}
          >
            {series.map((_, i) => {
              const x = i * slot + (slot - bw) / 2;
              let y = height;
              return (
                <g key={i} opacity={hi == null || hi === i ? 1 : 0.45}>
                  {totals[i] === 0 ? (
                    <rect x={x} y={height - 1} width={bw} height={1} style={{ fill: "var(--line)" }} />
                  ) : (
                    shown.map((l) => {
                      const v = l.values[i] ?? 0;
                      if (!v) return null;
                      const h = Math.max(1.5, Y(v));
                      y -= h;
                      return <rect key={l.key} x={x} y={y} width={bw} height={h - (y > 0 ? 0.75 : 0)} rx={Math.min(1.5, bw / 4)} style={{ fill: l.color }} />;
                    })
                  )}
                </g>
              );
            })}
          </svg>
        )}
        {!shown.length && <div className="absolute inset-0 flex items-center justify-center text-[13px] text-ink-4">Nothing in this window</div>}
        <ChartTip tip={tip} />
      </div>
      {shown.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-3.5 gap-y-1">
          {shown.map((l) => (
            <span key={l.key} className="inline-flex min-w-0 items-center gap-1.5 text-xs text-ink-3">
              <i className="size-2 shrink-0 rounded-[2px]" style={{ background: l.color }} />
              <span className="truncate first-letter:uppercase">{l.label}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** One value per bucket as a line with its latest reading; gaps where a bucket had nothing. */
function MiniLine({ label, series, bucketMs, values, color, fmt }: { label: string; series: Bucket[]; bucketMs: number; values: (number | null)[]; color: string; fmt: (n: number) => string }) {
  const [ref, { w }] = useSize<HTMLDivElement>();
  const gid = useId().replace(/:/g, "");
  const [hi, setHi] = useState<number | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const H = 58;
  const n = values.length;
  const nums = values.filter((v): v is number => v != null);
  const max = niceMax(Math.max(1e-9, ...nums) * 1.1);
  const last = [...values].reverse().find((v) => v != null) ?? null;
  const X = (i: number) => (n > 1 ? (i / (n - 1)) * w : 0);
  const Y = (v: number) => H - 2 - (v / max) * (H - 6);
  const pts = values.map((v, i) => [i, v] as [number, number | null]);
  const ln = line<[number, number | null]>()
    .defined((d) => d[1] != null)
    .x((d) => X(d[0]))
    .y((d) => Y(d[1]!))
    .curve(curveMonotoneX);
  const ar = area<[number, number | null]>()
    .defined((d) => d[1] != null)
    .x((d) => X(d[0]))
    .y0(H)
    .y1((d) => Y(d[1]!))
    .curve(curveMonotoneX);
  return (
    <div>
      <div className="mb-1.5 flex items-baseline">
        <span className="mr-auto text-[12.5px] text-ink-3">{label}</span>
        <b className="font-mono text-[13px] font-medium tabular-nums">{last == null ? <Nil /> : fmt(last)}</b>
      </div>
      <div ref={ref} className="relative" style={{ height: H }}>
        {w > 0 && (
          <svg
            width={w}
            height={H}
            className="block overflow-visible"
            onMouseMove={(e) => {
              const b = e.currentTarget.getBoundingClientRect();
              const i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - b.left) / w) * (n - 1))));
              setHi(i);
              setTip({ x: e.clientX, y: e.clientY, content: <><TipTitle>{bucketLabel(series[i].t, bucketMs)}</TipTitle><TipRow color={color} label={values[i] == null ? "no calls" : fmt(values[i]!)} /></> });
            }}
            onMouseLeave={() => (setHi(null), setTip(null))}
          >
            <defs>
              <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" style={{ stopColor: color, stopOpacity: 0.3 }} />
                <stop offset="100%" style={{ stopColor: color, stopOpacity: 0 }} />
              </linearGradient>
            </defs>
            <path d={ar(pts) ?? ""} fill={`url(#${gid})`} />
            <path d={ln(pts) ?? ""} fill="none" strokeWidth={1.6} style={{ stroke: color }} />
            {pts.map(([i, v]) => (v != null && pts[i - 1]?.[1] == null && pts[i + 1]?.[1] == null ? <circle key={i} cx={X(i)} cy={Y(v)} r={2} style={{ fill: color }} /> : null))}
            {hi != null && values[hi] != null && <circle cx={X(hi)} cy={Y(values[hi]!)} r={3.5} style={{ fill: "var(--s1)", stroke: color, strokeWidth: 1.5 }} />}
          </svg>
        )}
        {!nums.length && <div className="absolute inset-0 flex items-center text-xs text-ink-4">No calls in this window</div>}
        <ChartTip tip={tip} />
      </div>
    </div>
  );
}

// ---- when agents work ----

function Heatmap({ grid }: { grid: number[][] }) {
  const [tip, setTip] = useState<TipState | null>(null);
  const max = Math.max(1, ...grid.flat());
  const busiest = grid.flatMap((row, d) => row.map((n, h) => ({ d, h, n }))).sort((a, b) => b.n - a.n)[0];
  return (
    <section className={cn(card, "px-5 py-4")}>
      <Head title="When agents work" meta={<span className="max-sm:hidden">model calls by weekday and hour</span>} right={busiest?.n ? <span className="font-mono text-[11.5px] text-ink-3">busiest {DAYS[busiest.d]} {String(busiest.h).padStart(2, "0")}:00</span> : undefined} />
      <div className="grid grid-cols-[30px_minmax(0,1fr)] gap-x-2">
        <div className="grid grid-rows-7 gap-[3px]">
          {DAYS.map((d) => (
            <span key={d} className="flex items-center font-mono text-[10.5px] text-ink-4">
              {d}
            </span>
          ))}
        </div>
        <div className="grid grid-rows-7 gap-[3px]" style={{ gridTemplateColumns: "repeat(24, minmax(0, 1fr))" }} onMouseLeave={() => setTip(null)}>
          {grid.map((row, d) =>
            row.map((n, h) => (
              <i
                key={`${d}-${h}`}
                className="aspect-square min-h-2 rounded-[3px] hover:outline hover:outline-1 hover:outline-ink-3"
                style={{ background: n ? `color-mix(in srgb, var(--r0) ${Math.round(18 + (n / max) * 82)}%, var(--s2))` : "var(--s2)" }}
                onMouseMove={(e) => setTip({ x: e.clientX, y: e.clientY, content: <><TipTitle>{`${DAYS[d]} ${String(h).padStart(2, "0")}:00`}</TipTitle><TipRow color="var(--r0)" label={`${int(n)} model calls`} /></> })}
              />
            )),
          )}
        </div>
        <span />
        <div className="mt-1.5 flex justify-between font-mono text-[10.5px] text-ink-4">
          {["00", "06", "12", "18", "24"].map((h) => (
            <span key={h}>{h}</span>
          ))}
        </div>
      </div>
      <ChartTip tip={tip} />
    </section>
  );
}

// ---- tools ----

function Tools({ rows }: { rows: Stats["tools"] }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  const total = rows.reduce((a, r) => a + r.n, 0);
  return (
    <section className={cn(card, "px-5 py-4")}>
      <Head title="By tool" meta={`${int(total)} calls`} right={<span className="font-mono text-[11px] text-ink-4">failed, avg time</span>} />
      {rows.length ? (
        <div className="flex flex-col gap-2">
          {rows.slice(0, 9).map((r) => (
            <div key={r.tool} className="grid grid-cols-[minmax(0,6.5em)_minmax(0,1fr)_auto] items-center gap-3">
              <span className="truncate font-mono text-xs text-ink-2">{r.tool}</span>
              <span className="flex h-2 items-center gap-2">
                <i className="block h-full rounded-full" style={{ width: `${Math.max(1.5, (r.n / max) * 100)}%`, background: kindColor(r.kind) }} />
                <span className="font-mono text-[11px] text-ink-3 tabular-nums">{int(r.n)}</span>
              </span>
              <span className="w-[86px] text-right font-mono text-[11px] text-ink-3 tabular-nums">
                <span className={r.errors ? "text-critical" : "text-ink-4"}>{r.n ? pct(r.errors / r.n, 0) : <Nil />}</span> <Sep /> <Val v={ms(r.avgMs)} />
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="py-6 text-center text-sm text-ink-3">No tool calls in this window</div>
      )}
    </section>
  );
}

// ---- per model ----

const MODEL_COLS = "grid grid-cols-[minmax(170px,1.3fr)_minmax(130px,1fr)_64px_72px_80px_64px_72px] items-center gap-4 px-5 max-md:grid-cols-[minmax(0,1fr)_auto]";

function Models({ rows }: { rows: Stats["byModel"] }) {
  const max = Math.max(1, ...rows.map(allTokens));
  return (
    <section className={cn(card, "overflow-hidden")}>
      <div className="px-5 pt-4">
        <Head title="By model" />
      </div>
      <div className={cn(MODEL_COLS, "h-8 border-y border-line-2 text-xs text-ink-3 max-md:hidden")}>
        <span>Model</span>
        <span>Tokens</span>
        <span className="text-right">Calls</span>
        <span className="text-right">Cache hits</span>
        <span className="text-right">Median call</span>
        <span className="text-right">Failed</span>
        <span className="text-right">Cost</span>
      </div>
      {rows.map((m, i) => (
        <div key={`${m.provider}/${m.model}`} className={cn(MODEL_COLS, "min-h-12 border-t border-line-2 py-2 first-of-type:border-t-0 hover:bg-s2")}>
          <span className="flex min-w-0 items-center gap-2.5">
            <i className="size-2.5 shrink-0 rounded-[3px]" style={{ background: `var(--r${i % 6})` }} />
            <span className="min-w-0">
              <span className="block truncate font-mono text-[13px]">{m.model}</span>
              <span className="block truncate text-xs text-ink-3">{m.provider}</span>
            </span>
          </span>
          <span className="flex items-center gap-2.5 max-md:hidden">
            <span className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-s3" title={KINDS.map((k) => `${k.label}: ${tokens(m[k.key])}`).join("\n")}>
              {KINDS.map((k) => (
                <i key={k.key} className="block h-full" style={{ width: `${(m[k.key] / max) * 100}%`, background: k.color }} />
              ))}
            </span>
            <span className="w-14 text-right font-mono text-xs tabular-nums">{tokens(allTokens(m))}</span>
          </span>
          <span className="text-right font-mono text-xs text-ink-2 tabular-nums max-md:hidden">{int(m.calls)}</span>
          <span className="text-right font-mono text-xs text-ink-2 tabular-nums max-md:hidden">{pct(m.hitRate, 0)}</span>
          <span className="text-right font-mono text-xs text-ink-2 tabular-nums max-md:hidden">{ms(m.medianMs)}</span>
          <span className={cn("text-right font-mono text-xs tabular-nums max-md:hidden", m.errors ? "text-critical" : "text-ink-4")}>{int(m.errors)}</span>
          <span className="text-right font-mono text-xs tabular-nums">{money(m.cost)}</span>
        </div>
      ))}
      {!rows.length && <div className="px-5 py-6 text-sm text-ink-3">No model calls in this window</div>}
    </section>
  );
}

// ---- per run ----

function TopRuns({ rows }: { rows: Stats["byRun"] }) {
  const max = Math.max(1, ...rows.map(allTokens));
  return (
    <section className={cn(card, "px-2 py-4")}>
      <div className="px-3">
        <Head title="Top runs" meta="by tokens" />
      </div>
      <div className="flex flex-col">
        {rows.slice(0, 8).map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => openRun(r.id)}
            className="grid min-h-12 cursor-pointer grid-cols-[10px_minmax(0,1fr)_minmax(80px,0.9fr)_58px_68px] items-center gap-3.5 rounded-xl border-0 bg-transparent px-3 py-1.5 text-left hover:bg-s2 max-sm:grid-cols-[10px_minmax(0,1fr)_68px]"
          >
            <i className="size-2.5 rounded-[3px]" style={{ background: `var(--r${r.hue ?? 0})` }} />
            <span className="min-w-0">
              <span className="block truncate text-[13.5px] text-ink">{runName(r)}</span>
              <span className="block truncate font-mono text-[11.5px] text-ink-3">{r.model?.split("/").slice(1).join("/")}</span>
            </span>
            <span className="flex items-center gap-2 max-sm:hidden">
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-s3">
                <i className="block h-full rounded-full" style={{ width: `${(allTokens(r) / max) * 100}%`, background: `var(--r${r.hue ?? 0})` }} />
              </span>
              <span className="w-12 text-right font-mono text-xs tabular-nums">{tokens(allTokens(r))}</span>
            </span>
            <span className="text-right font-mono text-xs text-ink-3 tabular-nums max-sm:hidden" title="Cache hit rate">
              {pct(r.hitRate, 0)}
            </span>
            <span className="text-right font-mono text-xs tabular-nums">{money(r.cost)}</span>
          </button>
        ))}
        {!rows.length && <div className="px-3 py-6 text-sm text-ink-3">No runs called a model in this window</div>}
      </div>
    </section>
  );
}

// ---- runs and reliability ----

const STATUS: [string, string, string][] = [
  ["running", "Running", "var(--good)"],
  ["preparing", "Preparing", "var(--r1)"],
  ["recovering", "Recovering", "var(--warning)"],
  ["paused", "Paused", "var(--ink-3)"],
  ["stopped", "Stopped", "var(--r5)"],
  ["failed", "Failed", "var(--critical)"],
  ["done", "Done", "var(--r2)"],
  ["triaged", "Triaged", "var(--ink-4)"],
];
const SEV: [string, string][] = [
  ["critical", "var(--sev-critical)"],
  ["high", "var(--sev-high)"],
  ["medium", "var(--sev-medium)"],
  ["low", "var(--sev-low)"],
  ["info", "var(--sev-info)"],
];
const PIXEL_KIND: Record<string, string> = {
  recover: "Recoveries",
  restart: "opencode restarts",
  continue: "Continues sent",
  limit: "Resource limits hit",
  permission: "Permissions approved",
  question: "Questions answered",
  stopped: "Stopped by Pixel",
  failed: "Runs failed",
};

function Num({ label, value, tone }: { label: string; value: ReactNode; tone?: "warn" | "bad" }) {
  return (
    <div className="min-w-0">
      <div className={cn("font-mono text-[17px] font-medium tabular-nums", tone === "bad" ? "text-critical" : tone === "warn" ? "text-warning" : "")}>{value}</div>
      <div className="truncate text-xs text-ink-3">{label}</div>
    </div>
  );
}

function RunsCard({ s }: { s: Stats }) {
  const r = s.runs;
  const p = s.providerEvents;
  const shown = STATUS.filter(([k]) => r.status[k]);
  const sevs = SEV.filter(([k]) => s.findings.bySeverity[k]);
  const sevTotal = sevs.reduce((a, [k]) => a + s.findings.bySeverity[k], 0);
  const pixel = Object.entries(s.pixelEvents).filter(([k]) => PIXEL_KIND[k]).sort((a, b) => b[1] - a[1]);
  return (
    <section className={cn(card, "flex flex-col gap-5 px-5 py-4")}>
      <div>
        <Head title="Runs" meta={`${r.total} in all, ${r.createdInWindow} new`} />
        <div className="flex h-2.5 gap-[3px] overflow-hidden rounded-full">
          {shown.map(([k, , c]) => (
            <i key={k} className="block h-full first:rounded-l-full last:rounded-r-full" style={{ flex: r.status[k], background: c }} />
          ))}
          {!shown.length && <i className="block h-full flex-1 bg-s3" />}
        </div>
        <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1">
          {shown.map(([k, label, c]) => (
            <span key={k} className="inline-flex items-center gap-1.5 text-xs text-ink-3">
              <i className="size-2 rounded-[2px]" style={{ background: c }} />
              {label}
              <span className="font-mono text-ink">{r.status[k]}</span>
            </span>
          ))}
        </div>
      </div>

      {s.findings.total > 0 && (
        <div>
          <div className="mb-2 flex items-baseline gap-2 text-[12.5px] text-ink-3">
            Findings <span className="font-mono text-ink">{s.findings.total}</span>
            <span className="ml-auto font-mono text-[11px]">
              {s.findings.byState.confirmed ?? 0} confirmed <Sep /> {r.verdicts.real ?? 0} real
            </span>
          </div>
          <div className="flex h-2.5 gap-[3px] overflow-hidden rounded-full">
            {sevs.map(([k, c]) => (
              <Tip key={k} content={`${s.findings.bySeverity[k]} ${k}`}>
                <i className="block h-full" style={{ flex: s.findings.bySeverity[k] / Math.max(1, sevTotal), background: c }} />
              </Tip>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-x-4 gap-y-4 border-t border-line-2 pt-4">
        <Num label="Failed calls" value={int(s.totals.errors)} tone={s.totals.errors ? "bad" : undefined} />
        <Num label="Rate limits" value={int(p.ratelimit ?? 0)} tone={p.ratelimit ? "warn" : undefined} />
        <Num label="Retries" value={int(p.retry ?? 0)} />
        <Num label="Continues" value={int(r.continues)} />
        <Num label="OOM restarts" value={int(r.oomRestarts)} tone={r.oomRestarts ? "warn" : undefined} />
        <Num label="Finished" value={int(r.finishedInWindow)} />
      </div>
      {pixel.length > 0 && (
        <div className="border-t border-line-2 pt-3">
          <div className="mb-1.5 text-xs text-ink-3">Pixel stepped in</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {pixel.map(([k, v]) => (
              <span key={k} className="text-[12.5px] text-ink-2">
                {PIXEL_KIND[k]} <span className="font-mono text-ink">{v}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
