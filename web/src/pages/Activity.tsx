/** Activity: every tool call and every Pixel action across the fleet, live, filterable. */
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { useLive } from "../lib/live.ts";
import { Link } from "../lib/router.tsx";
import { kindColor, runColor } from "../lib/fleet.ts";
import { useRuns } from "../lib/runs.ts";
import type { Activity, TimelineEntry } from "../lib/types.ts";
import { PageHeader } from "../components/ui.tsx";
import { Select } from "../components/ui/overlay.tsx";
import { KIND_LEGEND } from "../components/viz.tsx";

const LIMIT = 400;

interface Row {
  key: string;
  ts: number;
  run: string;
  who: string;
  source: "agent" | "pixel" | "user";
  kind: string | null;
  tool: string | null;
  text: string;
}

const fromCall = (a: Activity): Row => ({ key: `c${a.session}${a.ts}${a.tool}`, ts: a.ts, run: a.run, who: a.agent ?? "main", source: "agent", kind: a.kind, tool: a.tool, text: a.text });
const fromEvent = (e: Pick<TimelineEntry, "run_id" | "ts" | "actor" | "kind" | "message">): Row => ({
  key: `e${e.run_id}${e.ts}${e.kind}`,
  ts: e.ts,
  run: e.run_id,
  who: e.actor === "pixel" ? "pixel" : e.actor === "user" ? "you" : "agent",
  source: e.actor === "pixel" ? "pixel" : e.actor === "user" ? "user" : "agent",
  kind: null,
  tool: null,
  text: e.message,
});

export function ActivityPage() {
  const { runs } = useRuns();
  const [rows, setRows] = useState<Row[]>([]);
  const [run, setRun] = useState("");
  const [kinds, setKinds] = useState<Set<string>>(new Set());
  const [pixelOnly, setPixelOnly] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    api.activity(undefined, LIMIT).then((r) => setRows([...r.calls.map(fromCall), ...r.events.map(fromEvent)].sort((a, b) => b.ts - a.ts).slice(0, LIMIT)));
  }, []);
  useLive("*", (m) => {
    if (paused) return;
    const add = (r: Row) => setRows((xs) => [r, ...xs.filter((x) => x.key !== r.key)].slice(0, LIMIT));
    if (m.type === "activity" && m.data.status === "running") add(fromCall(m.data));
    if (m.type === "timeline" && !["prepare", "permission"].includes(m.data.kind)) add(fromEvent(m.data));
  });

  const shown = useMemo(
    () => rows.filter((r) => (!run || r.run === run) && (!pixelOnly || r.source !== "agent") && (!kinds.size || (!!r.kind && kinds.has(r.kind)))),
    [rows, run, kinds, pixelOnly],
  );
  const toggle = (k: string) => setKinds((s) => (s.has(k) ? new Set([...s].filter((x) => x !== k)) : new Set([...s, k])));

  return (
    <div>
      <PageHeader title="Activity" subtitle="Every tool call and every action Pixel took, across all runs, as it happens." />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <Select label="Run" value={run} onChange={setRun} options={[["", "All runs"], ...(runs ?? []).map((r): [string, string] => [r.id, r.id])]} />
        <div className="tabs">
          {KIND_LEGEND.map(([k, label]) => (
            <button key={k} className={`tab ${kinds.has(k) ? "on" : ""}`} onClick={() => toggle(k)} aria-pressed={kinds.has(k)}>
              <i style={{ width: 7, height: 7, borderRadius: 1, background: kindColor(k), display: "inline-block" }} />
              {label}
            </button>
          ))}
          <button className={`tab ${pixelOnly ? "on" : ""}`} onClick={() => setPixelOnly((p) => !p)} aria-pressed={pixelOnly}>
            Pixel & you only
          </button>
        </div>
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => setPaused((p) => !p)}>
          <span className={`live-dot ${paused ? "off" : ""}`} />
          {paused ? "Paused" : "Live"}
        </button>
      </div>
      <div className="card" style={{ padding: 0 }}>
        {!shown.length ? (
          <div className="muted" style={{ padding: 32, textAlign: "center" }}>
            Nothing yet.
          </div>
        ) : (
          <div className="tablewrap">
            <table className="runs" style={{ minWidth: 640 }}>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.key} style={{ cursor: "default" }}>
                    <td className="num muted" style={{ width: 80, fontSize: 11.5 }}>
                      {new Date(r.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </td>
                    <td style={{ width: 200 }}>
                      <Link to={`/?run=${encodeURIComponent(r.run)}`} style={{ display: "inline-flex", alignItems: "center", gap: 7, color: "var(--fg)" }}>
                        <i style={{ width: 7, height: 7, borderRadius: 1, background: runColor(r.run), display: "inline-block" }} />
                        {r.run}
                      </Link>
                    </td>
                    <td style={{ width: 160, color: r.source === "pixel" ? "var(--warn)" : "var(--fg3)", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 160 }}>{r.who}</td>
                    <td style={{ maxWidth: 0, width: "100%" }}>
                      {r.tool ? (
                        <div className="now" style={{ maxWidth: "none" }}>
                          <span className="tool" style={{ borderColor: kindColor(r.kind) }}>
                            {r.tool}
                          </span>
                          <span className="txt" style={{ whiteSpace: "nowrap" }}>
                            {r.text}
                          </span>
                        </div>
                      ) : (
                        <span style={{ color: r.source === "pixel" ? "var(--warn)" : "var(--fg2)" }}>{r.text}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
