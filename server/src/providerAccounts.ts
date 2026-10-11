/**
 * Model providers added from the dashboard. Keys go into every agent's opencode auth.json (keyed by
 * provider id, which opencode reads for catalogue and custom providers alike); custom endpoints and
 * base-URL overrides go into OPENCODE_CONFIG_CONTENT, which opencode merges over its config file, so
 * it reaches every runtime without touching the image's opencode.json.
 *
 * Accounts live in the settings table under `_providers`, so keys never travel back to the browser:
 * the API only shows a hint of each key.
 */
import { db } from "./db.ts";
import { getSettings, saveSettings, type Settings } from "./settings.ts";
import { cachedCatalog, catalogProvider } from "./catalog.ts";
import { githubForAgents } from "./github.ts";

export interface ProviderAccount {
  id: string;
  name: string;
  key: string;
  baseURL?: string;
  /** Not in the catalogue: an endpoint speaking the OpenAI or Anthropic API, serving these model ids. */
  custom?: { api: CustomApi; models: string[]; context: number; reasoning?: boolean };
  /** Send `prompt_cache_key` (the session id) so repeat requests hit the provider's cache; see opencode-plugins/prompt-cache-key.ts. */
  cacheKey?: boolean;
  added: number;
}

export interface AccountInput {
  id: string;
  name?: string;
  /** Omitted when editing = keep the stored key. */
  key?: string;
  baseURL?: string;
  custom?: { api?: CustomApi; models: string[]; context?: number; reasoning?: boolean };
  cacheKey?: boolean;
}

/**
 * OpenAI-compatible providers that cache prompts but only get a cache key from opencode when asked
 * (opencode sends one by itself for OpenAI, Anthropic, xAI, Mistral, DeepInfra, Cerebras and its own gateways).
 */
const CACHE_KEY_BY_DEFAULT = new Set(["coralbricks"]);

/**
 * Thinking levels some providers accept beyond the low/medium/high opencode offers for
 * OpenAI-compatible models. Coral Bricks: reasoning_effort none | low | high | max (medium = high);
 * DeepSeek V4.1 Flash reasons only when asked, GLM 5.3 always does.
 */
const PROVIDER_LEVELS: Record<string, Record<string, Record<string, unknown>>> = {
  coralbricks: { none: { reasoningEffort: "none" }, max: { reasoningEffort: "max" } },
};

export type CustomApi = "openai" | "anthropic";
/** AI SDK package opencode loads for each custom API type (both ship inside opencode). */
const NPM: Record<CustomApi, string> = { openai: "@ai-sdk/openai-compatible", anthropic: "@ai-sdk/anthropic" };

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const KEY = "_providers";

function load(): Record<string, ProviderAccount> {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(KEY);
  try {
    return row ? JSON.parse(row.value) : {};
  } catch {
    return {};
  }
}

function store(accounts: Record<string, ProviderAccount>) {
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(accounts));
}

const hint = (key: string) => (!key ? null : key.length < 12 ? "••••" : `${key.slice(0, 3)}…${key.slice(-4)}`);

function cleanUrl(u: string | undefined) {
  const s = u?.trim().replace(/\/+$/, "");
  if (!s) return undefined;
  if (!/^https?:\/\/[^\s]+$/.test(s)) throw new Error("base URL must start with http:// or https://");
  return s;
}

