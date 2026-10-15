/**
 * The live view of the fleet: one /api/fleet snapshot in the query cache, kept current by the websocket
 * (tokens/s every second, tool calls as they happen) and refreshed in the background.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";
import { keys, onLive, queryClient, startLiveCache } from "./query.ts";
import type { FleetRun, FleetSnapshot } from "./types.ts";

const REFRESH_MS = 15_000;
const TICK_WINDOW_MS = 15 * 60_000;

let refetchTimer: ReturnType<typeof setTimeout> | null = null;
/** Refetch soon, coalescing bursts (a run changing status emits several messages). */
function refetchSoon(ms = 1500) {
  if (refetchTimer) return;
  refetchTimer = setTimeout(() => {
    refetchTimer = null;
    void queryClient.invalidateQueries({ queryKey: keys.fleet });
  }, ms);
}

const patchRun = (id: string, fn: (r: FleetRun) => FleetRun) =>
  queryClient.setQueryData<FleetSnapshot>(keys.fleet, (s) => (s ? { ...s, runs: s.runs.map((r) => (r.id === id ? fn(r) : r)) } : s));

onLive((m) => {
  const snap = queryClient.getQueryData<FleetSnapshot>(keys.fleet);
  if (m.type === "connected") return void queryClient.invalidateQueries({ queryKey: keys.fleet });
  if (!snap) return;
  if (m.type === "fleet.tick") {
    const tps: Record<string, number> = m.data.tps;
    // The server corrects recent seconds when a model call finishes; those runs get their whole window.
    const fix: Record<string, number[]> = m.data.fix ?? {};
    queryClient.setQueryData<FleetSnapshot>(keys.fleet, {
      ...snap,
      runs: snap.runs.map((r) => {
        if (fix[r.id]) return { ...r, tps: fix[r.id] };
        if (!(r.id in tps) && !r.tps.length) return r;
        const s = r.tps.length ? r.tps.slice(1) : Array(snap.window - 1).fill(0);
        s.push(tps[r.id] ?? 0);
        return { ...r, tps: s };
      }),
    });
    if (Object.keys(tps).some((id) => !snap.runs.some((r) => r.id === id))) refetchSoon();
  } else if (m.type === "activity") {
    const a = m.data;
    const run = snap.runs.find((r) => r.id === a.run);
    if (!run) return;
    const now = { tool: a.tool, kind: a.kind, text: a.text, ts: a.ts, status: a.status };
    if (a.agent !== null && !run.agents.subs.some((s) => s.id === a.session)) refetchSoon(); // a new subagent
    patchRun(a.run, (r) => ({
      ...r,
      now: a.agent === null ? now : r.now,
      agents: a.agent === null ? r.agents : { ...r.agents, subs: r.agents.subs.map((s) => (s.id === a.session ? { ...s, now } : s)) },
      ticks: a.status === "running" || a.status === "pending" ? [...r.ticks.filter((t) => Date.now() - t[1] < TICK_WINDOW_MS), [a.session, a.ts, a.kind]] : r.ticks,
    }));
  } else if (["run", "run.deleted", "crossread", "todos"].includes(m.type)) refetchSoon();
});

export function useFleet(): FleetSnapshot | null {
  startLiveCache();
  return useQuery({ queryKey: keys.fleet, queryFn: api.fleet, refetchInterval: REFRESH_MS, staleTime: 5_000 }).data ?? null;
}

/** Tokens/s as a rate: opencode reports tokens in bursts at the end of each step, so average the last few seconds. */
export const RATE_WINDOW = 10;
export const rate = (samples: number[]) => (samples.length ? samples.slice(-RATE_WINDOW).reduce((a, b) => a + b, 0) / Math.min(RATE_WINDOW, samples.length) : 0);

/** Colour of a run (CSS variable), from the hue Pixel picked when it was created. */
export function runColor(run: { id: string; hue?: number | null } | string) {
  if (typeof run !== "string" && run.hue != null) return `var(--r${run.hue})`;
  const id = typeof run === "string" ? run : run.id;
  const known = queryClient.getQueryData<{ id: string; hue: number | null }[]>(keys.runs)?.find((r) => r.id === id)?.hue;
  if (known != null) return `var(--r${known})`;
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `var(--r${h % 6})`;
}

/** Colour per kind of tool call. */
export const kindColor = (k: string | null | undefined) =>
  k === "shell" ? "var(--k-shell)" : k === "read" ? "var(--k-read)" : k === "edit" ? "var(--k-edit)" : k === "task" ? "var(--k-task)" : k === "web" ? "var(--k-web)" : "var(--ink-3)";

/** Short name for charts: the repo part of `<repo>-<date>`. */
export const shortName = (id: string) => id.replace(/-\d{4}-\d{2}-\d{2}(-\d+)?$/, "");

/** What to call a run: the name the user gave it, else its id. */
export const runName = (r: { id: string; label?: string | null }) => r.label || r.id;

/**
 * Names for a set of runs that tell same-named runs apart, by the day (and number) from their id:
 * two "folia" runs become "folia ·12" and "folia ·13".
 */
export function distinctNames(runs: { id: string; label?: string | null }[]) {
  const names = new Map(runs.map((r) => [r.id, r.label || shortName(r.id)]));
  const count = new Map<string, number>();
  for (const n of names.values()) count.set(n, (count.get(n) ?? 0) + 1);
  for (const r of runs) {
    const n = names.get(r.id)!;
    if (count.get(n)! < 2) continue;
    const m = r.id.match(/-\d{4}-\d{2}-(\d{2})(-\d+)?$/);
    if (m) names.set(r.id, `${n} ·${m[1]}${m[2] ?? ""}`);
  }
  return names;
}

/** Output tokens/s over the last 30 minutes in 10 s buckets: finished calls from the server, the last 90 s from the live samples. */
export function streamSeries(r: FleetRun): number[] {
  const base = r.tps30.length ? r.tps30.slice() : Array(180).fill(0);
  const live = r.tps;
  if (live.length) {
    const n = Math.floor(live.length / 10);
    for (let k = 0; k < n; k++) {
      const chunk = live.slice(live.length - (k + 1) * 10, live.length - k * 10);
      const avg = chunk.reduce((a, b) => a + b, 0) / chunk.length;
      const i = base.length - 1 - k;
      base[i] = Math.max(base[i], avg);
    }
  }
  return base;
}
