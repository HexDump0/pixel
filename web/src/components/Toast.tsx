/** Fire-and-forget toasts: call `toast("Saved")` from anywhere, render <Toasts/> once. */
import { useEffect, useState } from "react";
import { cn } from "../lib/cn.ts";

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
    <div role="status" className="fixed right-4 bottom-6 z-[900] flex max-w-[min(420px,calc(100vw-32px))] flex-col items-end gap-1.5">
      {items.map((t) => (
        <div
          key={t.id}
          className={cn("cursor-pointer rounded-xl px-4 py-2.5 text-[13.5px] font-medium shadow-pop", t.kind === "error" ? "bg-critical text-white" : "bg-ink text-bg")}
          onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
