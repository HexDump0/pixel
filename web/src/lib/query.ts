/**
 * Server data lives in TanStack Query's cache. The websocket feed (lib/live.ts) keeps it current:
 * small updates are written straight into the cache, bigger changes invalidate the affected queries.
 */
import { QueryClient } from "@tanstack/react-query";
import { listenLive } from "./live.ts";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

/** Query keys in one place, so invalidation matches what the hooks read. */
export const keys = {
  runs: ["runs"] as const,
  fleet: ["fleet"] as const,
  feed: ["feed"] as const,
  findings: ["findings"] as const,
  run: (id: string) => ["run", id] as const,
  runFindings: (id: string) => ["run", id, "findings"] as const,
  runFindingEvents: (id: string) => ["run", id, "finding-events"] as const,
  runTimeline: (id: string) => ["run", id, "timeline"] as const,
  runSeries: (id: string) => ["run", id, "series"] as const,
  runLanes: (id: string, minutes: number) => ["run", id, "lanes", minutes] as const,
  runActivity: (id: string) => ["run", id, "activity"] as const,
  runReport: (id: string) => ["run", id, "report"] as const,
  runKeys: (id: string) => ["run", id, "keys"] as const,
  catalogProvider: (id: string) => ["catalog", id] as const,
  providers: ["providers"] as const,
  proxies: ["proxies"] as const,
};

type Handler = (m: { run: string; type: string; data: any }) => void;
const handlers: Handler[] = [];
/** Register what a live message type does to the cache (each store module adds its own). */
export const onLive = (h: Handler) => handlers.push(h);

let started = false;
export function startLiveCache() {
  if (started) return;
  started = true;
  listenLive((m) => {
    for (const h of handlers) {
      try {
        h(m);
      } catch (e) {
        console.error("live update failed", m.type, e);
      }
    }
  });
}
