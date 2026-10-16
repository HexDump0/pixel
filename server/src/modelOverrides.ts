/**
 * Model and provider settings changed by hand on the Models page (context, prices, flags, request options,
 * timeouts). They go into opencode's config over what the catalogue says, and Pixel's own numbers
 * (context use, cache savings, model pickers) read them through `effective`.
 */
import { cachedCatalog, type CatalogModel } from "./catalog.ts";
import { db } from "./db.ts";
import type { ModelOverride, ProviderOverride, Settings } from "./settings.ts";

const LIMITS = ["context", "output", "input"] as const;
const COSTS = ["input", "output", "cache_read", "cache_write"] as const;
const FLAGS = ["reasoning", "tool_call", "attachment", "temperature"] as const;
const TIMEOUTS = ["timeout", "headerTimeout", "chunkTimeout"] as const;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown, what: string, min = 0) => {
  if (v === undefined) return;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min) throw new Error(`${what} must be a number of at least ${min}`);
};
function plainObject(v: unknown, what: string) {
  if (v === undefined) return;
  if (!isObject(v)) throw new Error(`${what} must be a JSON object`);
  if (JSON.stringify(v).length > 4000) throw new Error(`${what} is too long`);
}
function headers(v: unknown, what: string) {
  if (v === undefined) return;
  if (!isObject(v) || Object.entries(v).some(([k, x]) => !/^[A-Za-z0-9-]+$/.test(k) || typeof x !== "string")) throw new Error(`${what}: header names are letters, digits and -, values are text`);
}

export function validateModelOverrides(v: unknown) {
  if (!isObject(v)) throw new Error("modelOverrides must be an object");
  for (const [key, o] of Object.entries(v)) {
    if (!key.includes("/")) throw new Error(`model settings: ${key} is not provider/model`);
    if (!isObject(o)) throw new Error(`model settings for ${key} must be an object`);
    for (const l of LIMITS) count(o[l], `${key}: ${l} tokens`, 1);
    if (o.cost !== undefined) {
      if (!isObject(o.cost)) throw new Error(`${key}: prices must be an object`);
      for (const c of COSTS) count(o.cost[c], `${key}: ${c} price`);
    }
    for (const f of FLAGS) if (o[f] !== undefined && typeof o[f] !== "boolean") throw new Error(`${key}: ${f} must be true or false`);
    plainObject(o.options, `${key}: options`);
    headers(o.headers, `${key}: headers`);
  }
}

export function validateProviderOverrides(v: unknown) {
  if (!isObject(v)) throw new Error("providerOverrides must be an object");
  for (const [id, o] of Object.entries(v)) {
    if (!isObject(o)) throw new Error(`provider settings for ${id} must be an object`);
    for (const t of TIMEOUTS) count(o[t], `${id}: ${t}`);
    plainObject(o.options, `${id}: options`);
    headers(o.headers, `${id}: headers`);
  }
}

const split = (full: string) => {
  const i = full.indexOf("/");
  return [full.slice(0, i), full.slice(i + 1)] as const;
};
const catalogModel = (provider: string, model: string) => cachedCatalog()?.get(provider)?.models.find((m) => m.id === model) ?? null;

/**
 * The opencode config entry for an overridden model, over `base` (the entry Pixel already writes for a
 * custom endpoint, if any). opencode wants context and output together and input and output prices
 * together, so a missing half comes from the base or the catalogue.
 */
export function opencodeModel(full: string, o: ModelOverride, base: Record<string, any> = {}) {
  const [pid, mid] = split(full);
  const cat = catalogModel(pid, mid);
  const out: Record<string, any> = { ...base };
  if (o.context !== undefined || o.output !== undefined || o.input !== undefined) {
    const context = o.context ?? base.limit?.context ?? cat?.context ?? 128_000;
    out.limit = {
      ...base.limit,
      context,
      output: o.output ?? base.limit?.output ?? cat?.output ?? Math.min(32_000, Math.floor(context / 4)),
      ...(o.input !== undefined && { input: o.input }),
    };
  }
  if (o.cost && Object.values(o.cost).some((x) => x !== undefined)) {
    out.cost = {
      ...base.cost,
      input: o.cost.input ?? base.cost?.input ?? cat?.costIn ?? 0,
      output: o.cost.output ?? base.cost?.output ?? cat?.costOut ?? 0,
      ...(o.cost.cache_read !== undefined ? { cache_read: o.cost.cache_read } : cat?.costCacheRead != null && { cache_read: cat.costCacheRead }),
      ...(o.cost.cache_write !== undefined && { cache_write: o.cost.cache_write }),
    };
  }
  for (const f of FLAGS) if (o[f] !== undefined) out[f] = o[f];
  if (o.options) out.options = { ...base.options, ...o.options };
  if (o.headers) out.headers = { ...base.headers, ...o.headers };
  return out;
}

/** opencode provider options from a provider override; 0 timeouts become false (off). */
export function opencodeProviderOptions(o: ProviderOverride) {
  const out: Record<string, unknown> = { ...o.options };
  for (const t of TIMEOUTS) if (o[t] !== undefined) out[t] = o[t] === 0 ? false : o[t];
  if (o.headers) out.headers = { ...(isObject(o.options?.headers) ? o.options.headers : {}), ...o.headers };
  return out;
}

/** A catalogue model as agents see it, with the overrides applied. */
export function effective(full: string, s: Settings, cat: CatalogModel | null = catalogModel(...split(full))) {
  const o = s.modelOverrides?.[full];
  return {
    context: o?.context ?? cat?.context ?? null,
    output: o?.output ?? cat?.output ?? null,
    costIn: o?.cost?.input ?? cat?.costIn ?? null,
    costOut: o?.cost?.output ?? cat?.costOut ?? null,
    costCacheRead: o?.cost?.cache_read ?? cat?.costCacheRead ?? null,
    reasoning: o?.reasoning ?? cat?.reasoning ?? false,
    tools: o?.tool_call ?? cat?.tools ?? true,
    overridden: !!o && Object.keys(o).length > 0,
  };
}

/** The context set by hand for a model, read on its own (the fleet asks for it every second per run). */
export function overriddenContext(full: string): number | null {
  const row = db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'modelOverrides'").get();
  try {
    return row ? (JSON.parse(row.value)[full]?.context ?? null) : null;
  } catch {
    return null;
  }
}
