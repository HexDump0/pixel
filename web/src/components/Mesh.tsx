/**
 * The fleet as a list with links: one row per run (status, subagents as dots, tokens/s), and
 * workbase reads between runs as arcs in the left gutter, with a pulse on recent ones. Rows never
 * collide however many runs there are; hover a row for who it reads and what it's doing.
 */
import { useEffect, useState } from "react";
import { navigate, useLocation } from "../lib/router.tsx";
import { distinctNames, rate, runColor, useFleet } from "../lib/fleet.ts";
import type { FleetRun, Run } from "../lib/types.ts";
import { RunName } from "./RunName.tsx";
import { fmtInt } from "./viz.tsx";

const RECENT_MS = 10 * 60_000;
const MAX_ROWS = 10;
const ROW = 30;
const GUTTER = 24;
const ORDER = ["running", "recovering", "preparing", "paused", "stopped", "failed", "done", "triaged"];
const STATUS_COLOR: Record<string, string> = { running: "var(--ok)", recovering: "var(--warn)", preparing: "var(--fg2)", paused: "var(--warn)", failed: "var(--bad)" };

interface Hover {
  id: string;
  x: number;
  y: number;
}

export function Mesh({ runs }: { runs: Run[] }) {
  const snap = useFleet();
  const { search } = useLocation();
  const selected = new URLSearchParams(search).get("run");
  const [reduce, setReduce] = useState(false);
  const [hover, setHover] = useState<Hover | null>(null);
  useEffect(() => setReduce(matchMedia("(prefers-reduced-motion: reduce)").matches), []);
  if (!snap) return null;

  const byId = new Map(runs.map((r) => [r.id, r]));
  const all = snap.runs.filter((r) => byId.has(r.id)).sort((a, b) => ORDER.indexOf(byId.get(a.id)!.status) - ORDER.indexOf(byId.get(b.id)!.status));
  const shown = all.slice(0, MAX_ROWS);
  if (!shown.length) return null;
  const names = distinctNames(shown.map((f) => byId.get(f.id)!));
  const row = new Map(shown.map((f, i) => [f.id, i]));
  const edges = snap.links.filter((l) => row.has(l.run_id) && row.has(l.other_run) && l.run_id !== l.other_run);
  const H = shown.length * ROW;
  const cy = (id: string) => row.get(id)! * ROW + ROW / 2 - 3;

  return (
    <div className="mesh" onMouseLeave={() => setHover(null)}>
      <div className="mhead">
        <span>{all.length} runs</span>
        <span>tok/s</span>
      </div>
      <div className="mbody" style={{ height: H }}>
        <svg className="arcs" width={GUTTER} height={H} viewBox={`0 0 ${GUTTER} ${H}`} aria-hidden>
          {edges.map((e, i) => {
            const y1 = cy(e.run_id);
            const y2 = cy(e.other_run);
            const depth = Math.min(GUTTER - 3, 5 + (Math.abs(y2 - y1) / ROW) * 4 + (i % 3) * 2);
            const x0 = GUTTER - 1;
            const recent = Date.now() - e.last < RECENT_MS;
            const stroke = recent ? "var(--accent)" : "var(--fg3)";
            const id = `mesh-e${i}`;
            return (
              <g key={id} opacity={recent ? 0.9 : 0.45}>
                <path id={id} d={`M${x0} ${y1} C${x0 - depth} ${y1} ${x0 - depth} ${y2} ${x0} ${y2}`} fill="none" strokeWidth={Math.min(2.2, 0.7 + e.n * 0.15)} strokeDasharray="2 2.5" style={{ stroke }} />
                <path d={`M${x0 - 3.5} ${y2 - 2.5} L${x0} ${y2} L${x0 - 3.5} ${y2 + 2.5}`} fill="none" strokeWidth={1} style={{ stroke }} />
                {recent && !reduce && (
                  <circle r={1.6} style={{ fill: "var(--accent)" }}>
                    <animateMotion dur={`${2.2 + (i % 4) * 0.5}s`} repeatCount="indefinite">
                      <mpath href={`#${id}`} />
                    </animateMotion>
                  </circle>
                )}
              </g>
            );
          })}
        </svg>
        {shown.map((f) => {
          const run = byId.get(f.id)!;
          const c = runColor(f.id);
          const tps = rate(f.tps);
          const hollow = !["running", "recovering", "preparing"].includes(run.status);
          const subs = f.agents.subs;
          return (
            <div
              key={f.id}
              className={`mrow ${selected === f.id ? "sel" : ""}`}
              style={{ height: ROW, paddingLeft: GUTTER }}
              role="button"
              tabIndex={0}
              aria-label={`${names.get(f.id)}, ${run.status}`}
              onClick={() => navigate(`/?run=${encodeURIComponent(f.id)}`)}
              onKeyDown={(e) => e.key === "Enter" && navigate(`/?run=${encodeURIComponent(f.id)}`)}
              onMouseEnter={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setHover({ id: f.id, x: r.right + 8, y: r.top });
              }}
            >
              <svg className="mnode" width={14} height={14} viewBox="0 0 14 14" aria-hidden>
                <circle cx={7} cy={7} r={6} fill="none" strokeWidth={1.2} style={{ stroke: STATUS_COLOR[run.status] ?? "var(--fg3)" }} />
                <circle cx={7} cy={7} r={3.4} strokeWidth={1} style={{ fill: hollow ? "var(--surface)" : c, stroke: c }} />
              </svg>
              <div className="mname">
                <RunName run={run}>{names.get(f.id)}</RunName>
                {subs.length > 0 && (
                  <span className="msubs">
                    {subs.slice(0, 14).map((s) => (
                      <i key={s.id} className={s.status} style={{ background: s.status === "running" ? c : s.status === "done" ? "var(--ok)" : "var(--warn)" }} />
                    ))}
                    {subs.length > 14 && <em>+{subs.length - 14}</em>}
                  </span>
                )}
              </div>
              <span className={`mrate ${tps ? "" : "off"}`}>{tps ? fmtInt(tps) : f.agents.main === "finished" ? run.status : f.agents.main}</span>
            </div>
          );
        })}
      </div>
      {all.length > shown.length && (
        <button className="mmore" onClick={() => navigate("/")}>
          +{all.length - shown.length} more
        </button>
      )}
      <div className="cap">
        <span>
          <svg width={14} height={8} aria-hidden>
            <path d="M1 4 H11 M8.5 1.5 L11 4 L8.5 6.5" fill="none" strokeWidth={1} strokeDasharray="2 1.5" style={{ stroke: "var(--accent)" }} />
          </svg>
          reads
        </span>
        <span>
          <i style={{ background: "var(--ok)" }} />
          <i style={{ background: "var(--r1)" }} /> subagents
        </span>
        <span>
          <svg width={9} height={9} aria-hidden>
            <circle cx={4.5} cy={4.5} r={3.5} fill="none" strokeWidth={1.1} style={{ stroke: "var(--ok)" }} />
          </svg>
          status
        </span>
      </div>
      {hover && byId.has(hover.id) && <Card f={snap.runs.find((r) => r.id === hover.id)!} run={byId.get(hover.id)!} names={names} links={snap.links} at={hover} />}
    </div>
  );
}

