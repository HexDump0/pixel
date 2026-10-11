/**
 * Shared live view of the fleet: one /api/fleet snapshot, kept current by the websocket
 * (tokens/s every second, tool calls as they happen) and refreshed in the background.
 * The sidebar mesh, the Runs page and the run panel all read the same store.
 */
import { useSyncExternalStore } from "react";
import { api } from "./api.ts";
import { listenLive } from "./live.ts";
import type { FleetSnapshot } from "./types.ts";

const REFRESH_MS = 15_000;

let snap: FleetSnapshot | null = null;
let started = false;
let loading = false;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());

async function load() {
  if (loading) return;
  loading = true;
  try {
    const next = await api.fleet();
    // Keep the live tokens/s history we've been collecting; the server only has the last 90 s too.
    if (snap) for (const r of next.runs) r.tps = r.tps.length ? r.tps : (snap.runs.find((x) => x.id === r.id)?.tps ?? []);
    snap = next;
    emit();
  } catch {
    // offline or logged out; the next refresh tries again
  } finally {
    loading = false;
  }
}

/** Reload soon, coalescing bursts (a run changing status emits several messages). */
function reloadSoon(ms = 1500) {
  if (reloadTimer) return;
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    void load();
  }, ms);
}

function start() {
  if (started) return;
  started = true;
  void load();
  setInterval(load, REFRESH_MS);
  listenLive((m) => {
    if (!snap) return;
    if (m.type === "fleet.tick") {
      const tps: Record<string, number> = m.data.tps;
      let changed = false;
      for (const r of snap.runs) {
        if (!(r.id in tps) && !r.tps.length) continue;
        const s = r.tps.length ? r.tps.slice(1) : Array(snap.window - 1).fill(0);
        s.push(tps[r.id] ?? 0);
        r.tps = s;
        changed = true;
      }
      if (Object.keys(tps).some((id) => !snap!.runs.some((r) => r.id === id))) reloadSoon();
      if (changed) {
        snap = { ...snap, runs: [...snap.runs] };
        emit();
      }
    } else if (m.type === "activity") {
      const a = m.data;
      const run = snap.runs.find((r) => r.id === a.run);
      if (!run) return;
      const now = { tool: a.tool, kind: a.kind, text: a.text, ts: a.ts, status: a.status };
      if (a.agent === null) run.now = now;
      else {
        const sub = run.agents.subs.find((s) => s.id === a.session);
        if (sub) sub.now = now;
        else reloadSoon(); // a new subagent
      }
      snap = { ...snap, runs: snap.runs.map((r) => (r.id === run.id ? { ...run } : r)) };
      emit();
    } else if (m.type === "run" || m.type === "run.deleted" || m.type === "crossread") {
      reloadSoon();
    } else if (m.type === "connected") {
      void load();
    }
  });
}

export function useFleet(): FleetSnapshot | null {
  start();
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    () => snap,
  );
}

/** Tokens/s as a rate: opencode reports tokens in bursts at the end of each step, so average the last few seconds. */
export const RATE_WINDOW = 10;
export const rate = (samples: number[]) => (samples.length ? samples.slice(-RATE_WINDOW).reduce((a, b) => a + b, 0) / Math.min(RATE_WINDOW, samples.length) : 0);

/** Stable colour token per run, so a run keeps its colour on every chart. */
export function runColor(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `var(--r${h % 6})`;
}

/** Colour token per kind of activity. */
export const kindColor = (k: string | null | undefined) =>
  k === "shell" ? "var(--k-shell)" : k === "read" ? "var(--k-read)" : k === "edit" ? "var(--k-edit)" : k === "task" ? "var(--k-task)" : k === "web" ? "var(--k-web)" : "var(--fg3)";

/** Short name for charts: the repo part of `<repo>-<date>`. */
export const shortName = (id: string) => id.replace(/-\d{4}-\d{2}-\d{2}(-\d+)?$/, "");
