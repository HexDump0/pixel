/** The run's machine: state, resources over time, snapshots and lifecycle controls. */
import { api } from "../../lib/api.ts";
import { useAsync } from "../../lib/hooks.ts";
import { useLive } from "../../lib/live.ts";
import { bytes, dateTime, money, tokens } from "../../lib/format.ts";
import type { RunDetail } from "../../lib/types.ts";
import { LineChart } from "../../components/LineChart.tsx";
import { Button, Card, Empty } from "../../components/ui.tsx";

export function MachineTab({ detail, onChange }: { detail: RunDetail; onChange: () => void }) {
  const r = detail.run;
  const vm = useAsync(() => api.vm(r.id), [r.id, r.status]);
  const metrics = useAsync(() => api.metrics(r.id), [r.id]);
  const snaps = useAsync(() => api.snapshots(r.id), [r.id]);
  useLive(r.id, (m) => {
    if (m.type === "metrics")
      metrics.setData((xs = []) => [
        ...xs,
        { ts: m.data.ts, cpu: m.data.cpu ?? null, mem_used: m.data.memUsed ?? null, mem_total: m.data.memTotal ?? null, disk_used: m.data.diskUsed ?? null, disk_total: m.data.diskTotal ?? null, workbase_bytes: m.data.workbase, tokens: null, cost: null },
      ]);
  });
  const act = (fn: () => Promise<unknown>) => async () => {
    await fn();
    await Promise.all([vm.reload(), snaps.reload()]);
    onChange();
  };
  const m = metrics.data ?? [];
  const memLimit = r.size.memoryGiB * 1024 ** 3;

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Machine"
        actions={
          <>
            <Button small onClick={act(() => api.vmAction(r.id, "start"))}>
              Start
            </Button>
            <Button small onClick={act(() => api.vmAction(r.id, "stop"))} confirm="Stop the machine? An active run will be marked stopped.">
              Stop
            </Button>
            <Button small onClick={act(() => api.vmAction(r.id, "snapshot"))} done="Snapshot taken">
              Snapshot
            </Button>
            <Button small variant="danger" onClick={act(() => api.deleteVm(r.id))} confirm="Delete the machine? The workbase is kept, everything else on the machine is lost.">
              Delete machine
            </Button>
          </>
        }
      >
        <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div>
            State: <b>{vm.data?.state ?? "…"}</b> · opencode {vm.data?.opencode ? "answering" : "not answering"}
          </div>
          <div>
            Name: <span className="font-mono">{r.vm_name ?? "–"}</span>
          </div>
          <div>
            Size: {r.size.cpu} CPU · {r.size.memoryGiB} GiB RAM · {r.size.diskGiB} GiB disk
          </div>
          <div>
            Endpoint: <span className="font-mono">{r.endpoint ?? "–"}</span>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="CPU">
          <LineChart points={m.map((x) => ({ t: x.ts, v: x.cpu }))} format={(v) => `${v.toFixed(0)}%`} />
        </Card>
        <Card title="Memory">
          <LineChart points={m.map((x) => ({ t: x.ts, v: x.mem_used }))} format={bytes} max={memLimit} />
        </Card>
        <Card title="Machine disk">
          <LineChart points={m.map((x) => ({ t: x.ts, v: x.disk_used }))} format={bytes} max={r.size.diskGiB * 1024 ** 3} />
        </Card>
        <Card title="Workbase size">
          <LineChart points={m.map((x) => ({ t: x.ts, v: x.workbase_bytes }))} format={bytes} />
        </Card>
        <Card title="Tokens">
          <LineChart points={m.map((x) => ({ t: x.ts, v: x.tokens }))} format={tokens} />
        </Card>
        <Card title="Cost">
          <LineChart points={m.map((x) => ({ t: x.ts, v: x.cost }))} format={money} />
        </Card>
      </div>

      <Card title="Snapshots">
        {snaps.data?.length ? (
          <table className="w-full text-sm">
            <tbody>
              {snaps.data.map((s) => (
                <tr key={s.name}>
                  <td className="td font-mono">{s.name}</td>
                  <td className="td muted">{dateTime(Date.parse(s.created))}</td>
                  <td className="td text-right">
                    <Button small onClick={act(() => api.vmAction(r.id, "restore", s.name))} confirm={`Restore ${s.name}? The machine's disk goes back to that point; the workbase on the host is not affected.`}>
                      Restore
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No snapshots{r.runtime !== "incus" ? ` (the ${r.runtime} runtime has no snapshots)` : ""}.</Empty>
        )}
      </Card>
    </div>
  );
}
