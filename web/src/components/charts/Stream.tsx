/**
 * Output tokens/s per run over the last 30 minutes as a streamgraph (silhouette baseline), labelled at its
 * right edge in each run's colour (no legend), with what happened marked on the streams: findings (dot in
 * the severity colour), questions (amber diamond) and crashes (amber tick). Hover a stream to isolate it;
 * click it to open the run.
 */
import { useId, useMemo, useState } from "react";
import { area, curveBasis, line, stack, stackOffsetSilhouette } from "d3-shape";
import { ChartTip, TipRow, TipTitle, useSize, type TipState } from "./common.tsx";
import { age } from "../../lib/health.ts";
import { Sep } from "../ui/bits.tsx";

export const STREAM_N = 180;
export const STREAM_STEP = 10_000;

export interface StreamRun {
  id: string;
  name: string;
  hue: number | null;
  /** STREAM_N buckets of STREAM_STEP, oldest first. */
  series: number[];
}

export interface StreamMark {
  run: string;
  at: number;
  kind: "find" | "ask" | "crash";
  sev?: string | null;
  text: string;
}

const SEV_COLOR: Record<string, string> = { critical: "var(--sev-high)", high: "var(--sev-high)", medium: "var(--sev-medium)", low: "var(--sev-low)", info: "var(--sev-info)" };
const hueVar = (h: number | null) => `var(--r${h ?? 0})`;

