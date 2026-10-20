/**
 * Model providers added from the dashboard. Keys, custom endpoints and base-URL overrides go into
 * OPENCODE_CONFIG_CONTENT as opencode 2 provider entries (opencodeConfig.ts), which opencode merges
 * over its config file, so they reach every runtime without touching the image's opencode.json.
 *
 * Accounts live in the settings table under `_providers`, so keys never travel back to the browser:
 * the API only shows a hint of each key.
 *
 * A provider can hold several keys, each with a name and notes. The first is the default; a run can
 * be put on any of them (runs.key_id), and failover (runs/keys.ts) walks them in this order.
 */
import { db } from "./db.ts";
import { getSettings, saveSettings, type Settings } from "./settings.ts";
import { cachedCatalog, catalogProvider, knownModel } from "./catalog.ts";
import { githubForAgents } from "./github.ts";
import { opencodeModel, opencodeProviderOptions } from "./modelOverrides.ts";
import { nativeProvider, type ProviderExtras } from "./opencodeConfig.ts";
import { proxySubject, relayUrl, runSubject, upstreamBase } from "./relay.ts";
import { cortexModels, snowflakeAccount, snowflakeHost, testCortexKey } from "./snowflake.ts";

export type KeyState = "rejected" | "credit" | "ratelimit";

export interface ApiKey {
  id: string;
  name: string;
  key: string;
  note: string;
  added: number;
  /** Set when a call with this key failed in a way that's the key's fault; cleared by a good call, a test or an edit. */
  status?: { state: KeyState; at: number; detail: string };
}

export interface ProviderAccount {
  id: string;
  name: string;
  /** In order: the first is the default for new runs and the first failover target. */
  keys: ApiKey[];
  /** May hold ${NAME} placeholders, filled from `vars` (then Settings env) when agents get it. */
  baseURL?: string;
  /**
   * Not in the catalogue: an endpoint speaking the OpenAI or Anthropic API, serving these model ids.
   * `modelApi` holds the models that speak the other API (Snowflake Cortex: Claude on /messages, the rest on /chat/completions).
   */
  custom?: { api: CustomApi; models: string[]; context: number; reasoning?: boolean; modelApi?: Record<string, CustomApi> };
  /** Send `prompt_cache_key` (the session id) so repeat requests hit the provider's cache (opencode's supportsPromptCacheKey). */
  cacheKey?: boolean;
  /**
   * What the provider needs besides the key (SNOWFLAKE_ACCOUNT, AZURE_RESOURCE_NAME, CLOUDFLARE_ACCOUNT_ID…).
   * Agents get them as environment variables, and they fill ${NAME} in the base URL.
   */
  vars?: Record<string, string>;
  /** Send the key as `Authorization: Bearer` on Anthropic-style calls too, for gateways that refuse x-api-key (Snowflake Cortex). */
  bearer?: boolean;
  /** Send the output limit as max_completion_tokens on OpenAI-style calls (opencode's maxTokensField). */
  maxCompletionTokens?: boolean;
  added: number;
}

export interface AccountInput {
  id: string;
  name?: string;
  /** The default (first) key. Omitted when editing = keep it. */
  key?: string;
  /** Drop every key: agents call the provider without one (OpenCode Zen's free models, a local server). */
  noKey?: boolean;
  baseURL?: string;
  custom?: { api?: CustomApi; models: string[]; context?: number; reasoning?: boolean; modelApi?: Record<string, CustomApi> };
  cacheKey?: boolean;
  /** The whole set: a value sets it, null keeps the stored one (secrets the dashboard never sees), "" or a missing name drops it. Omitted = keep all. */
  vars?: Record<string, string | null>;
  bearer?: boolean;
  maxCompletionTokens?: boolean;
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

const newKeyId = () => `k_${Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString("hex")}`;

function load(): Record<string, ProviderAccount> {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(KEY);
  let accounts: Record<string, any>;
  try {
    accounts = row ? JSON.parse(row.value) : {};
  } catch {
    return {};
  }
  // Before several keys: one `key` per provider. It becomes the first key, named "Default" (saved once, so its id sticks).
  let migrated = false;
  for (const a of Object.values(accounts)) {
    if (Array.isArray(a.keys)) continue;
    a.keys = a.key ? [{ id: newKeyId(), name: "Default", key: a.key, note: "", added: a.added ?? Date.now() }] : [];
    delete a.key;
    migrated = true;
  }
  if (migrated) store(accounts);
  return accounts;
}

function store(accounts: Record<string, ProviderAccount>) {
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(accounts));
}