export async function saveAccount(input: AccountInput) {
  const id = input.id?.trim();
  if (!id || !ID.test(id)) throw new Error("provider id: lowercase letters, digits, '.', '_' or '-'");
  const accounts = load();
  const old = accounts[id];
  const known = await catalogProvider(id);
  const custom = input.custom ? { ...input.custom } : old?.custom;
  if (!known && !custom) throw new Error(`${id} is not in the provider catalogue; add it as a custom endpoint`);
  if (known && input.custom) throw new Error(`${id} is a catalogue provider; pick another id for a custom endpoint`);
  const baseURL = cleanUrl(input.baseURL);
  if (custom) {
    if (!baseURL) throw new Error("a custom endpoint needs a base URL");
    custom.models = [...new Set(custom.models.map((m) => m.trim()).filter(Boolean))];
    if (!custom.models.length) throw new Error("list at least one model id");
  }
  const key = input.key === undefined ? (old?.key ?? "") : input.key.trim();
  if (key.length > 8192) throw new Error("key is too long");
  accounts[id] = {
    id,
    name: input.name?.trim() || known?.name || old?.name || id,
    key,
    ...(baseURL && { baseURL }),
    ...(custom && { custom: { api: custom.api === "anthropic" ? "anthropic" : "openai", models: custom.models, context: Math.max(1024, Number(custom.context) || 128_000), ...(custom.reasoning && { reasoning: true }) } }),
    ...((input.cacheKey ?? old?.cacheKey ?? CACHE_KEY_BY_DEFAULT.has(id)) && { cacheKey: true }),
    added: old?.added ?? Date.now(),
  };
  store(accounts);
  return accounts[id];
}

/** Remove a provider and its models from the new-run list. */
export function removeAccount(id: string) {
  const accounts = load();
  if (!accounts[id]) throw new Error(`no provider ${id}`);
  delete accounts[id];
  store(accounts);
  const s = getSettings();
  const models = s.models.filter((m) => !m.startsWith(`${id}/`));
  const patch: Partial<Settings> = { models };
  if (s.defaultModel.startsWith(`${id}/`)) patch.defaultModel = models[0] ?? "opencode/big-pickle";
  saveSettings(patch);
}

