/** One value over time: the latest on top, an area under the line, the limit (if any) as the top. Machine tab and Pixel's health. */
import { useState, type ReactNode } from "react";
import { area, curveMonotoneX, line } from "d3-shape";
import { ago } from "../../lib/format.ts";
import { cn } from "../../lib/cn.ts";
import { ChartTip, TipRow, TipTitle, niceMax, useSize, type TipState } from "./common.tsx";
import { Nil } from "../ui/bits.tsx";

const H = 64;

export function Meter({
  title,
  points,
  limit,
  fmt,
  color,
  warn,
  bad,
  note,
}: {
  title: ReactNode;
  /** [time, value], oldest first. */
  points: [number, number][];
  limit?: number | null;
  fmt: (v: number) => string;
  color: string;
  /** Latest value at or above these turns amber / red (absolute, or a share of `limit` when below 1 and a limit is set). */
  warn?: number;
  bad?: number;
  /** Small text after the value, instead of "of <limit>". */
  note?: ReactNode;
}) {
  const [ref, { w }] = useSize<HTMLDivElement>();
  const [tip, setTip] = useState<TipState | null>(null);
  const [hi, setHi] = useState<number | null>(null);
  const pts = points;
  const last = pts[pts.length - 1]?.[1] ?? null;
  const t0 = pts[0]?.[0] ?? 0;
  const t1 = pts[pts.length - 1]?.[0] ?? 1;
  const max = limit ?? niceMax(Math.max(1e-6, ...pts.map((p) => p[1])) * 1.1);
  const X = (t: number) => (t1 > t0 ? ((t - t0) / (t1 - t0)) * w : w);
  const Y = (v: number) => H - 2 - (Math.min(v, max) / max) * (H - 6);
  const ar = area<[number, number]>().x((d) => X(d[0])).y0(H).y1((d) => Y(d[1])).curve(curveMonotoneX);
  const ln = line<[number, number]>().x((d) => X(d[0])).y((d) => Y(d[1])).curve(curveMonotoneX);
  const level = (x: number | undefined) => (x == null ? Infinity : limit && x < 1 ? x * limit : x);
  const tone = last == null ? "" : last >= level(bad) ? "text-critical" : last >= level(warn) ? "text-warning" : "";
  return (
    <div className="min-w-0 rounded-xl border border-line-2 bg-s2 px-3.5 pt-3 pb-2.5">
      <div className="flex items-baseline gap-1.5">
        <span className="mr-auto text-[12.5px] text-ink-3">{title}</span>
        <b className={cn("text-[15px] font-medium tabular-nums", tone)}>{last == null ? <Nil /> : fmt(last)}</b>
        {note ?? (limit != null && <small className="font-mono text-[11.5px] text-ink-3">of {fmt(limit)}</small>)}
      </div>
      <div ref={ref} className="mt-2 h-16">
        {w > 0 && pts.length > 1 && (
          <svg
            width={w}
            height={H}
            className="block overflow-visible"
            onMouseMove={(e) => {
              const b = e.currentTarget.getBoundingClientRect();
              const t = t0 + ((e.clientX - b.left) / w) * (t1 - t0);
              let i = 0;
              for (let k = 1; k < pts.length; k++) if (Math.abs(pts[k][0] - t) < Math.abs(pts[i][0] - t)) i = k;
              setHi(i);
              setTip({ x: e.clientX, y: e.clientY, content: <><TipTitle>{ago(pts[i][0])}</TipTitle><TipRow color={color} label={fmt(pts[i][1])} /></> });
            }}
            onMouseLeave={() => (setTip(null), setHi(null))}
          >
            <path d={ar(pts) ?? ""} style={{ fill: color, fillOpacity: 0.18 }} />
            <path d={ln(pts) ?? ""} fill="none" strokeWidth={1.5} style={{ stroke: color }} />
            {hi != null && <line x1={X(pts[hi][0])} x2={X(pts[hi][0])} y1={0} y2={H} className="stroke-ink/25" />}
          </svg>
        )}
        {pts.length <= 1 && <div className="flex h-full items-center text-xs text-ink-4">{pts.length ? "one sample so far" : "no samples"}</div>}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10.5px] text-ink-4">
        <span>{pts.length > 1 ? ago(t0) : ""}</span>
        <span>{pts.length > 1 ? "now" : ""}</span>
      </div>
      <ChartTip tip={tip} />
    </div>
  );
}