/** Names that look like secrets: the dashboard only ever gets a hint of their values. */
const SECRET_VAR = /KEY|TOKEN|SECRET|PASSWORD|PAT$|CREDENTIAL/i;
/** Set by Pixel or the machine; a provider variable must not replace them. */
const RESERVED_VAR = /^(PATH|HOME|USER|SHELL|LANG|TERM|PWD|OPENCODE_.*|PIXEL_.*|XDG_.*)$/;
const VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** The ${NAME} placeholders in a URL. */
export const urlVars = (url: string | null | undefined) => [...(url ?? "").matchAll(VAR_REF)].map((m) => m[1]);

/** A URL with ${NAME} filled in from the provider's variables, then Settings env; null while one is still missing. */
export function fillVars(url: string | null | undefined, vars: Record<string, string> | undefined, env: Record<string, string> = getSettings().agentEnv) {
  if (!url) return null;
  const out = url.replace(VAR_REF, (m, n) => vars?.[n] || env[n] || m);
  return out.includes("${") ? null : out;
}

/**
 * Where a provider added here sends its calls, when Pixel sets it: its own base URL, or the catalogue's
 * when that needs variables (opencode doesn't fill ${NAME} in a catalogue URL by itself).
 */
function accountBase(a: ProviderAccount, env?: Record<string, string>) {
  const cat = cachedCatalog()?.get(a.id)?.api;
  return fillVars(a.baseURL ?? (cat?.includes("${") ? cat : null), a.vars, env);
}

/** The endpoint set for a provider added on the Models page (custom endpoint or proxy URL), if any. */
export function accountBaseURL(id: string) {
  const a = load()[id];
  return a ? accountBase(a) : null;
}

/** A variable's value as stored: trimmed, and a pasted Snowflake account URL cut down to the identifier. */
const varValue = (name: string, v: string) => (name === "SNOWFLAKE_ACCOUNT" ? snowflakeAccount(v) : v.trim());

function cleanVars(input: Record<string, string | null> | undefined, old: Record<string, string> | undefined) {
  if (input === undefined) return old;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("variables must be an object of NAME: value");
  const out: Record<string, string> = {};
  for (const [raw, v] of Object.entries(input)) {
    const name = raw.trim();
    if (!name) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new Error(`variable ${name}: letters, digits and _, not starting with a digit`);
    if (RESERVED_VAR.test(name)) throw new Error(`${name} is set by Pixel or the machine; it can't be a provider variable`);
    if (v !== null && typeof v !== "string") throw new Error(`variable ${name} must be text`);
    const value = v === null ? old?.[name] : varValue(name, v);
    if (!value) continue;
    if (value.length > 8192) throw new Error(`variable ${name} is too long`);
    out[name] = value;
  }
  if (Object.keys(out).length > 40) throw new Error("at most 40 variables per provider");
  return Object.keys(out).length ? out : undefined;
}

/** What agents get for one of a custom endpoint's models: the catalogue's numbers when it knows the id, else the endpoint's. */
export function customModelInfo(c: NonNullable<ProviderAccount["custom"]>, id: string) {
  const known = knownModel(id);
  const context = known?.context ?? c.context;
  return {
    id,
    name: known?.name ?? id,
    api: c.modelApi?.[id] ?? c.api,
    context,
    output: known?.output ?? Math.min(32_000, Math.floor(context / 4)),
    reasoning: !!c.reasoning || !!known?.reasoning,
    /** Numbers from the catalogue (the same model sold elsewhere) rather than the endpoint's defaults. */
    known: !!known,
  };
}

