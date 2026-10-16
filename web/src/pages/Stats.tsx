/** Stats: token usage and cache hit rate over time, per model and per run, tool calls, reliability, and Pixel's own health. */
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api.ts";
import { useAsync } from "../lib/hooks.ts";
import { Link, navigate, useLocation } from "../lib/router.tsx";
import { bytes, duration, money, tokens } from "../lib/format.ts";
import { kindColor } from "../lib/fleet.ts";
import type { Stats } from "../lib/types.ts";
import { Badge, Button, Card, Empty, ErrorBox, PageHeader, Stat } from "../components/ui.tsx";
import { fmtInt } from "../components/viz.tsx";

type Totals = Stats["totals"];
type Bucket = Stats["series"][number];

const WINDOWS = [
  { days: 1, label: "24h" },
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
];

/** Token kinds in stack order (bottom up). Colours are the per-run chart hues, fixed per kind. */
const KINDS = [
  { key: "cacheRead", label: "Cache read", color: "var(--r0)" },
  { key: "input", label: "Input", color: "var(--r1)" },
  { key: "cacheWrite", label: "Cache write", color: "var(--r2)" },
  { key: "output", label: "Output", color: "var(--r5)" },
] as const;

const pct = (v: number | null | undefined, digits = 1) => (v == null ? "–" : `${(v * 100).toFixed(digits)}%`);
const ms = (n: number | null | undefined) => (n == null ? "–" : n < 1000 ? `${Math.round(n)} ms` : n < 60_000 ? `${(n / 1000).toFixed(1)} s` : duration(n));
const allTokens = (t: Totals) => t.input + t.output + t.cacheRead + t.cacheWrite;
const CHECK_DOT = { ok: "running", warn: "recovering", bad: "failed" } as const;

function bucketLabel(t: number, size: number) {
  const d = new Date(t);
  if (size < 6 * 3600_000) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (size < 24 * 3600_000) return d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

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
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <PageHeader
        title="Stats"
        subtitle="Tokens, cache hits, cost and reliability across every run, plus how Pixel itself is doing."
        actions={
          <>
            <span className="tabs" style={{ gap: 0 }}>
              {WINDOWS.map((w) => (
                <button key={w.days} className={`tab ${days === w.days ? "on" : ""}`} onClick={() => navigate(w.days === 7 ? "/stats" : `/stats?days=${w.days}`, true)}>
                  {w.label}
                </button>
              ))}
            </span>
            <Button small onClick={stats.reload}>
              Refresh
            </Button>
          </>
        }
      />
      {!s ? <ErrorBox error={stats.error} /> : <Body s={s} />}
    </div>
  );
}

function Body({ s }: { s: Stats }) {
  const t = s.totals;
  const a = s.allTime;
  const w = WINDOWS.find((x) => x.days === s.window.days)?.label ?? `${s.window.days}d`;
  return (
    <>
      <Health checks={s.system.checks} />

      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-3 2xl:grid-cols-6">
        <Stat label={`Tokens · ${w}`} value={tokens(allTokens(t))} hint={`${tokens(allTokens(a))} all time`} />
        <Stat label={`Cache hit rate · ${w}`} value={pct(t.hitRate)} hint={`${pct(a.hitRate)} all time`} />
        <Stat
          label={`Cost · ${w}`}
          value={money(t.cost)}
          hint={s.savings.pricedTokens ? `≈ ${money(s.savings.saved)} saved by cache · ${money(a.cost)} all time` : `${money(a.cost)} all time`}
        />
        <Stat label={`Model calls · ${w}`} value={fmtInt(t.calls)} hint={`${fmtInt(t.errors)} errors (${pct(t.calls ? t.errors / t.calls : null)})`} />
        <Stat label={`Agent time · ${w}`} value={duration(s.runs.agentMs)} hint={`${s.runs.sessions} sessions · ${s.runs.subagents} subagents`} />
        <Stat label={`Runs · ${w}`} value={`${s.runs.createdInWindow} new`} hint={`${s.runs.finishedInWindow} finished · ${s.runs.total} total`} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card title="Token usage">
          <TokenBars series={s.series} bucketMs={s.window.bucketMs} />
        </Card>
        <Card title="Token mix">
          <TokenMix t={t} />
        </Card>
      </div>

      <Card title="Cache hit rate">
        <HitRate series={s.series} bucketMs={s.window.bucketMs} />
      </Card>

      <Card title={`By model · ${w}`}>
        <ModelTable rows={s.byModel} />
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title={`Top runs by tokens · ${w}`}>
          <RunTable rows={s.byRun} />
        </Card>
        <Card title={`Tool calls · ${w}`}>
          <Tools rows={s.tools} />
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Runs">
          <Runs s={s} />
        </Card>
        <Card title={`Reliability · ${w}`}>
          <Reliability s={s} />
        </Card>
        <Card title="Pixel" actions={<Link to="/system" className="btn btn-sm">System page</Link>}>
          <SystemFacts s={s} />
        </Card>
      </div>
    </>
  );
}

