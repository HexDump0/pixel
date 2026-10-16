/** Small SVG charts drawn from fleet telemetry. Colours come from CSS tokens so both themes work. */
import type { FleetRun, FleetSnapshot, Lanes } from "../lib/types.ts";
import { IconCaretDownFilled, IconCaretUpFilled } from "@tabler/icons-react";
import { distinctNames, kindColor, rate, runColor, shortName } from "../lib/fleet.ts";
import { bytes, money } from "../lib/format.ts";
import { Nil } from "./ui/bits.tsx";

export const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");

/** A centred moving average; the ends average over what they have. */
const smooth = (xs: number[], w: number) =>
  xs.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let k = i - w; k <= i + w; k++)
      if (k >= 0 && k < xs.length) {
        sum += xs[k];
        n++;
      }
    return sum / n;
  });

/** Round a chart's top up to 1, 2 or 5 × a power of ten. */
const niceTop = (v: number) => {
  const p = 10 ** Math.floor(Math.log10(Math.max(v, 1)));
  return ([1, 2, 5, 10].find((m) => m * p >= v) ?? 10) * p;
};

/**
 * Output tokens/s over the last N seconds as one stacked area, a band per run, smoothed over 5 s
 * so bursty streaming reads as a flow. The edge of each band is its own rate.
 */
