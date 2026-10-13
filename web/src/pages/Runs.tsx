/** Runs: live fleet strip, the runs table, and the panel for the selected run (?run=<id>). */
import { useEffect, useMemo, useState } from "react";
import { navigate, Link, useLocation } from "../lib/router.tsx";
import { useTick } from "../lib/hooks.ts";
import { duration, money, tokens } from "../lib/format.ts";
import { rate, RATE_WINDOW, useFleet } from "../lib/fleet.ts";
import { useRuns, ACTIVE } from "../lib/runs.ts";
import type { FleetRun, Run, RunStatus } from "../lib/types.ts";
import { Barcode, fmtInt, MemorySplit, MiniMeters, SpendBars, TokenFlow, TokensToday } from "../components/viz.tsx";
import { RunPanel } from "../components/RunPanel.tsx";
import { openPalette } from "../components/CommandPalette.tsx";
import { Icon } from "../components/icons.tsx";
import { ErrorBox } from "../components/ui.tsx";
import { RunName } from "../components/RunName.tsx";

const FILTERS: { id: string; label: string; match: (r: Run) => boolean }[] = [
  { id: "active", label: "Active", match: (r) => ACTIVE.includes(r.status) },
  { id: "attention", label: "Needs you", match: (r) => ["stopped", "failed"].includes(r.status) || (r.questions ?? 0) > 0 },
  { id: "triage", label: "To triage", match: (r) => r.status === "done" },
  { id: "all", label: "All", match: () => true },
];

const elapsed = (r: Run) => (r.started_at ? (r.finished_at ?? Date.now()) - r.started_at : null);

function NowCell({ run, fleet }: { run: Run; fleet?: FleetRun }) {
  const live = ["running", "recovering"].includes(run.status);
  const calling = fleet?.now && ["running", "pending"].includes(fleet.now.status);
  if (live && fleet?.now && calling && run.status === "running")
    return (
      <div className="now" title={`${fleet.now.tool} ${fleet.now.text}`}>
        <span className="tool">{fleet.now.tool}</span>
        <span className="txt">{fleet.now.text}</span>
      </div>
    );
  const text: Partial<Record<RunStatus, string>> = {
    done: run.report_ready ? "Report ready to triage" : "Finished",
    triaged: run.triage_verdict ? `Triaged · ${run.triage_verdict}` : "Triaged",
    paused: "Paused",
  };
  const warn = ["recovering", "stopped", "failed", "preparing"].includes(run.status);
  return (
    <div className={`now plain ${warn ? "warn" : ""}`}>
      <span className="txt">{run.status_detail || text[run.status] || (run.agent_status === "idle" ? "Idle" : run.status === "running" ? "thinking…" : run.status)}</span>
    </div>
  );
}

function AgentBlocks({ run, fleet }: { run: Run; fleet?: FleetRun }) {
  const subs = fleet?.agents.subs ?? [];
  const main = ACTIVE.includes(run.status) ? (run.status === "recovering" ? "interrupted" : "running") : "done";
  return (
    <span className="agents" title={`Main agent + ${subs.length} subagent${subs.length === 1 ? "" : "s"}`}>
      <i className={main} />
      {subs.slice(-8).map((s) => (
        <i key={s.id} className={s.status} />
      ))}
      <span className="num">{1 + subs.length}</span>
    </span>
  );
}

