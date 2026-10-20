/** Every provider agents can use, as a list beside the chosen one: how it's connected, its keys and its models. */
import { Fragment, useEffect } from "react";
import { queryClient, keys } from "../../lib/query.ts";
import { IconAdjustments, IconAlertTriangle, IconArrowRight, IconDots, IconKey, IconPencil, IconPlus, IconSettings, IconUnlink } from "@tabler/icons-react";
import { api } from "../../lib/api.ts";
import { navigate } from "../../lib/router.tsx";
import { cn } from "../../lib/cn.ts";
import type { ConnectedProvider, ProviderHealth, Settings } from "../../lib/types.ts";
import { Button } from "../../components/ui.tsx";
import { IC_SM, IC_XS, Sep } from "../../components/ui/bits.tsx";
import { Menu } from "../../components/ui/overlay.tsx";
import { ProviderMark } from "../../components/ProviderMark.tsx";
import { toast } from "../../components/Toast.tsx";
import { Keys } from "./Keys.tsx";
import { Catalogue } from "./Catalogue.tsx";

const WORST = ["limited", "degraded", "ok", "idle"];
const DOT: Record<string, string> = { ok: "bg-good", degraded: "bg-warning", limited: "bg-critical" };

/** One provider's state over the health window, folded from its models. */
function state(id: string, health: ProviderHealth) {
  return health.filter((h) => h.key.startsWith(`${id}/`)).map((h) => h.state).sort((a, b) => WORST.indexOf(a) - WORST.indexOf(b))[0] ?? "idle";
}

/** How the provider reaches agents, in a few words. */
function connection(p: ConnectedProvider) {
  if (p.via.includes("pixel")) {
    const keys = p.keys.length === 0 ? "no key" : p.keys.length === 1 ? "1 key" : `${p.keys.length} keys`;
    if (!p.custom) return keys;
    const apis = new Set(p.customModels?.map((m) => m.api) ?? [p.custom.api]);
    return `${apis.size > 1 ? "OpenAI and Anthropic" : p.custom.api === "anthropic" ? "Anthropic" : "OpenAI"} API, ${keys}`;
  }
  if (p.via.includes("env")) return `env ${p.envVars.join(", ")}`;
  if (p.via.includes("auth.json")) return "auth.json";
  return "free, no key";
}

