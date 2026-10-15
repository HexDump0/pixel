/** Little pieces the Wall and the run view repeat: hue chip, status chip, severity dot, waves, rings. */
import { useId, type ReactNode } from "react";
import { cn } from "../../lib/cn.ts";
import type { Health } from "../../lib/health.ts";

/** Tabler icon defaults: 16 px, stroke 1.75 (spread onto any Icon*). */
export const IC = { size: 16, stroke: 1.75 } as const;
export const IC_SM = { size: 15, stroke: 1.75 } as const;
export const IC_XS = { size: 12, stroke: 2 } as const;

/** The run's colour as a small rounded square. */
export function Hue({ hue, className }: { hue: number | null | undefined; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2.5 shrink-0 rounded-[3px]", className)} style={{ background: `var(--r${hue ?? 0})` }} />;
}

const DOT: Record<string, string> = {
  running: "bg-good",
  asking: "bg-warning",
  recovering: "bg-warning",
  idle: "bg-warning",
  preparing: "bg-warning",
  stopped: "bg-warning",
  failed: "bg-critical",
  done: "bg-ink",
  paused: "bg-transparent ring-[1.5px] ring-inset ring-ink-3",
  triaged: "bg-transparent ring-[1.5px] ring-inset ring-ink-3",
};
const WORD: Record<string, string> = {
  running: "font-mono text-xs text-ink-3",
  asking: "text-warning",
  recovering: "text-warning",
  idle: "text-warning",
  preparing: "text-warning",
  stopped: "text-warning",
  failed: "text-critical",
  done: "text-ink",
};

/** 6 px dot + word: running shows its age; words only for problems. */
export function StatusChip({ h, className }: { h: Health; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-[7px] text-[12.5px] whitespace-nowrap text-ink-2", WORD[h.s], className)}>
      <span className={cn("size-1.5 shrink-0 rounded-full bg-ink-3", DOT[h.s])} />
      {h.label}
    </span>
  );
}

const SEV_BG: Record<string, string> = {
  critical: "bg-sev-high",
  high: "bg-sev-high",
  medium: "bg-sev-medium",
  low: "bg-sev-low",
  info: "bg-sev-info",
  lead: "bg-transparent ring-[1.5px] ring-inset ring-ink-3",
};

/** Severity dot, optionally with its word. `done` = hollow (triaged). */
export function Sev({ sev, done, children, className, title }: { sev: string; done?: boolean; children?: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex shrink-0 items-center gap-1.5 text-[12.5px] whitespace-nowrap text-ink-2 capitalize", className)}>
      <span className={cn("size-[7px] shrink-0 rounded-full", done ? "bg-transparent ring-[1.5px] ring-inset ring-ink-4" : (SEV_BG[sev] ?? SEV_BG.low))} />
      {children}
    </span>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line bg-s2 px-1 font-mono text-[11px] font-medium text-ink-3", className)}>
      {children}
    </kbd>
  );
}

/** The blue "changed since you looked" dot. */
export const Unseen = ({ title }: { title?: string }) => <span title={title} className="inline-block size-1.5 shrink-0 rounded-full bg-accent" />;

/** Agent state dot: green working, hollow waiting, amber idle/interrupted, grey done. */
export function AgentDot({ s }: { s: string }) {
  const c =
    s === "running" || s === "working" || s === "starting"
      ? "bg-good"
      : s === "waiting"
        ? "bg-transparent ring-[1.5px] ring-inset ring-ink-3"
        : s === "idle" || s === "interrupted" || s === "recovering"
          ? "bg-warning"
          : s === "failed"
            ? "bg-critical"
            : "bg-ink-4";
  return <span aria-hidden className={cn("inline-block size-1.5 shrink-0 rounded-full", c)} />;
}

/** Small ring for context use. */
export function ContextRing({ pct, warn }: { pct: number; warn?: boolean }) {
  const c = 2 * Math.PI * 6;
  return (
    <svg viewBox="0 0 16 16" className="block size-[15px]" aria-hidden>
      <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2.5" className="stroke-s3" />
      <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2.5" strokeLinecap="round" className={warn ? "stroke-warning" : "stroke-ink-2"} strokeDasharray={`${((pct / 100) * c).toFixed(1)} ${c.toFixed(1)}`} transform="rotate(-90 8 8)" />
    </svg>
  );
}

/**
 * A run's output tokens/s as a soft area in its colour, scaled to its own range so the shape reads
 * (the number next to it gives the size). Flat dashed line when nothing is generating.
 */
export function Wave({ values, hue, className }: { values: number[]; hue: number | null | undefined; className?: string }) {
  const id = useId();
  const W = 400;
  const H = 40;
  const v = values;
  if (v.length < 2 || !v.some((x) => x > 0))
    return (
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden className={cn("block size-full", className)}>
        <line x1="0" x2={W} y1={H - 1} y2={H - 1} className="stroke-line" strokeWidth="1" vectorEffect="non-scaling-stroke" strokeDasharray="2 4" />
      </svg>
    );
  const hi = Math.max(...v) * 1.1;
  const lo = Math.min(...v) * 0.5;
  const span = Math.max(20, hi - lo);
  const pts = v.map((x, i) => [(i / (v.length - 1)) * W, H - 2 - ((x - lo) / span) * (H - 6)]);
  // light smoothing so 1-second samples read as a flow, not a seismograph
  for (let k = 0; k < 2; k++) for (let i = 1; i < pts.length - 1; i++) pts[i][1] = (pts[i - 1][1] + pts[i][1] * 2 + pts[i + 1][1]) / 4;
  let d = `M0,${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const cx = ((x0 + x1) / 2).toFixed(1);
    d += ` C${cx},${y0.toFixed(1)} ${cx},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  const col = `var(--r${hue ?? 0})`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden className={cn("block size-full", className)}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: col, stopOpacity: 0.34 }} />
          <stop offset="1" style={{ stopColor: col, stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      <path d={`${d} L${W},${H} L0,${H} Z`} fill={`url(#${CSS.escape(id)})`} />
      <path d={d} fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" style={{ stroke: col }} />
    </svg>
  );
}

/** Section title inside panels (sentence case, quiet). */
export function SectionHead({ title, icon, meta, right, className }: { title: ReactNode; icon?: ReactNode; meta?: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cn("mb-3 flex flex-wrap items-center gap-2.5", className)}>
      <h2 className="m-0 inline-flex items-center gap-[7px] text-[13.5px] font-medium text-ink [&_svg]:text-ink-3">
        {icon}
        {title}
      </h2>
      {meta && <span className="text-[12.5px] text-ink-3">{meta}</span>}
      {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
    </div>
  );
}

/** Dashed "nothing here" box. */
export function Nothing({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-center gap-2.5 rounded-2xl border border-dashed border-line px-4 py-14 text-ink-3">{children}</div>;
}

/** The brand mark: four rounded squares. */
export function BrandMark() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className="size-[18px]">
      <rect x="0" y="0" width="9" height="9" rx="2" style={{ fill: "var(--r0)" }} />
      <rect x="11" y="0" width="9" height="9" rx="2" style={{ fill: "var(--r2)" }} />
      <rect x="0" y="11" width="9" height="9" rx="2" style={{ fill: "var(--r3)" }} />
      <rect x="11" y="11" width="9" height="9" rx="2" style={{ fill: "var(--ink)" }} />
    </svg>
  );
}
