/** Minimal SVG line chart for time series (metrics, tokens). */
import { useState } from "react";

interface Props {
  points: { t: number; v: number | null }[];
  format?: (v: number) => string;
  /** Fixed y-axis maximum (e.g. a memory limit); defaults to the data maximum. */
  max?: number;
  height?: number;
}

const W = 600;

export function LineChart({ points, format = (v) => v.toFixed(0), max, height = 120 }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const data = points.filter((p): p is { t: number; v: number } => p.v != null);
  if (data.length < 2) return <div className="flex h-24 items-center justify-center text-xs muted">Not enough data yet</div>;

  const H = height;
  const pad = { top: 8, bottom: 16, left: 4, right: 4 };
  const t0 = data[0].t;
  const t1 = data[data.length - 1].t;
  const top = Math.max(max ?? 0, ...data.map((d) => d.v)) || 1;
  const x = (t: number) => pad.left + ((t - t0) / (t1 - t0 || 1)) * (W - pad.left - pad.right);
  const y = (v: number) => pad.top + (1 - v / top) * (H - pad.top - pad.bottom);
  const line = data.map((d, i) => `${i ? "L" : "M"}${x(d.t).toFixed(1)},${y(d.v).toFixed(1)}`).join("");
  const area = `${line}L${x(t1).toFixed(1)},${H - pad.bottom}L${x(t0).toFixed(1)},${H - pad.bottom}Z`;
  const h = hover != null ? data[hover] : data[data.length - 1];

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const t = t0 + ((e.clientX - rect.left) / rect.width) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < data.length; i++) if (Math.abs(data[i].t - t) < Math.abs(data[best].t - t)) best = i;
    setHover(best);
  };

  return (
    <div>
      <div className="mb-1 flex justify-between text-xs muted">
        <span className="font-medium text-zinc-800 tabular-nums dark:text-zinc-200">{format(h.v)}</span>
        <span>{new Date(h.t).toLocaleTimeString()}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-28 w-full" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <path d={area} className="fill-accent/15" />
        <path d={line} className="fill-none stroke-accent" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        <line x1={0} x2={W} y1={H - pad.bottom} y2={H - pad.bottom} className="stroke-zinc-300 dark:stroke-zinc-700" vectorEffect="non-scaling-stroke" />
        {hover != null && <line x1={x(h.t)} x2={x(h.t)} y1={pad.top} y2={H - pad.bottom} className="stroke-zinc-400" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
      </svg>
    </div>
  );
}