export const hint = (key: string) => (!key ? null : key.length < 12 ? "****" : `${key.slice(0, 3)}...${key.slice(-4)}`);

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
  const api: CustomApi = custom?.api === "anthropic" ? "anthropic" : "openai";
  const modelApi = custom && Object.fromEntries(Object.entries(custom.modelApi ?? {}).filter(([m, x]) => custom.models.includes(m) && (x === "openai" || x === "anthropic") && x !== api));
  const vars = cleanVars(input.vars, old?.vars);
  let keys = old?.keys.map((k) => ({ ...k })) ?? [];
  if (input.noKey) keys = [];
  else if (input.key !== undefined) {
    const key = cleanKey(input.key);
    if (keys[0]) {
      if (keys[0].key !== key) delete keys[0].status;
      keys[0].key = key;
    } else if (key) keys.push({ id: newKeyId(), name: "Default", key, note: "", added: Date.now() });
  }
  accounts[id] = {
    id,
    name: input.name?.trim() || known?.name || old?.name || id,
    keys,
    ...(baseURL && { baseURL }),
    ...(custom && {
      custom: { api, models: custom.models, context: Math.max(1024, Number(custom.context) || 128_000), ...(custom.reasoning && { reasoning: true }), ...(modelApi && Object.keys(modelApi).length && { modelApi }) },
    }),
    ...((input.cacheKey ?? old?.cacheKey ?? CACHE_KEY_BY_DEFAULT.has(id)) && { cacheKey: true }),
    ...(vars && { vars }),
    ...((input.bearer ?? old?.bearer) && { bearer: true }),
    ...((input.maxCompletionTokens ?? old?.maxCompletionTokens) && { maxCompletionTokens: true }),
    added: old?.added ?? Date.now(),
  };
  store(accounts);
  return accounts[id];
}

function cleanKey(key: string) {
  const k = key.trim();
  if (k.length > 8192) throw new Error("key is too long");
  return k;
}

function mustAccount(accounts: Record<string, ProviderAccount>, id: string) {
  const a = accounts[id];
  if (!a) throw new Error(`no provider ${id} added on the Models page`);
  return a;
}

export interface KeyInput {
  name?: string;
  /** Omitted when editing = keep the stored key. */
  key?: string;
  note?: string;
}

export function addKey(providerId: string, input: KeyInput) {
  const accounts = load();
  const a = mustAccount(accounts, providerId);
  const key = cleanKey(input.key ?? "");
  if (!key) throw new Error("paste the API key");
  const k: ApiKey = { id: newKeyId(), name: input.name?.trim().slice(0, 60) || `Key ${a.keys.length + 1}`, key, note: (input.note ?? "").trim().slice(0, 2000), added: Date.now() };
  a.keys.push(k);
  store(accounts);
  return publicKey(k);
}

export function editKey(providerId: string, keyId: string, input: KeyInput) {
  const accounts = load();
  const k = mustAccount(accounts, providerId).keys.find((x) => x.id === keyId);
  if (!k) throw new Error(`no key ${keyId}`);
  if (input.name !== undefined) k.name = input.name.trim().slice(0, 60) || k.name;
  if (input.note !== undefined) k.note = input.note.trim().slice(0, 2000);
  if (input.key !== undefined && input.key.trim()) {
    k.key = cleanKey(input.key);
    delete k.status;
  }
  store(accounts);
  return publicKey(k);
}

/** Remove a key; runs that were on it go back to the provider's default key. */
export function removeKey(providerId: string, keyId: string) {
  const accounts = load();
  const a = mustAccount(accounts, providerId);
  if (!a.keys.some((k) => k.id === keyId)) throw new Error(`no key ${keyId}`);
  a.keys = a.keys.filter((k) => k.id !== keyId);
  store(accounts);
  return db.query<{ id: string }, [string]>("SELECT id FROM runs WHERE key_id = ?").all(keyId).map((r) => r.id);
}

export function orderKeys(providerId: string, ids: string[]) {
  const accounts = load();
  const a = mustAccount(accounts, providerId);
  const rank = new Map(ids.map((id, i) => [id, i]));
  a.keys.sort((x, y) => (rank.get(x.id) ?? 1e9) - (rank.get(y.id) ?? 1e9));
  store(accounts);
}

