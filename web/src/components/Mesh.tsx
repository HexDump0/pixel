/**
 * The fleet as a small network: runs as nodes, their subagents as dots around them (turning while
 * they work), and workbase reads between runs as dashed links, with a pulse on recent ones.
 */
import { useEffect, useState } from "react";
import { navigate, useLocation } from "../lib/router.tsx";
import { runColor, shortName, useFleet } from "../lib/fleet.ts";
import type { Run } from "../lib/types.ts";

const RECENT_MS = 10 * 60_000;
const MAX_NODES = 8;

function layout(n: number): [number, number][] {
  if (n === 1) return [[100, 62]];
  if (n === 2) return [[52, 62], [148, 62]];
  return Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    return [100 + Math.cos(a) * 62, 64 + Math.sin(a) * 44];
  });
}

export function Mesh({ runs }: { runs: Run[] }) {
  const snap = useFleet();
  const { search } = useLocation();
  const selected = new URLSearchParams(search).get("run");
  const [reduce, setReduce] = useState(false);
  useEffect(() => setReduce(matchMedia("(prefers-reduced-motion: reduce)").matches), []);
  if (!snap) return null;

  const byId = new Map(runs.map((r) => [r.id, r]));
  const order = ["running", "recovering", "preparing", "paused", "stopped", "failed", "done", "triaged"];
  const shown = snap.runs
    .filter((r) => byId.has(r.id))
    .sort((a, b) => order.indexOf(byId.get(a.id)!.status) - order.indexOf(byId.get(b.id)!.status))
    .slice(0, MAX_NODES);
  if (!shown.length) return null;
  const pos = new Map(shown.map((r, i) => [r.id, layout(shown.length)[i]]));
  const edges = snap.links.filter((l) => pos.has(l.run_id) && pos.has(l.other_run) && l.run_id !== l.other_run);

  return (
    <div className="mesh">
      <svg viewBox="0 0 200 132" role="img" aria-label="Runs, subagents and workbase reads">
        {edges.map((e, i) => {
          const [x1, y1] = pos.get(e.run_id)!;
          const [x2, y2] = pos.get(e.other_run)!;
          const recent = Date.now() - e.last < RECENT_MS;
          const id = `mesh-e${i}`;
          return (
            <g key={id}>
              <path id={id} d={`M${x1} ${y1} L${x2} ${y2}`} fill="none" strokeWidth={0.8} strokeDasharray="2 3" style={{ stroke: recent ? "var(--accent)" : "var(--fg3)" }} opacity={recent ? 0.75 : 0.35} />
              {recent && !reduce && (
                <circle r={1.8} style={{ fill: "var(--accent)" }}>
                  <animateMotion dur={`${2.4 + i * 0.7}s`} repeatCount="indefinite">
                    <mpath href={`#${id}`} />
                  </animateMotion>
                </circle>
              )}
            </g>
          );
        })}
        {shown.map((f) => {
          const run = byId.get(f.id)!;
          const [x, y] = pos.get(f.id)!;
          const c = runColor(f.id);
          const subs = f.agents.subs;
          const working = subs.some((s) => s.status === "running");
          const hollow = ["done", "triaged", "stopped"].includes(run.status);
          return (
            <g key={f.id} className={`node ${selected === f.id ? "sel" : ""}`} onClick={() => navigate(`/?run=${encodeURIComponent(f.id)}`)}>
              <title>{`${f.id} · ${run.status}${subs.length ? ` · ${subs.length} subagents` : ""}`}</title>
              {subs.length > 0 && <circle cx={x} cy={y} r={12} fill="none" strokeWidth={0.7} style={{ stroke: "var(--line)" }} />}
              <g>
                {subs.map((s, i) => {
                  const a = (i / subs.length) * Math.PI * 2;
                  const sc = s.status === "running" ? c : s.status === "done" ? "var(--ok)" : "var(--warn)";
                  return <circle key={s.id} cx={x + Math.cos(a) * 12} cy={y + Math.sin(a) * 12} r={1.7} style={{ fill: sc }} />;
                })}
                {working && !reduce && <animateTransform attributeName="transform" type="rotate" from={`0 ${x} ${y}`} to={`360 ${x} ${y}`} dur="14s" repeatCount="indefinite" />}
              </g>
              {selected === f.id && <circle cx={x} cy={y} r={7.5} fill="none" strokeWidth={0.9} style={{ stroke: "var(--accent)" }} />}
              <circle cx={x} cy={y} r={5} strokeWidth={1.2} style={{ fill: hollow ? "var(--surface)" : c, stroke: c }} />
              <circle cx={x} cy={y} r={14} fill="transparent" />
              <text x={x} y={y + 26} textAnchor="middle">
                {shortName(f.id).slice(0, 14)}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="cap">
        <span>┄ workbase read</span>
        <span>· subagent</span>
      </div>
    </div>
  );
}