// ---- health ----

function Health({ checks }: { checks: Stats["system"]["checks"] }) {
  const worst = checks.some((c) => c.state === "bad") ? "bad" : checks.some((c) => c.state === "warn") ? "warn" : "ok";
  return (
    <section className="card" style={{ padding: "10px 14px" }}>
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <span className={`dot ${CHECK_DOT[worst]}`} />
        {worst === "ok" ? "All systems normal" : worst === "warn" ? "Needs attention" : "Something is wrong"}
      </div>
      <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 xl:grid-cols-4">
        {checks.map((c) => (
          <div key={c.name} className="flex min-w-0 items-start gap-2 text-sm">
            <span className={`dot ${CHECK_DOT[c.state]}`} style={{ marginTop: 6, flex: "none" }} title={c.state} />
            <div className="min-w-0">
              <div>
                {c.name} <span className="muted text-xs">{c.state === "ok" ? "ok" : c.state === "warn" ? "warning" : "problem"}</span>
              </div>
              <div className="muted text-xs break-words">{c.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---- charts ----

function Tooltip({ x, children }: { x: number; children: ReactNode }) {
  return (
    <div
      className="card"
      style={{ position: "absolute", top: 0, left: `${Math.min(Math.max(x * 100, 0), 100)}%`, transform: `translateX(${x > 0.6 ? "calc(-100% - 10px)" : "10px"})`, padding: "6px 9px", fontSize: 12, pointerEvents: "none", zIndex: 2, whiteSpace: "nowrap", boxShadow: "0 4px 14px rgba(0,0,0,.12)" }}
    >
      {children}
    </div>
  );
}

function Legend() {
  return (
    <div className="legend">
      {KINDS.map((k) => (
        <span key={k.key}>
          <i style={{ background: k.color }} />
          {k.label}
        </span>
      ))}
      <span>output includes reasoning</span>
    </div>
  );
}

/** Stacked bars per bucket: cache read, input, cache write, output. */
function TokenBars({ series, bucketMs }: { series: Bucket[]; bucketMs: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const H = 180;
  const n = series.length;
  const W = n * 12;
  const peak = Math.max(0, ...series.map(allTokens));
  if (!peak) return <Empty>No model calls in this window.</Empty>;
  const bw = Math.max(2, 12 - (n > 60 ? 3 : 4));
  const h = hover != null ? series[hover] : null;
  return (
    <div>
      <div style={{ position: "relative" }}>
        <svg
          className="viz"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          style={{ height: H }}
          role="img"
          aria-label="Tokens per time bucket, stacked by kind"
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setHover(Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n))));
          }}
          onMouseLeave={() => setHover(null)}
        >
          {[1, 2, 3].map((q) => (
            <rect key={q} x={0} y={(H * q) / 4} width={W} height={0.6} style={{ fill: "var(--grid)" }} />
          ))}
          {hover != null && <rect x={hover * 12} y={0} width={12} height={H} style={{ fill: "var(--hover)" }} />}
          {series.map((b, i) => {
            let y = H;
            return KINDS.map((k) => {
              const v = k.key === "output" ? b.output + b.reasoning : b[k.key];
              if (!v) return null;
              const hh = (v / peak) * (H - 4);
              y -= hh;
              // 1px gap between segments so stacked fills stay separable.
              return <rect key={`${i}-${k.key}`} x={i * 12 + (12 - bw) / 2} y={y} width={bw} height={Math.max(0.5, hh - 1)} style={{ fill: k.color }} />;
            });
          })}
        </svg>
        {h && hover != null && (
          <Tooltip x={(hover + 0.5) / n}>
            <div className="mb-1 font-medium">{bucketLabel(h.t, bucketMs)}</div>
            {[...KINDS].reverse().map((k) => (
              <div key={k.key} className="flex items-center justify-between gap-4">
                <span className="flex items-center gap-1.5">
                  <i style={{ width: 7, height: 7, background: k.color, display: "inline-block", borderRadius: 1 }} />
                  {k.label}
                </span>
                <span className="num">{tokens(k.key === "output" ? h.output + h.reasoning : h[k.key])}</span>
              </div>
            ))}
            <div className="muted mt-1 num">
              {fmtInt(h.calls)} calls · hit {pct(h.hitRate)} · {money(h.cost)}
            </div>
          </Tooltip>
        )}
      </div>
      <div className="scale" style={{ marginTop: 4 }}>
        <span>{bucketLabel(series[0].t, bucketMs)}</span>
        <span>peak {tokens(peak)} per {duration(bucketMs).replace(/ 0m$/, "")}</span>
        <span>now</span>
      </div>
      <div style={{ marginTop: 8 }}>
        <Legend />
      </div>
    </div>
  );
}

/** Share of each token kind in the window, as one bar plus a breakdown. */
function TokenMix({ t }: { t: Totals }) {
  const total = allTokens(t);
  if (!total) return <Empty>No tokens yet.</Empty>;
  const parts = KINDS.map((k) => ({ ...k, v: t[k.key] }));
  return (
    <div className="flex flex-col gap-3">
      <div style={{ display: "flex", height: 12, borderRadius: 3, overflow: "hidden", gap: 2 }}>
        {parts.map((p) => (p.v ? <div key={p.key} title={`${p.label}: ${tokens(p.v)}`} style={{ flex: p.v, background: p.color, minWidth: 2 }} /> : null))}
      </div>
      <table className="w-full text-sm">
        <tbody>
          {parts.map((p) => (
            <tr key={p.key}>
              <td className="py-0.5">
                <span className="flex items-center gap-1.5">
                  <i style={{ width: 8, height: 8, background: p.color, display: "inline-block", borderRadius: 1 }} />
                  {p.label}
                </span>
              </td>
              <td className="num py-0.5 text-right">{tokens(p.v)}</td>
              <td className="num muted py-0.5 text-right">{pct(p.v / total)}</td>
            </tr>
          ))}
          <tr>
            <td className="muted py-0.5 pl-3.5">of which reasoning</td>
            <td className="num py-0.5 text-right">{tokens(t.reasoning)}</td>
            <td className="num muted py-0.5 text-right">{t.output ? `${pct(t.reasoning / t.output, 0)} of output` : ""}</td>
          </tr>
        </tbody>
      </table>
      <div className="muted text-xs">
        Hit rate = cache read ÷ (input + cache read + cache write). Providers without prompt caching show 0%. Output per call averages {tokens(t.calls ? Math.round((t.output + t.reasoning) / t.calls) : 0)}; prompt per call{" "}
        {tokens(t.calls ? Math.round((t.input + t.cacheRead + t.cacheWrite) / t.calls) : 0)}.
      </div>
    </div>
  );
}

/** Cache hit rate per bucket, 0–100%; buckets without calls are gaps. */
function HitRate({ series, bucketMs }: { series: Bucket[]; bucketMs: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const H = 120;
  const n = series.length;
  const W = 600;
  const x = (i: number) => ((i + 0.5) / n) * W;
  const y = (v: number) => 4 + (1 - v) * (H - 8);
  if (!series.some((b) => b.hitRate != null)) return <Empty>No prompt tokens in this window.</Empty>;
  let d = "";
  series.forEach((b, i) => {
    if (b.hitRate == null) return;
    d += `${i && series[i - 1].hitRate != null ? "L" : "M"}${x(i).toFixed(1)},${y(b.hitRate).toFixed(1)}`;
  });
  const h = hover != null ? series[hover] : null;
  return (
    <div>
      <div style={{ position: "relative", display: "grid", gridTemplateColumns: "34px minmax(0,1fr)" }}>
        <div className="num muted" style={{ fontSize: 10, display: "flex", flexDirection: "column", justifyContent: "space-between", height: H }}>
          <span>100%</span>
          <span>50%</span>
          <span>0%</span>
        </div>
        <div style={{ position: "relative" }}>
          <svg
            className="viz"
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            style={{ height: H }}
            role="img"
            aria-label="Cache hit rate over time"
            onMouseMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setHover(Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n))));
            }}
            onMouseLeave={() => setHover(null)}
          >
            {[0, 0.5, 1].map((q) => (
              <line key={q} x1={0} x2={W} y1={y(q)} y2={y(q)} strokeWidth={1} vectorEffect="non-scaling-stroke" style={{ stroke: "var(--grid)" }} />
            ))}
            <path d={d} fill="none" strokeWidth={2} vectorEffect="non-scaling-stroke" style={{ stroke: "var(--r0)" }} />
            {/* Lone buckets have no line segment; mark them so they don't disappear. */}
            {series.map((b, i) =>
              b.hitRate != null && series[i - 1]?.hitRate == null && series[i + 1]?.hitRate == null ? <rect key={i} x={x(i) - W / n / 4} y={y(b.hitRate) - 1.5} width={W / n / 2} height={3} rx={1} style={{ fill: "var(--r0)" }} /> : null,
            )}
            {h && hover != null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" style={{ stroke: "var(--fg3)" }} />}
          </svg>
          {h && hover != null && (
            <Tooltip x={(hover + 0.5) / n}>
              <div className="font-medium">{bucketLabel(h.t, bucketMs)}</div>
              <div className="num">hit rate {pct(h.hitRate)}</div>
              <div className="muted num">
                {tokens(h.cacheRead)} cached of {tokens(h.input + h.cacheRead + h.cacheWrite)} prompt
              </div>
            </Tooltip>
          )}
        </div>
      </div>
      <div className="scale" style={{ marginTop: 4, paddingLeft: 34 }}>
        <span>{bucketLabel(series[0].t, bucketMs)}</span>
        <span>now</span>
      </div>
    </div>
  );
}

