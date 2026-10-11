/** Quick text-only speed test: the same prose prompt to each picked model, one after another. */
import { useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { useAsync, useThrottled } from "../lib/hooks.ts";
import { useLive } from "../lib/live.ts";
import { ago } from "../lib/format.ts";
import type { SpeedTestRow } from "../lib/types.ts";
import { ErrorBox } from "./ui.tsx";
import { toast } from "./Toast.tsx";

const ms = (n: number | null) => (n == null ? "–" : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`);
const keyOf = (r: SpeedTestRow) => `${r.provider}/${r.model}`;

function Bar({ value, max, color }: { value: number | null; max: number; color: string }) {
  if (value == null) return <span className="muted">–</span>;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, width: "100%" }}>
      <span style={{ flex: 1, minWidth: 60, height: 6, borderRadius: 3, background: "var(--meter)", overflow: "hidden", display: "inline-block" }}>
        <i style={{ display: "block", height: "100%", width: `${Math.max(2, (value / max) * 100)}%`, background: color }} />
      </span>
    </span>
  );
}

function Chip({ on, label, onClick, onRemove }: { on: boolean; label: string; onClick: () => void; onRemove?: () => void }) {
  return (
    <span
      className="mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 12,
        border: `1px solid ${on ? "var(--accent)" : "var(--line)"}`,
        background: on ? "var(--accent-soft)" : undefined,
        borderRadius: 5,
        padding: "1px 4px 1px 7px",
      }}
    >
      <button onClick={onClick} aria-pressed={on} style={{ all: "unset", cursor: "pointer", color: on ? "var(--fg)" : "var(--fg2)" }}>
        {label}
      </button>
      {onRemove && (
        <button onClick={onRemove} aria-label={`Remove ${label}`} className="muted" style={{ all: "unset", cursor: "pointer", padding: "0 3px" }}>
          ×
        </button>
      )}
    </span>
  );
}

export function SpeedTest() {
  const tests = useAsync(() => api.speedTests(), []);
  const settings = useAsync(() => api.settings(), []);
  const board = useAsync(() => api.leaderboard(), []);
  const health = useAsync(() => api.providerHealth(360), []);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [extra, setExtra] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [showAll, setShowAll] = useState(false);
  const reload = useThrottled(() => void tests.reload(), 500);

  useLive("*", (m) => {
    if (m.type !== "speedtest") return;
    if (m.data?.current)
      tests.setData((d) => (d ? { ...d, running: m.data.batch, current: m.data.current } : d));
    else reload();
  });

  const results = tests.data?.results ?? [];
  const running = tests.data?.running ?? null;

  // Models worth offering: your configured ones, everything that has run, and earlier tests that worked.
  const known = useMemo(() => {
    const s = new Set<string>([...(settings.data?.models ?? []), ...(board.data ?? []).map((m) => m.model), ...(health.data ?? []).map((h) => h.key), ...results.filter((r) => r.ok).map(keyOf), ...extra]);
    return [...s].filter((m) => m.includes("/")).sort();
  }, [settings.data, board.data, health.data, results, extra]);
  const selected = picked ?? new Set(settings.data?.models ?? []);
  const toggle = (m: string) => {
    const s = new Set(selected);
    s.has(m) ? s.delete(m) : s.add(m);
    setPicked(s);
  };
  const add = () => {
    const m = input.trim();
    if (!m.includes("/")) return toast("Use provider/model, e.g. opencode/big-pickle", "error");
    if (!known.includes(m)) setExtra((x) => [...x, m]);
    setPicked(new Set([...selected, m]));
    setInput("");
  };
  const start = async () => {
    try {
      const r = await api.startSpeedTest([...selected]);
      tests.setData((d) => ({ results: d?.results ?? [], running: r.batch, models: r.models, current: null }));
    } catch (e: any) {
      toast(e.message ?? String(e), "error");
    }
  };

  // The batch to show on top: the running one, else the latest.
  const batch = running ?? results[0]?.batch ?? null;
  const batchRows = results.filter((r) => r.batch === batch);
  const queue = running ? (tests.data?.models.length ? tests.data.models : [...new Set([...batchRows.map(keyOf), tests.data?.current ?? ""])].filter(Boolean)) : batchRows.map(keyOf);
  const rowFor = (m: string) => batchRows.find((r) => keyOf(r) === m);
  const ordered = running ? queue : [...queue].sort((a, b) => (rowFor(b)?.tps ?? -1) - (rowFor(a)?.tps ?? -1));
  const maxTps = Math.max(1, ...batchRows.map((r) => r.tps ?? 0));
  const maxTtft = Math.max(1, ...batchRows.map((r) => r.ttft_ms ?? 0));
  const older = results.filter((r) => r.batch !== batch);

  return (
    <section className="card" style={{ padding: 0 }}>
      <div className="sec">
        <h3>
          Speed test <span>same prompt, text only</span>
        </h3>
        <ErrorBox error={tests.error} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {known.map((m) => (
            <Chip key={m} label={m} on={selected.has(m)} onClick={() => toggle(m)} onRemove={extra.includes(m) ? () => setExtra((x) => x.filter((y) => y !== m)) : undefined} />
          ))}
          <form
            style={{ display: "inline-flex", gap: 4 }}
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <input className="input mono" style={{ width: 200, padding: "2px 6px", fontSize: 12 }} placeholder="provider/model" value={input} onChange={(e) => setInput(e.target.value)} aria-label="Add a model" />
            <button className="btn btn-sm" type="submit" disabled={!input.trim()}>
              Add
            </button>
          </form>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button className="btn btn-sm btn-primary" disabled={!!running || !selected.size || selected.size > 12} onClick={() => void start()}>
            {running ? "Running…" : `Test ${selected.size} model${selected.size === 1 ? "" : "s"}`}
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            {selected.size > 12 ? "At most 12 models per test." : "Models run one after another; each takes a few seconds to two minutes."}
          </span>
        </div>
      </div>

      {queue.length > 0 && (
        <div className="tablewrap">
          <table className="runs" style={{ minWidth: 820 }}>
            <thead>
              <tr>
                <th className="th">Model {batchRows[0] && !running && <span className="muted" style={{ textTransform: "none", letterSpacing: 0 }}>· {ago(batchRows[0].ts)}</span>}</th>
                <th className="th" style={{ width: "26%" }}>Output tok/s</th>
                <th className="th r" style={{ width: 60 }} />
                <th className="th" style={{ width: "20%" }}>First token</th>
                <th className="th r" style={{ width: 70 }} />
                <th className="th r">Total</th>
                <th className="th r">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((m) => {
                const r = rowFor(m);
                const state = r ? (r.ok ? "done" : "failed") : running && tests.data?.current === m ? "running" : "waiting";
                return (
                  <tr key={m} style={{ cursor: "default" }}>
                    <td>
                      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                        <span className={`ring ${state}`} title={state} />
                        <div>
                          <div className="mono" style={{ fontSize: 12.5 }}>
                            {m}
                          </div>
                          {r?.error && (
                            <div style={{ fontSize: 11.5, color: "var(--bad)", maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.error}>
                              {r.error}
                            </div>
                          )}
                          {state === "running" && <div className="muted" style={{ fontSize: 11.5 }}>waiting for the answer…</div>}
                        </div>
                      </div>
                    </td>
                    <td>{r?.ok ? <Bar value={r.tps} max={maxTps} color="var(--accent)" /> : null}</td>
                    <td className="r num">{r?.tps == null ? "" : Math.round(r.tps)}</td>
                    <td>{r?.ok ? <Bar value={r.ttft_ms} max={maxTtft} color="var(--fg3)" /> : null}</td>
                    <td className="r num">{r?.ok ? ms(r.ttft_ms) : ""}</td>
                    <td className="r num">{r?.ok ? ms(r.total_ms) : ""}</td>
                    <td className="r num">{r?.tokens_out ?? ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {older.length > 0 && (
        <div className="sec" style={{ borderTop: "1px solid var(--line)" }}>
          <h3>
            Earlier tests
            <button style={{ all: "unset", cursor: "pointer", color: "var(--fg3)", textTransform: "none", letterSpacing: 0 }} onClick={() => setShowAll((v) => !v)}>
              {showAll ? "show fewer" : `show all ${older.length}`}
            </button>
          </h3>
          <div className="tablewrap" style={{ margin: "0 -16px" }}>
            <table className="runs" style={{ minWidth: 640 }}>
              <tbody>
                {(showAll ? older : older.slice(0, 8)).map((r) => (
                  <tr key={r.id} style={{ cursor: "default" }}>
                    <td className="muted num" style={{ width: 110 }}>
                      {ago(r.ts)}
                    </td>
                    <td className="mono" style={{ fontSize: 12.5 }}>
                      {keyOf(r)}
                    </td>
                    {r.ok ? (
                      <>
                        <td className="r num">{r.tps == null ? "–" : `${Math.round(r.tps)} tok/s`}</td>
                        <td className="r num">{ms(r.ttft_ms)} first</td>
                        <td className="r num">{ms(r.total_ms)} total</td>
                      </>
                    ) : (
                      <td colSpan={3} style={{ color: "var(--bad)", fontSize: 12, maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.error ?? ""}>
                        {r.error}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="sec" style={{ borderTop: "1px solid var(--line)" }}>
        <span className="muted" style={{ fontSize: 12 }}>
          Asks each model for about 250 words of prose in a throwaway opencode with no files, where every tool call is refused. Uses the providers set up on this page. One sample per model, so treat small differences as noise; the Health tab shows what agents actually get.
        </span>
      </div>
    </section>
  );
}
