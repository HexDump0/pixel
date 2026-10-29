/**
 * The live view of the fleet: one /api/fleet snapshot in the query cache when a tab connects, then
 * kept current by the websocket: fleet.patch (the server's changes, about once a second), fleet.tick
 * (tokens/s every second) and activity (tool calls as they happen, for an instant "now").
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";
import { keys, onLive, queryClient, startLiveCache } from "./query.ts";
import type { FleetRun, FleetSnapshot } from "./types.ts";

const TICK_WINDOW_MS = 15 * 60_000;

const count = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

/** What a main agent whose turn is over is waiting for: its subagents, background commands, or both. */
export function waitingText(f: FleetRun) {
  const w = f.waiting;
  if (!w || (!w.subagents && !w.shells.length)) return { text: "waiting on subagents", full: undefined };
  const parts = [w.subagents && count(w.subagents, "a subagent", "subagents"), w.shells.length && count(w.shells.length, "a background command", "background commands")].filter(Boolean);
  return { text: `waiting on ${parts.join(" and ")}`, full: w.shells.length ? w.shells.join("\n") : undefined };
}

const reload = () => void queryClient.invalidateQueries({ queryKey: keys.fleet });
const patchRun = (id: string, fn: (r: FleetRun) => FleetRun) =>
  queryClient.setQueryData<FleetSnapshot>(keys.fleet, (s) => (s ? { ...s, runs: s.runs.map((r) => (r.id === id ? fn(r) : r)) } : s));

// A hidden tab ignores live updates (they re-render the whole Wall) and reloads the snapshot when shown.
let missed = false;
if (typeof document !== "undefined")
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !missed) return;
    missed = false;
    reload();
  });

interface FleetPatch {
  ts: number;
  runs: Record<string, Partial<FleetRun>>;
  removed: string[];
  top?: Omit<FleetSnapshot, "ts" | "runs">;
}

onLive((m) => {
  if (m.type === "connected") return reload();
  const snap = queryClient.getQueryData<FleetSnapshot>(keys.fleet);
  if (!snap) return;
  if (document.hidden) return void (missed = true);
  if (m.type === "fleet.patch") {
    const p = m.data as FleetPatch;
    if (p.ts < snap.ts) return; // the snapshot already has it
    const removed = new Set(p.removed);
    const known = new Set(snap.runs.map((r) => r.id));
    const runs = snap.runs.filter((r) => !removed.has(r.id)).map((r) => (p.runs[r.id] ? { ...r, ...p.runs[r.id] } : r));
    for (const [id, fields] of Object.entries(p.runs)) if (!known.has(id)) runs.push(fields as FleetRun);
    queryClient.setQueryData<FleetSnapshot>(keys.fleet, { ...snap, ...p.top, ts: p.ts, runs });
  } else if (m.type === "fleet.tick") {
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
  } else if (m.type === "activity") {
    const a = m.data;
    if (!snap.runs.some((r) => r.id === a.run)) return;
    const now = { tool: a.tool, kind: a.kind, text: a.text, ts: a.ts, status: a.status };
    patchRun(a.run, (r) => ({
      ...r,
      now: a.agent === null ? now : r.now,
      agents: a.agent === null ? r.agents : { ...r.agents, subs: r.agents.subs.map((s) => (s.id === a.session ? { ...s, now } : s)) },
      ticks: a.status === "running" || a.status === "pending" ? [...r.ticks.filter((t) => Date.now() - t[1] < TICK_WINDOW_MS), [a.session, a.ts, a.kind]] : r.ticks,
    }));
  }
});

export function useFleet(): FleetSnapshot | null {
  startLiveCache();
  return useQuery({ queryKey: keys.fleet, queryFn: api.fleet, staleTime: Infinity }).data ?? null;
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
 * two "folia" runs become "folia 12" and "folia 13".
 */
export function distinctNames(runs: { id: string; label?: string | null }[]) {
  const names = new Map(runs.map((r) => [r.id, r.label || shortName(r.id)]));
  const count = new Map<string, number>();
  for (const n of names.values()) count.set(n, (count.get(n) ?? 0) + 1);
  for (const r of runs) {
    const n = names.get(r.id)!;
    if (count.get(n)! < 2) continue;
    const m = r.id.match(/-\d{4}-\d{2}-(\d{2})(-\d+)?$/);
    if (m) names.set(r.id, `${n} ${m[1]}${m[2] ?? ""}`);
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
