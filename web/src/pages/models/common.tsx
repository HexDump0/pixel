/** Formatting and small marks shared by the Models page's sections. */
import { line, curveMonotoneX } from "d3-shape";
import { cn } from "../../lib/cn.ts";
import { Nil } from "../../components/ui/bits.tsx";

export const ms = (n: number | null | undefined) => (n == null ? "" : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`);
export const pct = (n: number | null | undefined) => (n == null ? "" : `${Math.round(n * 100)}%`);
/** "anthropic/claude-opus-4-5" → ["anthropic", "claude-opus-4-5"]. */
export const splitModel = (full: string) => {
  const i = full.indexOf("/");
  return i < 0 ? ["", full] : [full.slice(0, i), full.slice(i + 1)];
};
/** Each model in the lineup keeps one run colour across the chart and the table. */
export const hueVar = (i: number) => `var(--r${i % 6})`;

/** A tiny line over a window's buckets; gaps where a bucket had no calls. */
export function Spark({ values, color = "var(--ink-3)", className }: { values: (number | null)[]; color?: string; className?: string }) {
  const W = 56;
  const H = 18;
  const nums = values.filter((v): v is number => v != null);
  if (!nums.length) return <span className={cn("inline-block w-14", className)} />;
  const max = Math.max(...nums) || 1;
  const ln = line<number | null>()
    .defined((v) => v != null)
    .x((_, i) => (i / Math.max(1, values.length - 1)) * W)
    .y((v) => H - 2 - ((v as number) / max) * (H - 4))
    .curve(curveMonotoneX);
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden className={cn("inline-block shrink-0 overflow-visible align-middle", className)}>
      <path d={ln(values) ?? ""} fill="none" strokeWidth={1.25} strokeLinecap="round" style={{ stroke: color }} />
    </svg>
  );
}

/** A share as a short bar and its number. */
export function Share({ value, warnAt, className }: { value: number | null; warnAt?: number; className?: string }) {
  if (value == null) return <Nil />;
  const hot = warnAt != null && value >= warnAt;
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span className="h-1 w-10 overflow-hidden rounded-full bg-s3">
        <i className={cn("block h-full rounded-full", hot ? "bg-warning" : "bg-ink-3")} style={{ width: `${Math.min(1, value) * 100}%` }} />
      </span>
      <span className={cn("tabular-nums", hot && "text-warning")}>{pct(value)}</span>
    </span>
  );
}
