/**
 * "Since you last looked", per browser: when you last opened each run, and when you last cleared the
 * catch-up. Findings and events newer than that are marked.
 */
import { getPref, setPref, usePref } from "./prefs.ts";

const DAY = 86_400_000;

/** Run id → when you last had it open. */
export const useSeenRuns = () => usePref<Record<string, number>>("seenRuns", {})[0];

export function markRunSeen(id: string) {
  const seen = getPref<Record<string, number>>("seenRuns", {});
  setPref("seenRuns", { ...seen, [id]: Date.now() });
}

/** When you last cleared "Since you last looked" (a day ago on a first visit). */
export function useLastLooked(): [number, () => void] {
  const [ts, set] = usePref<number>("lastLooked", 0);
  // Store the first-visit default once: a value that changed every render would refetch forever.
  if (!ts) setTimeout(() => !getPref("lastLooked", 0) && setPref("lastLooked", Date.now() - DAY));
  return [ts || FIRST, () => set(Date.now())];
}
const FIRST = Date.now() - DAY;

/** The later of the two: what counts as new for one run. */
export const seenAt = (runSeen: number | undefined, lastLooked: number) => Math.max(runSeen ?? 0, lastLooked);
