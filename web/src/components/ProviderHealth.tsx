/** How each provider/model is behaving right now: latency, speed, errors and usage against your limits. */
import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { useAsync, useThrottled } from "../lib/hooks.ts";
import { useLive } from "../lib/live.ts";
import { tokens } from "../lib/format.ts";
import type { ProviderHealth as Health } from "../lib/types.ts";
import { ErrorBox } from "./ui.tsx";
import { toast } from "./Toast.tsx";

type Limit = { tpm?: number; rpm?: number };

const ms = (n: number | null) => (n == null ? "–" : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`);
const STATE: Record<string, { dot: string; label: string }> = {
  ok: { dot: "running", label: "healthy" },
  degraded: { dot: "recovering", label: "degraded" },
  limited: { dot: "failed", label: "rate limited" },
  idle: { dot: "", label: "idle" },
};

function Spark({ values }: { values: (number | null)[] }) {
  const W = 64;
  const H = 16;
  const max = Math.max(1, ...values.filter((v): v is number => v != null));
  const step = W / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => (v == null ? null : [i * step, H - 2 - (v / max) * (H - 4)]));
  const d = pts.map((p, i) => (p ? `${i && pts[i - 1] ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}` : "")).join("");
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" style={{ display: "inline-block", verticalAlign: "middle" }}>
      <path d={d} fill="none" strokeWidth={1.3} style={{ stroke: "var(--accent)" }} />
      {/* A bucket with no neighbours draws no line; show it as a dot. */}
      {pts.map((p, i) => (p && !pts[i - 1] && !pts[i + 1] ? <circle key={i} cx={p[0]} cy={p[1]} r={1.6} style={{ fill: "var(--accent)" }} /> : null))}
    </svg>
  );
}

function Usage({ value, limit, unit }: { value: number; limit?: number; unit: string }) {
  const text = `${unit === "tok" ? tokens(Math.round(value)) : value.toFixed(1)}${limit ? ` / ${unit === "tok" ? tokens(limit) : limit}` : ""}`;
  if (!limit) return <span className="num">{text}</span>;
  const p = Math.min(1, value / limit);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 40, height: 4, borderRadius: 2, background: "var(--meter)", overflow: "hidden", display: "inline-block" }}>
        <i style={{ display: "block", height: "100%", width: `${p * 100}%`, background: p > 0.8 ? "var(--warn)" : "var(--fg2)" }} />
      </span>
      <span className="num">{text}</span>
    </span>
  );
}

function LimitCell({ model, limit, onSave }: { model: string; limit: Limit | null; onSave: (l: Limit | null) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [tpm, setTpm] = useState(limit?.tpm ? String(limit.tpm) : "");
  const [rpm, setRpm] = useState(limit?.rpm ? String(limit.rpm) : "");
  if (!editing)
    return (
      <button className="btn btn-sm" onClick={() => setEditing(true)}>
        {limit ? "Edit limits" : "Set limits"}
      </button>
    );
  const num = (s: string) => (s.trim() && Number(s) > 0 ? Number(s) : undefined);
  const save = async () => {
    const l = { tpm: num(tpm), rpm: num(rpm) };
    await onSave(l.tpm || l.rpm ? l : null);
    setEditing(false);
  };
  return (
    <span style={{ display: "inline-flex", gap: 4 }}>
      <input className="input" style={{ width: 90, padding: "2px 6px", fontSize: 12 }} placeholder="tokens/min" value={tpm} onChange={(e) => setTpm(e.target.value)} aria-label={`Tokens per minute limit for ${model}`} />
      <input className="input" style={{ width: 66, padding: "2px 6px", fontSize: 12 }} placeholder="req/min" value={rpm} onChange={(e) => setRpm(e.target.value)} aria-label={`Requests per minute limit for ${model}`} />
      <button className="btn btn-sm btn-primary" onClick={() => void save()}>
        Save
      </button>
    </span>
  );
}

export function ProviderHealth() {
  const [minutes, setMinutes] = useState(60);
  const health = useAsync(() => api.providerHealth(minutes), [minutes]);
  const settings = useAsync(() => api.settings(), []);
  const refresh = useThrottled(() => void health.reload(), 3000);
  useLive("*", (m) => {
    if (m.type === "provider") refresh();
  });
  useEffect(() => {
    const t = setInterval(() => void health.reload(), 15_000);
    return () => clearInterval(t);
  }, [minutes]);

  const saveLimit = async (model: string, l: Limit | null) => {
    const limits = { ...(settings.data?.providerLimits ?? {}) };
    if (l) limits[model] = l;
    else delete limits[model];
    try {
      await api.saveSettings({ providerLimits: limits });
      toast("Limits saved");
      void settings.reload();
      void health.reload();
    } catch (e: any) {
      toast(e.message ?? String(e), "error");
    }
  };
  const rows: Health = health.data ?? [];

  return (
    <section className="card" style={{ padding: 0 }}>
      <div className="sec">
        <h3>
          Provider health
          <span className="tabs" style={{ gap: 0 }}>
            {[15, 60, 360].map((m) => (
              <button key={m} className={`tab ${minutes === m ? "on" : ""}`} style={{ padding: "0 6px", fontSize: 11 }} onClick={() => setMinutes(m)}>
                {m < 60 ? `${m}m` : `${m / 60}h`}
              </button>
            ))}
          </span>
        </h3>
        <ErrorBox error={health.error} />
        {health.data && !rows.length && <span className="muted">No model calls in this window. Start a run and this fills in live.</span>}
      </div>
      {rows.length > 0 && (
        <div className="tablewrap">
          <table className="runs" style={{ minWidth: 980 }}>
            <thead>
              <tr>
                <th className="th">Provider / model</th>
                <th className="th r">Calls</th>
                <th className="th">First token p50 · p90</th>
                <th className="th">Output tok/s p50</th>
                <th className="th r">Errors · 429 · retries</th>
                <th className="th">Tokens / min</th>
                <th className="th">Requests / min</th>
                <th className="th">Limits</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((h) => {
                const st = STATE[h.state] ?? STATE.idle;
                return (
                  <tr key={h.key} style={{ cursor: "default" }}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span className={`dot ${st.dot}`} title={st.label} />
                        <div>
                          <div className="mono" style={{ fontSize: 12.5 }}>
                            {h.key}
                          </div>
                          <div className="muted" style={{ fontSize: 11.5, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }} title={h.lastEvent?.message}>
                            {h.lastEvent ? `${h.lastEvent.kind}: ${h.lastEvent.message}` : st.label}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="r num">{h.calls}</td>
                    <td>
                      <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                        <Spark values={h.buckets.map((b) => b.ttft)} />
                        <span className="num">
                          {ms(h.ttft.p50)} · {ms(h.ttft.p90)}
                        </span>
                      </span>
                    </td>
                    <td>
                      <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                        <Spark values={h.buckets.map((b) => b.tps)} />
                        <span className="num">{h.tps.p50 == null ? "–" : Math.round(h.tps.p50)}</span>
                      </span>
                    </td>
                    <td className="r num" style={{ color: h.errors || h.rateLimits ? "var(--warn)" : undefined }}>
                      {h.errors} · {h.rateLimits} · {h.retries}
                    </td>
                    <td>
                      <Usage value={h.tokensPerMin} limit={h.limit?.tpm} unit="tok" />
                    </td>
                    <td>
                      <Usage value={h.requestsPerMin} limit={h.limit?.rpm} unit="req" />
                    </td>
                    <td>
                      <LimitCell model={h.key} limit={h.limit} onSave={(l) => saveLimit(h.key, l)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="sec" style={{ borderTop: rows.length ? "1px solid var(--line)" : undefined }}>
        <span className="muted" style={{ fontSize: 12 }}>
          First token = time from a model call starting to its first streamed output. Usage per minute is averaged over the last 5 minutes. Limits are yours to enter, from your provider plan.
        </span>
      </div>
    </section>
  );
}
