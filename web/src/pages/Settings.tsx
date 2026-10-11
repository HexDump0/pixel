/** All of Pixel's settings, edited as a draft and saved together. */
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api.ts";
import { useAsync } from "../lib/hooks.ts";
import type { Settings } from "../lib/types.ts";
import { Button, Card, ErrorBox, Field, PageHeader } from "../components/ui.tsx";

type Update = <K extends keyof Settings>(key: K, value: Settings[K]) => void;

function NumberField({ label, hint, value, onChange }: { label: string; hint?: ReactNode; value: number; onChange: (n: number) => void }) {
  return (
    <Field label={label} hint={hint}>
      <input className="input" type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </Field>
  );
}

/** Editable list of KEY=value pairs. */
function EnvEditor({ value, onChange }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const rows = Object.entries(value);
  const set = (i: number, k: string, v: string) => onChange(Object.fromEntries(rows.map((r, j) => (j === i ? [k, v] : r))));
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex gap-1.5">
          <input className="input w-56 font-mono" value={k} placeholder="NAME" onChange={(e) => set(i, e.target.value, v)} />
          <input className="input flex-1 font-mono" type="password" value={v} placeholder="value" onChange={(e) => set(i, k, e.target.value)} />
          <button className="btn btn-sm btn-danger" onClick={() => onChange(Object.fromEntries(rows.filter((_, j) => j !== i)))}>
            ✕
          </button>
        </div>
      ))}
      <button className="btn btn-sm self-start" onClick={() => onChange({ ...value, "": "" })}>
        Add variable
      </button>
    </div>
  );
}