export function Stream({ runs, marks, onOpen }: { runs: StreamRun[]; marks: StreamMark[]; onOpen: (id: string) => void }) {
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const gid = useId().replace(/:/g, "");
  const [hover, setHover] = useState<{ i: number; run: string | null } | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);

  const gut = Math.min(150, w * 0.24);
  const T = 50;
  const B = 22;
  const pw = Math.max(0, w - gut);
  const ph = Math.max(0, h - T - B);

  const geo = useMemo(() => {
    const live = runs.filter((r) => r.series.some((v) => v > 0.5));
    const rows = Array.from({ length: STREAM_N }, (_, i) => Object.fromEntries(live.map((r) => [r.id, r.series[i] ?? 0])));
    const layers = stack<Record<string, number>>().keys(live.map((r) => r.id)).offset(stackOffsetSilhouette)(rows);
    const sums = rows.map((row) => Object.values(row).reduce((a, b) => a + b, 0));
    const maxSum = Math.max(120, ...sums) * 1.1;
    return { live, layers, sums, maxSum };
  }, [runs]);

  const k = ph / geo.maxSum;
  const mid = T + ph / 2;
  const X = (i: number) => (i / (STREAM_N - 1)) * pw;
  const Y = (v: number) => mid - v * k;
  // Only where the run is generating, so an idle stream doesn't leave a line through the middle.
  const on = (d: [number, number]) => d[1] - d[0] > 0.5;
  const areaPath = area<[number, number]>()
    .defined(on)
    .x((_, i) => X(i))
    .y0((d) => Y(d[0]))
    .y1((d) => Y(d[1]))
    .curve(curveBasis);
  const topPath = line<[number, number]>()
    .defined(on)
    .x((_, i) => X(i))
    .y((d) => Y(d[1]))
    .curve(curveBasis);
  const now = Date.now();
  const byId = new Map(geo.live.map((r, j) => [r.id, { run: r, layer: geo.layers[j] }]));

  // labels at the right edge, spread so they never overlap
  const labels = geo.layers
    .map((ly, j) => ({ run: geo.live[j], y: (Y(ly[STREAM_N - 1][0]) + Y(ly[STREAM_N - 1][1])) / 2, v: geo.live[j].series[STREAM_N - 1] }))
    .filter((l) => l.v >= 1)
    .sort((a, b) => a.y - b.y);
  const ys = labels.map((l) => l.y);
  for (let it = 0; it < 20; it++)
    for (let i = 1; i < ys.length; i++)
      if (ys[i] - ys[i - 1] < 28) {
        const d = (28 - (ys[i] - ys[i - 1])) / 2;
        ys[i - 1] -= d;
        ys[i] += d;
      }
  const lx = pw + 14;
  const hot = hover?.run ?? null;
  const dim = (id: string) => (hot && hot !== id ? 0.3 : 1);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - b.left;
    const my = e.clientY - b.top;
    if (mx < 0 || mx > pw || !pw) {
      setHover(null);
      setTip(null);
      return;
    }
    const i = Math.max(0, Math.min(STREAM_N - 1, Math.round((mx / pw) * (STREAM_N - 1))));
    let run: string | null = null;
    geo.layers.forEach((ly, j) => {
      if (geo.live[j].series[i] > 0.5 && my <= Y(ly[i][0]) + 2 && my >= Y(ly[i][1]) - 2) run = geo.live[j].id;
    });
    setHover({ i, run });
    const secs = Math.round(((STREAM_N - 1 - i) * STREAM_STEP) / 1000);
    const when = secs < 60 ? (secs ? `${secs}s ago` : "now") : `${Math.round(secs / 60)} min ago`;
    const rows = geo.live.filter((r) => r.series[i] >= 1).reverse();
    setTip(
      rows.length
        ? {
            x: e.clientX,
            y: e.clientY,
            content: (
              <>
                <TipTitle>
                  {when} <Sep /> {Math.round(geo.sums[i])} tok/s
                </TipTitle>
                {rows.map((r) => (
                  <TipRow key={r.id} hue={r.hue} label={r.name} value={Math.round(r.series[i])} hot={r.id === run} />
                ))}
              </>
            ),
          }
        : null,
    );
  };

  return (
    <div ref={ref} className="absolute inset-[16px_16px_10px_20px]">
      {w > 0 && h > 0 && (
        <svg
          width={w}
          height={h}
          className="block"
          role="img"
          aria-label="Output tokens per second for each run over the last 30 minutes, with findings, questions and crashes marked"
          onMouseMove={onMove}
          onMouseLeave={() => (setHover(null), setTip(null))}
          onClick={() => hot && onOpen(hot)}
          style={{ cursor: hot ? "pointer" : "default" }}
        >
          <defs>
            {geo.live.map((r) => (
              <linearGradient key={r.id} id={`${gid}-${r.id}`} x1="0" x2="1" y1="0" y2="0">
                <stop offset="0" style={{ stopColor: hueVar(r.hue), stopOpacity: 0.22 }} />
                <stop offset="0.75" style={{ stopColor: hueVar(r.hue), stopOpacity: 0.5 }} />
                <stop offset="1" style={{ stopColor: hueVar(r.hue), stopOpacity: 0.72 }} />
              </linearGradient>
            ))}
          </defs>
          {/* time grid */}
          {[30, 20, 10, 0].map((m) => {
            const x = Math.round(pw - (m / 30) * pw) + 0.5;
            return (
              <g key={m}>
                {m > 0 && m < 30 && <line x1={x} x2={x} y1={T - 8} y2={T + ph + 4} className="stroke-line-2" strokeDasharray="2 4" />}
                <text x={x} y={h - 4} textAnchor={m === 30 ? "start" : m === 0 ? "end" : "middle"} className="fill-ink-4 font-mono text-[10px]">
                  {m ? `${m}m` : "now"}
                </text>
              </g>
            );
          })}
          <g>
            {geo.layers.map((ly, j) => {
              const r = geo.live[j];
              return (
                <g key={r.id} opacity={dim(r.id)} className="transition-opacity duration-150">
                  <path d={areaPath(ly as unknown as [number, number][]) ?? ""} fill={`url(#${gid}-${r.id})`} />
                  <path d={topPath(ly as unknown as [number, number][]) ?? ""} fill="none" strokeWidth={1.25} strokeLinejoin="round" style={{ stroke: hueVar(r.hue), strokeOpacity: 0.9 }} />
                </g>
              );
            })}
          </g>
          {hover && <line x1={X(hover.i) + 0.5} x2={X(hover.i) + 0.5} y1={T - 8} y2={T + ph + 4} className="stroke-ink/25" />}
          {/* events on the streams */}
          {marks.map((m, n) => {
            const s = byId.get(m.run);
            const i = Math.round(STREAM_N - 1 - (now - m.at) / STREAM_STEP);
            if (!s || i < 0 || i >= STREAM_N) return null;
            const x = X(i);
            const y = Y(s.layer[i][1]);
            const show = (e: React.MouseEvent) => {
              e.stopPropagation();
              setTip({
                x: e.clientX,
                y: e.clientY,
                content: (
                  <>
                    <TipTitle>
                      {m.kind === "find" ? `${m.sev ?? ""} finding` : m.kind === "ask" ? "Question" : "Crash"} <Sep /> {age(m.at)} ago
                    </TipTitle>
                    <TipRow hue={s.run.hue} label={s.run.name} />
                    <div className="mt-1.5 leading-snug text-ink">{m.text}</div>
                  </>
                ),
              });
            };
            const common = { onMouseMove: show, className: "stroke-s1", strokeWidth: 2 } as const;
            if (m.kind === "find") return <circle key={n} cx={x} cy={y} r={4.5} style={{ fill: SEV_COLOR[m.sev ?? ""] ?? "var(--ink-2)" }} {...common} />;
            if (m.kind === "ask") return <rect key={n} x={x - 4} y={y - 4} width={8} height={8} transform={`rotate(45 ${x} ${y})`} className="fill-warning stroke-s1" strokeWidth={2} onMouseMove={show} />;
            return <rect key={n} x={x - 1.5} y={y - 8} width={3} height={16} rx={1.5} className="fill-warning" onMouseMove={show} />;
          })}
          {/* right-edge labels with leader lines */}
          {labels.map((l, i) => {
            const y = Math.max(T, Math.min(T + ph, ys[i]));
            return (
              <g key={l.run.id} opacity={hot && hot !== l.run.id ? 0.4 : 1}>
                <path d={`M${pw + 2},${l.y} C${pw + 8},${l.y} ${lx - 8},${y} ${lx - 3},${y}`} fill="none" strokeWidth={1} style={{ stroke: hueVar(l.run.hue), strokeOpacity: 0.6 }} />
                <text x={lx} y={y - 2} className="fill-ink text-xs font-medium">
                  {l.run.name.length > 20 ? `${l.run.name.slice(0, 19)}.` : l.run.name}
                </text>
                <text x={lx} y={y + 12} className="font-mono text-[11px]" style={{ fill: hueVar(l.run.hue) }}>
                  {Math.round(l.v)}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      <ChartTip tip={tip} />
    </div>
  );
}
