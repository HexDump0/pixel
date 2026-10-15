/** Small UI preferences kept in this browser (filter, sort, layout, rail, focus, theme). */
import { useCallback, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const PREFIX = "pixel.";

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(PREFIX + key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

export function setPref<T>(key: string, value: T) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {}
  listeners.forEach((l) => l());
}

export const getPref = read;

/** `const [layout, setLayout] = usePref("layout", "tiles")` */
export function usePref<T>(key: string, fallback: T): [T, (v: T) => void] {
  const raw = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    () => {
      try {
        return localStorage.getItem(PREFIX + key);
      } catch {
        return null;
      }
    },
  );
  let value = fallback;
  if (raw != null)
    try {
      value = JSON.parse(raw) as T;
    } catch {}
  return [value, useCallback((v: T) => setPref(key, v), [key])];
}

window.addEventListener("storage", (e) => e.key?.startsWith(PREFIX) && listeners.forEach((l) => l()));

/** Dark by default; light only when picked. */
export function applyTheme(theme: "dark" | "light") {
  if (theme === "light") document.documentElement.setAttribute("data-theme", "light");
  else document.documentElement.removeAttribute("data-theme");
}
applyTheme(read<"dark" | "light">("theme", "dark"));
