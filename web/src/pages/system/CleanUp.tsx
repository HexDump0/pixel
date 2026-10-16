/** Clean-up of finished runs' transcripts and folders and the database (server/src/tidy.ts), and the copy saved before an upgrade. */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconDownload, IconLoader2 } from "@tabler/icons-react";
import { api } from "../../lib/api.ts";
import { bytes, dateTime } from "../../lib/format.ts";
import type { SystemInfo, TidyState } from "../../lib/types.ts";
import { Badge, Button, buttonClass, Card, ErrorBox, Segmented, Switch } from "../../components/ui.tsx";
import { IC_SM } from "../../components/ui/bits.tsx";

type Choice = "keep" | "slim" | "delete";
const busy = (s?: TidyState) => s?.phase === "measuring" || s?.phase === "working";

export function CleanUpCard({ onChanged }: { onChanged: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["tidy"], queryFn: api.tidy, refetchInterval: (x) => (busy(x.state.data) ? 1000 : false) });
  const s = q.data;
  const plan = s?.phase === "ready" ? s.plan : undefined;
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [opts, setOpts] = useState({ transcripts: true, copies: true, compact: true });

  useEffect(() => {
    if (!plan) return;
    setChoices(Object.fromEntries(plan.folders.map((f) => [f.id, f.status ? "slim" : "delete"])));
    setOpts({ transcripts: plan.transcripts.runs > 0, copies: plan.copies.files > 0, compact: plan.db.canCompact });
  }, [plan?.measuredAt]);
  useEffect(() => {
    if (s?.phase === "done") onChanged();
  }, [s?.phase]);

  const set = (next: TidyState) => qc.setQueryData(["tidy"], next);
  const measure = async () => set(await api.tidyMeasure());

  let body;
  if (!s) body = <ErrorBox error={q.error?.message} />;
  else if (busy(s))
    body = (
      <div className="flex items-center gap-2 text-sm text-ink-2">
        <IconLoader2 {...IC_SM} className="animate-spin" />
        {s.step}
      </div>
    );
  else if (plan) {
    const delCount = plan.folders.filter((f) => choices[f.id] === "delete").length;
    const freed =
      plan.folders.reduce((n, f) => n + (choices[f.id] === "slim" ? f.slimBytes : choices[f.id] === "delete" ? f.bytes : 0), 0) +
      (opts.copies ? plan.copies.bytes : 0) +
      (opts.transcripts && opts.compact ? plan.transcripts.bytes : 0);
    const setAll = (c: Choice) => setChoices(Object.fromEntries(plan.folders.map((f) => [f.id, !f.status && c === "slim" ? "delete" : c])));
    const apply = async () =>
      set(
        await api.tidyApply({
          transcripts: opts.transcripts,
          copies: opts.copies,
          compact: opts.compact,
          folders: Object.fromEntries(Object.entries(choices).filter(([, c]) => c !== "keep")) as Record<string, "slim" | "delete">,
        }),
      );
    body = (
      <div className="flex flex-col gap-4">
        {plan.transcripts.runs > 0 && (
          <Row size={plan.transcripts.bytes}>
            <Switch
              checked={opts.transcripts}
              onChange={(v) => setOpts({ ...opts, transcripts: v })}
              label={`Transcripts of ${plan.transcripts.runs} finished runs`}
              hint="Moved from the database to compressed files; the Transcript tab reads them as before"
            />
          </Row>
        )}
        {plan.copies.files > 0 && (
          <Row size={plan.copies.bytes}>
            <Switch checked={opts.copies} onChange={(v) => setOpts({ ...opts, copies: v })} label={`${plan.copies.files} old transcript copies`} hint="Written at finish before the redesign; nothing reads them" />
          </Row>
        )}
        {plan.folders.length > 0 && (
          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="text-[13px]">
                Run folders
                <span className="mt-0.5 block text-xs text-ink-3">Slim removes caches, untracked files in the checkout (build outputs) and temp files, and the run can still be resumed. Delete removes the whole folder; the workbase stays.</span>
              </div>
              <Segmented label="All run folders" value={"" as Choice} onChange={setAll} options={[["keep", "Keep all"], ["slim", "Slim all"], ["delete", "Delete all"]]} />
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr>
                  {["Run", "Status", "Size", "Slim frees", ""].map((h, i) => (
                    <th key={i} className={i >= 2 && i < 4 ? "th text-right" : "th"}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {plan.folders.map((f) => (
                  <tr key={f.id}>
                    <td className="td">{f.label ?? <span className="font-mono">{f.id}</span>}</td>
                    <td className="td">{f.status ? <Badge value={f.status} /> : <span className="text-ink-3">run deleted</span>}</td>
                    <td className="td text-right font-mono">{bytes(f.bytes)}</td>
                    <td className="td text-right font-mono text-ink-3">{f.status ? bytes(f.slimBytes) : ""}</td>
                    <td className="td text-right">
                      <Segmented
                        label={`Folder of ${f.label ?? f.id}`}
                        value={choices[f.id] ?? "keep"}
                        onChange={(c) => setChoices({ ...choices, [f.id]: c })}
                        options={f.status ? [["keep", "Keep"], ["slim", "Slim"], ["delete", "Delete"]] : [["keep", "Keep"], ["delete", "Delete"]]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Row size={plan.db.bytes}>
          <Switch
            checked={opts.compact}
            disabled={!plan.db.canCompact}
            onChange={(v) => setOpts({ ...opts, compact: v })}
            label="Compact the database"
            hint={plan.db.canCompact ? "Gives freed space back to the disk; Pixel pauses while it runs" : `Needs about ${bytes(2 * plan.db.inUse)} free; ${bytes(plan.disk.free)} is`}
          />
        </Row>
        <div className="flex items-center justify-end gap-3 border-t border-line-2 pt-3">
          <span className="text-sm text-ink-3">Up to {bytes(freed)} freed</span>
          <Button variant="primary" small onClick={apply} confirm={delCount ? `Delete ${delCount} run folders? Those runs can't be resumed afterwards.` : undefined}>
            Clean up
          </Button>
        </div>
      </div>
    );
  } else if (s.phase === "done")
    body = (
      <div className="text-sm">
        {s.error && <ErrorBox error={s.error} />}
        <ul className="m-0 list-none p-0 text-ink-2">
          {s.log.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
        {s.freed != null && <p className="mt-2 mb-0">{bytes(Math.max(0, s.freed))} of disk freed</p>}
      </div>
    );
  else body = s.error ? <ErrorBox error={s.error} /> : <p className="m-0 text-sm text-ink-3">Transcripts and folders of finished runs, and the database. Nothing changes until you choose.</p>;

  return (
    <Card
      title="Clean up"
      className="mb-4"
      actions={
        !busy(s) && (
          <Button small onClick={measure}>
            {s?.phase === "idle" ? "Measure" : "Measure again"}
          </Button>
        )
      }
    >
      {body}
    </Card>
  );
}

function Row({ size, children }: { size: number; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      {children}
      <span className="shrink-0 font-mono text-sm text-ink-2">{bytes(size)}</span>
    </div>
  );
}

/** The copy of the database saved before the last upgrade, or why there isn't one. */
export function PreUpgradeCard({ info, onChanged }: { info: NonNullable<SystemInfo["preUpgrade"]>; onChanged: () => void }) {
  const remove = async () => (await api.removePreUpgrade(), onChanged());
  return (
    <Card
      title="Before the upgrade"
      className="mb-4"
      actions={
        info.bytes ? (
          <>
            <a className={buttonClass("default", "sm")} href="/api/system/pre-upgrade.db" download>
              <IconDownload {...IC_SM} />
              Download
            </a>
            <Button small variant="danger" onClick={remove} confirm="Remove the copy of the database from before the upgrade?">
              Remove
            </Button>
          </>
        ) : (
          <Button small onClick={remove}>
            Dismiss
          </Button>
        )
      }
    >
      <p className="m-0 text-sm text-ink-2">
        {info.bytes
          ? `Pixel saved the database as it was (${bytes(info.bytes)}) when it upgraded on ${dateTime(info.ts)}. Remove it once everything looks right.`
          : `No copy of the database was saved when Pixel upgraded on ${dateTime(info.ts)}: ${info.skipped}.`}
      </p>
    </Card>
  );
}
