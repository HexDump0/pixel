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

const STATUS_STYLE: Record<string, string> = {
  running: "border-blue-500 text-blue-600 dark:text-blue-400",
  busy: "border-blue-500 text-blue-600 dark:text-blue-400",
  preparing: "border-amber-500 text-amber-600 dark:text-amber-400",
  recovering: "border-amber-500 text-amber-600 dark:text-amber-400",
  retry: "border-amber-500 text-amber-600 dark:text-amber-400",
  paused: "border-zinc-400 text-amber-600 dark:text-amber-400",
  stopped: "border-zinc-400 text-amber-700 dark:text-amber-300",
  done: "border-emerald-500 text-emerald-600 dark:text-emerald-400",
  idle: "border-emerald-500 text-emerald-600 dark:text-emerald-400",
  triaged: "border-violet-500 text-violet-600 dark:text-violet-400",
  failed: "border-red-500 text-red-600 dark:text-red-400",
};

export function Badge({ value, className }: { value: string | null | undefined; className?: string }) {
  if (!value) return null;
  return <span className={cx("inline-block rounded-full border px-2 text-xs whitespace-nowrap", STATUS_STYLE[value] ?? "border-zinc-300 dark:border-zinc-700", className)}>{value}</span>;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="card p-3">
      <div className="text-xs muted">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-xs muted">{hint}</div>}
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
  return <div className="rounded-md border border-red-400/50 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">{error}</div>;
}

export function Notice({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-amber-400/50 bg-amber-500/10 px-3 py-2 text-sm">{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-8 text-center text-sm muted">{children}</div>;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="my-4 flex gap-0.5 overflow-x-auto border-b border-zinc-200 dark:border-zinc-800">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={cx(
            "cursor-pointer border-b-2 px-3 py-2 text-sm whitespace-nowrap",
            t.id === value ? "border-accent text-zinc-900 dark:text-zinc-100" : "border-transparent muted hover:text-zinc-900 dark:hover:text-zinc-100",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function CopyText({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cx("flex items-start gap-2", className)}>
      <code className="min-w-0 flex-1 rounded bg-zinc-100 px-2 py-1 font-mono text-xs break-all dark:bg-zinc-800">{text}</code>
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
        <h1 className="text-xl font-semibold break-words">{title}</h1>
        {subtitle && <div className="mt-0.5 text-sm muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-1.5">{actions}</div>}
    </div>
  );
}
