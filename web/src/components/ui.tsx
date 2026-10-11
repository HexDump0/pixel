/** Small presentational building blocks shared by every page. */
import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { toast } from "./Toast.tsx";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
export { cx };

type Variant = "default" | "primary" | "danger";

interface ActionButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  variant?: Variant;
  small?: boolean;
  /** Async action; the button disables while it runs and errors become toasts. */
  onClick?: () => unknown | Promise<unknown>;
  /** Ask before running. */
  confirm?: string;
  /** Toast shown on success. */
  done?: string;
}

export function Button({ variant = "default", small, onClick, confirm, done, className, disabled, children, ...rest }: ActionButtonProps) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!onClick) return;
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    try {
      await onClick();
      if (done) toast(done);
    } catch (e: any) {
      toast(e.message ?? String(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      className={cx("btn", variant === "primary" && "btn-primary", variant === "danger" && "btn-danger", small && "btn-sm", className)}
      disabled={disabled || busy}
      onClick={run}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Card({ title, actions, className, children }: { title?: ReactNode; actions?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={cx("card min-w-0", className)}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {actions && <div className="flex flex-wrap gap-1.5">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Status pill; colours come from the .badge.<status> classes in index.css. */
export function Badge({ value, className }: { value: string | null | undefined; className?: string }) {
  if (!value) return null;
  return <span className={cx("badge", value, className)}>{value}</span>;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="card" style={{ padding: "10px 12px" }}>
      <div className="eyebrow">{label}</div>
      <div className="num" style={{ fontSize: 18, fontWeight: 500, marginTop: 2 }}>
        {value}
      </div>
      {hint && <div className="muted" style={{ fontSize: 11.5 }}>{hint}</div>}
    </div>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("label", className)}>
      <span>{label}</span>
      {children}
      {hint && <span className="text-[11px]">{hint}</span>}
    </label>
  );
}

export function ErrorBox({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <div className="rounded-md px-3 py-2 text-sm" style={{ border: "1px solid color-mix(in srgb, var(--bad) 45%, transparent)", background: "color-mix(in srgb, var(--bad) 9%, transparent)", color: "var(--bad)" }}>
      {error}
    </div>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md px-3 py-2 text-sm" style={{ border: "1px solid color-mix(in srgb, var(--warn) 45%, transparent)", background: "color-mix(in srgb, var(--warn) 9%, transparent)" }}>
      {children}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-8 text-center text-sm muted">{children}</div>;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist" style={{ margin: "16px 0", paddingBottom: 8, borderBottom: "1px solid var(--line)" }}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === value} onClick={() => onChange(t.id)} className={cx("tab", t.id === value && "on")}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function CopyText({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cx("flex items-start gap-2", className)}>
      <code className="min-w-0 flex-1 rounded px-2 py-1 font-mono text-xs break-all" style={{ background: "var(--hover)" }}>
        {text}
      </code>
      <Button small onClick={() => navigator.clipboard.writeText(text)} done="Copied">
        Copy
      </Button>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="break-words" style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
          {title}
        </h1>
        {subtitle && <div className="mt-0.5 text-sm muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-1.5">{actions}</div>}
    </div>
  );
}
