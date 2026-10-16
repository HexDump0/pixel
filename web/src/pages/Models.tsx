/**
 * Models: calls by model over a window and what's wrong right now on top, the models the new-run form
 * offers (live health, or results across runs), then the providers with their keys and catalogue.
 * The speed test and the live test open as dialogs.
 */
import { useEffect, useMemo, useState } from "react";
import { IconAlertTriangle, IconGauge, IconKey, IconPlayerPlay, IconPlus } from "@tabler/icons-react";
import { api } from "../lib/api.ts";
import { useAsync, useThrottled } from "../lib/hooks.ts";
import { useLive } from "../lib/live.ts";
import { navigate, useLocation } from "../lib/router.tsx";
import { ago } from "../lib/format.ts";
import { cn } from "../lib/cn.ts";
import type { ConnectedProvider, Settings } from "../lib/types.ts";
import { Button, ErrorBox, PageHeader, Segmented } from "../components/ui.tsx";
import { IC_SM } from "../components/ui/bits.tsx";
import { SectionHead } from "../components/ui/bits.tsx";
import { AddProviderDialog } from "../components/AddProviderDialog.tsx";
import { LiveTest } from "../components/LiveTest.tsx";
import { refreshModels } from "../components/ModelSelect.tsx";
import { toast } from "../components/Toast.tsx";
import { Traffic } from "./models/Traffic.tsx";
import { Lineup, type LineupRow, type LineupView } from "./models/Lineup.tsx";
import { Providers } from "./models/Providers.tsx";
import { SpeedTestDialog } from "./models/SpeedTest.tsx";
import { hueVar, splitModel } from "./models/common.tsx";

const WINDOWS: [number, string][] = [
  [15, "15m"],
  [60, "1h"],
  [360, "6h"],
];

