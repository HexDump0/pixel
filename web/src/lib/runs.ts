/** The live list of runs, shared by every page (one query, kept current by the websocket). */
import { useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";
import { keys, onLive, queryClient, startLiveCache } from "./query.ts";
import type { Run } from "./types.ts";

onLive((m) => {
  if (m.type === "connected") return void queryClient.invalidateQueries({ queryKey: keys.runs });
  if (m.type === "run")
    queryClient.setQueryData<Run[]>(keys.runs, (runs) => {
      if (!runs) return runs;
      const i = runs.findIndex((r) => r.id === m.data.id);
      return i >= 0 ? runs.map((r, j) => (j === i ? { ...r, ...m.data } : r)) : [m.data, ...runs];
    });
  if (m.type === "run.deleted") queryClient.setQueryData<Run[]>(keys.runs, (runs) => runs?.filter((r) => r.id !== m.data.id));
  if (m.type === "question" || m.type === "question.closed" || m.type === "findings") void queryClient.invalidateQueries({ queryKey: keys.runs });
});

export function useRuns(): { runs: Run[] | null; error: string | null } {
  startLiveCache();
  const q = useQuery({ queryKey: keys.runs, queryFn: api.runs, staleTime: 60_000 });
  return { runs: q.data ?? null, error: q.error ? String((q.error as Error).message) : null };
}

export const reloadRuns = () => queryClient.invalidateQueries({ queryKey: keys.runs });

export const ACTIVE: Run["status"][] = ["preparing", "running", "recovering", "paused"];
export const isLive = (r: Pick<Run, "status">) => r.status === "running" || r.status === "recovering" || r.status === "preparing";
export const isFinished = (r: Pick<Run, "status">) => r.status === "done" || r.status === "triaged";
export const repoShort = (repo: string) => repo.replace(/^https?:\/\/(www\.)?/, "").replace(/^github\.com\//, "").replace(/\.git$/, "");
