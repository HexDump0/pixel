/** Small building blocks shared by every page, styled with Tailwind over the design tokens. */
import { forwardRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { toast } from "./Toast.tsx";

export { cn as cx };

export type Variant = "default" | "primary" | "danger" | "ghost" | "warn";
export type Size = "md" | "sm" | "xs";

const VARIANT: Record<Variant, string> = {
  default: "border-line bg-s1 text-ink hover:enabled:border-ink-4 hover:enabled:bg-s2",
  primary: "border-ink bg-ink text-bg hover:enabled:opacity-90",
  danger: "border-line bg-s1 text-critical hover:enabled:border-critical/60 hover:enabled:bg-s2",
  warn: "border-line bg-s1 text-warning hover:enabled:border-warning/60 hover:enabled:bg-s2",
  ghost: "border-transparent bg-transparent text-ink-2 hover:enabled:bg-s3 hover:enabled:text-ink",
};
const SIZE: Record<Size, string> = {
  md: "h-8 px-3 text-[13px] gap-[7px] rounded-lg",
  sm: "h-[30px] px-2.5 text-[12.5px] gap-[7px] rounded-lg",
  xs: "h-[26px] px-2 text-xs gap-[5px] rounded-md",
};
const ICON_SIZE: Record<Size, string> = { md: "w-[34px] px-0", sm: "w-[30px] px-0", xs: "w-[26px] px-0" };

/** Class names for anything that should look like a button (links included). */
export const buttonClass = (variant: Variant = "default", size: Size = "md", icon = false, className?: string) =>
  cn(
    "inline-flex shrink-0 cursor-pointer items-center justify-center border font-medium whitespace-nowrap no-underline transition-colors hover:no-underline disabled:cursor-default disabled:opacity-45",
    VARIANT[variant],
    SIZE[size],
    icon && ICON_SIZE[size],
    className,
  );

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  variant?: Variant;
  size?: Size;
  /** Same as size="sm" (older call sites). */
  small?: boolean;
  /** Square, for a lone icon (give it an aria-label). */
  icon?: boolean;
  /** Async action; the button disables while it runs and errors become toasts. */
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => unknown | Promise<unknown>;
  /** Ask before running. */
  confirm?: string;
  /** Toast shown on success. */
  done?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", size, small, icon, onClick, confirm, done, className, disabled, children, type = "button", ...rest },
  ref,
) {
  const [busy, setBusy] = useState(false);
  const run = async (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!onClick) return;
    if (confirm && !window.confirm(confirm)) return;
    const out = onClick(e);
    if (!(out instanceof Promise)) {
      if (done) toast(done);
      return;
    }
    setBusy(true);
    try {
      await out;
      if (done) toast(done);
    } catch (err: any) {
      toast(err?.message ?? String(err), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <button ref={ref} type={type} className={buttonClass(variant, size ?? (small ? "sm" : "md"), icon, className)} disabled={disabled || busy} onClick={onClick ? run : undefined} {...rest}>
      {children}
    </button>
  );
});

export function Card({ title, actions, className, children }: { title?: ReactNode; actions?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={cn("min-w-0 rounded-2xl border border-line-2 bg-s1 p-4", className)}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="m-0 text-[13.5px] font-medium">{title}</h2>}
          {actions && <div className="flex flex-wrap gap-1.5">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Status pill for older pages; colours come from the .badge.<status> classes in index.css. */
export function Badge({ value, className }: { value: string | null | undefined; className?: string }) {
  if (!value) return null;
  return <span className={cn("badge", value, className)}>{value}</span>;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-xl border border-line-2 bg-s1 px-3 py-2.5">
      <div className="text-xs text-ink-3">{label}</div>
      <div className="mt-0.5 font-mono text-lg font-medium tabular-nums">{value}</div>
      {hint && <div className="text-[11.5px] text-ink-3">{hint}</div>}
    </div>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn("label", className)}>
      <span>{label}</span>
      {children}
      {hint && <span className="text-[11px]">{hint}</span>}
    </label>
  );
}

export function ErrorBox({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return <div className="rounded-lg border border-critical/45 bg-critical/10 px-3 py-2 text-sm text-critical">{error}</div>;
}

export function Notice({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-warning/45 bg-warning/10 px-3 py-2 text-sm">{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-8 text-center text-sm text-ink-3">{children}</div>;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div role="tablist" className="my-4 flex flex-wrap gap-0.5 border-b border-line-2 pb-2">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === value}
          onClick={() => onChange(t.id)}
          className="inline-flex h-[30px] items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-ink-3 hover:bg-s2 hover:text-ink aria-selected:bg-s3 aria-selected:text-ink"
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function CopyText({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("flex items-start gap-2", className)}>
      <code className="min-w-0 flex-1 rounded-md bg-s3 px-2 py-1 font-mono text-xs break-all">{text}</code>
      <Button size="xs" onClick={() => navigator.clipboard.writeText(text)} done="Copied">
        Copy
      </Button>
    </div>
  );
}

/** The one header every page that keeps its own layout uses. */
export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mt-4 mb-5 flex flex-wrap items-baseline gap-x-3 gap-y-2">
      <h1 className="m-0 min-w-0 text-[22px] font-medium tracking-[-0.02em] break-words">{title}</h1>
      {subtitle && <div className="text-sm text-ink-3">{subtitle}</div>}
      {actions && <div className="ml-auto flex flex-wrap items-center gap-1.5">{actions}</div>}
    </div>
  );
}

/** A small set of mutually exclusive choices shown side by side (time window, view). */
export function Segmented<T extends string | number>({ value, onChange, options, label, className }: { value: T; onChange: (v: T) => void; options: [T, ReactNode][]; label: string; className?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex h-[30px] items-center rounded-[9px] border border-line-2 bg-s1 p-0.5", className)}>
      {options.map(([v, l]) => (
        <button
          key={String(v)}
          type="button"
          role="radio"
          aria-checked={v === value}
          onClick={() => onChange(v)}
          className="inline-flex h-[24px] cursor-pointer items-center gap-1.5 rounded-[7px] px-2.5 text-[12.5px] text-ink-3 hover:text-ink aria-checked:bg-s3 aria-checked:text-ink"
        >
          {l}
        </button>
      ))}
    </div>
  );
}

/** An on/off setting: a switch with its label and an optional line of explanation. */
export function Switch({ checked, onChange, label, hint, disabled, className }: { checked: boolean; onChange: (on: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean; className?: string }) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-3", disabled && "cursor-default opacity-50", className)}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="mt-px inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border border-line bg-s3 p-[2px] transition-colors aria-checked:border-transparent aria-checked:bg-[var(--accent-c)] disabled:cursor-default"
      >
        <span className={cn("size-3 rounded-full bg-ink-2 transition-transform", checked && "translate-x-[14px] bg-white")} />
      </button>
      <span className="min-w-0 text-[13px]">
        {label}
        {hint && <span className="mt-0.5 block text-xs text-ink-3">{hint}</span>}
      </span>
    </label>
  );
}