function HitMeter({ v }: { v: number | null }) {
  return (
    <span className="meter" style={{ gridTemplateColumns: "42px 44px" }}>
      <b>
        <i style={{ width: `${(v ?? 0) * 100}%`, background: "var(--r0)" }} />
      </b>
      <span>{pct(v)}</span>
    </span>
  );
}

// ---- tables ----

function ModelTable({ rows }: { rows: Stats["byModel"] }) {
  if (!rows.length) return <Empty>No model calls in this window.</Empty>;
  return (
    <div className="tablewrap">
      <table className="runs" style={{ minWidth: 900 }}>
        <thead>
          <tr>
            <th className="th">Provider / model</th>
            <th className="th r">Calls</th>
            <th className="th r">Input</th>
            <th className="th r">Cache read</th>
            <th className="th r">Cache write</th>
            <th className="th r">Output</th>
            <th className="th r">Hit rate</th>
            <th className="th r">Median call</th>
            <th className="th r">Errors</th>
            <th className="th r">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={`${m.provider}/${m.model}`} style={{ cursor: "default" }}>
              <td className="td mono" style={{ fontSize: 12.5 }}>
                <span className="muted">{m.provider}/</span>
                {m.model}
              </td>
              <td className="td r num">{fmtInt(m.calls)}</td>
              <td className="td r num">{tokens(m.input)}</td>
              <td className="td r num">{tokens(m.cacheRead)}</td>
              <td className="td r num">{tokens(m.cacheWrite)}</td>
              <td className="td r num">{tokens(m.output + m.reasoning)}</td>
              <td className="td r">
                <HitMeter v={m.hitRate} />
              </td>
              <td className="td r num">{ms(m.medianMs)}</td>
              <td className="td r num" style={{ color: m.errors ? "var(--bad)" : undefined }}>
                {m.errors}
              </td>
              <td className="td r num">{money(m.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunTable({ rows }: { rows: Stats["byRun"] }) {
  if (!rows.length) return <Empty>No runs used tokens in this window.</Empty>;
  return (
    <div className="tablewrap">
      <table className="runs" style={{ minWidth: 520 }}>
        <thead>
          <tr>
            <th className="th">Run</th>
            <th className="th r">Tokens</th>
            <th className="th r">Hit rate</th>
            <th className="th r">Calls</th>
            <th className="th r">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} onClick={() => navigate(`/runs/${encodeURIComponent(r.id)}`)}>
              <td className="td">
                <div className="flex items-center gap-2">
                  <span className={`dot ${r.status ?? ""}`} title={r.status ?? "deleted"} />
                  <div className="min-w-0">
                    <div className="truncate font-medium" style={{ maxWidth: 200 }}>
                      {r.id}
                    </div>
                    <div className="muted truncate text-xs" style={{ maxWidth: 200 }}>
                      {r.model ?? ""}
                    </div>
                  </div>
                </div>
              </td>
              <td className="td r num">{tokens(allTokens(r))}</td>
              <td className="td r">
                <HitMeter v={r.hitRate} />
              </td>
              <td className="td r num">{fmtInt(r.calls)}</td>
              <td className="td r num">{money(r.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Tools({ rows }: { rows: Stats["tools"] }) {
  if (!rows.length) return <Empty>No tool calls in this window.</Empty>;
  const top = rows.slice(0, 14);
  const rest = rows.slice(14);
  const max = top[0].n;
  const total = rows.reduce((n, r) => n + r.n, 0);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="muted mb-1 flex justify-between text-xs">
        <span>{fmtInt(total)} calls</span>
        <span>calls · errors · avg time</span>
      </div>
      {top.map((t) => (
        <div key={t.tool} className="grid items-center gap-2 text-sm" style={{ gridTemplateColumns: "110px minmax(0,1fr) 150px" }}>
          <span className="mono truncate" style={{ fontSize: 12 }} title={`${t.tool} (${t.kind})`}>
            {t.tool}
          </span>
          <span style={{ height: 8, background: "var(--meter)", borderRadius: 2, overflow: "hidden" }}>
            <i style={{ display: "block", height: "100%", width: `${(t.n / max) * 100}%`, background: kindColor(t.kind), borderRadius: 2 }} />
          </span>
          <span className="num text-right text-xs">
            {fmtInt(t.n)} · <span style={{ color: t.errors ? "var(--bad)" : undefined }}>{pct(t.n ? t.errors / t.n : 0, 0)}</span> · {ms(t.avgMs)}
          </span>
        </div>
      ))}
      {rest.length > 0 && (
        <div className="muted text-xs">
          + {rest.length} more tools, {fmtInt(rest.reduce((n, r) => n + r.n, 0))} calls
        </div>
      )}
      <div className="legend" style={{ marginTop: 6 }}>
        {["shell", "read", "edit", "task", "web", "other"].map((k) => (
          <span key={k}>
            <i style={{ background: kindColor(k) }} />
            {k}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---- facts ----

function Facts({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-sm">
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="muted">{k}</dt>
          <dd className="num text-right">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Runs({ s }: { s: Stats }) {
  const r = s.runs;
  const order = ["preparing", "running", "recovering", "paused", "stopped", "failed", "done", "triaged"];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {order.filter((k) => r.status[k]).map((k) => (
          <span key={k} className="flex items-center gap-1 text-sm">
            <Badge value={k} /> <span className="num">{r.status[k]}</span>
          </span>
        ))}
        {!r.total && <span className="muted text-sm">No runs yet.</span>}
      </div>
      <Facts
        rows={[
          ["Runs, all time", r.total],
          ["Continues sent", fmtInt(r.continues)],
          ["OOM restarts", fmtInt(r.oomRestarts)],
          ["Sessions in window", `${r.sessions} (${r.subagents} subagents)`],
          ...Object.entries(r.verdicts).map(([k, v]) => [`Findings triaged ${({ real: "real", not_bug: "not a bug", duplicate: "duplicate" } as Record<string, string>)[k] ?? k}`, v] as [string, number]),
        ]}
      />
    </div>
  );
}

const PIXEL_KIND: Record<string, string> = {
  recover: "Recoveries",
  restart: "opencode restarts",
  continue: "Continues sent",
  limit: "Resource limits hit",
  permission: "Permissions auto-approved",
  question: "Questions answered",
  stopped: "Runs stopped by Pixel",
  failed: "Runs failed",
};

function Reliability({ s }: { s: Stats }) {
  const p = s.providerEvents;
  const pixel = Object.entries(s.pixelEvents).filter(([k]) => PIXEL_KIND[k]).sort((a, b) => b[1] - a[1]);
  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="eyebrow mb-1">Providers</div>
        <Facts
          rows={[
            ["Errors", <span style={{ color: p.error ? "var(--bad)" : undefined }}>{fmtInt(p.error ?? 0)}</span>],
            ["Rate limits", <span style={{ color: p.ratelimit ? "var(--warn)" : undefined }}>{fmtInt(p.ratelimit ?? 0)}</span>],
            ["Retries", fmtInt(p.retry ?? 0)],
            ["Failed calls", `${fmtInt(s.totals.errors)} of ${fmtInt(s.totals.calls)}`],
          ]}
        />
      </div>
      <div>
        <div className="eyebrow mb-1">Pixel stepped in</div>
        {pixel.length ? <Facts rows={pixel.map(([k, v]) => [PIXEL_KIND[k], fmtInt(v)])} /> : <div className="muted text-sm">Nothing in this window.</div>}
      </div>
    </div>
  );
}

function SystemFacts({ s }: { s: Stats }) {
  const { pixel, host, db } = s.system;
  return (
    <div className="flex flex-col gap-3">
      <Facts
        rows={[
          ["Pixel uptime", duration(pixel.uptimeMs)],
          ["Pixel memory", `${bytes(pixel.rss)} (heap ${bytes(pixel.heapUsed)})`],
          ["Runtime · Bun", `${pixel.runtime} · ${pixel.bun}`],
          ["Host", `${host.cpus} CPUs · up ${duration(host.uptimeMs)}`],
          ["Load", host.load.map((l) => l.toFixed(2)).join(" ")],
          ["Host memory", `${bytes(host.memTotal - host.memFree)} / ${bytes(host.memTotal)}`],
          ["Data disk", host.disk ? `${bytes(host.disk.total - host.disk.free)} / ${bytes(host.disk.total)}` : "–"],
          ["Database", `${bytes(db.bytes)} + ${bytes(db.walBytes)} WAL`],
        ]}
      />
      <div>
        <div className="eyebrow mb-1">Rows</div>
        <Facts rows={Object.entries(db.rows).map(([k, v]) => [<span className="mono text-xs">{k}</span>, fmtInt(v)])} />
      </div>
    </div>
  );
}
