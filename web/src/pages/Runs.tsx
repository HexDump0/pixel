import { useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { useAsync, useTick } from "../lib/hooks.ts";
import { useLive } from "../lib/live.ts";
import { Link, navigate } from "../lib/router.tsx";
import { ago, duration, money, tokens } from "../lib/format.ts";
import type { Run, RunStatus } from "../lib/types.ts";
import { Badge, Empty, ErrorBox, PageHeader, Stat } from "../components/ui.tsx";

const FILTERS: { id: string; label: string; statuses: RunStatus[] | null }[] = [
  { id: "all", label: "All", statuses: null },
  { id: "active", label: "Active", statuses: ["preparing", "running", "recovering", "paused"] },
  { id: "attention", label: "Needs you", statuses: ["stopped", "failed"] },
  { id: "done", label: "To triage", statuses: ["done"] },
  { id: "triaged", label: "Triaged", statuses: ["triaged"] },
];

const runtimeOf = (r: Run) => (r.started_at ? (r.finished_at ?? Date.now()) - r.started_at : null);

export function RunsPage() {
  useTick(15_000);
  const runs = useAsync(api.runs, []);
  const [filter, setFilter] = useState("all");
  const [text, setText] = useState("");

  useLive("*", (m) => {
    if (m.type === "run") runs.setData((xs) => (xs?.some((r) => r.id === m.data.id) ? xs.map((r) => (r.id === m.data.id ? { ...r, ...m.data } : r)) : [m.data, ...(xs ?? [])]));
    if (m.type === "run.deleted") runs.setData((xs) => xs?.filter((r) => r.id !== m.data.id));
    if (m.type === "connected") void runs.reload();
  });

  const all = runs.data ?? [];
  const shown = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter)!;
    const t = text.toLowerCase();
    return all.filter((r) => (!f.statuses || f.statuses.includes(r.status)) && (!t || `${r.id} ${r.repo} ${r.model} ${r.language ?? ""}`.toLowerCase().includes(t)));
  }, [all, filter, text]);

  const active = all.filter((r) => ["preparing", "running", "recovering"].includes(r.status)).length;
  const attention = all.filter((r) => ["stopped", "failed"].includes(r.status) || (r.questions ?? 0) > 0).length;
  const toTriage = all.filter((r) => r.status === "done").length;
  const cost = all.reduce((n, r) => n + r.cost, 0);

  return (
    <div>
      <PageHeader
        title="Runs"
        actions={
          <Link to="/new" className="btn btn-primary hover:no-underline">
            New run
          </Link>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label="Active" value={active} />
        <Stat label="Need you" value={attention} />
        <Stat label="To triage" value={toTriage} />
        <Stat label="Total cost" value={money(cost)} />
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button key={f.id} className={`btn btn-sm ${filter === f.id ? "btn-primary" : ""}`} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
        <input className="input ml-auto w-56" placeholder="Filter by name, repo, model…" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <ErrorBox error={runs.error} />
      {runs.data && !shown.length ? (
        <Empty>{all.length ? "No runs match." : "No runs yet. Start one from “New run”."}</Empty>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr>
                {["Run", "Status", "Agent", "Model", "Runtime", "Tokens", "Cost", "Active", "Report", "Cont / OOM"].map((h) => (
                  <th key={h} className="th">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50" onClick={() => navigate(`/runs/${encodeURIComponent(r.id)}`)}>
                  <td className="td">
                    <div className="font-medium">{r.id}</div>
                    <div className="max-w-64 truncate text-xs muted" title={r.repo}>
                      {r.repo.replace(/^https?:\/\/(www\.)?/, "")}
                      {r.language ? ` · ${r.language}` : ""}
                    </div>
                  </td>
                  <td className="td">
                    <Badge value={r.status} />
                    {(r.questions ?? 0) > 0 && <Badge value="question" className="ml-1 border-amber-500 text-amber-600" />}
                    {r.status_detail && <div className="max-w-56 truncate text-xs muted">{r.status_detail}</div>}
                  </td>
                  <td className="td">{["running", "recovering"].includes(r.status) ? <Badge value={r.agent_status} /> : <span className="muted">–</span>}</td>
                  <td className="td font-mono text-xs whitespace-nowrap">{r.model}</td>
                  <td className="td tabular-nums">{duration(runtimeOf(r))}</td>
                  <td className="td tabular-nums">{tokens(r.tokens_in + r.tokens_out + r.tokens_reasoning)}</td>
                  <td className="td tabular-nums">{money(r.cost)}</td>
                  <td className="td whitespace-nowrap">{ago(r.last_activity)}</td>
                  <td className="td">{r.report_ready ? "✓" : <span className="muted">–</span>}</td>
                  <td className="td whitespace-nowrap tabular-nums">
                    {r.continues} / {r.oom_restarts}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
