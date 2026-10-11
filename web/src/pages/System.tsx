/** Pixel host resources, machines, runtime/image info and backups. */
import { api } from "../lib/api.ts";
import { useAsync } from "../lib/hooks.ts";
import { bytes, dateTime } from "../lib/format.ts";
import { Badge, Button, Card, Empty, ErrorBox, PageHeader, Stat } from "../components/ui.tsx";

export function SystemPage() {
  const sys = useAsync(api.system, []);
  const s = sys.data;
  if (!s) return <ErrorBox error={sys.error} />;
  const memUsed = s.host.memTotal - s.host.memFree;
  const memTotalGiB = s.host.memTotal / 1024 ** 3;
  const image = s.runtime.image;

  return (
    <div>
      <PageHeader
        title="System"
        actions={
          <Button small onClick={sys.reload}>
            Refresh
          </Button>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <Stat label="Host memory" value={`${bytes(memUsed)} / ${bytes(s.host.memTotal)}`} hint={`${s.host.cpus} CPUs · load ${s.host.load.map((l) => l.toFixed(2)).join(" ")}`} />
        <Stat
          label="RAM promised to machines"
          value={`${s.committedMemoryGiB} GiB`}
          hint={s.committedMemoryGiB > memTotalGiB - 1.5 ? "over budget: stop or delete some machines" : `of ~${(memTotalGiB - 1.5).toFixed(0)} GiB available`}
        />
        <Stat label="Data disk free" value={s.host.disk ? bytes(s.host.disk.free) : "–"} hint={s.host.disk ? `of ${bytes(s.host.disk.total)} · ${s.host.dataDir}` : undefined} />
        <Stat label="Database" value={bytes(s.dbBytes)} hint={`${bytes(s.indexedBytes)} of workbase files indexed`} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Runtime">
          {s.runtime.error ? (
            <ErrorBox error={`Runtime not reachable: ${s.runtime.error}`} />
          ) : (
            <dl className="grid grid-cols-[140px_1fr] gap-y-1 text-sm">
              <dt className="muted">Runtime</dt>
              <dd>{s.runtime.runtime}</dd>
              {s.runtime.server && (
                <>
                  <dt className="muted">Incus</dt>
                  <dd>
                    {s.runtime.server} · kernel {s.runtime.kernel} · storage {s.runtime.storage}
                  </dd>
                </>
              )}
              {image && (
                <>
                  <dt className="muted">Image</dt>
                  <dd>{image.missing ? <span className="text-red-500">{image.alias} is missing: build it with image/build.sh</span> : `${image.alias} · ${image.fingerprint} · ${dateTime(Date.parse(image.created))} · ${image.description ?? ""}`}</dd>
                </>
              )}
              {s.runtime.note && (
                <>
                  <dt className="muted">Note</dt>
                  <dd>{s.runtime.note}</dd>
                </>
              )}
            </dl>
          )}
        </Card>
        <Card
          title="Backups"
          actions={
            <Button small onClick={async () => (await api.backup(), sys.reload())} disabled={s.backup.running} done="Backup finished">
              {s.backup.running ? "Running…" : "Back up now"}
            </Button>
          }
        >
          {s.backup.last ? (
            <div className="text-sm">
              Last backup {dateTime(s.backup.last.ts)}: <Badge value={s.backup.last.ok ? "done" : "failed"} />
              <pre className="mt-2 max-h-48 overflow-auto font-mono text-xs whitespace-pre-wrap muted">{s.backup.last.output}</pre>
            </div>
          ) : (
            <Empty>No backup yet. Configure restic in Settings.</Empty>
          )}
        </Card>
        <Card title={`Machines (${s.machines.length})`} className="xl:col-span-2">
          {s.machines.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr>
                  {["Name", "State", "CPU limit", "Memory in use"].map((h) => (
                    <th key={h} className="th">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {s.machines.map((m) => (
                  <tr key={m.name}>
                    <td className="td font-mono">{m.name}</td>
                    <td className="td">{m.status}</td>
                    <td className="td">{m.cpu ?? "–"}</td>
                    <td className="td">{bytes(m.memory)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No machines.</Empty>
          )}
        </Card>
      </div>
    </div>
  );
}