export function Providers({
  providers,
  settings,
  health,
  selected,
  onSelect,
  onSettings,
  onEdit,
  onAdd,
  onChanged,
  onTest,
  onAdvanced,
  onAdvancedProvider,
}: {
  providers: ConnectedProvider[];
  settings: Settings;
  health: ProviderHealth;
  selected: string | null;
  onSelect: (id: string) => void;
  onSettings: (s: Settings) => void;
  onEdit: (p: ConnectedProvider) => void;
  onAdd: () => void;
  onChanged: () => void;
  onTest: (model: string) => void;
  onAdvanced: (model: string) => void;
  onAdvancedProvider: (id: string) => void;
}) {
  const p = providers.find((x) => x.id === selected) ?? providers[0];
  // Fetch every connected provider's catalogue up front so switching between them is instant.
  useEffect(() => {
    for (const x of providers) if (!x.custom) void queryClient.prefetchQuery({ queryKey: keys.catalogProvider(x.id), queryFn: () => api.catalogProvider(x.id).catch(() => null), staleTime: 10 * 60_000 });
  }, [providers.map((x) => x.id).join()]);
  const ids = new Set(providers.map((x) => x.id));
  const orphans = settings.models.filter((m) => !ids.has(m.split("/")[0]));

  return (
    <div className="grid overflow-hidden rounded-2xl border border-line-2 bg-s1 md:h-[min(780px,calc(100vh-120px))] md:grid-cols-[260px_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)_auto]">
      <nav aria-label="Providers" className="flex flex-col gap-0.5 overflow-y-auto border-line-2 p-2 max-md:border-b md:border-r">
        {providers.map((x) => {
          const st = state(x.id, health);
          const offered = settings.models.filter((m) => m.startsWith(`${x.id}/`)).length;
          const failing = x.keys.filter((k) => k.status).length;
          return (
            <button
              key={x.id}
              type="button"
              aria-current={x.id === p?.id}
              onClick={() => onSelect(x.id)}
              className="grid cursor-pointer grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-xl border-0 bg-transparent px-2 py-2 text-left hover:bg-s2 aria-[current=true]:bg-s3"
            >
              <ProviderMark id={x.id} name={x.name}>
                {DOT[st] && <i className={cn("absolute -right-[3px] -bottom-[3px] size-[9px] rounded-full ring-2 ring-s1", DOT[st])} />}
              </ProviderMark>
              <span className="min-w-0">
                <span className="block truncate text-[13.5px] font-medium text-ink">{x.name}</span>
                <span className="block truncate font-mono text-[11.5px] text-ink-3">
                  {connection(x)}
                  {offered > 0 && `, ${offered} offered`}
                </span>
              </span>
              <span>{failing > 0 && <IconAlertTriangle {...IC_XS} className="text-warning" aria-label={`${failing} key${failing === 1 ? "" : "s"} failing`} />}</span>
            </button>
          );
        })}
        <button type="button" onClick={onAdd} className="mt-1 inline-flex cursor-pointer items-center gap-2.5 rounded-xl border-0 bg-transparent px-2 py-2 text-left text-[13px] text-ink-3 hover:bg-s2 hover:text-ink">
          <span className="inline-flex size-[30px] items-center justify-center rounded-lg border border-dashed border-line">
            <IconPlus {...IC_SM} />
          </span>
          Add provider
        </button>
      </nav>

      {p && (
        <div key={p.id} className="flex min-w-0 flex-col gap-6 overflow-y-auto p-5 [scrollbar-gutter:stable]">
          <header className="flex flex-wrap items-start gap-3">
            <div className="min-w-0">
              <h2 className="m-0 text-[17px] font-medium tracking-[-0.01em]">{p.name}</h2>
              <div className="mt-0.5 truncate font-mono text-xs text-ink-3" title={p.baseURL ?? undefined}>
                {p.id}
                {p.baseURL ? <><Sep />{p.baseURL.replace(/^https?:\/\//, "")}</> : null}
              </div>
            </div>
            <div className="ml-auto flex items-center gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => onAdvancedProvider(p.id)} title={settings.providerOverrides?.[p.id] ? "Timeouts, options or headers set by hand" : "Timeouts, options and headers for all its models"}>
                <IconAdjustments {...IC_SM} />
                Advanced
                {settings.providerOverrides?.[p.id] && <i className="size-1.5 rounded-full bg-accent" aria-label="changed" />}
              </Button>
              {p.via.includes("pixel") ? (
                <>
                  <Button size="sm" onClick={() => onEdit(p)}>
                    <IconPencil {...IC_SM} />
                    Edit
                  </Button>
                  <Menu
                    trigger={
                      <button type="button" aria-label={`More for ${p.name}`} className="inline-flex size-[30px] cursor-pointer items-center justify-center rounded-lg border border-line bg-s1 text-ink-3 hover:bg-s2 hover:text-ink">
                        <IconDots {...IC_SM} />
                      </button>
                    }
                    items={[
                      {
                        label: p.id === "opencode" ? "Disconnect (back to the free models)" : `Disconnect ${p.name}`,
                        icon: <IconUnlink {...IC_SM} />,
                        danger: true,
                        onSelect: async () => {
                          const n = settings.models.filter((m) => m.startsWith(`${p.id}/`)).length;
                          const msg =
                            p.id === "opencode"
                              ? "Disconnect OpenCode Zen? Its keys are deleted and agents go back to its free models without a key."
                              : `Disconnect ${p.name}? Its keys are deleted and its ${n} model${n === 1 ? "" : "s"} leave the new-run form. Running agents keep working.`;
                          if (!confirm(msg)) return;
                          try {
                            await api.removeProvider(p.id);
                            toast(`${p.name} disconnected`);
                            onChanged();
                          } catch (e: any) {
                            toast(e.message ?? String(e), "error");
                          }
                        },
                      },
                    ]}
                  />
                </>
              ) : p.via.includes("builtin") ? (
                <Button size="sm" onClick={() => onEdit(p)}>
                  <IconKey {...IC_SM} />
                  Add a key
                </Button>
              ) : (
                <Button size="sm" onClick={() => navigate("/settings")}>
                  <IconSettings {...IC_SM} />
                  Agent credentials
                </Button>
              )}
            </div>
          </header>

          {p.missingVars.length > 0 && (
            <div className="flex items-center gap-2.5 rounded-xl bg-[var(--warn-tint)] px-3.5 py-2.5 text-[13px]">
              <IconAlertTriangle {...IC_SM} className="shrink-0 text-warning" />
              <span className="min-w-0 flex-1">
                Calls can't go anywhere until <span className="font-mono text-xs">{p.missingVars.join(", ")}</span> {p.missingVars.length === 1 ? "is" : "are"} set: the API address needs {p.missingVars.length === 1 ? "it" : "them"}.
              </span>
              <Button size="xs" onClick={() => onEdit(p)}>
                Set
              </Button>
            </div>
          )}

          {p.via.includes("pixel") ? (
            <Keys provider={p} onChanged={onChanged} />
          ) : (
            <p className="m-0 text-[13px] text-ink-3">
              {p.via.includes("builtin") ? (
                <>OpenCode Zen's free models work without a key. Add one to use the rest.</>
              ) : p.via.includes("env") ? (
                <>
                  The key comes from <span className="font-mono text-ink-2">{p.envVars.join(", ")}</span> under Settings <IconArrowRight size={12} className="inline align-middle" /> Agent credentials.
                </>
              ) : (
                <>The key comes from auth.json under Settings <IconArrowRight size={12} className="inline align-middle" /> Agent credentials.</>
              )}
            </p>
          )}

          <Catalogue key={p.id} provider={p} settings={settings} onSettings={onSettings} onTest={onTest} onAdvanced={onAdvanced} />
        </div>
      )}

      {orphans.length > 0 && (
        <div className="col-span-full flex flex-wrap items-center gap-3 border-t border-line-2 bg-[var(--warn-tint)] px-5 py-3 text-[13px]">
          <IconAlertTriangle {...IC_SM} className="text-warning" />
          <span className="min-w-0 flex-1">
            Offered without a provider:{" "}
            {orphans.map((m, i) => (
              <Fragment key={m}>
                {i > 0 && ", "}
                <span className="font-mono text-xs">{m}</span>
              </Fragment>
            ))}
          </span>
          <Button
            size="xs"
            onClick={async () => {
              const keep = settings.models.filter((m) => !orphans.includes(m));
              onSettings(await api.saveSettings({ models: keep, ...(orphans.includes(settings.defaultModel) && { defaultModel: keep[0] ?? "opencode/big-pickle" }) }));
            }}
            done="Removed from the new-run form"
          >
            Remove them
          </Button>
        </div>
      )}
    </div>
  );
}