function SizePresets({ s, update }: { s: Settings; update: Update }) {
  const entries = Object.entries(s.sizePresets);
  const set = (name: string, field: "cpu" | "memoryGiB" | "diskGiB", v: number) => update("sizePresets", { ...s.sizePresets, [name]: { ...s.sizePresets[name], [field]: v } });
  return (
    <div className="flex flex-col gap-2">
      <table className="text-sm">
        <thead>
          <tr>
            {["Preset", "CPU", "RAM (GiB)", "Disk (GiB)", ""].map((h) => (
              <th key={h} className="th">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map(([name, p]) => (
            <tr key={name}>
              <td className="td">
                <label className="flex items-center gap-1.5">
                  <input type="radio" checked={s.defaultSize === name} onChange={() => update("defaultSize", name)} title="default" />
                  {name}
                </label>
              </td>
              {(["cpu", "memoryGiB", "diskGiB"] as const).map((f) => (
                <td key={f} className="td">
                  <input className="input w-20" type="number" value={p[f]} onChange={(e) => set(name, f, Number(e.target.value))} />
                </td>
              ))}
              <td className="td">
                <button
                  className="btn btn-sm btn-danger"
                  disabled={entries.length < 2 || s.defaultSize === name}
                  onClick={() => update("sizePresets", Object.fromEntries(entries.filter(([n]) => n !== name)))}
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        className="btn btn-sm self-start"
        onClick={() => {
          const name = prompt("Preset name:");
          if (name) update("sizePresets", { ...s.sizePresets, [name]: { cpu: 2, memoryGiB: 4, diskGiB: 20 } });
        }}
      >
        Add preset
      </button>
      <div className="text-xs muted">The radio button marks the default. Keep the sum of running machines' RAM within the pixel host's budget.</div>
    </div>
  );
}

export function SettingsPage() {
  const loaded = useAsync(api.settings, []);
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (loaded.data) setS(loaded.data);
  }, [loaded.data]);
  if (!s) return <ErrorBox error={loaded.error} />;

  const update: Update = (k, v) => setS({ ...s, [k]: v });
  const notifyOn = (k: keyof Settings["notify"]["on"], v: boolean) => update("notify", { ...s.notify, on: { ...s.notify.on, [k]: v } });
  const save = async () => {
    try {
      const { defaults, ...rest } = s as Settings & { defaults?: unknown };
      setS(await api.saveSettings(rest));
      setError(null);
    } catch (e: any) {
      setError(e.message);
      throw e;
    }
  };

  return (
    <div>
      <PageHeader
        title="Settings"
        actions={
          <Button variant="primary" onClick={save} done="Settings saved">
            Save
          </Button>
        }
      />
      <ErrorBox error={error} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Models">
          <div className="flex flex-col gap-3">
            <Field label="Default model" hint="provider/model, as opencode names it">
              <input className="input font-mono" value={s.defaultModel} onChange={(e) => update("defaultModel", e.target.value)} />
            </Field>
            <Field label="Models offered in the new-run form (one per line)">
              <textarea className="input h-28 font-mono" value={s.models.join("\n")} onChange={(e) => update("models", e.target.value.split("\n").map((x) => x.trim()).filter(Boolean))} />
            </Field>
          </div>
        </Card>

        <Card title="Machine sizes">
          <SizePresets s={s} update={update} />
        </Card>

        <Card title="Recovery (autopilot)">
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField label="Automatic continues per run" value={s.maxAutoContinues} onChange={(v) => update("maxAutoContinues", v)} hint="When the agent stops without REPORT.md" />
            <NumberField label="OOM restarts per run" value={s.maxOomRestarts} onChange={(v) => update("maxOomRestarts", v)} />
            <NumberField label="Dismiss unanswered questions after (min)" value={s.questionTimeoutMin} onChange={(v) => update("questionTimeoutMin", v)} hint="0 = wait for you forever" />
            <NumberField label="Stop when machine disk is at (%)" value={s.diskFullPercent} onChange={(v) => update("diskFullPercent", v)} />
            <NumberField label="Workbase size limit (GiB)" value={s.workbaseLimitGiB} onChange={(v) => update("workbaseLimitGiB", v)} />
            <NumberField label="Workbase history snapshot every (min)" value={s.historyIntervalMin} onChange={(v) => update("historyIntervalMin", v)} hint="0 = off" />
            <Field label="Continue message" className="sm:col-span-2">
              <input className="input" value={s.continueMessage} onChange={(e) => update("continueMessage", e.target.value)} />
            </Field>
            <Field label="Message after an OOM kill" className="sm:col-span-2">
              <input className="input" value={s.oomMessage} onChange={(e) => update("oomMessage", e.target.value)} />
            </Field>
          </div>
        </Card>

        <Card title="Agent credentials">
          <div className="flex flex-col gap-3">
            <div className="text-xs muted">Injected into every new machine. Use read-only tokens only (e.g. a fine-grained GitHub token without write scopes).</div>
            <Field label="Environment variables (provider API keys, GITHUB_TOKEN…)">
              <EnvEditor value={s.agentEnv} onChange={(v) => update("agentEnv", v)} />
            </Field>
            <Field label="opencode auth.json (optional)" hint="Copied to ~/.local/share/opencode/auth.json in each machine">
              <textarea className="input h-24 font-mono text-xs" value={s.agentAuthJson} onChange={(e) => update("agentAuthJson", e.target.value)} />
            </Field>
          </div>
        </Card>

        <Card
          title="Notifications"
          actions={
            <Button small onClick={async () => (await save(), api.testNotify())} done="Test notification sent">
              Save & send test
            </Button>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="ntfy topic URL" className="sm:col-span-2" hint="e.g. https://ntfy.sh/your-secret-topic">
              <input className="input" value={s.notify.ntfyUrl} onChange={(e) => update("notify", { ...s.notify, ntfyUrl: e.target.value })} />
            </Field>
            <Field label="Telegram bot token">
              <input className="input" type="password" value={s.notify.telegramToken} onChange={(e) => update("notify", { ...s.notify, telegramToken: e.target.value })} />
            </Field>
            <Field label="Telegram chat id">
              <input className="input" value={s.notify.telegramChat} onChange={(e) => update("notify", { ...s.notify, telegramChat: e.target.value })} />
            </Field>
            <div className="flex flex-wrap gap-4 text-sm sm:col-span-2">
              {(["done", "stopped", "question", "failed"] as const).map((k) => (
                <label key={k} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={s.notify.on[k]} onChange={(e) => notifyOn(k, e.target.checked)} />
                  {k}
                </label>
              ))}
            </div>
          </div>
        </Card>

        <Card title="Backups (restic)">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Repository" className="sm:col-span-2" hint="e.g. sftp:user@host:/backups/pixel or s3:https://…/bucket">
              <input className="input font-mono" value={s.backup.repository} onChange={(e) => update("backup", { ...s.backup, repository: e.target.value })} />
            </Field>
            <Field label="Repository password">
              <input className="input" type="password" value={s.backup.password} onChange={(e) => update("backup", { ...s.backup, password: e.target.value })} />
            </Field>
            <NumberField label="Daily backup hour (0–23, -1 = off)" value={s.backup.dailyHour} onChange={(v) => update("backup", { ...s.backup, dailyHour: v })} />
            <Field label="Extra environment (e.g. AWS_ACCESS_KEY_ID)" className="sm:col-span-2">
              <EnvEditor value={s.backup.env} onChange={(v) => update("backup", { ...s.backup, env: v })} />
            </Field>
          </div>
        </Card>
      </div>
    </div>
  );
}
