/** Model calls over the window, stacked by model in each model's lineup colour, with failed calls marked under the axis. */
import { useMemo, useState } from "react";
import { area, curveMonotoneX, stack } from "d3-shape";
import { ChartTip, TipRow, TipTitle, niceMax, useSize, type TipState } from "../../components/charts/common.tsx";
import { hueVar, splitModel } from "./common.tsx";
import { Sep } from "../../components/ui/bits.tsx";

export interface TrafficRow {
  key: string;
  hue: number;
  buckets: { calls: number; errors: number }[];
}

const B = 14;

export function Traffic({ rows, minutes }: { rows: TrafficRow[]; minutes: number }) {
  const [ref, { w, h: H }] = useSize<HTMLDivElement>();
  const [hi, setHi] = useState<number | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const n = rows[0]?.buckets.length ?? 0;

  const geo = useMemo(() => {
    const data = Array.from({ length: n }, (_, i) => Object.fromEntries(rows.map((r) => [r.key, r.buckets[i]?.calls ?? 0])));
    const layers = stack<Record<string, number>>().keys(rows.map((r) => r.key))(data);
    const sums = data.map((d) => Object.values(d).reduce((a, b) => a + b, 0));
    const errors = Array.from({ length: n }, (_, i) => rows.reduce((a, r) => a + (r.buckets[i]?.errors ?? 0), 0));
    return { layers, sums, errors, max: niceMax(Math.max(4, ...sums) * 1.1) };
  }, [rows, n]);

  const ph = H - B;
  const X = (i: number) => (n > 1 ? (i / (n - 1)) * w : 0);
  const Y = (v: number) => ph - (v / geo.max) * (ph - 4);
  const ar = area<[number, number]>()
    .x((_, i) => X(i))
    .y0((d) => Y(d[0]))
    .y1((d) => Y(d[1]))
    .curve(curveMonotoneX);
  const bucketMin = minutes / Math.max(1, n);
  const at = (i: number) => {
    const m = Math.round((n - 1 - i) * bucketMin);
    return m <= 0 ? "now" : m < 60 ? `${m} min ago` : `${(m / 60).toFixed(m % 60 ? 1 : 0)} h ago`;
  };

  return (
    <div ref={ref} className="relative min-h-[132px] flex-1">
      {w > 0 && H > 0 && n > 1 && (
        <svg
          width={w}
          height={H}
          className="absolute inset-0 block overflow-visible"
          role="img"
          aria-label="Model calls over time, stacked by model"
          onMouseMove={(e) => {
            const b = e.currentTarget.getBoundingClientRect();
            const i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - b.left) / w) * (n - 1))));
            setHi(i);
            const by = rows.map((r) => ({ r, c: r.buckets[i]?.calls ?? 0, e: r.buckets[i]?.errors ?? 0 })).filter((x) => x.c || x.e);
            setTip({
              x: e.clientX,
              y: e.clientY,
              content: (
                <>
                  <TipTitle>
                    {at(i)} <Sep /> {geo.sums[i]} calls
                  </TipTitle>
                  {by.length ? by.map(({ r, c, e: er }) => <TipRow key={r.key} color={hueVar(r.hue)} label={splitModel(r.key)[1]} value={er ? `${c}, ${er} failed` : c} />) : <div className="text-ink-3">No calls</div>}
                </>
              ),
            });
          }}
          onMouseLeave={() => (setHi(null), setTip(null))}
        >
          {[0.5, 1].map((f) => (
            <line key={f} x1={0} x2={w} y1={Y(geo.max * f)} y2={Y(geo.max * f)} strokeDasharray="2 4" style={{ stroke: "var(--grid)" }} />
          ))}
          <line x1={0} x2={w} y1={ph} y2={ph} style={{ stroke: "var(--line)" }} />
          {geo.layers.map((l, k) => (
            <path key={l.key} d={ar(l as unknown as [number, number][]) ?? ""} style={{ fill: hueVar(rows[k].hue), fillOpacity: hi == null ? 0.55 : 0.4 }} />
          ))}
          {geo.errors.map((e, i) =>
            e ? <rect key={i} x={X(i) - 1.5} y={ph + 4} width={3} height={Math.min(8, 3 + e * 1.5)} rx={1} style={{ fill: "var(--critical)" }} /> : null,
          )}
          {hi != null && <line x1={X(hi)} x2={X(hi)} y1={0} y2={ph} className="stroke-ink/30" />}
          <text x={w} y={Y(geo.max) - 4} textAnchor="end" className="fill-ink-4 font-mono text-[10px]">
            {geo.max}
          </text>
        </svg>
      )}
      {n <= 1 && <div className="absolute inset-0 flex items-center justify-center text-sm text-ink-3">No model calls in this window</div>}
      <ChartTip tip={tip} />
    </div>
  );
}
