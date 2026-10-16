/** Building blocks of the Settings page: a section panel of rows, a row with its label, number and env inputs. */
import type { ReactNode } from "react";
import { IconArrowBackUp, IconPlus, IconX } from "@tabler/icons-react";
import { cn } from "../../lib/cn.ts";
import { Button } from "../../components/ui.tsx";
import { IC_SM, IC_XS, SectionHead } from "../../components/ui/bits.tsx";

export function Section({ id, icon, title, meta, right, children }: { id: string; icon: ReactNode; title: string; meta?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} data-section className="scroll-mt-[84px]">
      <SectionHead icon={icon} title={title} meta={meta} right={right} className="mb-2.5 min-h-[30px]" />
      <div className="divide-y divide-line-2 rounded-2xl border border-line-2 bg-s1">{children}</div>
    </section>
  );
}

/**
 * One setting: label and an optional hint on the left, the control on the right (below on narrow
 * screens, or always with `wide`). `reset` shows a way back to the default when the value differs.
 */
export function Row({ label, hint, wide, reset, children, className }: { label: ReactNode; hint?: ReactNode; wide?: boolean; reset?: { show: boolean; to: string; onReset: () => void }; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("grid items-start gap-x-8 gap-y-2.5 px-4 py-3.5", !wide && "sm:grid-cols-[minmax(0,1fr)_auto]", className)}>
      <div className="min-w-0">
        <div className="flex min-h-[20px] items-center gap-1.5 text-[13px] text-ink">
          {label}
          {reset?.show && (
            <button type="button" onClick={reset.onReset} title={`Back to the default, ${reset.to}`} className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-ink-3 hover:bg-s3 hover:text-ink">
              <IconArrowBackUp {...IC_XS} />
              Default {reset.to}
            </button>
          )}
        </div>
        {hint && <div className="mt-0.5 max-w-[62ch] text-xs leading-relaxed text-ink-3">{hint}</div>}
      </div>
      {children !== undefined && <div className={cn("flex min-w-0 items-center gap-2", !wide && "sm:justify-end")}>{children}</div>}
    </div>
  );
}

/** A number with its unit inside the field; `zero` names what 0 means (off, never). */
export function NumberInput({ value, onChange, unit, zero, min = 0, max, width = "w-[132px]", label }: { value: number; onChange: (n: number) => void; unit?: string; zero?: string; min?: number; max?: number; width?: string; label: string }) {
  const off = zero !== undefined && value === 0;
  return (
    <label className={cn("input flex items-center gap-2 focus-within:border-accent/65 focus-within:shadow-[0_0_0_3px_var(--accent-soft)]", width)}>
      <input
        type="number"
        aria-label={label}
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
        className={cn("w-full min-w-0 [appearance:textfield] bg-transparent text-right font-mono tabular-nums outline-none [&::-webkit-inner-spin-button]:appearance-none", off && "text-ink-3")}
      />
      {(unit || off) && <span className={cn("shrink-0 text-xs", off ? "text-warning" : "text-ink-3")}>{off ? zero : unit}</span>}
    </label>
  );
}

/** Editable KEY=value pairs; `tag` can label a row (which provider reads it). */
export function EnvEditor({ value, onChange, tag, placeholder = "NAME" }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void; tag?: (name: string) => ReactNode; placeholder?: string }) {
  const rows = Object.entries(value);
  const set = (i: number, k: string, v: string) => onChange(Object.fromEntries(rows.map((r, j) => (j === i ? [k, v] : r))));
  return (
    <div className="flex w-full flex-col gap-1.5">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input className="input w-[38%] min-w-[140px] font-mono text-[12.5px]" value={k} placeholder={placeholder} spellCheck={false} onChange={(e) => set(i, e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"), v)} />
          <input className="input flex-1 font-mono text-[12.5px]" type="password" autoComplete="off" value={v} placeholder="value" onChange={(e) => set(i, k, e.target.value)} />
          {tag && <span className="hidden w-[120px] shrink-0 truncate text-xs text-ink-3 md:block">{tag(k)}</span>}
          <Button size="sm" icon variant="ghost" aria-label={`Remove ${k || "this variable"}`} className="hover:enabled:text-critical" onClick={() => onChange(Object.fromEntries(rows.filter((_, j) => j !== i)))}>
            <IconX {...IC_SM} />
          </Button>
        </div>
      ))}
      <Button size="xs" variant="ghost" className="self-start text-ink-3" onClick={() => onChange({ ...value, "": "" })} disabled={"" in value}>
        <IconPlus {...IC_XS} />
        Add variable
      </Button>
    </div>
  );
}

/** Small status line: a dot and a few words. */
export function State({ tone, children, title }: { tone: "good" | "bad" | "off" | "warn"; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex min-w-0 items-center gap-[7px] text-[12.5px]", tone === "bad" ? "text-critical" : tone === "warn" ? "text-warning" : "text-ink-3")}>
      <span className={cn("size-1.5 shrink-0 rounded-full", tone === "good" ? "bg-good" : tone === "bad" ? "bg-critical" : tone === "warn" ? "bg-warning" : "bg-transparent ring-[1.5px] ring-ink-4 ring-inset")} />
      <span className="truncate">{children}</span>
    </span>
  );
}

/** A bare on/off switch for a Row (the row carries the label). */
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border border-line bg-s3 p-[2px] transition-colors aria-checked:border-transparent aria-checked:bg-accent disabled:cursor-default disabled:opacity-50"
    >
      <span className={cn("size-3 rounded-full bg-ink-2 transition-transform", checked && "translate-x-[14px] bg-white")} />
    </button>
  );
}
