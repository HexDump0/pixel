/**
 * The run panel on the Runs page: who the agent is (profiler), its PROGRESS.md, its agents and subagents, a swimlane
 * timeline, workbase links, resources and recent activity. AgentTree and RunLanes are reused on the
 * run page.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { useAsync, useThrottled } from "../lib/hooks.ts";
import { useLive } from "../lib/live.ts";
import { navigate, Link } from "../lib/router.tsx";
import { bytes, duration, money, tokens } from "../lib/format.ts";
import { kindColor, runName, useFleet } from "../lib/fleet.ts";
import type { Activity, FleetRun, FleetSnapshot, Run, TimelineEntry } from "../lib/types.ts";
import { LanesChart } from "./viz.tsx";
import { Icon } from "./icons.tsx";
import { openPalette } from "./CommandPalette.tsx";
import { toast } from "./Toast.tsx";
import { RunName } from "./RunName.tsx";
import { ProgressNotes } from "./ProgressNotes.tsx";

const age = (ts: number | null | undefined) => (ts ? duration(Date.now() - ts).replace(/ \d+s$/, "") : "");

const MAIN_TEXT: Record<string, string> = {
  waiting: "waiting on subagents",
  idle: "idle",
  recovering: "being recovered by Pixel",
  paused: "paused",
  finished: "finished",
};

export function AgentTree({ run, fleet }: { run: Run; fleet: FleetRun }) {
  const { main, subs } = fleet.agents;
  const working = subs.filter((s) => s.status === "running").length;
  const roots = subs.filter((s) => !s.parent);
  const kids = (id: string) => subs.filter((s) => s.parent === id);
  const node = (s: (typeof subs)[number]) => (
    <div key={s.id}>
      <div className="node">
        <span className={`ring ${s.status}`} />
        <div style={{ minWidth: 0 }}>
          <div className="t" title={s.title}>
            {s.title}
          </div>
          <div className={`d ${s.now && s.status === "running" ? "" : "sans"}`} title={s.now?.text}>
            {s.status === "running" && s.now ? (["running", "pending"].includes(s.now.status) ? `${s.now.tool} ${s.now.text}` : "thinking…") : s.status === "interrupted" ? "Interrupted · can be resumed by task_id" : s.status === "failed" ? "Failed" : "Finished"}
          </div>
        </div>
        <span className="age">{age(s.started)}</span>
      </div>
      {kids(s.id).length > 0 && <div className="kids">{kids(s.id).map(node)}</div>}
    </div>
  );
  return (
    <>
      <h3>
        Agents{" "}
        <span>
          {1 + subs.length} total{working ? ` · ${working} working` : ""}
        </span>
      </h3>
      <div className="tree">
        <div className="node">
          <span className={`ring ${main}`} />
          <div style={{ minWidth: 0 }}>
            <div className="t">Main agent</div>
            <div className={`d ${main === "working" && fleet.now ? "" : "sans"}`} title={fleet.now?.text}>
              {main === "working" ? (fleet.now && ["running", "pending"].includes(fleet.now.status) ? `${fleet.now.tool} ${fleet.now.text}` : "thinking…") : (MAIN_TEXT[main] ?? main)}
            </div>
          </div>
          <span className="age">{age(run.started_at)}</span>
        </div>
        {roots.length > 0 && <div className="kids">{roots.map(node)}</div>}
      </div>
    </>
  );
}

export function RunLanes({ runId, minutes = 20 }: { runId: string; minutes?: number }) {
  const lanes = useAsync(() => api.lanes(runId, minutes), [runId, minutes]);
  const refresh = useThrottled(() => void lanes.reload(), 5000);
  useLive("*", (m) => {
    if (m.type === "activity" && m.data.run === runId) refresh();
  });
  useEffect(() => {
    const t = setInterval(() => void lanes.reload(), 30_000);
    return () => clearInterval(t);
  }, [runId]);
  return lanes.data ? <LanesChart data={lanes.data} /> : <span className="muted text-xs">Loading…</span>;
}

/**
 * COST, plus KEY and FAILOVER when the run's provider has several keys: which key it's on (change it
 * here), whether it moves to the next key when this one fails, and what it spent on each key.
 */
