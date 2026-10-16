/** The run's machine: what it is, how full it is over the run's life, its snapshots, and start / stop / delete. */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { IconCamera, IconDots, IconPlayerPlay, IconPlayerStop, IconRestore, IconTrash } from "@tabler/icons-react";
import { api } from "../../lib/api.ts";
import { useLive } from "../../lib/live.ts";
import { ago, bytes, dateTime } from "../../lib/format.ts";
import { cn } from "../../lib/cn.ts";
import type { MetricRow, ProcessKind, RunDetail } from "../../lib/types.ts";
import { Button } from "../../components/ui.tsx";
import { Menu } from "../../components/ui/overlay.tsx";
import { IC_SM, Nothing, SectionHead } from "../../components/ui/bits.tsx";
import { Meter } from "../../components/charts/Meter.tsx";
import { toast } from "../../components/Toast.tsx";

const series = (rows: MetricRow[], pick: (r: MetricRow) => number | null) => rows.flatMap((r) => (pick(r) == null ? [] : [[r.ts, pick(r)!] as [number, number]]));
const pctFmt = (v: number) => `${Math.round(v)}%`;
const gb = (v: number) => (v >= 1024 ** 3 ? `${(v / 1024 ** 3).toFixed(1)} GB` : bytes(v));

const KINDS: [ProcessKind, string, string][] = [
  ["opencode", "opencode", "var(--r1)"],
  ["lsp", "Language servers", "var(--r2)"],
  ["mcp", "MCP servers", "var(--r3)"],
  ["agent", "Agent's processes", "var(--r0)"],
];
const kindColor = (k: ProcessKind) => KINDS.find((x) => x[0] === k)![2];
const SHOWN = 10;

/** What uses the machine's memory right now, by kind and by process. */
function Processes({ runId, limit, live }: { runId: string; limit: number; live: boolean }) {
  const q = useQuery({ queryKey: ["processes", runId], queryFn: () => api.processes(runId), refetchInterval: live ? 5000 : false });
  const [all, setAll] = useState(false);
  const ps = q.data ?? [];
  const total = ps.reduce((a, p) => a + p.rss, 0);
  const kinds = KINDS.map(([k, label, color]) => ({ k, label, color, rss: ps.filter((p) => p.kind === k).reduce((a, p) => a + p.rss, 0) })).filter((x) => x.rss > 0);
  const scale = Math.max(limit, total);
  return (
    <section>
      <SectionHead title="Processes" meta={ps.length ? String(ps.length) : undefined} />
      {!ps.length ? (
        <Nothing>{q.isLoading ? "…" : "Nothing running"}</Nothing>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line-2">
          <div className="bg-s2 px-3.5 pt-3 pb-2.5">
            <div className="flex items-baseline gap-1.5">
              <span className="mr-auto text-[12.5px] text-ink-3">Memory</span>
              <b className="text-[15px] font-medium tabular-nums">{gb(total)}</b>
              <small className="font-mono text-[11.5px] text-ink-3">of {gb(limit)}</small>
            </div>
            <div className="mt-2.5 flex h-2 overflow-hidden rounded-full bg-s3">
              {kinds.map((x) => (
                <div key={x.k} title={`${x.label}: ${gb(x.rss)}`} style={{ width: `${(x.rss / scale) * 100}%`, background: x.color }} />
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-3">
              {kinds.map((x) => (
                <span key={x.k} className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-full" style={{ background: x.color }} />
                  {x.label}
                  <span className="font-mono text-ink-2 tabular-nums">{gb(x.rss)}</span>
                </span>
              ))}
            </div>
          </div>
          <ul className="m-0 list-none p-0">
            {(all ? ps : ps.slice(0, SHOWN)).map((p) => (
              <li key={p.pid} className="grid grid-cols-[minmax(0,1fr)_52px_72px] items-center gap-3 border-t border-line-2 px-3.5 py-[7px] text-[13px]">
                <span className="flex min-w-0 items-center gap-2" title={`${p.cmd}\npid ${p.pid}`}>
                  <span className="size-2 shrink-0 rounded-full" style={{ background: kindColor(p.kind) }} />
                  <span className="shrink-0 font-mono text-[12.5px] text-ink">{p.name}</span>
                  <span className="truncate font-mono text-[11.5px] text-ink-4">{p.cmd}</span>
                </span>
                <span className="text-right font-mono text-[12px] text-ink-3 tabular-nums">{p.cpu == null ? "" : `${Math.round(p.cpu)}%`}</span>
                <span className="text-right font-mono text-[12.5px] tabular-nums">{gb(p.rss)}</span>
              </li>
            ))}
          </ul>
          {ps.length > SHOWN && (
            <button className="w-full border-t border-line-2 py-2 text-[12.5px] text-ink-3 hover:bg-s2 hover:text-ink" onClick={() => setAll(!all)}>
              {all ? "Show fewer" : `Show all ${ps.length}`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

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
              {r.asleep ? (
                <span className="text-ink-3"> · opencode stopped to free memory; it starts again on resume or a message</span>
              ) : (
                running && !vm.data?.opencode && <span className="text-warning"> · opencode not answering</span>
              )}
            </span>,
          )}
          {fact("Name", r.vm_name ?? "–")}
          {fact("Size", `${r.size.cpu} CPU · ${r.size.memoryGiB} GB memory · ${r.size.diskGiB} GB disk`)}
          {fact("Runtime", r.runtime)}
          {r.endpoint && fact("opencode", r.endpoint)}
        </dl>
      </section>

      <Processes runId={r.id} limit={lastMem} live={running} />

      <section>
        <SectionHead title="Over the run" />
        <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
          <Meter title={`CPU · ${r.size.cpu} cores`} points={series(m, (x) => x.cpu)} limit={100} fmt={pctFmt} color="var(--r1)" warn={0.75} bad={0.9} />
          <Meter title="Memory" points={series(m, (x) => x.mem_used)} limit={lastMem} fmt={gb} color="var(--r2)" warn={0.75} bad={0.9} />
          <Meter title="Disk" points={series(m, (x) => x.disk_used)} limit={lastDisk} fmt={gb} color="var(--r5)" warn={0.75} bad={0.9} />
          <Meter title="Workbase" points={series(m, (x) => x.workbase_bytes)} fmt={bytes} color="var(--r0)" />
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