export function setKeyStatus(providerId: string, keyId: string, status: ApiKey["status"] | null) {
  const accounts = load();
  const k = accounts[providerId]?.keys.find((x) => x.id === keyId);
  if (!k || (!status && !k.status)) return;
  if (status) k.status = status;
  else delete k.status;
  store(accounts);
}

/** Rate-limit marks wear off; the others stay until a good call, a test or an edit. */
export const RATELIMIT_MARK_MS = 30 * 60_000;
export const keyFailing = (k: Pick<ApiKey, "status">, now = Date.now()) => !!k.status && (k.status.state !== "ratelimit" || now - k.status.at < RATELIMIT_MARK_MS);

/** A key as the dashboard sees it: no secret, just a hint. */
export const publicKey = (k: ApiKey) => ({ id: k.id, name: k.name, note: k.note, hint: hint(k.key), added: k.added, status: k.status && keyFailing(k) ? k.status : null });
export type PublicKey = ReturnType<typeof publicKey>;

export function providerKeys(providerId: string): ApiKey[] {
  return load()[providerId]?.keys ?? [];
}

/** A run's key_id (and a live test's key) meaning "call the model's provider without any key". */
export const NO_KEY = "none";

/** The key a run uses for a provider: its chosen key when it belongs to that provider, else the default; none when it runs without a key. */
export function keyFor(run: { key_id: string | null; model?: string } | null | undefined, providerId: string): ApiKey | null {
  if (run?.key_id === NO_KEY && (!run.model || run.model.split("/")[0] === providerId)) return null;
  const keys = providerKeys(providerId);
  return keys.find((k) => k.id === run?.key_id) ?? keys[0] ?? null;
}

