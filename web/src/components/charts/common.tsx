/** Shared bits for the SVG charts: container size, a cursor-following tooltip, the run-colour row. */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn.ts";

/** Measure an element (charts draw in real pixels so text and strokes stay crisp). */
export function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

export interface TipState {
  x: number;
  y: number;
  content: ReactNode;
}

/** Tooltip that follows the cursor (for chart hovers, where Radix's anchored tooltip doesn't fit). */
export function ChartTip({ tip }: { tip: TipState | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!tip || !ref.current) return;
    const w = ref.current.offsetWidth;
    const h = ref.current.offsetHeight;
    setPos({ left: Math.min(innerWidth - w - 8, tip.x + 14), top: Math.max(8, tip.y - h - 12) });
  }, [tip]);
  if (!tip) return null;
  return createPortal(
    <div ref={ref} role="tooltip" style={pos} className="pointer-events-none fixed z-[950] max-w-[300px] min-w-40 rounded-lg border border-line bg-s3 px-2.5 py-2 text-[12.5px] shadow-pop">
      {tip.content}
    </div>,
    document.body,
  );
}

export const TipTitle = ({ children }: { children: ReactNode }) => <div className="mb-1 text-xs text-ink-3 first-letter:uppercase">{children}</div>;

export function TipRow({ hue, color, label, value, hot }: { hue?: number | null; color?: string; label: ReactNode; value?: ReactNode; hot?: boolean }) {
  return (
    <div className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2">
      <i className="size-2 rounded-[2px]" style={{ background: color ?? `var(--r${hue ?? 0})` }} />
      <span className={cn("truncate text-ink-2", hot && "text-ink")}>{label}</span>
      {value != null && <b className="font-mono text-xs font-medium text-ink">{value}</b>}
    </div>
  );
}

/** Round a chart's top up to 1, 2, 2.5 or 5 × a power of ten. */
export function niceMax(v: number) {
  const p = 10 ** Math.floor(Math.log10(Math.max(v, 1e-9)));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}
