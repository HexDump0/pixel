/** The run's machine: what it is, how full it is over the run's life, its snapshots, and start / stop / delete. */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { area, curveMonotoneX, line } from "d3-shape";
import { IconCamera, IconDots, IconPlayerPlay, IconPlayerStop, IconRestore, IconTrash } from "@tabler/icons-react";
import { api } from "../../lib/api.ts";
import { useLive } from "../../lib/live.ts";
import { ago, bytes, dateTime } from "../../lib/format.ts";
import { cn } from "../../lib/cn.ts";
import type { MetricRow, RunDetail } from "../../lib/types.ts";
import { Button } from "../../components/ui.tsx";
import { Menu } from "../../components/ui/overlay.tsx";
import { IC_SM, Nothing, SectionHead } from "../../components/ui/bits.tsx";
import { ChartTip, TipRow, TipTitle, niceMax, useSize, type TipState } from "../../components/charts/common.tsx";
import { toast } from "../../components/Toast.tsx";

const H = 64;

/** One resource over time: the latest value on top, an area under the line, the limit (if any) as the top. */
function Meter({ title, rows, pick, limit, fmt, color }: { title: string; rows: MetricRow[]; pick: (r: MetricRow) => number | null; limit?: number | null; fmt: (v: number) => string; color: string }) {
  const [ref, { w }] = useSize<HTMLDivElement>();
  const [tip, setTip] = useState<TipState | null>(null);
  const [hi, setHi] = useState<number | null>(null);
  const pts = rows.flatMap((r) => (pick(r) == null ? [] : [[r.ts, pick(r)!] as [number, number]]));
  const last = pts[pts.length - 1]?.[1] ?? null;
  const t0 = pts[0]?.[0] ?? 0;
  const t1 = pts[pts.length - 1]?.[0] ?? 1;
  const max = limit ?? niceMax(Math.max(1e-6, ...pts.map((p) => p[1])) * 1.1);
  const X = (t: number) => (t1 > t0 ? ((t - t0) / (t1 - t0)) * w : w);
  const Y = (v: number) => H - 2 - (Math.min(v, max) / max) * (H - 6);
  const ar = area<[number, number]>().x((d) => X(d[0])).y0(H).y1((d) => Y(d[1])).curve(curveMonotoneX);
  const ln = line<[number, number]>().x((d) => X(d[0])).y((d) => Y(d[1])).curve(curveMonotoneX);
  const pct = last != null && limit ? last / limit : null;
  return (
    <div className="min-w-0 rounded-xl border border-line-2 bg-s2 px-3.5 pt-3 pb-2.5">
      <div className="flex items-baseline gap-1.5">
        <span className="mr-auto text-[12.5px] text-ink-3">{title}</span>
        <b className={cn("text-[15px] font-medium tabular-nums", pct != null && pct > 0.9 && "text-critical", pct != null && pct > 0.75 && pct <= 0.9 && "text-warning")}>{last == null ? "–" : fmt(last)}</b>
        {limit != null && <small className="font-mono text-[11.5px] text-ink-3">of {fmt(limit)}</small>}
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

const pctFmt = (v: number) => `${Math.round(v)}%`;
const gb = (v: number) => (v >= 1024 ** 3 ? `${(v / 1024 ** 3).toFixed(1)} GB` : bytes(v));

export function MachineTab({ detail, onChange }: { detail: RunDetail; onChange: () => void }) {
  const r = detail.run;
  const vm = useQuery({ queryKey: ["vm", r.id, r.status], queryFn: () => api.vm(r.id) });
  const metrics = useQuery({ queryKey: ["metrics", r.id], queryFn: () => api.metrics(r.id) });
  const snaps = useQuery({ queryKey: ["snapshots", r.id], queryFn: () => api.snapshots(r.id) });
  const [rows, setRows] = useState<MetricRow[] | null>(null);
  useLive(r.id, (m) => {
    if (m.type === "metrics")
      setRows((xs) => [
        ...(xs ?? metrics.data ?? []),
        { ts: m.data.ts, cpu: m.data.cpu ?? null, mem_used: m.data.memUsed ?? null, mem_total: m.data.memTotal ?? null, disk_used: m.data.diskUsed ?? null, disk_total: m.data.diskTotal ?? null, workbase_bytes: m.data.workbase, tokens: null, cost: null },
      ]);
  });
  const m = rows ?? metrics.data ?? [];
  const act = (fn: () => Promise<unknown>, done?: string) => async () => {
    try {
      await fn();
      if (done) toast(done);
    } catch (e) {
      toast((e as Error).message, "error");
    }
    await Promise.all([vm.refetch(), snaps.refetch()]);
    onChange();
  };
  const ask = (text: string, fn: () => Promise<unknown>, done?: string) => () => {
    if (confirm(text)) void act(fn, done)();
  };
  const state = vm.data?.state ?? "…";
  const running = /running/i.test(state);
  const lastMem = [...m].reverse().find((x) => x.mem_total)?.mem_total ?? r.size.memoryGiB * 1024 ** 3;
  const lastDisk = [...m].reverse().find((x) => x.disk_total)?.disk_total ?? r.size.diskGiB * 1024 ** 3;
  const incus = r.runtime === "incus";

  const fact = (k: string, v: React.ReactNode) => (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 border-t border-line-2 py-[7px] text-[13px] first:border-t-0">
      <dt className="text-ink-3">{k}</dt>
      <dd className="m-0 truncate font-mono text-[12.5px] text-ink">{v}</dd>
    </div>
  );

  return (
    <div className="mx-auto flex max-w-[980px] flex-col gap-8 px-7 pt-6 pb-12 max-md:px-4">
      <section>
        <SectionHead
          title="Machine"
          right={
            <div className="flex items-center gap-1.5">
              {!running && (
                <Button size="sm" onClick={act(() => api.vmAction(r.id, "start"), "Machine started")}>
                  <IconPlayerPlay {...IC_SM} />
                  Start
                </Button>
              )}
              {incus && (
                <Button size="sm" onClick={act(() => api.vmAction(r.id, "snapshot"), "Snapshot taken")}>
                  <IconCamera {...IC_SM} />
                  Snapshot
                </Button>
              )}
              <Menu
                trigger={
                  <Button size="sm" icon variant="ghost" aria-label="More machine actions">
                    <IconDots {...IC_SM} />
                  </Button>
                }
                items={[
                  { label: "Stop the machine", icon: <IconPlayerStop {...IC_SM} />, disabled: !running, onSelect: ask("Stop the machine? An active run will be marked stopped.", () => api.vmAction(r.id, "stop"), "Machine stopped") },
                  "-",
                  { label: "Delete the machine", danger: true, icon: <IconTrash {...IC_SM} />, disabled: !r.vm_name, onSelect: ask("Delete the machine? The workbase is kept; everything else on the machine is lost.", () => api.deleteVm(r.id), "Machine deleted") },
                ]}
              />
            </div>
          }
        />
        <dl className="m-0 flex flex-col">
          {fact(
            "State",
            <span className={cn(!running && "text-ink-2")}>
              {state}
              {running && !vm.data?.opencode && <span className="text-warning"> · opencode not answering</span>}
            </span>,
          )}
          {fact("Name", r.vm_name ?? "–")}
          {fact("Size", `${r.size.cpu} CPU · ${r.size.memoryGiB} GB memory · ${r.size.diskGiB} GB disk`)}
          {fact("Runtime", r.runtime)}
          {r.endpoint && fact("opencode", r.endpoint)}
        </dl>
      </section>

      <section>
        <SectionHead title="Over the run" />
        <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
          <Meter title={`CPU · ${r.size.cpu} cores`} rows={m} pick={(x) => x.cpu} limit={100} fmt={pctFmt} color="var(--r1)" />
          <Meter title="Memory" rows={m} pick={(x) => x.mem_used} limit={lastMem} fmt={gb} color="var(--r2)" />
          <Meter title="Disk" rows={m} pick={(x) => x.disk_used} limit={lastDisk} fmt={gb} color="var(--r5)" />
          <Meter title="Workbase" rows={m} pick={(x) => x.workbase_bytes} fmt={bytes} color="var(--r0)" />
        </div>
      </section>

      <section>
        <SectionHead title="Snapshots" meta={snaps.data?.length ? String(snaps.data.length) : undefined} />
        {snaps.data?.length ? (
          <ul className="m-0 flex list-none flex-col overflow-hidden rounded-xl border border-line-2 p-0">
            {snaps.data.map((s) => (
              <li key={s.name} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4 border-t border-line-2 px-3.5 py-2 text-[13px] first:border-t-0">
                <span className="truncate font-mono text-[12.5px]">{s.name}</span>
                <span className="text-ink-3" title={dateTime(Date.parse(s.created))}>{ago(Date.parse(s.created))}</span>
                <Button size="xs" variant="ghost" onClick={ask(`Restore ${s.name}? The machine's disk goes back to that point; the workbase on the host is not affected.`, () => api.vmAction(r.id, "restore", s.name), "Restored")}>
                  <IconRestore size={12} stroke={2} />
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <Nothing>{incus ? "No snapshots yet." : `The ${r.runtime} runtime doesn't take machine snapshots; the workbase still has its own history in Files.`}</Nothing>
        )}
      </section>
    </div>
  );
}