function Card({ f, run, names, links, at }: { f: FleetRun; run: Run; names: Map<string, string>; links: { run_id: string; other_run: string; n: number }[]; at: Hover }) {
  const nameOf = (id: string) => (id === "*" ? "index" : (names.get(id) ?? id));
  const readsFrom = links.filter((l) => l.run_id === f.id && l.other_run !== f.id).map((l) => nameOf(l.other_run));
  const readBy = links.filter((l) => l.other_run === f.id && l.run_id !== f.id).map((l) => nameOf(l.run_id));
  const working = f.agents.subs.filter((s) => s.status === "running").length;
  const done = f.agents.subs.filter((s) => s.status === "done").length;
  const tps = rate(f.tps);
  const top = Math.min(at.y, window.innerHeight - 170);
  return (
    <div className="mcard" style={{ left: at.x, top }} role="tooltip">
      <div className="t">
        <span>{names.get(f.id)}</span>
        <span style={{ color: STATUS_COLOR[run.status] ?? "var(--fg3)" }}>{run.status}</span>
      </div>
      {run.label && <div className="row muted">{run.id}</div>}
      <div className="row">
        <span>tokens/s</span>
        <b>{tps ? fmtInt(tps) : "–"}</b>
      </div>
      <div className="row">
        <span>subagents</span>
        <b>{f.agents.subs.length ? `${working} working · ${done} done` : "none"}</b>
      </div>
      {readsFrom.length > 0 && (
        <div className="row">
          <span>reads</span>
          <b>{readsFrom.join(", ")}</b>
        </div>
      )}
      {readBy.length > 0 && (
        <div className="row">
          <span>read by</span>
          <b>{readBy.join(", ")}</b>
        </div>
      )}
      {f.now && (
        <div className="row">
          <span>doing</span>
          <b>
            {f.now.tool} · {f.now.text}
          </b>
        </div>
      )}
    </div>
  );
}