export function ModelsPage() {
  const loc = useLocation();
  const params = new URLSearchParams(loc.search);
  const [minutes, setMinutes] = useState(60);
  const [view, setView] = useState<LineupView>(params.get("tab") === "leaderboard" ? "runs" : "now");
  const providers = useAsync(() => api.providers(), []);
  const settingsReq = useAsync(() => api.settings(), []);
  const health = useAsync(() => api.providerHealth(minutes), [minutes]);
  const board = useAsync(() => api.leaderboard(), []);
  const [settings, setSettings] = useState<Settings | null>(null);
  // ?add=1 opens the add dialog, ?provider=<id> picks that provider, ?test=<provider/model> opens the live test, ?tab=speed the speed test.
  const [dialog, setDialog] = useState<{ edit?: ConnectedProvider } | null>(() => (params.get("add") ? {} : null));
  const [picked, setPicked] = useState<string | null>(() => params.get("provider"));
  const [live, setLive] = useState<string | null>(() => params.get("test"));
  const [speed, setSpeed] = useState(() => params.get("tab") === "speed");

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
  }, [minutes]);

  const list = providers.data ?? [];
  const hrows = health.data ?? [];
  const names = new Map(list.map((p) => [p.id, p.name]));
  const providerName = (id: string) => names.get(id) ?? id;

  // Offered models (default first), then models runs used that aren't offered.
  const rows: LineupRow[] = useMemo(() => {
    if (!settings) return [];
    const offered = [settings.defaultModel, ...settings.models.filter((m) => m !== settings.defaultModel)].filter((m) => settings.models.includes(m));
    const used = [...hrows.map((h) => h.key), ...(board.data ?? []).map((b) => b.model)].filter((m, i, a) => !offered.includes(m) && a.indexOf(m) === i);
    return [...offered, ...used].map((key, i) => ({ key, hue: i, offered: i < offered.length, health: hrows.find((h) => h.key === key) ?? null, board: board.data?.find((b) => b.model === key) ?? null }));
  }, [settings, hrows, board.data]);

  const calls = hrows.reduce((a, h) => a + h.calls, 0);
  const failed = hrows.reduce((a, h) => a + h.errors, 0);
  const problems = [
    ...hrows
      .filter((h) => h.state === "limited" || h.state === "degraded")
      .map((h) => ({ id: h.key, bad: h.state === "limited", title: `${splitModel(h.key)[1]} ${h.state === "limited" ? "rate limited" : "degraded"}`, detail: h.lastEvent?.message ?? `${Math.round(h.errorRate * 100)}% of calls failed`, at: h.lastEvent?.ts ?? null, provider: splitModel(h.key)[0] })),
    ...list.flatMap((p) =>
      p.keys
        .filter((k) => k.status)
        .map((k) => ({ id: `${p.id}:${k.id}`, bad: k.status!.state !== "ratelimit", title: `${p.name} key ${k.name}: ${k.status!.state === "credit" ? "out of credit" : k.status!.state === "rejected" ? "rejected" : "rate limited"}`, detail: k.status!.detail, at: k.status!.at, provider: p.id })),
    ),
  ];
  const speeds = rows.filter((r) => r.health?.tps.p50 != null).sort((a, b) => b.health!.tps.p50! - a.health!.tps.p50!);
  const maxTps = Math.max(1, ...speeds.map((r) => r.health!.tps.p50!));

  const save = async (patch: Partial<Settings>) => {
    try {
      setSettings(await api.saveSettings(patch));
      refreshModels();
    } catch (e: any) {
      toast(e.message ?? String(e), "error");
    }
  };
  const saved = async (id: string, offer?: string[]) => {
    setDialog(null);
    refreshModels();
    await providers.reload();
    if (offer?.length && settings) {
      const add = offer.map((m) => `${id}/${m}`).filter((m) => !settings.models.includes(m));
      if (add.length) setSettings(await api.saveSettings({ models: [...settings.models, ...add] }));
    }
    setPicked(id);
  };
  const showProvider = (id: string) => {
    setPicked(id);
    requestAnimationFrame(() => document.getElementById("providers")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  return (
    <div className="pb-16">
      <PageHeader
        title="Models"
        actions={
          <>
            <Button variant="ghost" onClick={() => setSpeed(true)}>
              <IconGauge {...IC_SM} />
              Speed test
            </Button>
            <Button onClick={() => setLive(settings?.defaultModel ?? "opencode/big-pickle")}>
              <IconPlayerPlay {...IC_SM} />
              Live test
            </Button>
            <Button variant="primary" onClick={() => setDialog({})}>
              <IconPlus {...IC_SM} />
              Add provider
            </Button>
          </>
        }
      />
      <ErrorBox error={providers.error ?? settingsReq.error ?? health.error} />

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]">
        <section className="flex min-h-[230px] min-w-0 flex-col rounded-2xl border border-line-2 bg-s1 px-5 pt-4 pb-3">
          <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-2">
            <span className="text-[26px] leading-none font-medium tabular-nums">{calls}</span>
            <span className="text-[13px] text-ink-3">model calls</span>
            {failed > 0 && <span className="font-mono text-xs text-critical">{failed} failed</span>}
            <Segmented label="Window" className="ml-auto self-center" value={minutes} onChange={setMinutes} options={WINDOWS} />
          </div>
          <Traffic rows={rows.filter((r) => r.health).map((r) => ({ key: r.key, hue: r.hue, buckets: r.health!.buckets }))} minutes={minutes} />
        </section>

        <section className="flex min-w-0 flex-col rounded-2xl border border-line-2 bg-s1 px-5 py-4">
          {problems.length > 0 && (
            <ul className="m-0 mb-4 flex list-none flex-col gap-2.5 border-b border-line-2 p-0 pb-4">
              {problems.map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => showProvider(p.provider)} className="grid w-full cursor-pointer grid-cols-[16px_minmax(0,1fr)_auto] gap-x-2.5 border-0 bg-transparent p-0 text-left">
                    {p.id.includes(":") ? <IconKey {...IC_SM} className={cn("mt-px", p.bad ? "text-critical" : "text-warning")} /> : <IconAlertTriangle {...IC_SM} className={cn("mt-px", p.bad ? "text-critical" : "text-warning")} />}
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] text-ink">{p.title}</span>
                      <span className="block truncate text-xs text-ink-3" title={p.detail}>
                        {p.detail}
                      </span>
                    </span>
                    <span className="font-mono text-[11px] text-ink-4">{p.at ? ago(p.at).replace(" ago", "") : ""}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mb-2.5 flex items-baseline text-[12.5px] text-ink-3">
            Output tok/s
            <span className="ml-auto font-mono text-[11px] text-ink-4">p50</span>
          </div>
          {speeds.length ? (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {speeds.slice(0, problems.length ? 4 : 7).map((r) => (
                <li key={r.key} className="grid grid-cols-[minmax(0,9.5em)_minmax(0,1fr)_32px] items-center gap-3">
                  <span className="truncate font-mono text-xs text-ink-2" title={r.key}>
                    {splitModel(r.key)[1]}
                  </span>
                  <span className="h-1.5 overflow-hidden rounded-full bg-s3">
                    <i className="block h-full rounded-full" style={{ width: `${(r.health!.tps.p50! / maxTps) * 100}%`, background: hueVar(r.hue) }} />
                  </span>
                  <span className="text-right font-mono text-xs tabular-nums">{Math.round(r.health!.tps.p50!)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex flex-1 items-center text-[13px] text-ink-4">No streamed output in this window</div>
          )}
        </section>
      </div>

      {settings && (
        <>
          <SectionHead
            className="mt-8"
            title="Offered"
            meta={`${settings.models.length} in the new-run form`}
            right={
              <Segmented
                label="Show"
                value={view}
                onChange={setView}
                options={[
                  ["now", "Now"],
                  ["runs", "Across runs"],
                ]}
              />
            }
          />
          <Lineup
            rows={rows}
            view={view}
            settings={settings}
            providerName={providerName}
            onDefault={(key) => void save({ defaultModel: key, models: settings.models.includes(key) ? settings.models : [...settings.models, key] })}
            onOffer={(key, on) => {
              if (!on && key === settings.defaultModel) return toast("That's the default model; star another one first", "error");
              void save({ models: on ? [...settings.models, key] : settings.models.filter((m) => m !== key) });
            }}
            onLimit={async (key, l) => {
              const limits = { ...settings.providerLimits };
              if (l) limits[key] = l;
              else delete limits[key];
              await save({ providerLimits: limits });
              void health.reload();
            }}
            onTest={setLive}
            onProvider={showProvider}
          />

          <div id="providers" className="scroll-mt-20">
            <SectionHead className="mt-8" title="Providers" meta={list.length} />
            <Providers
              providers={list}
              settings={settings}
              health={hrows}
              selected={picked}
              onSelect={setPicked}
              onSettings={setSettings}
              onEdit={(p) => setDialog({ edit: p })}
              onAdd={() => setDialog({})}
              onTest={setLive}
              onChanged={() => {
                refreshModels();
                void providers.reload();
                void settingsReq.reload();
              }}
            />
          </div>
        </>
      )}

      {live && <LiveTest model={live} models={settings?.models ?? []} onClose={() => setLive(null)} />}
      {speed && (
        <SpeedTestDialog
          onClose={() => {
            setSpeed(false);
            if (params.get("tab")) navigate("/models", true);
          }}
        />
      )}
      {dialog && <AddProviderDialog connected={list} edit={dialog.edit} onClose={() => setDialog(null)} onSaved={(id, offer) => void saved(id, offer)} />}
    </div>
  );
}