/** Which key a key id is, wherever it lives. */
export function findKey(keyId: string): { provider: string; key: ApiKey } | null {
  for (const a of Object.values(load())) {
    const key = a.keys.find((k) => k.id === keyId);
    if (key) return { provider: a.id, key };
  }
  return null;
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
  const out = new Map<
    string,
    {
      id: string;
      name: string;
      via: Via[];
      keyHint: string | null;
      keys: PublicKey[];
      envVars: string[];
      baseURL: string | null;
      custom: ProviderAccount["custom"] | null;
      /** A custom endpoint's models as agents get them (name, API, context). */
      customModels: ReturnType<typeof customModelInfo>[] | null;
      /** Variables set on the Models page; secret-looking ones only as a hint. */
      vars: { name: string; value: string | null; hint: string | null; secret: boolean }[];
      /** ${NAME} placeholders in the base URL with no value yet: calls can't go anywhere until they're set. */
      missingVars: string[];
      bearer: boolean;
      maxCompletionTokens: boolean;
      added: number | null;
    }
  >();
  const entry = (id: string, name?: string) => {
    let e = out.get(id);
    if (!e)
      out.set(
        id,
        (e = { id, name: name ?? cachedCatalog()?.get(id)?.name ?? id, via: [], keyHint: null, keys: [], envVars: [], baseURL: null, custom: null, customModels: null, vars: [], missingVars: [], bearer: false, maxCompletionTokens: false, added: null }),
      );
    return e;
  };
  for (const a of Object.values(load())) {
    const e = entry(a.id, a.name);
    e.via.push("pixel");
    e.keyHint = a.keys[0] ? hint(a.keys[0].key) : null;
    e.keys = a.keys.map(publicKey);
    e.baseURL = a.baseURL ?? null;
    e.custom = a.custom ?? null;
    e.customModels = a.custom ? a.custom.models.map((m) => customModelInfo(a.custom!, m)) : null;
    e.vars = Object.entries(a.vars ?? {}).map(([name, v]) => {
      const secret = SECRET_VAR.test(name);
      return { name, value: secret ? null : v, hint: secret ? hint(v) : null, secret };
    });
    const template = a.baseURL ?? cachedCatalog()?.get(a.id)?.api;
    e.missingVars = urlVars(template).filter((n) => !a.vars?.[n] && !s.agentEnv[n]);
    e.bearer = !!a.bearer;
    e.maxCompletionTokens = !!a.maxCompletionTokens;
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
/** What a run (or a live test) is: its key, model, and the proxy its model calls go through. */
export interface CredsFor {
  key_id: string | null;
  model?: string;
  /** A run's id: proxied calls look up its current proxy at the relay. Without one, `proxy_id` is fixed. */
  id?: string;
  proxy_id?: string | null;
}

export function agentCredentials(s: Settings = getSettings(), run?: CredsFor | null): { env: Record<string, string>; authJson: string } {
  const creds = credentials(s, run);
  const bare = run?.key_id === NO_KEY ? run.model?.split("/")[0] : undefined;
  return bare ? withoutKey(creds, bare) : creds;
}

/** Drop every way a provider's key reaches opencode: its auth.json entry and its catalogue env vars. */
function withoutKey(creds: { env: Record<string, string>; authJson: string }, providerId: string) {
  const env = { ...creds.env };
  for (const v of cachedCatalog()?.get(providerId)?.env ?? []) delete env[v];
  const auth = parseAuth(creds.authJson);
  if (!auth?.[providerId]) return { env, authJson: creds.authJson };
  delete auth[providerId];
  return { env, authJson: Object.keys(auth).length ? JSON.stringify(auth, null, 2) : "" };
}

function credentials(s: Settings, run?: CredsFor | null): { env: Record<string, string>; authJson: string } {
  const accounts = Object.values(load());
  const github = githubForAgents();
  // Settings env first, then each provider's own variables; the GitHub card wins over a GITHUB_TOKEN typed by hand.
  const env: Record<string, string> = { ...s.agentEnv };
  for (const a of accounts) Object.assign(env, a.vars);
  Object.assign(env, github.env);
  // A run set to call its model's provider without a key: no key reaches it in any form.
  const bare = run?.key_id === NO_KEY ? run.model?.split("/")[0] : undefined;
  // Provider levels first, so your own levels with the same name win.
  const levels: [string, Record<string, Record<string, unknown>>][] = [];
  for (const a of accounts) if (PROVIDER_LEVELS[a.id]) for (const m of s.models.filter((m) => m.startsWith(`${a.id}/`))) levels.push([m, PROVIDER_LEVELS[a.id]]);
  levels.push(...Object.entries(s.thinkingLevels ?? {}).filter(([, v]) => Object.keys(v).length));
  const modelOverrides = Object.entries(s.modelOverrides ?? {}).filter(([, o]) => Object.keys(o).length);
  const providerOverrides = Object.entries(s.providerOverrides ?? {}).filter(([, o]) => Object.keys(o).length);
  const relaySubject = run?.proxy_id ? (run.id ? runSubject(run.id) : proxySubject(run.proxy_id)) : null;
  // API keys typed into Settings' auth.json: opencode 2 doesn't read that file for them, so they go into the config.
  const auth = parseAuth(s.agentAuthJson);
  if (auth === null && accounts.length) console.error("Settings auth.json is not a JSON object; agents only get the providers added on the Models page");
  const settingsKeys = Object.entries(auth ?? {}).filter(([id, v]) => (v as any)?.type === "api" && typeof (v as any).key === "string" && id !== bare);
  if (!accounts.length && !github.mcp && !levels.length && !modelOverrides.length && !providerOverrides.length && !relaySubject && !settingsKeys.length)
    return { env, authJson: s.agentAuthJson };

  const keyOf = (a: ProviderAccount) => a.keys.find((x) => x.id === run?.key_id) ?? a.keys[0];
  // Each provider's key and switches, which only exist in opencode 2's native config shape.
  const extras: Record<string, ProviderExtras> = {};
  for (const [id, v] of settingsKeys) extras[id] = { apiKey: (v as any).key };
  for (const a of accounts) {
    const k = keyOf(a);
    extras[a.id] = {
      ...(k?.key && a.id !== bare && { apiKey: k.key }),
      ...(a.cacheKey && { cacheKey: true }),
      ...(a.maxCompletionTokens && { maxCompletionTokens: true }),
    };
  }

  const provider: Record<string, any> = {};
  for (const a of accounts) {
    const base = accountBase(a, env);
    const k = keyOf(a);
    const options: Record<string, any> = { ...(base && { baseURL: base }) };
    if (a.bearer && k?.key && a.id !== bare) options.headers = { Authorization: `Bearer ${k.key}` };
    if (a.custom) {
      const api = a.custom.api ?? "openai";
      provider[a.id] = {
        npm: NPM[api],
        name: a.name,
        options,
        models: Object.fromEntries(
          a.custom.models.map((m) => {
            const info = customModelInfo(a.custom!, m);
            // A model speaking the other API gets that API's SDK; same base URL (/messages vs /chat/completions after it).
            return [m, { name: info.name, tool_call: true, ...(info.reasoning && { reasoning: true }), limit: { context: info.context, output: info.output }, ...(info.api !== api && { provider: { npm: NPM[info.api] } }) }];
          }),
        ),
      };
    } else if (Object.keys(options).length) provider[a.id] = { options };
  }
  // Settings changed by hand on the Models page, over the catalogue and the custom endpoint's own.
  for (const [id, o] of providerOverrides) {
    const p = (provider[id] ??= {});
    const extra = opencodeProviderOptions(o);
    p.options = { ...p.options, ...extra, ...((p.options?.headers || extra.headers) && { headers: { ...p.options?.headers, ...(extra.headers as object) } }) };
  }
  for (const [full, o] of modelOverrides) {
    const [pid, ...rest] = full.split("/");
    const mid = rest.join("/");
    const p = (provider[pid] ??= {});
    p.models ??= {};
    p.models[mid] = opencodeModel(full, o, p.models[mid]);
  }
  // A proxied run's model calls go to Pixel's relay, which sends them on through the proxy.
  if (relaySubject)
    for (const { id } of connectedProviders(s)) {
      // Skip only providers known to have no relayable address; before the catalogue loads, relay everything (fail closed).
      if (cachedCatalog() && !upstreamBase(id)) continue;
      const p = (provider[id] ??= {});
      p.options = { ...p.options, baseURL: relayUrl(relaySubject, id) };
    }
  // Custom thinking levels become extra variants on the model, next to opencode's own.
  for (const [full, vs] of levels) {
    const [pid, ...rest] = full.split("/");
    const mid = rest.join("/");
    const p = (provider[pid] ??= {});
    p.models ??= {};
    p.models[mid] = { ...(p.models[mid] ?? {}), variants: { ...(p.models[mid]?.variants ?? {}), ...vs } };
  }
  // opencode 2's native provider entries: everything above, plus each provider's key and switches.
  const providers: Record<string, any> = {};
  for (const id of new Set([...Object.keys(provider), ...Object.keys(extras)])) {
    const entry = nativeProvider(provider[id] ?? {}, extras[id]);
    if (Object.keys(entry).length) providers[id] = entry;
  }
  if (Object.keys(providers).length || github.mcp) {
    let base: Record<string, any> = {};
    try {
      base = env.OPENCODE_CONFIG_CONTENT ? JSON.parse(env.OPENCODE_CONFIG_CONTENT) : {};
    } catch {}
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      ...base,
      ...(Object.keys(providers).length && { providers: { ...(base.providers ?? {}), ...providers } }),
      ...(github.mcp && { mcp: { ...(base.mcp ?? {}), ...github.mcp } }),
    });
  }
  // Keys travel in the config; auth.json is only Settings' own.
  return { env, authJson: s.agentAuthJson };
}

