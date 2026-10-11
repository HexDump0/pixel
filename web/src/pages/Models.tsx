/** Models: the providers agents can use and their models, live provider health, every model compared across runs, and a speed test. */
import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { useAsync, useThrottled } from "../lib/hooks.ts";
import { useLive } from "../lib/live.ts";
import { navigate, useLocation } from "../lib/router.tsx";
import type { ConnectedProvider, Settings } from "../lib/types.ts";
import { ErrorBox, PageHeader, Stat, Tabs } from "../components/ui.tsx";
import { ProviderList } from "../components/ProviderList.tsx";
import { AddProviderDialog } from "../components/AddProviderDialog.tsx";
import { ProviderHealth } from "../components/ProviderHealth.tsx";
import { ModelLeaderboard } from "../components/ModelLeaderboard.tsx";
import { SpeedTest } from "../components/SpeedTest.tsx";
import { LiveTest } from "../components/LiveTest.tsx";
import { refreshModels } from "../components/ModelSelect.tsx";

type Tab = "providers" | "health" | "leaderboard" | "speed";
const TABS: Tab[] = ["providers", "health", "leaderboard", "speed"];

export function ModelsPage() {
  const loc = useLocation();
  const params = new URLSearchParams(loc.search);
  const fromUrl = params.get("tab") as Tab | null;
  const tab: Tab = fromUrl && TABS.includes(fromUrl) ? fromUrl : "providers";
  const setTab = (t: Tab) => navigate(t === "providers" ? "/models" : `/models?tab=${t}`, true);

  const providers = useAsync(() => api.providers(), []);
  const settingsReq = useAsync(() => api.settings(), []);
  const health = useAsync(() => api.providerHealth(60), []);
  const [settings, setSettings] = useState<Settings | null>(null);
  // ?add=1 opens the add dialog, ?provider=<id> opens that provider's models (links from elsewhere).
  const [dialog, setDialog] = useState<{ edit?: ConnectedProvider } | null>(() => (params.get("add") ? {} : null));
  const [open, setOpen] = useState<string | null>(() => params.get("provider"));
  // ?test=<provider/model> opens the live test on that model.
  const [live, setLive] = useState<string | null>(() => params.get("test"));
  useEffect(() => {
    if (settingsReq.data) setSettings(settingsReq.data);
  }, [settingsReq.data]);
  const refreshHealth = useThrottled(() => void health.reload(), 3000);
  useLive("*", (m) => {
    if (m.type === "provider") refreshHealth();
  });
  useEffect(() => {
    const t = setInterval(() => void health.reload(), 30_000);
    return () => clearInterval(t);
  }, []);

  const list = providers.data ?? [];
  const rows = health.data ?? [];
  const calls = rows.reduce((a, h) => a + h.calls, 0);
  const troubled = rows.filter((h) => h.state === "limited" || h.state === "degraded");

  const saved = async (id: string, offer?: string[]) => {
    setDialog(null);
    refreshModels();
    await providers.reload();
    if (offer?.length && settings) {
      const add = offer.map((m) => `${id}/${m}`).filter((m) => !settings.models.includes(m));
      if (add.length) setSettings(await api.saveSettings({ models: [...settings.models, ...add] }));
    }
    setOpen(id);
    setTab("providers");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <PageHeader
        title="Models"
        subtitle="The providers your agents can use and which models the new-run form offers, plus live health, results across runs, and a quick speed test."
        actions={
          <>
            <button className="btn" onClick={() => setLive(settings?.defaultModel ?? "opencode/big-pickle")}>
              <span style={{ color: "var(--accent)" }}>▶</span> Live test
            </button>
            <button className="btn btn-primary" onClick={() => setDialog({})}>
              Add provider
            </button>
          </>
        }
      />
      <ErrorBox error={providers.error ?? settingsReq.error} />

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <Stat label="Providers" value={list.filter((p) => !p.via.includes("builtin")).length} hint={list.some((p) => p.via.includes("builtin")) ? "plus opencode's free models" : undefined} />
        <Stat label="Models offered" value={settings?.models.length ?? "–"} hint={settings ? <span className="mono">default {settings.defaultModel}</span> : undefined} />
        <Stat label="Model calls, last hour" value={calls} hint={`${rows.length} model${rows.length === 1 ? "" : "s"} in use`} />
        <Stat
          label="Problems now"
          value={<span style={{ color: troubled.length ? "var(--warn)" : undefined }}>{troubled.length}</span>}
          hint={troubled.length ? troubled.map((h) => `${h.key} ${h.state}`).join(", ") : "no rate limits or error bursts"}
        />
      </div>

      <div>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "providers", label: "Providers & models" },
            { id: "health", label: <>Health{troubled.length > 0 && <span className="dot recovering" style={{ marginLeft: 6 }} />}</> },
            { id: "leaderboard", label: "Leaderboard" },
            { id: "speed", label: "Speed test" },
          ]}
        />
        {tab === "providers" && settings && (
          <ProviderList
            providers={list}
            settings={settings}
            health={rows}
            open={open}
            onOpen={setOpen}
            onSettings={setSettings}
            onEdit={(p) => setDialog({ edit: p })}
            onAdd={() => setDialog({})}
            onTest={setLive}
            onRemoved={() => {
              void providers.reload();
              void settingsReq.reload();
            }}
          />
        )}
        {tab === "health" && <ProviderHealth />}
        {tab === "leaderboard" && <ModelLeaderboard />}
        {tab === "speed" && <SpeedTest />}
      </div>

      {live && <LiveTest model={live} models={settings?.models ?? []} onClose={() => setLive(null)} />}
      {dialog && <AddProviderDialog connected={list} edit={dialog.edit} onClose={() => setDialog(null)} onSaved={(id, offer) => void saved(id, offer)} />}
    </div>
  );
}
