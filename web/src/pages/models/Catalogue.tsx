/**
 * One provider's models from the catalogue: tick the ones the new-run form offers, star the default, and
 * open a live test. Offered models stay on top; changes save straight away.
 */
import { useMemo, useState } from "react";
import { IconAdjustments, IconPlayerPlay, IconPlus, IconSearch, IconStar, IconStarFilled } from "@tabler/icons-react";
import { api } from "../../lib/api.ts";
import { useQuery } from "@tanstack/react-query";
import { keys } from "../../lib/query.ts";
import { tokens } from "../../lib/format.ts";
import { cn } from "../../lib/cn.ts";
import type { CatalogModel, ConnectedProvider, Settings } from "../../lib/types.ts";
import { Button, ErrorBox } from "../../components/ui.tsx";
import { IC_SM, IC_XS, Nil } from "../../components/ui/bits.tsx";
import { refreshModels } from "../../components/ModelSelect.tsx";
import { toast } from "../../components/Toast.tsx";
import { describeOverride, shortTokens } from "./Advanced.tsx";

const price = (n: number | null) => (n == null ? "" : n === 0 ? "0" : n < 1 ? n.toFixed(2) : String(Math.round(n * 10) / 10));
const SHOW = 40;
const blank = (id: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({ id, name: id, family: null, context: null, output: null, costIn: null, costOut: null, costCacheRead: null, tools: true, reasoning: false, openWeights: false, released: null, status: null, ...extra });

type Filter = "tools" | "reasoning" | "free" | "open";
const FILTERS: [Filter, string, (m: CatalogModel) => boolean][] = [
  ["tools", "Tool calling", (m) => m.tools],
  ["reasoning", "Reasoning", (m) => m.reasoning],
  ["free", "Free", (m) => m.costIn === 0],
  ["open", "Open weights", (m) => m.openWeights],
];
const ROW = "grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-3.5 px-3 md:grid-cols-[28px_minmax(180px,1.5fr)_64px_96px_minmax(0,1fr)_90px]";

export function Catalogue({ provider, settings, onSettings, onTest, onAdvanced }: { provider: ConnectedProvider; settings: Settings; onSettings: (s: Settings) => void; onTest: (model: string) => void; onAdvanced: (model: string) => void }) {
  // Cached per provider (and prefetched by the provider list), so switching providers doesn't flash a loading state.
  const cat = useQuery({ queryKey: keys.catalogProvider(provider.id), queryFn: () => api.catalogProvider(provider.id).catch(() => null), enabled: !provider.custom, staleTime: 10 * 60_000 });
  // OpenCode Zen without any key serves only its free models.
  const freeOnly = provider.id === "opencode" && !provider.keys.length && !provider.via.includes("env") && !provider.via.includes("auth.json");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Set<Filter>>(() => new Set(["tools"]));
  const [all, setAll] = useState(false);
  const [extra, setExtra] = useState("");
  const prefix = `${provider.id}/`;

  const models: CatalogModel[] = useMemo(() => {
    const list: CatalogModel[] = provider.custom ? provider.custom.models.map((id) => blank(id, { context: provider.custom!.context, reasoning: !!provider.custom!.reasoning })) : [...(cat.data?.models ?? [])];
    // Offered models the catalogue doesn't list (typed in by hand, or newer than the catalogue).
    for (const m of settings.models) if (m.startsWith(prefix) && !list.some((x) => x.id === m.slice(prefix.length))) list.push(blank(m.slice(prefix.length)));
    return list;
  }, [cat.data, provider, settings.models]);

  const offered = (id: string) => settings.models.includes(prefix + id);
  const q = query.trim().toLowerCase();
  const pass = (m: CatalogModel) =>
    m.status !== "deprecated" && (!freeOnly || m.costIn === 0) && FILTERS.every(([f, , ok]) => !filters.has(f) || ok(m)) && (!q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  const shown = models
    .filter((m) => offered(m.id) || pass(m))
    .sort((a, b) => Number(offered(b.id)) - Number(offered(a.id)) || (b.released ?? "").localeCompare(a.released ?? "") || a.id.localeCompare(b.id));
  const nOffered = models.filter((m) => offered(m.id)).length;

  const save = async (patch: Partial<Settings>) => {
    try {
      onSettings(await api.saveSettings(patch));
      refreshModels();
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
  const addExtra = () => {
    const id = extra.trim().replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "");
    if (!id) return;
    if (!offered(id)) void save({ models: [...settings.models, prefix + id] });
    setExtra("");
  };

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="m-0 mr-1 text-[13px] font-medium">Models</h3>
        <span className="font-mono text-xs text-ink-3">
          {nOffered} of {models.length} offered
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {!provider.custom &&
            FILTERS.filter(([f]) => !(freeOnly && f === "free")).map(([f, label]) => (
              <button
                key={f}
                type="button"
                aria-pressed={filters.has(f)}
                onClick={() => setFilters((s) => (s.has(f) ? new Set([...s].filter((x) => x !== f)) : new Set([...s, f])))}
                className="inline-flex h-[26px] cursor-pointer items-center rounded-md border border-line-2 bg-transparent px-2 text-xs text-ink-3 hover:text-ink aria-pressed:border-line aria-pressed:bg-s3 aria-pressed:text-ink"
              >
                {label}
              </button>
            ))}
          <label className="inline-flex h-[26px] w-48 items-center gap-1.5 rounded-md border border-line-2 bg-s1 px-2 text-ink-3 focus-within:border-ink-4">
            <IconSearch {...IC_XS} />
            <input type="search" value={query} placeholder="Search" aria-label="Search models" onChange={(e) => setQuery(e.target.value)} className="min-w-0 flex-1 border-0 bg-transparent text-xs text-ink outline-none [&::-webkit-search-cancel-button]:hidden" />
          </label>
        </div>
      </div>
      {freeOnly && <p className="mt-0 mb-2 text-xs text-ink-3">Free models only until you add an OpenCode Zen key.</p>}
      <ErrorBox error={cat.error?.message} />

      <div className="overflow-hidden rounded-xl border border-line-2">
        <div className={cn(ROW, "h-[34px] border-b border-line-2 text-xs text-ink-3 max-md:hidden")}>
          <span />
          <span>Model</span>
          <span className="text-right">Context</span>
          <span className="text-right" title="USD per million tokens">
            $ in / out
          </span>
          <span />
          <span />
        </div>
        {!provider.custom && cat.isPending && <div className="px-3.5 py-3 text-[13px] text-ink-3">Loading the catalogue</div>}
        {!provider.custom && cat.isSuccess && !cat.data && <div className="px-3.5 py-3 text-[13px] text-ink-3">Not in the catalogue; add model ids below.</div>}
        {(all ? shown : shown.slice(0, SHOW)).map((m, i, arr) => {
          const on = offered(m.id);
          const isDefault = settings.defaultModel === prefix + m.id;
          const lastOffered = on && !offered(arr[i + 1]?.id ?? "");
          const o = settings.modelOverrides?.[prefix + m.id];
          const custom = describeOverride(o);
          const context = o?.context ?? m.context;
          const costIn = o?.cost?.input ?? m.costIn;
          const costOut = o?.cost?.output ?? m.costOut;
          return (
            <div key={m.id} className={cn(ROW, "group min-h-12 border-t border-line-2 py-1.5 first-of-type:border-t-0 hover:bg-s2", lastOffered && i < arr.length - 1 && "border-b border-b-line")}>
              <label className="flex cursor-pointer items-center justify-center">
                <input type="checkbox" checked={on} onChange={() => toggle(m.id)} aria-label={`Offer ${m.id} in the new-run form`} className="size-4 cursor-pointer accent-[var(--accent-c)]" />
              </label>
              <span className="min-w-0">
                <span className={cn("block truncate text-[13px]", on ? "text-ink" : "text-ink-2")}>{m.name}</span>
                {m.name !== m.id && <span className="block truncate font-mono text-[11.5px] text-ink-3">{m.id}</span>}
              </span>
              <span className={cn("text-right font-mono text-xs tabular-nums max-md:hidden", o?.context ? "text-ink" : "text-ink-2")} title={o?.context && m.context ? `Set by hand; the catalogue says ${shortTokens(m.context)}` : undefined}>
                {context ? tokens(context) : <Nil />}
              </span>
              <span className={cn("text-right font-mono text-xs tabular-nums max-md:hidden", o?.cost ? "text-ink" : "text-ink-2")}>{costIn == null ? <Nil /> : costIn === 0 && costOut === 0 ? "free" : `${price(costIn)} / ${price(costOut)}`}</span>
              <span className="truncate text-xs text-ink-3 max-md:hidden">
                {[!m.tools && "no tool calling", m.reasoning && "reasoning", m.openWeights && "open weights", m.status].filter(Boolean).join(", ")}
              </span>
              <span className="flex justify-end gap-0.5">
                <Button
                  size="xs"
                  icon
                  variant="ghost"
                  className={cn(custom.length ? "text-ink-2" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100")}
                  title={custom.length ? `Advanced settings: ${custom.join(", ")}` : "Advanced settings"}
                  aria-label={`Advanced settings for ${m.id}`}
                  onClick={() => onAdvanced(prefix + m.id)}
                >
                  <IconAdjustments {...IC_SM} />
                </Button>
                <Button size="xs" icon variant="ghost" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100" title="Live test" aria-label={`Live test ${m.id}`} onClick={() => onTest(prefix + m.id)}>
                  <IconPlayerPlay {...IC_SM} />
                </Button>
                <button
                  type="button"
                  onClick={() => makeDefault(m.id)}
                  aria-pressed={isDefault}
                  aria-label={`Make ${m.id} the default model`}
                  title={isDefault ? "Default for new runs" : "Make default"}
                  className={cn("inline-flex size-[26px] cursor-pointer items-center justify-center rounded-md hover:bg-s3", isDefault ? "text-accent" : "text-ink-4 opacity-0 group-hover:opacity-100 hover:text-ink-2 focus-visible:opacity-100 max-md:opacity-100")}
                >
                  {isDefault ? <IconStarFilled size={14} /> : <IconStar size={14} stroke={1.75} />}
                </button>
              </span>
            </div>
          );
        })}
        {shown.length === 0 && models.length > 0 && <div className="px-3.5 py-3 text-[13px] text-ink-3">Nothing matches.</div>}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {shown.length > SHOW && (
          <Button size="xs" variant="ghost" onClick={() => setAll((v) => !v)}>
            {all ? "Show fewer" : `Show all ${shown.length}`}
          </Button>
        )}
        {provider.custom ? (
          <span className="ml-auto text-xs text-ink-3">Edit the provider to change its models.</span>
        ) : (
          <form
            className="ml-auto flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              addExtra();
            }}
          >
            <input className="input h-[26px] w-52 py-0 font-mono text-xs" placeholder="other model id" value={extra} onChange={(e) => setExtra(e.target.value)} aria-label={`Add a ${provider.id} model id by hand`} />
            <Button size="xs" type="submit" disabled={!extra.trim()}>
              <IconPlus {...IC_XS} />
              Add
            </Button>
          </form>
        )}
      </div>
    </section>
  );
}