function parseAuth(raw: string): Record<string, any> | null {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export type ConnectedProvider = ReturnType<typeof connectedProviders>[number];
export type Via = "pixel" | "env" | "auth.json" | "builtin";

/** Every provider an agent can use: added here, or set up by hand in Settings (env vars, auth.json). */
export function connectedProviders(s: Settings = getSettings()) {
  const out = new Map<string, { id: string; name: string; via: Via[]; keyHint: string | null; envVars: string[]; baseURL: string | null; custom: ProviderAccount["custom"] | null; added: number | null }>();
  const entry = (id: string, name?: string) => {
    let e = out.get(id);
    if (!e) out.set(id, (e = { id, name: name ?? cachedCatalog()?.get(id)?.name ?? id, via: [], keyHint: null, envVars: [], baseURL: null, custom: null, added: null }));
    return e;
  };
  for (const a of Object.values(load())) {
    const e = entry(a.id, a.name);
    e.via.push("pixel");
    e.keyHint = hint(a.key);
    e.baseURL = a.baseURL ?? null;
    e.custom = a.custom ?? null;
    e.added = a.added;
  }
  for (const id of Object.keys(parseAuth(s.agentAuthJson) ?? {})) entry(id).via.push("auth.json");
  for (const p of cachedCatalog()?.values() ?? []) {
    const vars = p.env.filter((v) => s.agentEnv[v]);
    if (vars.length) {
      const e = entry(p.id);
      e.via.push("env");
      e.envVars = vars;
    }
  }
  // opencode's own gateway serves its free models without a key.
  if (!out.has("opencode")) entry("opencode", "OpenCode Zen").via.push("builtin");
  return [...out.values()].sort((a, b) => (b.added ?? 0) - (a.added ?? 0) || a.name.localeCompare(b.name));
}

/**
 * The environment and auth.json every agent (and the speed and live tests) gets: Settings, plus the
 * providers added on the Models page, plus GitHub (token as env, read-only MCP server in the config).
 */
export function agentCredentials(s: Settings = getSettings()): { env: Record<string, string>; authJson: string } {
  const accounts = Object.values(load());
  const github = githubForAgents();
  // Settings env first, so the GitHub card wins over a GITHUB_TOKEN typed there by hand.
  const env = { ...s.agentEnv, ...github.env };
  // Provider levels first, so your own levels with the same name win.
  const levels: [string, Record<string, Record<string, unknown>>][] = [];
  for (const a of accounts) if (PROVIDER_LEVELS[a.id]) for (const m of s.models.filter((m) => m.startsWith(`${a.id}/`))) levels.push([m, PROVIDER_LEVELS[a.id]]);
  levels.push(...Object.entries(s.thinkingLevels ?? {}).filter(([, v]) => Object.keys(v).length));
  if (!accounts.length && !github.mcp && !levels.length) return { env, authJson: s.agentAuthJson };

  const auth = parseAuth(s.agentAuthJson);
  if (auth === null && accounts.length) console.error("Settings auth.json is not a JSON object; agents only get the providers added on the Models page");
  const merged: Record<string, any> = { ...(auth ?? {}) };
  for (const a of accounts) if (a.key) merged[a.id] = { type: "api", key: a.key };

  const provider: Record<string, any> = {};
  for (const a of accounts) {
    const options = { ...(a.baseURL && { baseURL: a.baseURL }) };
    if (a.custom)
      provider[a.id] = {
        npm: NPM[a.custom.api ?? "openai"],
        name: a.name,
        options,
        models: Object.fromEntries(
          a.custom.models.map((m) => [m, { name: m, tool_call: true, ...(a.custom!.reasoning && { reasoning: true }), limit: { context: a.custom!.context, output: Math.min(32_000, Math.floor(a.custom!.context / 4)) } }]),
        ),
      };
    else if (Object.keys(options).length) provider[a.id] = { options };
  }
  // Custom thinking levels become extra variants on the model, next to opencode's own.
  for (const [full, vs] of levels) {
    const [pid, ...rest] = full.split("/");
    const mid = rest.join("/");
    const p = (provider[pid] ??= {});
    p.models ??= {};
    p.models[mid] = { ...(p.models[mid] ?? {}), variants: { ...(p.models[mid]?.variants ?? {}), ...vs } };
  }
  const cacheKey = accounts.filter((a) => a.cacheKey).map((a) => a.id);
  if (cacheKey.length) env.PIXEL_CACHE_KEY_PROVIDERS = cacheKey.join(",");
  if (Object.keys(provider).length || github.mcp) {
    let base: Record<string, any> = {};
    try {
      base = env.OPENCODE_CONFIG_CONTENT ? JSON.parse(env.OPENCODE_CONFIG_CONTENT) : {};
    } catch {}
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      ...base,
      ...(Object.keys(provider).length && { provider: { ...(base.provider ?? {}), ...provider } }),
      ...(github.mcp && { mcp: { ...(base.mcp ?? {}), ...github.mcp } }),
    });
  }
  return { env, authJson: !accounts.length ? s.agentAuthJson : Object.keys(merged).length ? JSON.stringify(merged, null, 2) : "" };
}

/** Ask an endpoint which models it serves (GET {baseURL}/models, the same path in both APIs). */
export async function discoverModels(baseURL: string, key?: string, id?: string, api: CustomApi = "openai") {
  const url = cleanUrl(baseURL);
  if (!url) throw new Error("base URL needed");
  const stored = !key && id ? load()[id]?.key : undefined;
  const auth = key?.trim() || stored;
  const headers: Record<string, string> = api === "anthropic" ? { "anthropic-version": "2023-06-01", ...(auth && { "x-api-key": auth }) } : auth ? { authorization: `Bearer ${auth}` } : {};
  const res = await fetch(`${url}/models`, { headers, signal: AbortSignal.timeout(15_000) }).catch((e) => {
    throw new Error(`cannot reach ${url}/models: ${e.message}`);
  });
  if (!res.ok) throw new Error(`${url}/models answered ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const body: any = await res.json().catch(() => null);
  const list: any[] = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : Array.isArray(body) ? body : [];
  return { models: [...new Set(list.map((m) => (typeof m === "string" ? m : (m?.id ?? m?.name))).filter((m): m is string => typeof m === "string"))].sort() };
}