export function TokenFlow({ runs, window }: { runs: FleetRun[]; window: number }) {
  const live = runs.filter((r) => r.tps.some((v) => v > 0));
  const names = distinctNames(runs);
  const W = 360;
  const H = 56;
  const series = live.map((r) => smooth(Array.from({ length: window }, (_, i) => r.tps[r.tps.length - window + i] ?? 0), 2));
  const totals = Array.from({ length: window }, (_, i) => series.reduce((a, s) => a + s[i], 0));
  const peak = Math.max(0, ...totals);
  const top = niceTop(Math.max(50, peak * 1.1));
  const X = (i: number) => (i / (window - 1)) * W;
  const Y = (v: number) => H - (v / top) * (H - 2);
  const pathOf = (vals: number[]) => vals.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join("");
  let base = Array(window).fill(0) as number[];
  const bands = series.map((s, k) => {
    const upper = base.map((b, i) => b + s[i]);
    const back = base.map((v, i) => `L${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).reverse().join("");
    base = upper;
    const c = runColor(live[k].id);
    return (
      <g key={live[k].id}>
        <path d={`${pathOf(upper)}${back}Z`} style={{ fill: c }} opacity={0.28} />
        <path d={pathOf(upper)} fill="none" style={{ stroke: c }} strokeWidth={1.3} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </g>
    );
  });
  return (
    <>
      <div className="vizbox">
        <svg className="viz" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: H }} aria-label="Output tokens per second by run">
          {[1, 2, 3].map((q) => (
            <rect key={q} x={0} y={(H * q) / 4} width={W} height={0.6} style={{ fill: "var(--grid)" }} />
          ))}
          {bands}
        </svg>
        <span className="ytop">{fmtInt(top)}/s</span>
      </div>
      <div className="scale">
        <span>-{window}s</span>
        <span>{peak ? `peak ${fmtInt(peak)}/s` : "nothing generating"}</span>
        <span>now</span>
      </div>
      <div className="legend">
        {live.length ? (
          live.map((r) => (
            <span key={r.id}>
              <i style={{ background: runColor(r.id) }} />
              {names.get(r.id)} <b>{fmtInt(rate(r.tps))}</b>
            </span>
          ))
        ) : (
          <span>No model output in the last {window}s</span>
        )}
      </div>
    </>
  );
}

const tok = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));

/** Today's tokens in one bar split by kind, and the cache hit rate against yesterday's. */
export function TokensToday({ t }: { t: FleetSnapshot["tokens"] }) {
  const parts = [
    { k: "in", v: t.input, c: "var(--t-in)", title: "Input (not cached)" },
    { k: "cache read", v: t.cacheRead, c: "var(--t-cr)", title: "Cache read" },
    { k: "write", v: t.cacheWrite, c: "var(--t-cw)", title: "Cache write" },
    { k: "out", v: t.output + t.reasoning, c: "var(--t-out)", title: "Output and reasoning" },
  ];
  const total = t.total || 1;
  let x = 0;
  const diff = t.hitRate != null && t.yesterday.hitRate != null ? Math.round((t.hitRate - t.yesterday.hitRate) * 100) : null;
  return (
    <>
      <svg className="viz" viewBox="0 0 200 30" preserveAspectRatio="none" style={{ height: 30 }} aria-label="Tokens today by kind">
        <rect x={0} y={9} width={200} height={12} rx={2} style={{ fill: "var(--meter)" }} />
        {t.total > 0 &&
          parts.map((p) => {
            const w = (p.v / total) * 200;
            const el = (
              <rect key={p.k} x={x} y={9} width={Math.max(0, w - 1)} height={12} style={{ fill: p.c }} opacity={0.85}>
                <title>{`${p.title}: ${fmtInt(p.v)}`}</title>
              </rect>
            );
            x += w;
            return el;
          })}
      </svg>
      <div className="legend">
        {parts.map((p) => (
          <span key={p.k} title={p.title}>
            <i style={{ background: p.c }} />
            {p.k} <b>{tok(p.v)}</b>
          </span>
        ))}
        {diff != null && (
          <span style={{ color: diff >= 0 ? "var(--ok)" : "var(--warn)" }} title="Cache hit rate today vs all of yesterday up to this time">
            {diff >= 0 ? <IconCaretUpFilled size={12} className="inline align-middle" /> : <IconCaretDownFilled size={12} className="inline align-middle" />} {Math.abs(diff)} pts vs yesterday
          </span>
        )}
      </div>
    </>
  );
}

/** One bar split by run (plus Pixel itself) against the shared memory limit. */
export function MemorySplit({ snap }: { snap: FleetSnapshot }) {
  const total = snap.memory.total || 1;
  const parts = [
    ...snap.runs.filter((r) => r.mem.used).map((r) => ({ name: distinctNames(snap.runs).get(r.id)!, v: r.mem.used!, c: runColor(r.id) })),
    { name: "pixel", v: snap.memory.pixel, c: "var(--fg2)" },
  ];
  let x = 0;
  return (
    <>
      <svg className="viz" viewBox="0 0 200 30" preserveAspectRatio="none" style={{ height: 30 }} aria-label="Memory by run">
        <rect x={0} y={9} width={200} height={12} rx={2} style={{ fill: "var(--meter)" }} />
        {/* Everything else using memory (other processes, page cache) shows as a faint segment. */}
        <rect x={0} y={9} width={Math.min(200, (snap.memory.used / total) * 200)} height={12} rx={2} style={{ fill: "var(--fg3)" }} opacity={0.18} />
        {parts.map((p) => {
          const w = (p.v / total) * 200;
          const el = <rect key={p.name} x={x} y={9} width={Math.max(0, w - 1)} height={12} style={{ fill: p.c }} opacity={0.85} />;
          x += w;
          return el;
        })}
        <rect x={160} y={5} width={1} height={20} style={{ fill: "var(--warn)" }} opacity={0.7} />
      </svg>
      <div className="legend">
        {parts.map((p) => (
          <span key={p.name}>
            <i style={{ background: p.c }} />
            {p.name} <b>{bytes(p.v)}</b>
          </span>
        ))}
        <span>
          <i style={{ background: "var(--warn)" }} />
          80%
        </span>
      </div>
    </>
  );
}

/**
 * Spend per hour since midnight, stacked by run (the four biggest, then everyone else), and the
 * rest of the day as faint bars at the last hour's rate: what "projected" assumes.
 */
export function SpendBars({ spend, runs }: { spend: FleetSnapshot["spend"]; runs: FleetRun[] }) {
  const W = 240;
  const H = 34;
  const bw = W / 24;
  const names = distinctNames(runs);
  const hourly = Array.from({ length: spend.hours }, (_, h) => spend.runs.reduce((a, r) => a + r.hourly[h], 0));
  const top = Math.max(spend.perHour, ...hourly, 0.0001) * 1.08;
  const Y = (v: number) => (v / top) * (H - 2);
  const colorOf = (id: string | null) => (id ? runColor(id) : "var(--fg3)");
  return (
    <>
      <svg className="viz" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: H }} aria-label="Spend per hour today">
        <rect x={0} y={H - 0.6} width={W} height={0.6} style={{ fill: "var(--grid)" }} />
        {hourly.map((_, h) => {
          let y = H;
          return spend.runs.map((r) => {
            const v = r.hourly[h];
            if (!v) return null;
            const hh = Y(v);
            y -= hh;
            return <rect key={`${r.id}-${h}`} x={h * bw + 1} y={y} width={bw - 2} height={Math.max(0.6, hh - 0.4)} style={{ fill: colorOf(r.id) }} opacity={h === spend.hours - 1 ? 0.95 : 0.7} />;
          });
        })}
        {spend.perHour > 0 &&
          Array.from({ length: 24 - spend.hours }, (_, k) => {
            const h = spend.hours + k;
            return <rect key={`p${h}`} x={h * bw + 1} y={H - Y(spend.perHour)} width={bw - 2} height={Y(spend.perHour)} style={{ fill: "var(--fg3)" }} opacity={0.14} />;
          })}
      </svg>
      <div className="scale">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
      <div className="legend">
        {spend.runs.slice(0, 3).map((r) => (
          <span key={r.id ?? "other"}>
            <i style={{ background: colorOf(r.id) }} />
            {r.id ? (names.get(r.id) ?? shortName(r.id)) : "other"} <b>{money(r.cost)}</b>
          </span>
        ))}
        <span>
          <b>{money(spend.perHour)}</b>/h now
        </span>
        <span>
          yesterday <b>{money(spend.yesterday)}</b> by now
        </span>
      </div>
    </>
  );
}

/** The last 30 minutes in 30-second ticks: height = how busy, colour = what kind of work, red = Pixel stepped in. */
export function Barcode({ activity, max }: { activity: FleetRun["activity"]; max: number }) {
  if (!activity.some((b) => b.n || b.alert)) return <span className="muted">idle</span>;
  const w = 100 / activity.length;
  return (
    <svg className="barcode" viewBox="0 0 100 18" preserveAspectRatio="none" aria-label="Activity in the last 30 minutes">
      {activity.map((b, i) => {
        if (b.alert) return <rect key={i} x={i * w} y={0} width={w} height={18} style={{ fill: "var(--bad)" }} />;
        if (!b.n) return <rect key={i} x={i * w + 0.3} y={17} width={w - 0.6} height={1} style={{ fill: "var(--meter)" }} />;
        const v = Math.min(1, b.n / Math.max(1, max));
        const h = 3 + v * 15;
        return <rect key={i} x={i * w + 0.3} y={18 - h} width={w - 0.6} height={h} style={{ fill: kindColor(b.k) }} opacity={0.45 + v * 0.55} />;
      })}
    </svg>
  );
}

export const KIND_LEGEND: [string, string][] = [
  ["shell", "shell"],
  ["read", "read"],
  ["edit", "edit"],
  ["task", "subagents"],
  ["web", "web"],
];

/** One lane per agent: tool calls as segments, Pixel's interventions as red ticks, finished subagents as dots. */
export function LanesChart({ data }: { data: Lanes }) {
  if (!data.lanes.length || data.to <= data.from) return <span className="muted text-xs">No activity in this window.</span>;
  const span = data.to - data.from;
  const x = (t: number) => Math.max(0, Math.min(200, ((t - data.from) / span) * 200));
  const minutes = Math.round(span / 60_000);
  return (
    <div className="lanes">
      {data.lanes.map((l) => (
        <div className="lane" key={l.session}>
          <span className="ln" title={l.title}>
            {l.title}
          </span>
          <svg viewBox="0 0 200 12" preserveAspectRatio="none">
            <rect x={0} y={5.5} width={200} height={1} style={{ fill: "var(--line)" }} />
            {l.segs.map(([a, b, k], i) => (
              <rect key={i} x={x(a)} y={2} width={Math.max(0.8, x(b) - x(a) - 0.4)} height={8} rx={1} style={{ fill: kindColor(k) }} opacity={k === "task" ? 0.55 : 0.9} />
            ))}
            {l.marks.map(([t, kind], i) =>
              kind === "done" ? (
                <circle key={i} cx={x(t)} cy={6} r={2.4} style={{ fill: "var(--ok)" }} />
              ) : kind === "interrupted" ? (
                <circle key={i} cx={x(t)} cy={6} r={2.4} style={{ fill: "var(--warn)" }} />
              ) : (
                <rect key={i} x={x(t) - 0.8} y={0} width={1.6} height={12} style={{ fill: kind === "continue" ? "var(--warn)" : "var(--bad)" }} />
              ),
            )}
          </svg>
        </div>
      ))}
      <div className="lane axis">
        <span />
        <div>
          <span>-{minutes}m</span>
          <span>-{Math.round(minutes / 2)}m</span>
          <span>now</span>
        </div>
      </div>
      <div className="legend" style={{ marginTop: 2 }}>
        {KIND_LEGEND.map(([k, label]) => (
          <span key={k}>
            <i style={{ background: kindColor(k) }} />
            {label}
          </span>
        ))}
        <span>
          <i style={{ background: "var(--bad)" }} />
          recovery
        </span>
      </div>
    </div>
  );
}

/** Two-row CPU / memory meter for table cells. */
export function MiniMeters({ run }: { run: FleetRun }) {
  if (run.cpu == null && run.mem.used == null) return <Nil />;
  const memPct = run.mem.used && run.mem.total ? run.mem.used / run.mem.total : 0;
  return (
    <>
      <div className="meter">
        <b>
          <i style={{ width: `${Math.min(100, run.cpu ?? 0)}%` }} />
        </b>
        <span>{run.cpu == null ? <Nil /> : `${Math.round(run.cpu)}%`}</span>
      </div>
      <div className="meter">
        <b>
          <i className={memPct > 0.8 ? "hot" : ""} style={{ width: `${Math.min(100, memPct * 100)}%` }} />
        </b>
        <span>{run.mem.used == null ? <Nil /> : bytes(run.mem.used).replace(" ", "")}</span>
      </div>
    </>
  );
}
