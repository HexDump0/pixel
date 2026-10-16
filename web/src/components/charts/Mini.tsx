/** The small fleet charts beside the stream: spend per hour today, tool calls per minute, memory by run. */
import { useState } from "react";
import type { FleetRun, FleetSnapshot } from "../../lib/types.ts";
import { money } from "../../lib/format.ts";
import { ChartTip, TipRow, TipTitle, useSize, type TipState } from "./common.tsx";
import { Sep } from "../ui/bits.tsx";

const hueVar = (h: number | null | undefined) => `var(--r${h ?? 0})`;
type Named = { id: string; name: string; hue: number | null };

function useHoverIndex() {
  const [i, setI] = useState<number | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  return { i, setI, tip, setTip, clear: () => (setI(null), setTip(null)) };
}

/** 24 hourly bars stacked by run (the four biggest spenders, then the rest); the rest of the day dashed at the last hour's rate. */
export function SpendBars({ spend, runs }: { spend: FleetSnapshot["spend"]; runs: Named[] }) {
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const hv = useHoverIndex();
  const named = new Map(runs.map((r) => [r.id, r]));
  const hourly = Array.from({ length: spend.hours }, (_, k) => spend.runs.reduce((a, r) => a + (r.hourly[k] ?? 0), 0));
  const max = Math.max(0.05, spend.perHour, ...hourly) * 1.05;
  const slot = w / 24;
  const bw = Math.max(2, slot - 3);
  const ph = h - 2;
  return (
    <div ref={ref} className="absolute inset-0">
      {w > 0 && (
        <svg
          width={w}
          height={h}
          className="block"
          role="img"
          aria-label="Spend per hour today stacked by run, with the rest of the day projected"
          onMouseMove={(e) => {
            const b = e.currentTarget.getBoundingClientRect();
            const k = Math.max(0, Math.min(23, Math.floor((e.clientX - b.left) / slot)));
            hv.setI(k);
            const lab = `${String(k).padStart(2, "0")}:00`;
            hv.setTip({
              x: e.clientX,
              y: e.clientY,
              content:
                k >= spend.hours ? (
                  <>
                    <TipTitle>{lab}, projected</TipTitle>
                    <TipRow color="transparent" label="at the last hour's rate" value={money(spend.perHour)} />
                  </>
                ) : (
                  <>
                    <TipTitle>
                      {lab} <Sep /> {money(hourly[k])}
                    </TipTitle>
                    {spend.runs
                      .filter((r) => r.hourly[k] > 0)
                      .map((r) => (
                        <TipRow key={r.id ?? "other"} hue={r.id ? named.get(r.id)?.hue : null} color={r.id ? undefined : "var(--ink-4)"} label={r.id ? (named.get(r.id)?.name ?? r.id) : "other runs"} value={money(r.hourly[k])} />
                      ))}
                  </>
                ),
            });
          }}
          onMouseLeave={hv.clear}
        >
          {hv.i != null && <rect x={hv.i * slot} y={0} width={slot} height={ph} className="fill-ink/5" />}
          {Array.from({ length: 24 }, (_, k) => {
            const x = k * slot + 1.5;
            if (k >= spend.hours) {
              const bh = Math.max(2, (spend.perHour / max) * ph);
              return <rect key={k} x={x + 0.5} y={ph - bh + 0.5} width={bw - 1} height={bh - 1} rx={2} fill="none" className="stroke-ink/15" strokeDasharray="2 2" />;
            }
            let y = ph;
            const segs = spend.runs.filter((r) => r.hourly[k] > 0);
            if (!segs.length) return <rect key={k} x={x} y={ph - 2} width={bw} height={2} className="fill-s3" />;
            return (
              <g key={k}>
                {segs.map((r) => {
                  const sh = (r.hourly[k] / max) * ph;
                  y -= sh;
                  return <rect key={r.id ?? "o"} x={x} y={y} width={bw} height={Math.max(0.6, sh)} style={{ fill: r.id ? hueVar(named.get(r.id)?.hue) : "var(--ink-4)" }} />;
                })}
              </g>
            );
          })}
        </svg>
      )}
      <ChartTip tip={hv.tip} />
    </div>
  );
}