export function RunKeyRows({ run }: { run: Run }) {
  const info = useAsync(() => api.runKeys(run.id), [run.id, run.key_id, run.key_failover, run.model, run.status]);
  const k = info.data;
  const many = !!k && k.keys.length > 1;
  const act = (fn: () => Promise<unknown>, done: string) => fn().then(() => (toast(done), info.reload()), (e) => toast(e.message ?? String(e), "error"));
  return (
    <>
      <dt>COST</dt>
      <dd className={k && k.costs.length > 1 ? "wide" : undefined}>
        {money(run.cost)}
        {k && k.costs.length > 1 && <span className="muted"> · {k.costs.map((c) => `${money(c.cost)} on ${c.name}`).join(", ")}</span>}
      </dd>
      {many && (
        <>
          <dt>KEY</dt>
          <dd className="wide">
            <select
              className="keysel"
              aria-label="API key for this run"
              value={k.current ?? ""}
              onChange={(e) => act(() => api.setRunKey(run.id, e.target.value), `Key changed to ${k.keys.find((x) => x.id === e.target.value)?.name}`)}
            >
              {k.keys.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} · {x.hint}
                  {x.status ? " · failing" : ""}
                </option>
              ))}
            </select>
          </dd>
          <dt>FAILOVER</dt>
          <dd className="wide">
            <button className="linkbtn" onClick={() => act(() => api.setFailover(run.id, !k.failover), k.failover ? "Failover off" : "Failover on")}>
              {k.failover ? "on" : "off"}
            </button>
            <span className="muted">{k.failover ? (k.next ? ` · next: ${k.next}` : " · no other working key") : " · pauses if the key fails"}</span>
          </dd>
        </>
      )}
    </>
  );
}

/** The run name resolves from random glyphs, once, when a run is opened. */
function Decrypt({ text }: { text: string }) {
  const [shown, setShown] = useState<{ done: string; noise: string }>({ done: text, noise: "" });
  const reduce = useRef(typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    if (reduce.current) return setShown({ done: text, noise: "" });
    const glyphs = "abcdef0123456789#%&*<>/\\[]{}";
    let frame = 0;
    const t = setInterval(() => {
      const done = Math.floor(frame / 1.4);
      const noise = Array.from(text.slice(done), (c) => (c === "-" ? "-" : glyphs[(Math.random() * glyphs.length) | 0])).join("");
      setShown({ done: text.slice(0, done), noise });
      if (++frame > text.length * 1.4) {
        clearInterval(t);
        setShown({ done: text, noise: "" });
      }
    }, 22);
    return () => clearInterval(t);
  }, [text]);
  return (
    <>
      {shown.done}
      <span className="scr">{shown.noise}</span>
    </>
  );
}

function Links({ runId, snap }: { runId: string; snap: FleetSnapshot }) {
  const reads = snap.links.filter((l) => l.run_id === runId && l.other_run !== runId);
  const readBy = snap.links.filter((l) => l.other_run === runId && l.run_id !== runId);
  const arrow = (out: boolean) => (
    <svg viewBox="0 0 34 8" aria-hidden="true">
      <path d="M1 4h30" strokeWidth={1} strokeDasharray="2 2" style={{ stroke: "var(--accent)" }} />
      <path d={out ? "M28 1l4 3-4 3" : "M5 1L1 4l4 3"} fill="none" strokeWidth={1} style={{ stroke: "var(--accent)" }} />
    </svg>
  );
  const row = (k: string, out: boolean, target: string, n: number) => (
    <div className="link" key={`${k}${target}`}>
      <span className="eyebrow">{k}</span>
      {arrow(out)}
      <span className="tgt">
        {target === "*" ? "the workbases index" : <Link to={`/?run=${encodeURIComponent(target)}`}>{target}</Link>}
        <span className="muted"> · {n}×</span>
      </span>
    </div>
  );
  if (!reads.length && !readBy.length) return <span className="muted text-xs">No cross-reads yet.</span>;
  return (
    <div className="links">
      {reads.map((l) => row("Reads", true, l.other_run, l.n))}
      {readBy.map((l) => row("Read by", false, l.run_id, l.n))}
    </div>
  );
}