/** GET {base}/models with the key the way the provider takes it; the body only when it failed. */
async function getModels(base: string, key: string, anthropic: boolean, bearer: boolean) {
  const headers: Record<string, string> = anthropic && !bearer ? { "anthropic-version": "2023-06-01", "x-api-key": key } : { authorization: `Bearer ${key}`, ...(anthropic && { "anthropic-version": "2023-06-01" }) };
  const url = `${base.replace(/\/+$/, "")}/models`;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) }).catch((e) => {
    throw new Error(`cannot reach ${url}: ${e.message}`);
  });
  return { ok: r.ok, status: r.status, body: r.ok ? "" : (await r.text().catch(() => "")).slice(0, 300) };
}

/** Where to reach a provider's API directly, for testing a key; null when Pixel doesn't know. */
const KNOWN_API: Record<string, string> = { anthropic: "https://api.anthropic.com/v1", openai: "https://api.openai.com/v1" };

/**
 * Check a key with one free call (GET {base}/models). Marks the key rejected or out of credit when
 * the provider says so, and clears any mark when it works.
 */
export async function testKey(providerId: string, keyId: string) {
  const a = load()[providerId];
  const k = a?.keys.find((x) => x.id === keyId);
  if (!a || !k) throw new Error(`no key ${keyId} for ${providerId}`);
  const cat = cachedCatalog()?.get(providerId);
  const base = accountBase(a) ?? (cat?.api && !cat.api.includes("${") ? cat.api : null) ?? KNOWN_API[providerId];
  if (!base) {
    const missing = urlVars(a.baseURL ?? cat?.api).filter((n) => !a.vars?.[n]);
    throw new Error(missing.length ? `Set ${missing.join(", ")} first: the API address needs ${missing.length === 1 ? "it" : "them"}` : `Pixel doesn't know ${a.name}'s API address, so it can't test the key directly; try it in the live test instead`);
  }
  const anthropic = a.custom ? a.custom.api === "anthropic" : providerId === "anthropic" || !!cat?.npm?.includes("anthropic");
  const sf = snowflakeHost(base);
  const res = sf ? await testCortexKey(sf, k.key) : await getModels(base, k.key, anthropic, !!a.bearer);
  const body = res.body;
  if (res.ok) {
    setKeyStatus(providerId, keyId, null);
    return { ok: true, status: res.status, message: "The key works" };
  }
  const state = res.status === 401 || res.status === 403 ? "rejected" : res.status === 402 || /insufficient|balance|credit|billing/i.test(body) ? "credit" : null;
  if (state) setKeyStatus(providerId, keyId, { state, at: Date.now(), detail: `HTTP ${res.status}: ${body.slice(0, 160)}` });
  return { ok: false, status: res.status, message: `HTTP ${res.status}${body ? `: ${body}` : ""}` };
}

