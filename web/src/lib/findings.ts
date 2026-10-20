/**
 * Findings the agents keep in their workbases, across runs and per run, with the human's triage
 * (disposition, final severity, duplicate of) and, for the ones to report, the disclosure.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";
import { keys, onLive, queryClient, startLiveCache } from "./query.ts";
import { toast } from "../components/Toast.tsx";
import type { Disclosure, DisclosureInput, Disposition, Finding, TriageInput } from "./types.ts";

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

export const DISPOSITIONS: { v: Disposition; key: string; label: string; hint: string }[] = [
  { v: "report", key: "r", label: "Report", hint: "Real and new, disclose it" },
  { v: "known", key: "k", label: "Known", hint: "Already public" },
  { v: "duplicate", key: "d", label: "Duplicate", hint: "Same root cause as another" },
  { v: "weak", key: "w", label: "Weak", hint: "Real, not worth disclosing" },
  { v: "invalid", key: "i", label: "Invalid", hint: "Not a bug" },
];
export const dispositionLabel = (v: string | null | undefined) => DISPOSITIONS.find((x) => x.v === v)?.label ?? "";

export const DISCLOSURE_LABEL: Record<Disclosure, string> = { ready: "Not sent", reported: "Sent", fixed: "Fixed", dropped: "Dropped" };

export const STATE_LABEL: Record<string, string> = { confirmed: "Confirmed", suspected: "Suspected", lead: "Leads", ruled_out: "Ruled out" };
export const STATE_WORD: Record<string, string> = { confirmed: "confirmed", suspected: "suspected", lead: "lead", ruled_out: "ruled out" };

export const FINAL_SEVERITIES = ["critical", "high", "medium", "low", "info", "none"] as const;

/** The severity after triage: the final one if the triage set it, else the agent's. */
export const finalSev = (f: Pick<Finding, "severity" | "severity_final">) => f.severity_final ?? f.severity;
/** Whether the triage disagrees with the agent's severity. */
export const sevChanged = (f: Pick<Finding, "severity" | "severity_final">) => !!f.severity_final && f.severity_final !== f.severity;

const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4, none: 5 };
export const sevRank = (f: Pick<Finding, "severity" | "severity_final">) => SEV_RANK[finalSev(f) ?? ""] ?? 5;
/** The dot colour for a finding: its severity after triage, or hollow for a lead without one. */
export const sevOf = (f: Pick<Finding, "severity" | "severity_final" | "state">) => {
  const s = finalSev(f);
  return s === "none" ? "info" : (s ?? (f.state === "lead" ? "lead" : "low"));
};

/** Needs triage: suspected or confirmed, not removed, no disposition yet. */
export const isOpen = (f: Finding) => !f.disposition && !f.removed_at && (f.state === "suspected" || f.state === "confirmed");

/** The Findings page's lists. `aside` is what the agent set aside itself (leads, ruled out) without a triage. */
export type FindingView = "triage" | "report" | "resolved" | "reviewed" | "aside";
export const disclosureOf = (f: Finding): Disclosure | null => (f.disposition === "report" ? (f.disclosure ?? "ready") : null);
export function inView(f: Finding, v: FindingView) {
  if (f.removed_at) return false;
  const d = disclosureOf(f);
  switch (v) {
    case "triage":
      return isOpen(f);
    case "report":
      return d === "ready" || d === "reported";
    case "resolved":
      return d === "fixed" || d === "dropped";
    case "reviewed":
      return !!f.disposition;
    case "aside":
      return !f.disposition && (f.state === "lead" || f.state === "ruled_out");
  }
}

/** Untriaged first, then by severity, then newest. */
export const byPriority = (a: Finding, b: Finding) => Number(!!a.disposition) - Number(!!b.disposition) || sevRank(a) - sevRank(b) || b.updated - a.updated;

export const refOf = (f: Pick<Finding, "run_id" | "id">) => `${f.run_id}/${f.id}`;

/** Put text on the clipboard. The text goes in as a promise so Safari still counts the click as the gesture. */
async function copyLater(text: Promise<string>) {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })]);
  } else await navigator.clipboard.writeText(await text);
}

export type LlmPurpose = "verify" | "disclose" | "variants";
export const LLM_PURPOSES: { v: LlmPurpose; label: string; hint: string }[] = [
  { v: "verify", label: "To check it", hint: "Reproduce, confirm the root cause, compare with what's triaged" },
  { v: "disclose", label: "To write the disclosure", hint: "The report for the maintainers" },
  { v: "variants", label: "To find variants", hint: "The same mistake elsewhere in the code" },
];
/** What Copy for LLM asks for by default: the disclosure for a finding ready to send, else a check. */
export const defaultPurpose = (f: Finding): LlmPurpose => (disclosureOf(f) === "ready" ? "disclose" : "verify");

/**
 * Copy one finding as markdown for another model: README, PoC and small files inline, findings already
 * triaged in the project, a new token (a week, this finding only) to download its files, and a task.
 */
export const copyForLlm = (f: Pick<Finding, "run_id" | "id">, purpose?: LlmPurpose) => copyLater(api.findingLlm(f.run_id, f.id, purpose).then((b) => b.text));

/** Copy a list of findings as one markdown text (each README cut to fit), with a task for the purpose. */
export const copyListForLlm = (list: Finding[], purpose: "list" | "triage" | LlmPurpose, title?: string) =>
  copyLater(api.findingsLlm(list.slice(0, 500).map(refOf), purpose, title).then((b) => b.text));

function refresh(f: Finding) {
  void queryClient.invalidateQueries({ queryKey: keys.findings });
  void queryClient.invalidateQueries({ queryKey: keys.runFindings(f.run_id) });
  void queryClient.invalidateQueries({ queryKey: keys.runFindingEvents(f.run_id) });
}

export function useTriage() {
  return useMutation({
    mutationFn: ({ f, ...body }: TriageInput & { f: Finding }) => api.triageFinding(f.run_id, f.id, body),
    onSuccess: (f, { disposition }) => {
      if (disposition !== undefined) toast(disposition ? `${f.id}: ${dispositionLabel(disposition).toLowerCase()}` : `${f.id}: triage cleared`);
      refresh(f);
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
}

export function useDisclosure() {
  return useMutation({
    mutationFn: ({ f, ...body }: DisclosureInput & { f: Finding }) => api.disclosure(f.run_id, f.id, body),
    onSuccess: (f) => refresh(f),
    onError: (e) => toast((e as Error).message, "error"),
  });
}
