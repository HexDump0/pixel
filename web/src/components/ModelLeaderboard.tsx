/** Every model Pixel has run, compared across all its runs. */
import { useEffect } from "react";
import { api } from "../lib/api.ts";
import { useAsync } from "../lib/hooks.ts";
import { duration, money, tokens } from "../lib/format.ts";
import { ErrorBox } from "./ui.tsx";

const pct = (n: number | null) => (n == null ? "–" : `${Math.round(n * 100)}%`);
const ms = (n: number | null) => (n == null ? "–" : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`);

function Meter({ value }: { value: number | null }) {
  if (value == null) return <span className="muted">–</span>;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 44, height: 4, borderRadius: 2, background: "var(--meter)", overflow: "hidden", display: "inline-block" }}>
        <i style={{ display: "block", height: "100%", width: `${value * 100}%`, background: "var(--accent)" }} />
      </span>
      <span className="num">{pct(value)}</span>
    </span>
  );
}

export function ModelLeaderboard() {
  const board = useAsync(() => api.leaderboard(), []);
  useEffect(() => {
    const t = setInterval(() => void board.reload(), 60_000);
    return () => clearInterval(t);
  }, []);
  const rows = board.data ?? [];

  return (
    <section className="card" style={{ padding: 0 }}>
      <div className="sec">
        <h3>
          Leaderboard <span>all runs, per model</span>
        </h3>
        <ErrorBox error={board.error} />
        {board.data && !rows.length && <span className="muted">No runs yet.</span>}
      </div>
      {rows.length > 0 && (
        <div className="tablewrap">
          <table className="runs" style={{ minWidth: 980 }}>
            <thead>
              <tr>
                <th className="th">Model</th>
                <th className="th r">Runs</th>
                <th className="th">Finished</th>
                <th className="th r">Median time</th>
                <th className="th r">Tokens / run</th>
                <th className="th r">Cost / run</th>
                <th className="th">Real findings</th>
                <th className="th r">Cost / real</th>
                <th className="th r">Cont · OOM</th>
                <th className="th r">First token</th>
                <th className="th r">Tok/s</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.model} style={{ cursor: "default" }}>
                  <td>
                    <div className="mono" style={{ fontSize: 12.5 }}>
                      {m.model}
                    </div>
                    {m.active > 0 && <div className="muted" style={{ fontSize: 11.5 }}>{m.active} active</div>}
                  </td>
                  <td className="r num">{m.runs}</td>
                  <td title={`${m.finished} finished, ${m.gaveUp} stopped or failed`}>
                    <Meter value={m.finishRate} />
                  </td>
                  <td className="r num">{m.medianDuration == null ? "–" : duration(m.medianDuration).replace(/ \d+s$/, "")}</td>
                  <td className="r num">{tokens(Math.round(m.avgTokens))}</td>
                  <td className="r num">{money(m.avgCost)}</td>
                  <td title={Object.entries(m.verdicts).map(([v, n]) => `${v}: ${n}`).join("\n") || "No triage verdicts yet"}>
                    {m.triaged ? (
                      <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                        <Meter value={m.realRate} />
                        <span className="muted num" style={{ fontSize: 11.5 }}>
                          {m.real}/{m.triaged}
                        </span>
                      </span>
                    ) : (
                      <span className="muted">not triaged</span>
                    )}
                  </td>
                  <td className="r num">{m.costPerReal == null ? "–" : money(m.costPerReal)}</td>
                  <td className="r num">
                    {m.avgContinues.toFixed(1)} · {m.avgOom.toFixed(1)}
                  </td>
                  <td className="r num">{ms(m.ttftP50)}</td>
                  <td className="r num">{m.tpsP50 == null ? "–" : Math.round(m.tpsP50)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="sec" style={{ borderTop: rows.length ? "1px solid var(--line)" : undefined }}>
        <span className="muted" style={{ fontSize: 12 }}>
          Finished = wrote a report. Real findings = runs you triaged as "real findings" or "partly real". First token and tok/s are medians over every model call.
        </span>
      </div>
    </section>
  );
}
