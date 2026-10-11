/** Shared, live list of runs (sidebar, command palette and Runs page read the same one). */
import { useSyncExternalStore } from "react";
import { api } from "./api.ts";
import { listenLive } from "./live.ts";
import type { Run } from "./types.ts";

let runs: Run[] | null = null;
let error: string | null = null;
let started = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());

async function load() {
  try {
    runs = await api.runs();
    error = null;
  } catch (e: any) {
    error = e.message ?? String(e);
  }
  emit();
}

function start() {
  if (started) return;
  started = true;
  void load();
  listenLive((m) => {
    if (m.type === "connected") return void load();
    if (!runs) return;
    if (m.type === "run") {
      const i = runs.findIndex((r) => r.id === m.data.id);
      runs = i >= 0 ? runs.map((r, j) => (j === i ? { ...r, ...m.data } : r)) : [m.data, ...runs];
      emit();
    }
    if (m.type === "run.deleted") {
      runs = runs.filter((r) => r.id !== m.data.id);
      emit();
    }
  });
}

export const reloadRuns = load;

export function useRuns(): { runs: Run[] | null; error: string | null } {
  start();
  const r = useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    () => runs,
  );
  return { runs: r, error };
}

export const ACTIVE: Run["status"][] = ["preparing", "running", "recovering", "paused"];
