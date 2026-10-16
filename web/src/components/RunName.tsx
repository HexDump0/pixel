/**
 * A run's display name, editable in place: double-click it (or "Rename" in a menu or the command palette)
 * to type a new one. Enter saves, Esc cancels, an empty name goes back to the id.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api.ts";
import { runName } from "../lib/fleet.ts";
import { reloadRuns } from "../lib/runs.ts";
import { cn } from "../lib/cn.ts";
import { toast } from "./Toast.tsx";

const renameListeners = new Set<(id: string) => void>();
/** Put the name of this run into edit mode wherever it's shown `editable`. */
export const startRename = (id: string) => renameListeners.forEach((l) => l(id));

export function RunName({ run, editable = false, className, children }: { run: { id: string; label?: string | null }; editable?: boolean; className?: string; children?: ReactNode }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const name = runName(run);

  const begin = () => {
    setValue(run.label ?? "");
    setEditing(true);
  };
  useEffect(() => {
    if (!editable) return;
    const l = (id: string) => id === run.id && begin();
    renameListeners.add(l);
    return () => void renameListeners.delete(l);
  });
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const save = () => {
    setEditing(false);
    const next = value.trim();
    if (next === (run.label ?? "")) return;
    api.setLabel(run.id, next).then(
      () => (toast(next ? `Renamed to ${next}` : "Name reset"), reloadRuns()),
      (e) => toast(e.message ?? String(e), "error"),
    );
  };

  if (editing)
    return (
      <input
        ref={input}
        value={value}
        maxLength={80}
        placeholder={run.id}
        aria-label="Run name"
        className="w-[min(420px,100%)] min-w-0 rounded-md border border-line bg-s2 px-2 text-[length:inherit] font-[inherit] text-ink outline-none focus:border-ink-3"
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") save();
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );

  return (
    <span
      className={cn("truncate", editable && "cursor-text", className)}
      title={editable ? (run.label ? `${run.id}, double-click to rename` : "Double-click to rename") : run.label ? run.id : undefined}
      onDoubleClick={
        editable
          ? (e) => {
              e.stopPropagation();
              begin();
            }
          : undefined
      }
    >
      {children ?? name}
    </span>
  );
}
