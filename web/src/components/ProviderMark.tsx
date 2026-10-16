/** A provider's initial on a tile tinted by its id (styles: .pmark in index.css); children sit in the corner (a health dot). */
import type { CSSProperties, ReactNode } from "react";

/** Stable tint per provider, from the run palette (--r0…--r5). */
const hue = (id: string) => [...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 6;

export function ProviderMark({ id, name, size, children }: { id: string; name: string; size?: number; children?: ReactNode }) {
  return (
    <span className="pmark" style={{ "--hue": `var(--r${hue(id)})`, ...(size && { width: size, height: size, fontSize: Math.round(size * 0.44), borderRadius: Math.round(size * 0.27) }) } as CSSProperties} aria-hidden="true">
      {name.replace(/[^A-Za-z0-9]/g, "").slice(0, 1).toUpperCase() || "?"}
      {children}
    </span>
  );
}
