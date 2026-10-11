/** Fire-and-forget toasts: call `toast("Saved")` from anywhere, render <Toasts/> once. */
import { useEffect, useState } from "react";

interface ToastItem {
  id: number;
  text: string;
  kind: "info" | "error";
}

let next = 1;
const listeners = new Set<(t: ToastItem) => void>();

export function toast(text: string, kind: ToastItem["kind"] = "info") {
  const t = { id: next++, text, kind };
  for (const l of listeners) l(t);
}

export function Toasts() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    const add = (t: ToastItem) => {
      setItems((xs) => [...xs, t]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), t.kind === "error" ? 8000 : 2500);
    };
    listeners.add(add);
    return () => void listeners.delete(add);
  }, []);
  return (
    <div className="fixed right-4 bottom-4 z-50 flex max-w-sm flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={`card px-3 py-2 text-sm shadow-lg ${t.kind === "error" ? "border-red-500 text-red-700 dark:text-red-300" : ""}`}
          onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
