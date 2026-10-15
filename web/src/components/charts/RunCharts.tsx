/** A run over its whole life: output tok/s, cost, context use (with continue and restart marks), tool calls by kind. */
import { useState } from "react";
import { area, curveMonotoneX, line } from "d3-shape";
import type { RunSeries } from "../../lib/types.ts";
import { kindColor } from "../../lib/fleet.ts";
import { money, tokens } from "../../lib/format.ts";
import { elapsed } from "../../lib/health.ts";
import { ChartTip, TipRow, TipTitle, niceMax, useSize, type TipState } from "./common.tsx";

const H = 72;
const MARK: Record<string, string> = { continue: "var(--warning)", recover: "var(--warning)", restart: "var(--warning)", key: "var(--warning)", limit: "var(--critical)" };

function Frame({ title, value, unit, children, axis, wide }: { title: string; value: string; unit?: string; children: React.ReactNode; axis: [string, string]; wide?: boolean }) {
  return (
    <div className={`min-w-0 rounded-xl border border-line-2 bg-s2 px-3.5 pt-3 pb-2.5 ${wide ? "col-span-full" : ""}`}>
      <div className="flex items-baseline gap-1.5">
        <span className="mr-auto text-[12.5px] text-ink-3">{title}</span>
        <b className="text-[15px] font-medium tabular-nums">{value}</b>
        {unit && <small className="font-mono text-[11.5px] text-ink-3">{unit}</small>}
      </div>
      {children}
      <div className="mt-1 flex justify-between font-mono text-[10.5px] text-ink-4">
        <span>{axis[0]}</span>
        <span>{axis[1]}</span>
      </div>
    </div>
  );
}

/** One small chart: the series as an area or line, the marks as ticks, hover for the value. */
function Plot({ s, values, kind, color, fmt, marks = false }: { s: RunSeries; values: (number | null)[]; kind: "area" | "line"; color: string; fmt: (v: number) => string; marks?: boolean }) {
  const [ref, { w }] = useSize<HTMLDivElement>();
  const [tip, setTip] = useState<TipState | null>(null);
  const [hi, setHi] = useState<number | null>(null);
  const n = values.length;
  const max = niceMax(Math.max(1e-6, ...values.map((v) => v ?? 0)) * 1.1);
  const X = (i: number) => (n > 1 ? (i / (n - 1)) * w : 0);
  const Y = (v: number) => H - 2 - (v / max) * (H - 6);
  const pts = values.map((v, i) => [i, v] as const).filter(([, v]) => v != null) as [number, number][];
  const ar = area<[number, number]>().x((d) => X(d[0])).y0(H).y1((d) => Y(d[1])).curve(curveMonotoneX);
  const ln = line<[number, number]>().x((d) => X(d[0])).y((d) => Y(d[1])).curve(curveMonotoneX);
  const tAt = (i: number) => s.from + (i + 0.5) * s.step;
  return (
    <div ref={ref} className="mt-2 h-[72px]">
      {w > 0 && (
        <svg
          width={w}
          height={H}
          className="block overflow-visible"
          onMouseMove={(e) => {
            const b = e.currentTarget.getBoundingClientRect();
            const i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - b.left) / w) * (n - 1))));
            setHi(i);
            const near = marks ? s.marks.filter((m) => Math.abs(m.ts - tAt(i)) < s.step && MARK[m.kind]) : [];
            setTip({
              x: e.clientX,
              y: e.clientY,
              content: (
                <>
                  <TipTitle>{elapsed(tAt(i) - s.from)} in</TipTitle>
                  <TipRow color={color} label={values[i] == null ? "–" : fmt(values[i]!)} />
                  {near.map((m, k) => (
                    <div key={k} className="mt-1 text-ink-2">
                      {m.message}
                    </div>
                  ))}
                </>
              ),
            });
          }}
          onMouseLeave={() => (setTip(null), setHi(null))}
        >
          {kind === "area" && <path d={ar(pts) ?? ""} style={{ fill: color, fillOpacity: 0.2 }} />}
          <path d={ln(pts) ?? ""} fill="none" strokeWidth={1.5} style={{ stroke: color }} />
          {marks &&
            s.marks
              .filter((m) => MARK[m.kind])
              .map((m, k) => {
                const x = ((m.ts - s.from) / (s.to - s.from)) * w;
                return <rect key={k} x={x - 1} y={2} width={2} height={H - 4} rx={1} style={{ fill: MARK[m.kind], opacity: 0.7 }} />;
              })}
          {hi != null && <line x1={X(hi)} x2={X(hi)} y1={0} y2={H} className="stroke-ink/25" />}
        </svg>
      )}
      <ChartTip tip={tip} />
    </div>
  );
}