interface FeedItem {
  key: string;
  ts: number;
  who: string;
  pixel: boolean;
  tool?: string;
  kind?: string;
  text: string;
}

const fromCall = (a: Activity): FeedItem => ({ key: `c${a.session}${a.ts}${a.tool}`, ts: a.ts, who: a.agent ?? "Main agent", pixel: false, tool: a.tool, kind: a.kind, text: a.text });
const fromEvent = (e: Pick<TimelineEntry, "ts" | "actor" | "kind" | "message">): FeedItem => ({ key: `e${e.ts}${e.kind}`, ts: e.ts, who: e.actor === "pixel" ? "Pixel" : e.actor === "user" ? "You" : "Agent", pixel: e.actor === "pixel", text: e.message });

export function ActivityLog({ runId, limit = 12 }: { runId: string; limit?: number }) {
  const [items, setItems] = useState<FeedItem[]>([]);
  useEffect(() => {
    let alive = true;
    api.activity(runId, limit).then((r) => {
      if (!alive) return;
      setItems([...r.calls.map(fromCall), ...r.events.map(fromEvent)].sort((a, b) => b.ts - a.ts).slice(0, limit));
    });
    return () => void (alive = false);
  }, [runId, limit]);
  useLive("*", (m) => {
    const add = (it: FeedItem) => setItems((xs) => [it, ...xs.filter((x) => x.key !== it.key)].slice(0, limit));
    if (m.type === "activity" && m.data.run === runId && m.data.status === "running") add(fromCall(m.data));
    if (m.type === "timeline" && m.data.run_id === runId && !["prepare", "permission"].includes(m.data.kind)) add(fromEvent(m.data));
  });
  if (!items.length) return <span className="muted text-xs">Nothing yet.</span>;
  return (
    <div className="log">
      {items.map((it) => (
        <div key={it.key} className={`ev ${it.pixel ? "pixel" : ""}`}>
          <span className="tm">{new Date(it.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
          <span>
            <span className="who">{it.who}</span>{" "}
            {it.tool ? (
              <>
                <span style={{ color: kindColor(it.kind) }}>{it.tool}</span> <code>{it.text}</code>
              </>
            ) : (
              it.text
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function Resources({ fleet }: { fleet: FleetRun }) {
  const row = (k: string, used: number | null, total: number | null, label: string) => (
    <>
      <span className="k">{k}</span>
      <b>
        <i style={{ width: `${used != null && total ? Math.min(100, (used / total) * 100) : 0}%` }} />
      </b>
      <span className="v">{label}</span>
    </>
  );
  return (
    <div className="res">
      {row("CPU", fleet.cpu, 100, fleet.cpu == null ? "–" : `${Math.round(fleet.cpu)}%`)}
      {row("Memory", fleet.mem.used, fleet.mem.total, fleet.mem.used == null ? "–" : `${bytes(fleet.mem.used)} / ${bytes(fleet.mem.total)}`)}
      {row("Disk", fleet.disk.used, fleet.disk.total, fleet.disk.used == null ? "–" : `${bytes(fleet.disk.used)} / ${bytes(fleet.disk.total)}`)}
    </div>
  );
}

export function RunPanel({ run, onClose }: { run: Run; onClose: () => void }) {
  const snap = useFleet();
  const fleet = snap?.runs.find((r) => r.id === run.id);
  const elapsed = run.started_at ? (run.finished_at ?? Date.now()) - run.started_at : null;
  const ctx = fleet?.context;
  const ctxPct = ctx?.used && ctx.limit ? ctx.used / ctx.limit : null;
  const act = (fn: () => Promise<unknown>, done: string) => () => fn().then(() => toast(done), (e) => toast(e.message ?? String(e), "error"));
  const live = ["running", "recovering"].includes(run.status);

  return (
    <aside className="panel" aria-label={`Run ${run.id}`}>
      <div className="ph brk">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className={`badge ${run.status}`}>{run.status}</span>
          {live && run.agent_status && <span className={`badge ${run.agent_status}`}>{run.agent_status}</span>}
          <span className="meta num">{duration(elapsed)}</span>
          <button className="iconbtn" style={{ marginLeft: "auto" }} aria-label="Open run page" title="Open run page (Enter)" onClick={() => navigate(`/runs/${encodeURIComponent(run.id)}`)}>
            <Icon name="open" />
          </button>
          <button className="iconbtn" aria-label="Close panel" title="Close (Esc)" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <h2 aria-label={runName(run)}>
          <RunName run={run} pencil>
            <Decrypt text={runName(run)} />
          </RunName>
        </h2>
        {run.label && <div className="meta num">{run.id}</div>}
        <div className="meta">
          {run.repo.replace(/^https?:\/\/(www\.)?/, "")}
          {run.ref ? ` @ ${run.ref}` : ""} · {run.language ?? "?"} · {run.model}
        </div>
        {run.status_detail && <div className="meta" style={{ color: "var(--warn)" }}>{run.status_detail}</div>}
        <dl className="prof">
          <dt>MACHINE</dt>
          <dd className="acc">{fleet?.machine.name ?? run.vm_name ?? "–"}</dd>
          <dt>PID</dt>
          <dd>{fleet?.machine.pid ?? "–"}</dd>
          <dt>ENDPOINT</dt>
          <dd>{fleet?.machine.endpoint ?? "–"}</dd>
          <dt>COMMIT</dt>
          <dd>{run.commit_sha?.slice(0, 7) ?? "–"}</dd>
          <dt>SESSION</dt>
          <dd className="wide">{run.session_id ?? "–"}</dd>
          <dt>TOKENS</dt>
          <dd>{tokens(run.tokens_in + run.tokens_out + run.tokens_reasoning)}</dd>
          <RunKeyRows run={run} />
          <dt>CONTEXT</dt>
          <dd className="wide">
            {ctx?.used ? (
              <span className="ctx">
                {ctxPct != null && (
                  <b>
                    <i style={{ width: `${Math.min(100, ctxPct * 100)}%`, background: ctxPct > 0.9 ? "var(--warn)" : undefined }} />
                  </b>
                )}
                {tokens(ctx.used)}
                {ctx.limit ? ` / ${tokens(ctx.limit)}` : ""}
              </span>
            ) : (
              "–"
            )}
          </dd>
        </dl>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button className="btn btn-sm" onClick={() => openPalette(run.id)} disabled={!run.session_id}>
            <Icon name="msg" />
            Message
          </button>
          {live ? (
            <button className="btn btn-sm" onClick={act(() => api.control(run.id, "pause"), "Paused")}>
              <Icon name="pause" />
              Pause
            </button>
          ) : ["paused", "stopped", "done"].includes(run.status) ? (
            <button className="btn btn-sm" onClick={act(() => api.resume(run.id), "Resumed")}>
              <Icon name="play" />
              Resume
            </button>
          ) : null}
          <button className="btn btn-sm" onClick={() => navigate(`/runs/${encodeURIComponent(run.id)}#terminal`)}>
            <Icon name="term" />
            Terminal
          </button>
        </div>
      </div>
      <div className="sec">
        <ProgressNotes run={run} compact />
      </div>
      {fleet && (
        <div className="sec">
          <AgentTree run={run} fleet={fleet} />
        </div>
      )}
      <div className="sec">
        <h3>
          Timeline <span>last 20 min</span>
        </h3>
        <RunLanes runId={run.id} />
      </div>
      {snap && (
        <div className="sec">
          <h3>
            Links <span>workbase reads</span>
          </h3>
          <Links runId={run.id} snap={snap} />
        </div>
      )}
      {fleet && (
        <div className="sec">
          <h3>Resources</h3>
          <Resources fleet={fleet} />
        </div>
      )}
      <div className="sec">
        <h3>
          Activity <span>live</span>
        </h3>
        <ActivityLog runId={run.id} />
      </div>
    </aside>
  );
}
