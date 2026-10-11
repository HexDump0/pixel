/**
 * One provider's models: tick the ones offered in the new-run form, star the default, and run a
 * one-model speed test to check the key works. Changes save straight away.
 */
import { useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { useAsync } from "../lib/hooks.ts";
import { useLive } from "../lib/live.ts";
import { tokens } from "../lib/format.ts";
import type { CatalogModel, ConnectedProvider, Settings, SpeedTestRow } from "../lib/types.ts";
import { ErrorBox } from "./ui.tsx";
import { toast } from "./Toast.tsx";

const price = (n: number | null) => (n == null ? "–" : n === 0 ? "0" : n < 1 ? n.toFixed(2) : String(Math.round(n * 10) / 10));
const ms = (n: number | null) => (n == null ? "–" : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`);
const SHOW = 60;

type Test = { state: "running" } | { state: "done"; row: SpeedTestRow };

function TestResult({ t }: { t: Test | undefined }) {
  if (!t) return null;
  if (t.state === "running") return <span className="muted">testing…</span>;
  const r = t.row;
  if (!r.ok)
    return (
      <span style={{ color: "var(--bad)", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", display: "inline-block", verticalAlign: "middle" }} title={r.error ?? ""}>
        ✕ {r.error}
      </span>
    );
  return (
    <span style={{ color: "var(--ok)" }} className="num">
      ✓ {r.tps == null ? "" : `${Math.round(r.tps)} tok/s · `}
      {ms(r.ttft_ms)} first
    </span>
  );
}

export function ModelPicker({ provider, settings, onSettings }: { provider: ConnectedProvider; settings: Settings; onSettings: (s: Settings) => void }) {
  const cat = useAsync(() => (provider.custom ? Promise.resolve(null) : api.catalogProvider(provider.id).catch(() => null)), [provider.id, !!provider.custom]);
  const [query, setQuery] = useState("");
  const [toolsOnly, setToolsOnly] = useState(true);
  const [all, setAll] = useState(false);
  const [extra, setExtra] = useState("");
  const [tests, setTests] = useState<Record<string, Test>>({});
  const prefix = `${provider.id}/`;
  const freeOnly = provider.via.length === 1 && provider.via[0] === "builtin";

  useLive("*", (m) => {
    if (m.type !== "speedtest" || !m.data?.result) return;
    const row = m.data.result as SpeedTestRow;
    if (row.provider !== provider.id) return;
    setTests((t) => (t[row.model]?.state === "running" ? { ...t, [row.model]: { state: "done", row } } : t));
  });

  const models: CatalogModel[] = useMemo(() => {
    const list: CatalogModel[] = provider.custom
      ? provider.custom.models.map((id) => ({ id, name: id, family: null, context: provider.custom!.context, output: null, costIn: null, costOut: null, tools: true, reasoning: false, openWeights: false, released: null, status: null }))
      : [...(cat.data?.models ?? [])];
    // Offered models that the catalogue doesn't list (typed in by hand, or newer than the catalogue).
    for (const m of settings.models)
      if (m.startsWith(prefix) && !list.some((x) => x.id === m.slice(prefix.length)))
        list.push({ id: m.slice(prefix.length), name: m.slice(prefix.length), family: null, context: null, output: null, costIn: null, costOut: null, tools: true, reasoning: false, openWeights: false, released: null, status: null });
    return list;
  }, [cat.data, provider, settings.models]);

  const offered = (id: string) => settings.models.includes(prefix + id);
  const q = query.trim().toLowerCase();
  const shown = models
    .filter((m) => offered(m.id) || ((!toolsOnly || m.tools) && (!freeOnly || m.costIn === 0) && m.status !== "deprecated" && (!q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))))
    .sort((a, b) => Number(offered(b.id)) - Number(offered(a.id)) || (b.released ?? "").localeCompare(a.released ?? "") || a.id.localeCompare(b.id));
  const hidden = models.length - shown.length;

  const save = async (patch: Partial<Settings>) => {
    try {
      onSettings(await api.saveSettings(patch));
    } catch (e: any) {
      toast(e.message ?? String(e), "error");
    }
  };
  const toggle = (id: string) => {
    const full = prefix + id;
    if (offered(id)) {
      if (settings.defaultModel === full) return toast("That's the default model; star another one first", "error");
      void save({ models: settings.models.filter((m) => m !== full) });
    } else void save({ models: [...settings.models, full] });
  };
  const makeDefault = (id: string) => {
    const full = prefix + id;
    void save({ defaultModel: full, models: settings.models.includes(full) ? settings.models : [...settings.models, full] });
  };
  const test = async (id: string) => {
    try {
      await api.startSpeedTest([prefix + id]);
      setTests((t) => ({ ...t, [id]: { state: "running" } }));
    } catch (e: any) {
      toast(e.message ?? String(e), "error");
    }
  };
  const addExtra = () => {
    const id = extra.trim().replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "");
    if (!id) return;
    if (!offered(id)) void save({ models: [...settings.models, prefix + id] });
    setExtra("");
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 px-4 py-2">
        <input className="input" style={{ width: 240, padding: "3px 8px", fontSize: 12.5 }} placeholder={`Search ${models.length} models`} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search models" />
        {!provider.custom && (
          <label className="flex items-center gap-1.5 text-xs muted">
            <input type="checkbox" checked={toolsOnly} onChange={(e) => setToolsOnly(e.target.checked)} />
            only models that can call tools
          </label>
        )}
        {freeOnly && <span className="text-xs muted">Free models only; add an OpenCode Zen key to use the rest.</span>}
        <span className="text-xs muted ml-auto">{settings.models.filter((m) => m.startsWith(prefix)).length} offered in the new-run form</span>
      </div>
      <ErrorBox error={cat.error} />
      {!provider.custom && cat.loading && !cat.data && <div className="px-4 py-2 muted">Loading models…</div>}
      {!provider.custom && !cat.loading && !cat.data && <div className="px-4 py-2 muted">This provider isn't in the catalogue; type model ids below.</div>}
      {shown.length > 0 && (
        <div className="tablewrap">
          <table className="runs" style={{ minWidth: 820 }}>
            <thead>
              <tr>
                <th className="th" style={{ width: 70 }}>
                  Offer
                </th>
                <th className="th">Model</th>
                <th className="th r">Context</th>
                <th className="th r" title="USD per million tokens">
                  $ in · out /M
                </th>
                <th className="th" />
                <th className="th">Check</th>
                <th className="th r" style={{ width: 70 }}>
                  Default
                </th>
              </tr>
            </thead>
            <tbody>
              {(all ? shown : shown.slice(0, SHOW)).map((m) => {
                const on = offered(m.id);
                const isDefault = settings.defaultModel === prefix + m.id;
                return (
                  <tr key={m.id} style={{ cursor: "default" }}>
                    <td>
                      <input type="checkbox" checked={on} onChange={() => toggle(m.id)} aria-label={`Offer ${m.id} in the new-run form`} />
                    </td>
                    <td style={{ whiteSpace: "normal" }}>
                      <div style={{ color: on ? "var(--fg)" : "var(--fg2)" }}>{m.name}</div>
                      {m.name !== m.id && (
                        <div className="mono muted" style={{ fontSize: 11.5 }}>
                          {m.id}
                        </div>
                      )}
                    </td>
                    <td className="r num">{m.context ? tokens(m.context) : "–"}</td>
                    <td className="r num">{m.costIn == null ? "–" : m.costIn === 0 && m.costOut === 0 ? "free" : `${price(m.costIn)} · ${price(m.costOut)}`}</td>
                    <td>
                      <span className="flex gap-1">
                        {!m.tools && <span className="badge failed">no tools</span>}
                        {m.reasoning && <span className="badge">reasoning</span>}
                        {m.openWeights && <span className="badge">open weights</span>}
                        {m.status && <span className="badge stopped">{m.status}</span>}
                      </span>
                    </td>
                    <td>
                      <span className="flex items-center gap-2">
                        <button className="btn btn-sm" disabled={tests[m.id]?.state === "running"} onClick={() => void test(m.id)} title="Send a short text prompt to this model">
                          Test
                        </button>
                        <TestResult t={tests[m.id]} />
                      </span>
                    </td>
                    <td className="r">
                      <button className={`star ${isDefault ? "on" : ""}`} onClick={() => makeDefault(m.id)} aria-pressed={isDefault} aria-label={`Make ${m.id} the default model`} title={isDefault ? "Default model for new runs" : "Make default"}>
                        {isDefault ? "★" : "☆"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 px-4 pt-2">
        {shown.length > SHOW && (
          <button className="btn btn-sm" onClick={() => setAll((v) => !v)}>
            {all ? "Show fewer" : `Show all ${shown.length}`}
          </button>
        )}
        {hidden > 0 && (
          <span className="text-xs muted">
            {hidden} hidden by filters{toolsOnly && !provider.custom ? " (agents need tool calling)" : ""}
          </span>
        )}
        {provider.custom ? (
          <span className="ml-auto text-xs muted">Edit the provider to change its model list.</span>
        ) : (
        <form
          className="ml-auto flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            addExtra();
          }}
        >
          <input className="input mono" style={{ width: 220, padding: "3px 8px", fontSize: 12 }} placeholder="other model id" value={extra} onChange={(e) => setExtra(e.target.value)} aria-label={`Add a ${provider.id} model id by hand`} />
          <button className="btn btn-sm" type="submit" disabled={!extra.trim()}>
            Add
          </button>
        </form>
        )}
      </div>
    </div>
  );
}