/**
 * Ask an endpoint which models it serves (GET {baseURL}/models, the same path in both APIs; Snowflake
 * through its SQL API). `vars` are the form's unsaved variables, null meaning the stored value.
 */
export async function discoverModels(baseURL: string, key?: string, id?: string, api: CustomApi = "openai", vars?: Record<string, string | null>, bearer?: boolean) {
  const stored = id ? load()[id] : undefined;
  const filled = Object.fromEntries(Object.entries(vars ?? stored?.vars ?? {}).map(([n, v]) => [n, v === null ? (stored?.vars?.[n] ?? "") : varValue(n, v)]));
  const missing = urlVars(baseURL).filter((n) => !filled[n] && !getSettings().agentEnv[n]);
  if (missing.length) throw new Error(`Set ${missing.join(", ")} first: the base URL needs ${missing.length === 1 ? "it" : "them"}`);
  const url = cleanUrl(fillVars(baseURL, filled) ?? "");
  if (!url) throw new Error("base URL needed");
  const auth = key?.trim() || stored?.keys[0]?.key;
  const sf = snowflakeHost(url);
  if (sf) return { models: await cortexModels(sf, auth ?? "") };
  const headers: Record<string, string> =
    api === "anthropic" && !bearer ? { "anthropic-version": "2023-06-01", ...(auth && { "x-api-key": auth }) } : { ...(api === "anthropic" && { "anthropic-version": "2023-06-01" }), ...(auth && { authorization: `Bearer ${auth}` }) };
  const res = await fetch(`${url}/models`, { headers, signal: AbortSignal.timeout(15_000) }).catch((e) => {
    throw new Error(`cannot reach ${url}/models: ${e.message}`);
  });
  if (!res.ok) throw new Error(`${url}/models answered ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const body: any = await res.json().catch(() => null);
  const list: any[] = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : Array.isArray(body) ? body : [];
  return { models: [...new Set(list.map((m) => (typeof m === "string" ? m : (m?.id ?? m?.name))).filter((m): m is string => typeof m === "string"))].sort() };
}
