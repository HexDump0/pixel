/**
 * The provider and model catalogue from models.dev, the same list opencode uses to know providers,
 * their key variables and model limits. Fetched at most once a day and cached in the data dir; when
 * offline, the cached copy or opencode's own cache is used.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { config } from "./config.ts";

export interface CatalogModel {
  id: string;
  name: string;
  family: string | null;
  context: number | null;
  output: number | null;
  /** USD per million tokens. */
  costIn: number | null;
  costOut: number | null;
  costCacheRead: number | null;
  tools: boolean;
  reasoning: boolean;
  openWeights: boolean;
  released: string | null;
  status: string | null;
  /** Where this model's requests go when it differs from the provider's (opencode Zen, gateways). */
  api: string | null;
  npm: string | null;
}

export interface CatalogProvider {
  id: string;
  name: string;
  env: string[];
  doc: string | null;
  api: string | null;
  npm: string | null;
  models: CatalogModel[];
}

const MAX_AGE_MS = 24 * 3600_000;
const cacheFile = () => join(config.dataDir, "models.json");

let cache: { at: number; source: string; providers: Map<string, CatalogProvider> } | null = null;
let loading: Promise<void> | null = null;

function slim(raw: Record<string, any>): Map<string, CatalogProvider> {
  const out = new Map<string, CatalogProvider>();
  for (const [id, p] of Object.entries(raw ?? {})) {
    if (!p || typeof p !== "object") continue;
    const models = Object.entries<any>(p.models ?? {}).map(([mid, m]) => ({
      id: mid,
      name: String(m?.name ?? mid),
      family: m?.family ?? null,
      context: m?.limit?.context ?? null,
      output: m?.limit?.output ?? null,
      costIn: m?.cost?.input ?? null,
      costOut: m?.cost?.output ?? null,
      costCacheRead: m?.cost?.cache_read ?? null,
      tools: !!m?.tool_call,
      reasoning: !!m?.reasoning,
      openWeights: !!m?.open_weights,
      released: m?.release_date ?? null,
      status: m?.status ?? null,
      api: m?.provider?.api ?? null,
      npm: m?.provider?.npm ?? null,
    }));
    out.set(id, { id, name: String(p.name ?? id), env: Array.isArray(p.env) ? p.env : [], doc: p.doc ?? null, api: p.api ?? null, npm: p.npm ?? null, models });
  }
  return out;
}

function readFile(path: string) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
}

async function load(force: boolean) {
  if (config.modelsUrl && (force || !cache || Date.now() - cache.at > MAX_AGE_MS)) {
    try {
      const res = await fetch(config.modelsUrl, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const providers = slim(JSON.parse(text));
      if (providers.size) {
        writeFileSync(cacheFile(), text);
        cache = { at: Date.now(), source: config.modelsUrl, providers };
        return;
      }
    } catch (e: any) {
      console.error(`models catalogue: ${config.modelsUrl}: ${e.message}`);
    }
  }
  if (cache) return;
  for (const path of [cacheFile(), join(homedir(), ".cache", "opencode", "models.json")]) {
    const raw = readFile(path);
    if (raw) {
      // Retry the download in an hour rather than on every request.
      cache = { at: Date.now() - MAX_AGE_MS + 3600_000, source: path, providers: slim(raw) };
      return;
    }
  }
  cache = { at: Date.now() - MAX_AGE_MS + 600_000, source: "none", providers: new Map() };
}

async function ensure(force = false) {
  if (!force && cache && Date.now() - cache.at < MAX_AGE_MS) return cache;
  loading ??= load(force).finally(() => (loading = null));
  await loading;
  return cache!;
}

/** Every provider, without its models (the list is long). */
export async function catalogProviders(refresh = false) {
  const c = await ensure(refresh);
  return {
    source: c.source,
    fetchedAt: c.at,
    providers: [...c.providers.values()].map(({ models, ...p }) => ({ ...p, modelCount: models.length, toolModels: models.filter((m) => m.tools).length })),
  };
}

export async function catalogProvider(id: string): Promise<CatalogProvider | null> {
  return (await ensure()).providers.get(id) ?? null;
}

/** Only what is already loaded; for synchronous callers that can do without the catalogue. */
export function cachedCatalog() {
  return cache?.providers ?? null;
}

export type CatalogList = Awaited<ReturnType<typeof catalogProviders>>;

/** Providers that make the models, searched first so a model's own numbers win over a reseller's. */
const MAKERS = ["anthropic", "openai", "google", "xai", "moonshotai", "zai", "deepseek", "mistral", "alibaba", "meta-llama", "minimax"];
/** Gateways put the maker in front of the id (Snowflake Cortex: openai-gpt-5.4). */
const MAKER_PREFIX = /^(openai|anthropic|google|xai|meta|mistral|deepseek|moonshotai|zai|snowflake)-(.+)$/;
const byId = new WeakMap<Map<string, CatalogProvider>, Map<string, CatalogModel>>();

/**
 * A model the catalogue knows by its id under any provider, for endpoints that serve known models
 * under their own name (Snowflake Cortex, LiteLLM, vLLM). Context, output and abilities only: a
 * reseller's prices aren't the maker's, so those are left out.
 */
export function knownModel(id: string): CatalogModel | null {
  const c = cachedCatalog();
  if (!c) return null;
  let index = byId.get(c);
  if (!index) {
    index = new Map();
    for (const pid of [...MAKERS, ...c.keys()]) for (const m of c.get(pid)?.models ?? []) if (!index.has(m.id)) index.set(m.id, m);
    byId.set(c, index);
  }
  const lower = id.toLowerCase();
  const hit = index.get(lower) ?? index.get(lower.match(MAKER_PREFIX)?.[2] ?? "");
  return hit ? { ...hit, costIn: null, costOut: null, costCacheRead: null, api: null, npm: null } : null;
}
