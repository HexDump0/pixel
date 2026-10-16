/**
 * A run's state, said once: running shows only its age; words only for problems
 * ("Waiting 12m", "Recovering 2/3", "Failed"). Tone tints problem tiles and rows.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";
import type { FleetRun, Run } from "./types.ts";

export type HealthState = "running" | "asking" | "recovering" | "failed" | "preparing" | "stopped" | "paused" | "done" | "triaged" | "idle";

export interface Health {
  s: HealthState;
  label: string;
  tone: "" | "warn" | "bad";
  /** Pixel stopped its opencode to free memory; a resume or message starts it again. */
  asleep?: boolean;
}

/** "12m", "3h", "45s" */
export function age(ts: number | null | undefined, now = Date.now()) {
  if (!ts) return "";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400 * 2) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** "3h 21m" */
export function elapsed(ms: number) {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export const runtimeOf = (r: Run, now = Date.now()) => (r.started_at ? (r.finished_at ?? now) - r.started_at : 0);

/** Pixel's limits on automatic recovery, from Settings (cached). */
export function useLimits() {
  const q = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 5 * 60_000 });
  return { maxOom: q.data?.maxOomRestarts ?? 3, maxContinues: q.data?.maxAutoContinues ?? 3 };
}

export function health(r: Run, fleet?: FleetRun | null, limits = { maxOom: 3, maxContinues: 3 }): Health {
  if (r.question && (r.status === "running" || r.status === "paused")) return { s: "asking", label: `Waiting ${age(r.question.created_at)}`, tone: "warn" };
  switch (r.status) {
    case "recovering":
      return { s: "recovering", label: `Recovering ${Math.max(1, Math.min(limits.maxOom, r.oom_restarts || 1))}/${limits.maxOom}`, tone: "warn" };
    case "failed":
      return { s: "failed", label: "Failed", tone: "bad" };
    case "preparing":
      return { s: "preparing", label: "Preparing", tone: "" };
    case "stopped":
      return { s: "stopped", label: "Stopped", tone: "warn", asleep: !!r.asleep };
    case "paused":
      return { s: "paused", label: "Paused", tone: "", asleep: !!r.asleep };
    case "done":
      return { s: "done", label: "Done", tone: "" };
    case "triaged":
      return { s: "triaged", label: r.findings?.outcome ?? r.triage_verdict ?? "Triaged", tone: "" };
  }
  if (r.agent_status === "idle" || fleet?.agents.main === "idle") return { s: "idle", label: "Idle", tone: "warn" };
  return { s: "running", label: elapsed(runtimeOf(r)), tone: "" };
}

/** Needs you: asking, failed, stopped, recovering, or idle without a report. */
export const needsYou = (h: Health) => ["asking", "failed", "stopped", "recovering", "idle"].includes(h.s);