/** Tool calls per minute for the last 30 minutes, stacked by run. */
export function CallBars({ runs, names }: { runs: FleetRun[]; names: Map<string, Named> }) {
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const hv = useHoverIndex();
  // 60 buckets of 30 s → 30 minutes
  const per = runs.map((r) => ({ r, m: Array.from({ length: 30 }, (_, i) => (r.activity[i * 2]?.n ?? 0) + (r.activity[i * 2 + 1]?.n ?? 0)) }));
  const tot = (i: number) => per.reduce((a, p) => a + p.m[i], 0);
  const max = Math.max(10, ...Array.from({ length: 30 }, (_, i) => tot(i))) * 1.05;
  const slot = w / 30;
  const bw = Math.max(2, slot - 2);
  const ph = h - 2;
  return (
    <div ref={ref} className="absolute inset-0">
      {w > 0 && (
        <svg
          width={w}
          height={h}
          className="block"
          role="img"
          aria-label="Tool calls per minute for the last 30 minutes, stacked by run"
          onMouseMove={(e) => {
            const b = e.currentTarget.getBoundingClientRect();
            const i = Math.max(0, Math.min(29, Math.floor((e.clientX - b.left) / slot)));
            hv.setI(i);
            const ago = 29 - i;
            hv.setTip({
              x: e.clientX,
              y: e.clientY,
              content: (
                <>
                  <TipTitle>
                    {ago ? `${ago} min ago` : "this minute"} <Sep /> {tot(i)} calls
                  </TipTitle>
                  {per
                    .filter((p) => p.m[i])
                    .map((p) => (
                      <TipRow key={p.r.id} hue={p.r.hue} label={names.get(p.r.id)?.name ?? p.r.id} value={p.m[i]} />
                    ))}
                </>
              ),
            });
          }}
          onMouseLeave={hv.clear}
        >
          {hv.i != null && <rect x={hv.i * slot} y={0} width={slot} height={ph} className="fill-ink/5" />}
          {Array.from({ length: 30 }, (_, i) => {
            let y = ph;
            return (
              <g key={i} opacity={0.55 + 0.45 * (i / 29)}>
                {per
                  .filter((p) => p.m[i])
                  .map((p) => {
                    const sh = (p.m[i] / max) * ph;
                    y -= sh;
                    return <rect key={p.r.id} x={i * slot + 1} y={y} width={bw} height={sh} style={{ fill: hueVar(p.r.hue) }} />;
                  })}
              </g>
            );
          })}
        </svg>
      )}
      <ChartTip tip={hv.tip} />
    </div>
  );
}

/** One bar split by run against the shared memory, with a mark at 90 %. */
export function MemoryBar({ snap, names }: { snap: FleetSnapshot; names: Map<string, Named> }) {
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const [tip, setTip] = useState<TipState | null>(null);
  const total = snap.memory.total || 1;
  const segs = [
    ...snap.runs.filter((r) => r.mem.used).map((r) => ({ key: r.id, hue: r.hue as number | null, label: names.get(r.id)?.name ?? r.id, v: r.mem.used! })),
    { key: "pixel", hue: null, label: "Pixel and everything else", v: Math.max(0, snap.memory.used - snap.runs.reduce((a, r) => a + (r.mem.used ?? 0), 0)) },
  ];
  const bh = 10;
  const y = Math.round((h - bh) / 2);
  let x = 0;
  return (
    <div ref={ref} className="absolute inset-0">
      {w > 0 && (
        <svg width={w} height={h} className="block" role="img" aria-label="Memory used by each run out of the machine total" onMouseLeave={() => setTip(null)}>
          <clipPath id="membar">
            <rect x={0} y={y} width={w} height={bh} rx={3} />
          </clipPath>
          <rect x={0} y={y} width={w} height={bh} rx={3} className="fill-s3" />
          <g clipPath="url(#membar)">
            {segs.map((s) => {
              const sw = (s.v / total) * w;
              const el = (
                <rect
                  key={s.key}
                  x={x}
                  y={y}
                  width={Math.max(0, sw - 2)}
                  height={bh}
                  style={{ fill: s.hue == null ? "var(--ink-4)" : hueVar(s.hue) }}
                  onMouseMove={(e) => setTip({ x: e.clientX, y: e.clientY, content: <><TipTitle>Memory</TipTitle><TipRow hue={s.hue} color={s.hue == null ? "var(--ink-4)" : undefined} label={s.label} value={`${(s.v / 1024 ** 3).toFixed(1)} GB`} /></> })}
                />
              );
              x += sw;
              return el;
            })}
          </g>
          <line x1={Math.round(w * 0.9) + 0.5} x2={Math.round(w * 0.9) + 0.5} y1={y - 4} y2={y + bh + 4} className="stroke-warning" strokeWidth={1.5}>
            <title>90 % of memory</title>
          </line>
        </svg>
      )}
      <ChartTip tip={tip} />
    </div>
  );
}