export function RunsPage() {
  useTick(10_000);
  const { runs, error } = useRuns();
  const snap = useFleet();
  const { search } = useLocation();
  const selected = new URLSearchParams(search).get("run");
  const [filter, setFilter] = useState<string | null>(null);

  const all = runs ?? [];
  const counts = Object.fromEntries(FILTERS.map((f) => [f.id, all.filter(f.match).length]));
  const tab = filter ?? (counts.active ? "active" : "all");
  const shown = useMemo(() => all.filter(FILTERS.find((f) => f.id === tab)!.match), [all, tab]);
  const fleetById = new Map((snap?.runs ?? []).map((r) => [r.id, r]));
  const maxActivity = Math.max(1, ...(snap?.runs ?? []).flatMap((r) => r.activity.map((b) => b.n)));
  const selRun = all.find((r) => r.id === selected) ?? null;
  const select = (id: string | null) => navigate(id ? `/?run=${encodeURIComponent(id)}` : "/", true);

  // j/k move through the table, Enter opens the run page, Esc closes the panel.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest("input, textarea, select, .scrim")) return;
      const i = shown.findIndex((r) => r.id === selected);
      if (e.key === "j" || e.key === "k") {
        if (!shown.length) return;
        const next = i < 0 ? 0 : (i + (e.key === "j" ? 1 : shown.length - 1)) % shown.length;
        select(shown[next].id);
      } else if (e.key === "Enter" && selected) navigate(`/runs/${encodeURIComponent(selected)}`);
      else if (e.key === "Escape" && selected) select(null);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [shown, selected]);

  const tpsNow = (snap?.runs ?? []).reduce((a, r) => a + rate(r.tps), 0);

  return (
    <div>
      <div className="bar">
        <h1>Runs</h1>
        <div className="tabs" role="tablist">
          {FILTERS.map((f) => (
            <button key={f.id} role="tab" aria-selected={tab === f.id} className={`tab ${tab === f.id ? "on" : ""}`} onClick={() => setFilter(f.id)}>
              {f.label} <span className="num">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        <button className="searchbtn" onClick={() => openPalette()} aria-label="Open command palette">
          <Icon name="search" />
          <span>Search or run a command</span>
          <kbd>⌘K</kbd>
        </button>
        <Link to="/new" className="btn btn-primary">
          <Icon name="plus" />
          New run
        </Link>
      </div>

      {snap && (
        <div className="stats">
          <div className="stat">
            <div className="head">
              <div className="k eyebrow">
                <span className={`live-dot ${tpsNow ? "" : "off"}`} style={tpsNow ? undefined : { background: "var(--fg3)" }} />
                <span title="Tokens the models are generating (text, reasoning, tool calls). Live from the stream, corrected to exact counts as each call finishes.">
                  Output tokens / s · {RATE_WINDOW} s avg
                </span>
              </div>
              <div className="v">{fmtInt(tpsNow)}</div>
            </div>
            <TokenFlow runs={snap.runs} window={snap.window} />
          </div>
          <div className="stat">
            <div className="head">
              <div className="k eyebrow">Tokens today</div>
              <div className="v">
                {tokens(snap.tokens.total)}
                {snap.tokens.hitRate != null && <small>{Math.round(snap.tokens.hitRate * 100)}% cached</small>}
              </div>
            </div>
            <TokensToday t={snap.tokens} />
          </div>
          <div className="stat">
            <div className="head">
              <div className="k eyebrow">{snap.memory.label}</div>
              <div className="v">
                {(snap.memory.used / 1024 ** 3).toFixed(1)}
                <small>/ {(snap.memory.total / 1024 ** 3).toFixed(0)} GB</small>
              </div>
            </div>
            <MemorySplit snap={snap} />
          </div>
          <div className="stat">
            <div className="head">
              <div className="k eyebrow">Spend today</div>
              <div className="v">
                {money(snap.spend.total)}
                <small title="Today so far plus the last hour's rate until midnight">→ {money(snap.spend.projected)}</small>
              </div>
            </div>
            <SpendBars spend={snap.spend} runs={snap.runs} />
          </div>
        </div>
      )}

      <div style={{ padding: error ? "12px 16px 0" : 0 }}>
        <ErrorBox error={error} />
      </div>

      <div className={`split ${selRun ? "" : "closed"}`}>
        <div className="tablewrap">
          {runs && !shown.length ? (
            <div className="muted" style={{ padding: "48px 16px", textAlign: "center" }}>
              {all.length ? "No runs here." : <>No runs yet. <Link to="/new">Start one</Link>, or press <kbd>⌘K</kbd>.</>}
            </div>
          ) : (
            <table className="runs">
              <thead>
                <tr>
                  <th className="th">Run</th>
                  <th className="th">Now</th>
                  <th className="th">Agents</th>
                  <th className="th">Activity · 30m</th>
                  <th className="th r">Tok/s</th>
                  <th className="th r">CPU · Mem</th>
                  <th className="th r">Time</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const f = fleetById.get(r.id);
                  return (
                    <tr key={r.id} className={r.id === selected ? "sel" : ""} tabIndex={0} onClick={() => select(r.id === selected ? null : r.id)} onDoubleClick={() => navigate(`/runs/${encodeURIComponent(r.id)}`)} onKeyDown={(e) => e.key === " " && (e.preventDefault(), select(r.id))}>
                      <td>
                        <div className="runcell">
                          <span className={`dot ${r.status}`} title={r.status} />
                          <div style={{ minWidth: 0 }}>
                            <div className="name">
                              <RunName run={r} />
                              {(r.questions ?? 0) > 0 && (
                                <span className="badge question" style={{ marginLeft: 6 }}>
                                  question
                                </span>
                              )}
                            </div>
                            <div className="repo">{r.repo.replace(/^https?:\/\/(www\.)?(github\.com\/)?/, "")}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <NowCell run={r} fleet={f} />
                      </td>
                      <td>
                        <AgentBlocks run={r} fleet={f} />
                      </td>
                      <td>{f ? <Barcode activity={f.activity} max={maxActivity} /> : <span className="muted">–</span>}</td>
                      <td className="r num">{f?.tps.length ? fmtInt(rate(f.tps)) : <span className="muted">–</span>}</td>
                      <td className="r">{f ? <MiniMeters run={f} /> : <span className="muted">–</span>}</td>
                      <td className="r num">{duration(elapsed(r)).replace(/ \d+s$/, "")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        {selRun && <RunPanel key={selRun.id} run={selRun} onClose={() => select(null)} />}
      </div>
    </div>
  );
}
