/** Which PROGRESS.md version you last looked at, per run. Kept in this browser only. */
import { useSyncExternalStore } from "react";
import type { Run } from "./types.ts";

const KEY = "pixel.progressSeen";
const listeners = new Set<() => void>();

function load(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

let seen = load();

const emit = () => listeners.forEach((l) => l());

// Another tab looked at a run.
window.addEventListener("storage", (e) => {
  if (e.key !== KEY) return;
  seen = load();
  emit();
});

export const lastSeen = (runId: string): number | null => seen[runId] ?? null;

export function markSeen(runId: string, ts: number) {
  if ((seen[runId] ?? 0) >= ts) return;
  seen = { ...seen, [runId]: ts };
  try {
    localStorage.setItem(KEY, JSON.stringify(seen));
  } catch {}
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Re-renders when anything is marked seen. */
export const useProgressSeen = () => useSyncExternalStore(subscribe, () => seen);

/** PROGRESS.md changed since you last opened the run. */
export const progressUnseen = (run: Run, s: Record<string, number>) => !!run.progress_at && run.status !== "triaged" && run.progress_at > (s[run.id] ?? 0);

/** A live run whose PROGRESS.md hasn't changed for this long gets a hint. */
export const STALE_MS = 60 * 60_000;
export const progressStale = (run: Run, now = Date.now()) => !!run.progress_at && ["running", "recovering"].includes(run.status) && now - run.progress_at > STALE_MS;
