/** Small SVG charts drawn from fleet telemetry. Colours come from CSS tokens so both themes work. */
import type { FleetRun, FleetSnapshot, Lanes } from "../lib/types.ts";
import { kindColor, rate, runColor, shortName } from "../lib/fleet.ts";
import { bytes } from "../lib/format.ts";

export const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");

/** Tokens/s for the last N seconds, one stacked bar per second, each run in its own colour. */
export function TokenSpectrum({ runs, window }: { runs: FleetRun[]; window: number }) {
  const live = runs.filter((r) => r.tps.length);
  const W = 360;
  const H = 52;
  const w = W / window;
  const at = (r: FleetRun, i: number) => r.tps[r.tps.length - window + i] ?? 0;
  const totals = Array.from({ length: window }, (_, i) => live.reduce((a, r) => a + at(r, i), 0));
  const peak = Math.max(0, ...totals);
  const top = Math.max(500, Math.ceil(peak / 500) * 500);
  const bars = [];
  for (let i = 0; i < window; i++) {
    let y = H;
    for (const r of live) {
      const v = at(r, i);
      if (!v) continue;
      const h = (v / top) * (H - 2);
      y -= h;
      bars.push(<rect key={`${r.id}-${i}`} x={i * w + 0.5} y={y} width={Math.max(0.5, w - 1)} height={h} style={{ fill: runColor(r.id) }} opacity={i === window - 1 ? 1 : 0.55 + (i / window) * 0.35} />);
    }
  }
  return (
    <>
      <svg className="viz" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: H }} aria-label="Tokens per second by run">
        {[1, 2, 3].map((q) => (
          <rect key={q} x={0} y={(H * q) / 4} width={W} height={0.6} style={{ fill: "var(--grid)" }} />
        ))}
        {bars}
      </svg>
      <div className="scale">
        <span>-{window}s</span>
        <span>{peak ? `peak ${fmtInt(peak)}/s` : "no tokens yet"}</span>
        <span>now</span>
      </div>
      <div className="legend">
        {live.length ? (
          live.map((r) => (
            <span key={r.id}>
              <i style={{ background: runColor(r.id) }} />
              {shortName(r.id)} <b>{fmtInt(rate(r.tps))}</b>
            </span>
          ))
        ) : (
          <span>No active runs</span>
        )}
      </div>
    </>
  );
}

/** One bar split by run (plus Pixel itself) against the shared memory limit. */
export function MemorySplit({ snap }: { snap: FleetSnapshot }) {
  const total = snap.memory.total || 1;
  const parts = [
    ...snap.runs.filter((r) => r.mem.used).map((r) => ({ name: shortName(r.id), v: r.mem.used!, c: runColor(r.id) })),
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

/** Cumulative spend since midnight with a dashed projection to the end of the day. */
export function SpendLine({ spend }: { spend: FleetSnapshot["spend"] }) {
  const H = 30;
  const top = Math.max(spend.projected, spend.total, 0.01) * 1.1;
  const pts = [[0, H - 2], ...spend.hourly.map((v, h) => [((h + 1) / 24) * 200, H - 2 - (v / top) * (H - 4)])];
  const nowX = Math.min(200, ((Date.now() - spend.dayStart) / 86_400_000) * 200);
  pts[pts.length - 1][0] = nowX;
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const end = pts[pts.length - 1];
  const projY = H - 2 - (spend.projected / top) * (H - 4);
  return (
    <svg className="viz" viewBox={`0 0 200 ${H}`} preserveAspectRatio="none" style={{ height: H }} aria-label="Spend today">
      <rect x={0} y={1} width={200} height={0.7} style={{ fill: "var(--grid)" }} />
      <path d={`${line} L${end[0]} ${H} L0 ${H} Z`} style={{ fill: "var(--fg2)" }} opacity={0.08} />
      <path d={line} fill="none" style={{ stroke: "var(--fg2)" }} strokeWidth={1.3} vectorEffect="non-scaling-stroke" />
      <path d={`M${end[0]} ${end[1]} L200 ${projY}`} fill="none" style={{ stroke: "var(--fg3)" }} strokeWidth={1.2} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      <rect x={nowX} y={0} width={0.8} height={H} style={{ fill: "var(--fg3)" }} opacity={0.5} />
    </svg>
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
  if (run.cpu == null && run.mem.used == null) return <span className="muted">–</span>;
  const memPct = run.mem.used && run.mem.total ? run.mem.used / run.mem.total : 0;
  return (
    <>
      <div className="meter">
        <b>
          <i style={{ width: `${Math.min(100, run.cpu ?? 0)}%` }} />
        </b>
        <span>{run.cpu == null ? "–" : `${Math.round(run.cpu)}%`}</span>
      </div>
      <div className="meter">
        <b>
          <i className={memPct > 0.8 ? "hot" : ""} style={{ width: `${Math.min(100, memPct * 100)}%` }} />
        </b>
        <span>{run.mem.used == null ? "–" : bytes(run.mem.used).replace(" ", "")}</span>
      </div>
    </>
  );
}
