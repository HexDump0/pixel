/**
 * A run's display name, editable in place: double-click it (or the pencil, or "Rename run…" in the
 * command palette) to type a new one. Enter saves, Esc cancels, an empty name goes back to the id.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api.ts";
import { runName } from "../lib/fleet.ts";
import { toast } from "./Toast.tsx";
import { Icon } from "./icons.tsx";

const renameListeners = new Set<(id: string) => void>();
/** Put the name of this run into edit mode wherever it's shown with `pencil`. */
export const startRename = (id: string) => renameListeners.forEach((l) => l(id));

export function RunName({ run, pencil = false, children }: { run: { id: string; label?: string | null }; pencil?: boolean; children?: ReactNode }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const name = runName(run);

  const begin = () => {
    setValue(run.label ?? "");
    setEditing(true);
  };
  useEffect(() => {
    if (!pencil) return;
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
      () => toast(next ? `Renamed to ${next}` : "Name reset"),
      (e) => toast(e.message ?? String(e), "error"),
    );
  };

  if (editing)
    return (
      <span className="rename" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <input
          ref={input}
          id={`rename-${run.id}`}
          value={value}
          maxLength={80}
          placeholder={name}
          aria-label="Run name"
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") save();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      </span>
    );

  return (
    <span
      className="runname"
      title={run.label ? `${run.id} · double-click to rename` : "Double-click to rename"}
      onDoubleClick={(e) => {
        e.stopPropagation();
        begin();
      }}
    >
      {children ?? name}
      {pencil && (
        <button className="iconbtn pencil" aria-label="Rename run" title="Rename" onClick={begin}>
          <Icon name="edit" />
        </button>
      )}
    </span>
  );
}