function KindBars({ s }: { s: RunSeries }) {
  const [ref, { w }] = useSize<HTMLDivElement>();
  const [tip, setTip] = useState<TipState | null>(null);
  const kinds = Object.keys(s.kinds);
  const n = s.tps.length;
  const tot = (i: number) => kinds.reduce((a, k) => a + s.kinds[k][i], 0);
  const max = Math.max(1, ...Array.from({ length: n }, (_, i) => tot(i)));
  const slot = w / Math.max(1, n);
  return (
    <div ref={ref} className="mt-2 h-[72px]">
      {w > 0 && (
        <svg
          width={w}
          height={H}
          className="block"
          onMouseMove={(e) => {
            const b = e.currentTarget.getBoundingClientRect();
            const i = Math.max(0, Math.min(n - 1, Math.floor((e.clientX - b.left) / slot)));
            setTip({ x: e.clientX, y: e.clientY, content: <><TipTitle>{elapsed(s.from + i * s.step - s.from)} in · {tot(i)} calls</TipTitle>{kinds.filter((k) => s.kinds[k][i]).map((k) => <TipRow key={k} color={kindColor(k)} label={k === "task" ? "subagent" : k} value={s.kinds[k][i]} />)}</> });
          }}
          onMouseLeave={() => setTip(null)}
        >
          {Array.from({ length: n }, (_, i) => {
            let y = H;
            return (
              <g key={i}>
                {kinds.map((k) => {
                  const v = s.kinds[k][i];
                  if (!v) return null;
                  const h = (v / max) * (H - 2);
                  y -= h;
                  return <rect key={k} x={i * slot + 0.5} y={y} width={Math.max(1, slot - 1)} height={h} style={{ fill: kindColor(k) }} />;
                })}
              </g>
            );
          })}
        </svg>
      )}
      <ChartTip tip={tip} />
    </div>
  );
}

export function RunCharts({ s, contextLimit }: { s: RunSeries; contextLimit: number | null }) {
  if (!s.tps.length) return null;
  const axis: [string, string] = ["start", s.to >= Date.now() - 60_000 ? "now" : "end"];
  const lastCtx = [...s.context].reverse().find((v) => v != null) ?? null;
  const peak = Math.max(0, ...s.tps);
  const totalCalls = Object.values(s.kinds).reduce((a, k) => a + k.reduce((x, y) => x + y, 0), 0);
  return (
    <div className="grid grid-cols-2 gap-3 max-lg:grid-cols-1">
      <Frame title="Output" value={String(Math.round(peak))} unit="tok/s peak" axis={axis} wide>
        <Plot s={s} values={s.tps} kind="area" color="var(--accent-c)" fmt={(v) => `${Math.round(v)} tok/s`} marks />
      </Frame>
      <Frame title="Cost" value={money(s.cost.at(-1) ?? 0)} axis={axis}>
        <Plot s={s} values={s.cost} kind="line" color="var(--ink-2)" fmt={money} />
      </Frame>
      <Frame title="Context" value={lastCtx != null ? tokens(lastCtx) : "–"} unit={contextLimit ? `of ${tokens(contextLimit)}` : undefined} axis={axis}>
        <Plot s={s} values={s.context} kind="line" color="var(--r2)" fmt={(v) => `${tokens(v)} tokens`} marks />
      </Frame>
      <Frame title="Tool calls" value={String(totalCalls)} axis={axis} wide>
        <KindBars s={s} />
      </Frame>
    </div>
  );
}
