/** Change a run's machine size while it runs: a preset or CPU, memory and disk by hand. */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { IconCpu } from "@tabler/icons-react";
import { api } from "../lib/api.ts";
import { reloadRuns } from "../lib/runs.ts";
import type { Run } from "../lib/types.ts";
import { Button, Field } from "./ui.tsx";
import { IC_XS, Join } from "./ui/bits.tsx";
import { Dialog } from "./ui/overlay.tsx";
import { toast } from "./Toast.tsx";

type Size = Run["size"];
const listeners = new Set<(id: string) => void>();
/** Open the machine size dialog for a run (from any menu or the Machine tab). */
export const openSizeDialog = (id: string) => listeners.forEach((l) => l(id));

export const sizeText = (s: Size) => [`${s.cpu} CPU`, `${s.memoryGiB} GB`, `${s.diskGiB} GB disk`];
const same = (a: Size, b: Size) => a.cpu === b.cpu && a.memoryGiB === b.memoryGiB && a.diskGiB === b.diskGiB;

function Num({ label, value, onChange, unit, step = 1, min }: { label: string; value: number; onChange: (n: number) => void; unit: string; step?: number; min: number }) {
  return (
    <Field label={label}>
      <label className="input flex items-center gap-2 focus-within:border-accent/65 focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
        <input
          type="number"
          aria-label={label}
          min={min}
          step={step}
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full min-w-0 [appearance:textfield] bg-transparent text-right font-mono tabular-nums outline-none [&::-webkit-inner-spin-button]:appearance-none"
        />
        <span className="shrink-0 text-xs text-ink-3">{unit}</span>
      </label>
    </Field>
  );
}

/** Mounted once: the machine size dialog any menu can open. */
export function SizeDialogHost({ runs }: { runs: Run[] }) {
  const [id, setId] = useState<string | null>(null);
  const [size, setSize] = useState<Size | null>(null);
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.settings(), enabled: !!id });
  useEffect(() => {
    const l = (rid: string) => {
      setId(rid);
      setSize(null);
    };
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  const r = runs.find((x) => x.id === id);
  useEffect(() => {
    if (r && !size) setSize(r.size);
  }, [r, size]);
  const presets = Object.entries(settings.data?.sizePresets ?? {});
  const boost = r?.disk_boost;
  const shrinks = !!r && !!size && size.diskGiB < r.size.diskGiB;

  return (
    <Dialog
      open={!!id && !!size}
      onOpenChange={(o) => !o && setId(null)}
      size="md"
      title="Machine size"
      description="Applies right away, the agent keeps working."
      footer={
        r &&
        size && (
          <>
            <Button variant="ghost" onClick={() => setId(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={same(size, r.size)}
              onClick={async () => {
                try {
                  const res = await api.resize(r.id, size);
                  toast(res.notes.length ? `Machine resized. ${res.notes.join(". ")}` : "Machine resized");
                  setId(null);
                  void reloadRuns();
                } catch (e) {
                  toast((e as Error).message, "error");
                }
              }}
            >
              Apply
            </Button>
          </>
        )
      }
    >
      {r && size && (
        <div className="flex flex-col gap-4">
          {presets.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Preset">
              {presets.map(([k, p]) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={same(size, p)}
                  onClick={() => setSize(p)}
                  className="flex cursor-pointer flex-col gap-1 rounded-xl border border-line-2 bg-transparent px-3.5 py-3 text-left hover:border-line aria-checked:border-[color-mix(in_srgb,var(--accent-c)_60%,var(--line))] aria-checked:bg-[var(--accent-soft)]"
                >
                  <span className="flex items-center gap-2 text-[13px] font-medium text-ink">
                    <IconCpu {...IC_XS} className="text-ink-3" />
                    {k}
                  </span>
                  <span className="font-mono text-[11.5px] text-ink-3">
                    <Join items={sizeText(p)} />
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="grid grid-cols-3 gap-3">
            <Num label="CPU" value={size.cpu} onChange={(cpu) => setSize({ ...size, cpu })} unit="cores" min={1} />
            <Num label="Memory" value={size.memoryGiB} onChange={(memoryGiB) => setSize({ ...size, memoryGiB })} unit="GB" step={0.5} min={0.5} />
            <Num label="Disk" value={size.diskGiB} onChange={(diskGiB) => setSize({ ...size, diskGiB })} unit="GB" min={1} />
          </div>
          {(boost || shrinks) && (
            <p className="m-0 text-[13px] text-ink-3">
              {boost && size.diskGiB !== r.size.diskGiB
                ? `The disk has ${boost.extraGiB} GB extra for a cleanup right now; a new disk size replaces it.`
                : shrinks
                  ? "If the agent already uses more than this, the disk counts as full and the agent is asked to clean up."
                  : null}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
