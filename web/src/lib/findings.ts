/** Findings the agents record with the finding tools, across runs and per run, with the human's verdicts. */
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";
import { keys, onLive, queryClient, startLiveCache } from "./query.ts";
import { toast } from "../components/Toast.tsx";
import type { Finding, Verdict } from "./types.ts";

onLive((m) => {
  if (m.type === "finding" || m.type === "findings") {
    const run = m.data.event?.run_id ?? m.data.run;
    void queryClient.invalidateQueries({ queryKey: keys.findings });
    if (run) {
      void queryClient.invalidateQueries({ queryKey: keys.runFindings(run) });
      void queryClient.invalidateQueries({ queryKey: keys.runFindingEvents(run) });
    }
  }
  if (m.type === "connected") void queryClient.invalidateQueries({ queryKey: keys.findings });
});

/** Every finding that isn't removed, newest change first. */
export function useFindings() {
  startLiveCache();
  return useQuery({ queryKey: keys.findings, queryFn: () => api.findings(), staleTime: 30_000 }).data ?? null;
}

/** One run's findings, removed ones included. */
export function useRunFindings(runId: string) {
  startLiveCache();
  return useQuery({ queryKey: keys.runFindings(runId), queryFn: () => api.runFindings(runId) });
}

export function useFindingEvents(runId: string) {
  return useQuery({ queryKey: keys.runFindingEvents(runId), queryFn: () => api.findingEvents(runId) });
}

export const VERDICTS: { v: Verdict; key: string; label: string; hint: string }[] = [
  { v: "real", key: "r", label: "Real", hint: "Goes in the write-up" },
  { v: "not_bug", key: "n", label: "Not a bug", hint: "False positive or out of scope" },
  { v: "duplicate", key: "d", label: "Duplicate", hint: "Known, or same as another finding" },
  { v: "needs_work", key: "w", label: "Needs work", hint: "Send it back to the agent" },
];
export const verdictLabel = (v: string | null | undefined) => VERDICTS.find((x) => x.v === v)?.label ?? "";

export const STATE_LABEL: Record<string, string> = { confirmed: "Confirmed", suspected: "Suspected", lead: "Leads", ruled_out: "Ruled out" };
export const STATE_WORD: Record<string, string> = { confirmed: "confirmed", suspected: "suspected", lead: "lead", ruled_out: "ruled out" };

const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
export const sevRank = (f: Pick<Finding, "severity">) => SEV_RANK[f.severity ?? ""] ?? 5;
/** The dot colour for a finding: severity, or hollow for a lead without one. */
export const sevOf = (f: Pick<Finding, "severity" | "state">) => f.severity ?? (f.state === "lead" ? "lead" : "low");

/** Needs a verdict: not a lead, not ruled out, not removed, no verdict yet. */
export const isOpen = (f: Finding) => !f.verdict && !f.removed_at && f.state !== "ruled_out" && f.state !== "lead";

/** Untriaged first, then by severity, then newest. */
export const byPriority = (a: Finding, b: Finding) => Number(!!a.verdict) - Number(!!b.verdict) || sevRank(a) - sevRank(b) || b.updated - a.updated;

export function useSetVerdict() {
  return useMutation({
    mutationFn: ({ f, verdict, note }: { f: Finding; verdict: Verdict | null; note?: string | null }) => api.setVerdict(f.run_id, f.id, verdict, note),
    onSuccess: (f, { verdict }) => {
      toast(verdict ? `${f.id} marked ${verdictLabel(verdict).toLowerCase()}` : `${f.id} verdict cleared`);
      void queryClient.invalidateQueries({ queryKey: keys.findings });
      void queryClient.invalidateQueries({ queryKey: keys.runFindings(f.run_id) });
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
}
