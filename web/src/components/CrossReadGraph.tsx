/** Circle-layout graph of runs reading other runs' workbases. Edge width = number of reads. */
import type { CrossReadEdge } from "../lib/types.ts";
import { navigate } from "../lib/router.tsx";

const SIZE = 480;
const R = 180;

export function CrossReadGraph({ edges }: { edges: CrossReadEdge[] }) {
  const real = edges.filter((e) => e.other_run !== "*");
  const nodes = [...new Set(real.flatMap((e) => [e.run_id, e.other_run]))].sort();
  if (!nodes.length) return <div className="py-8 text-center text-sm muted">Only index lookups so far, no reads of another run's workbase.</div>;
  const pos = new Map(nodes.map((n, i) => [n, { x: SIZE / 2 + R * Math.cos((2 * Math.PI * i) / nodes.length - Math.PI / 2), y: SIZE / 2 + R * Math.sin((2 * Math.PI * i) / nodes.length - Math.PI / 2) }]));
  const maxN = Math.max(...real.map((e) => e.n));

  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="mx-auto block w-full max-w-xl">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="16" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0L10,5L0,10z" className="fill-zinc-400" />
        </marker>
      </defs>
      {real.map((e, i) => {
        const a = pos.get(e.run_id)!;
        const b = pos.get(e.other_run)!;
        return (
          <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="stroke-zinc-400" strokeOpacity={0.7} strokeWidth={1 + (3 * e.n) / maxN} markerEnd="url(#arrow)">
            <title>{`${e.run_id} read ${e.other_run} ${e.n}×`}</title>
          </line>
        );
      })}
      {nodes.map((n) => {
        const p = pos.get(n)!;
        return (
          <g key={n} className="cursor-pointer" onClick={() => navigate(`/runs/${encodeURIComponent(n)}`)}>
            <circle cx={p.x} cy={p.y} r={7} className="fill-white stroke-accent dark:fill-zinc-900" strokeWidth={2} />
            <text x={p.x} y={p.y - 12} textAnchor="middle" className="fill-zinc-700 text-[11px] dark:fill-zinc-300">
              {n}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
