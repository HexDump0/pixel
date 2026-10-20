/** Notable events across runs (findings, questions, problems, runs finishing): the Latest feed and the catch-up. */
import { useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";
import { keys, onLive, queryClient, startLiveCache } from "./query.ts";
import type { FeedEntry } from "./types.ts";

/** Kinds the server's /api/feed returns (server/src/fleet.ts FEED_KINDS). */
export const FEED_KINDS = new Set(["finding", "question", "failed", "stopped", "recover", "limit", "done", "idle", "key", "created"]);

let timer: ReturnType<typeof setTimeout> | null = null;
onLive((m) => {
  if (m.type === "connected" || (m.type === "timeline" && FEED_KINDS.has(m.data?.kind))) {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void queryClient.invalidateQueries({ queryKey: keys.feed });
    }, 800);
  }
});

export function useFeed(limit = 50, since?: number) {
  startLiveCache();
  return (
    useQuery({
      queryKey: [...keys.feed, limit, since ?? 0],
      queryFn: () => api.feed(limit, since),
      staleTime: 30_000,
      // your own triage isn't news to you
      select: (rows) => rows.filter((e) => !(e.kind === "finding" && ["verdict", "triage", "disclosure"].includes(e.data?.action))),
    }).data ?? null
  );
}

/** How an event reads: k = icon family (find, ask, bad, warn, done, you, "") and the finding it's about. */
export function feedKind(e: Pick<FeedEntry, "kind" | "data" | "actor">): { k: string; finding?: string } {
  switch (e.kind) {
    case "finding":
      return { k: "find", finding: e.data?.finding };
    case "question":
      return { k: e.actor === "agent" ? "ask" : "you" };
    case "failed":
    case "stopped":
      return { k: "bad" };
    case "recover":
    case "limit":
    case "idle":
    case "key":
      return { k: "warn" };
    case "done":
      return { k: "done" };
    case "message":
    case "triage":
      return { k: "you" };
    default:
      return { k: "" };
  }
}

/** Short text for one event: drop Pixel's prefixes that the icon already says. */
export function feedText(e: Pick<FeedEntry, "kind" | "message" | "data">) {
  let t = e.message;
  if (e.kind === "finding" && e.data?.title) return e.data.title as string;
  t = t.replace(/^Agent asked: /, "Asked: ").replace(/^Preparing failed: /, "").replace(/^REPORT\.md written and the agent is idle: run done$/, "Finished, REPORT.md written");
  return t;
}
