/** /api/providers, /api/catalog and /api/speedtests: connected providers, the model catalogue, provider health, the model leaderboard, and text-only speed tests. */
import { health, leaderboard, speedTests, speedTestStatus, startSpeedTest } from "../providers.ts";
import { catalogProvider, catalogProviders } from "../catalog.ts";
import { liveAbort, livePrompt, liveStatus, modelVariants } from "../liveTest.ts";
import { cachedCatalog } from "../catalog.ts";
import { effective } from "../modelOverrides.ts";
import { getSettings, saveSettings } from "../settings.ts";
import { getProxy, importProxies, listProxies, publicProxy, removeProxy, resolveProxyUrl, saveProxy, testProxy, testProxyUrl, withScheme, type ProxyInput } from "../proxies.ts";
import { relayBase, upstreamBase } from "../relay.ts";
import { addKey, connectedProviders, discoverModels, editKey, orderKeys, removeAccount, removeKey, saveAccount, testKey, type AccountInput, type KeyInput } from "../providerAccounts.ts";
import { ACTIVE_STATUSES, db, listRuns } from "../db.ts";
import { timeline } from "../runs/state.ts";
import { del, get, post, put, readJson, HttpError } from "./router.ts";

get("/providers/health", ({ query }) => health(Math.min(24 * 60, Math.max(5, Number(query.get("minutes") ?? 60)))));
get("/providers/leaderboard", () => leaderboard());
get("/speedtests", () => ({ ...speedTestStatus(), results: speedTests() }));
post("/speedtests", async ({ req }) => startSpeedTest((await readJson<{ models?: string[] }>(req)).models ?? []));

// ---- catalogue ----

get("/catalog", ({ query }) => catalogProviders(query.get("refresh") === "1"));
get("/catalog/:id", async ({ params: { id } }) => {
  const p = await catalogProvider(id);
  if (!p) throw new HttpError(404, `${id} is not in the catalogue`);
  return p;
});

// ---- connected providers ----

get("/providers", async () => {
  await catalogProviders(); // env-var detection needs the catalogue loaded
  return connectedProviders();
});
put("/providers/:id", async ({ req, params: { id } }) => {
  const a = await saveAccount({ ...(await readJson<AccountInput>(req)), id });
  return { id: a.id };
});
del("/providers/:id", ({ params: { id } }) => removeAccount(id));

// ---- a provider's keys ----

/** Runs on each key and its calls in the last hour, for the Models page. */
get("/providers/:id/keys/usage", ({ params: { id } }) => {
  const runs = db.query<{ key_id: string | null; n: number }, [string]>("SELECT key_id, COUNT(*) AS n FROM runs WHERE model LIKE ? || '/%' AND status IN ('preparing', 'running', 'recovering', 'paused') GROUP BY key_id").all(id);
  const calls = db.query<{ key_id: string | null; n: number }, [string, number]>("SELECT key_id, COUNT(*) AS n FROM llm_calls WHERE provider = ? AND created >= ? GROUP BY key_id").all(id, Date.now() - 3_600_000);
  return { runs: Object.fromEntries(runs.map((r) => [r.key_id ?? "", r.n])), callsPerHour: Object.fromEntries(calls.map((r) => [r.key_id ?? "", r.n])) };
});
post("/providers/:id/keys", async ({ req, params: { id } }) => addKey(id, await readJson<KeyInput>(req)));
put("/providers/:id/keys/:key", async ({ req, params: { id, key } }) => editKey(id, key, await readJson<KeyInput>(req)));
del("/providers/:id/keys/:key", ({ params: { id, key } }) => {
  const moved = removeKey(id, key);
  for (const run of moved) {
    db.query("UPDATE runs SET key_id = NULL WHERE id = ?").run(run);
    timeline(run, "user", "key", "Its API key was removed; the run uses the provider's default key from its next restart");
  }
  return { moved };
});
put("/providers/:id/keys-order", async ({ req, params: { id } }) => orderKeys(id, (await readJson<{ ids: string[] }>(req)).ids ?? []));
post("/providers/:id/keys/:key/test", ({ params: { id, key } }) => testKey(id, key));
post("/providers/discover", async ({ req }) => {
  const b = await readJson<{ baseURL?: string; key?: string; id?: string; api?: "openai" | "anthropic"; vars?: Record<string, string | null>; bearer?: boolean }>(req);
  return discoverModels(b.baseURL ?? "", b.key, b.id, b.api === "anthropic" ? "anthropic" : "openai", b.vars, !!b.bearer);
});

// ---- models offered in the new-run form, for the model pickers ----

get("/models", async () => {
  await catalogProviders();
  const s = getSettings();
  const names = new Map(connectedProviders(s).map((p) => [p.id, p]));
  return {
    defaultModel: s.defaultModel,
    models: s.models.map((full) => {
      const [provider, ...rest] = full.split("/");
      const id = rest.join("/");
      const p = names.get(provider);
      const m = cachedCatalog()?.get(provider)?.models.find((x) => x.id === id) ?? null;
      const c = p?.customModels?.find((x) => x.id === id);
      const e = effective(full, s, m ?? null);
      return {
        model: full,
        provider,
        providerName: p?.name ?? cachedCatalog()?.get(provider)?.name ?? provider,
        name: m?.name ?? c?.name ?? id,
        context: e.context ?? c?.context ?? p?.custom?.context ?? null,
        costIn: e.costIn,
        costOut: e.costOut,
        reasoning: e.reasoning || !!c?.reasoning || !!p?.custom?.reasoning,
        connected: !!p,
      };
    }),
  };
});
get("/models/variants", () => modelVariants());

// ---- live test ----

get("/live", () => liveStatus());
post("/live", async ({ req }) => livePrompt(await readJson(req)));
post("/live/:session/abort", ({ params: { session } }) => liveAbort(session));

// ---- proxies for model calls ----

/** The provider APIs the offered models use, for a proxy test to try. */
const offeredBases = async () => {
  await catalogProviders();
  const s = getSettings();
  return [...new Set(s.models.map((m) => upstreamBase(m.split("/")[0], m.split("/").slice(1).join("/"))).filter((b): b is string => !!b))];
};

get("/proxies", async () => {
  await catalogProviders();
  const s = getSettings();
  const runs = listRuns().filter((r) => r.proxy_id && ACTIVE_STATUSES.includes(r.status));
  return {
    defaultProxy: s.defaultProxy,
    relay: relayBase(),
    /** Connected providers whose calls can't go through a proxy (Pixel doesn't know their API's address). */
    unrelayable: connectedProviders(s).filter((p) => !upstreamBase(p.id)).map((p) => p.name),
    proxies: listProxies().map((p) => ({ ...publicProxy(p), runs: runs.filter((r) => r.proxy_id === p.id).map((r) => r.id) })),
  };
});
post("/proxies", async ({ req }) => publicProxy(await saveProxy(await readJson<ProxyInput>(req))));
post("/proxies/import", async ({ req }) => {
  const b = await readJson<{ text?: string; scheme?: ProxyInput["scheme"] }>(req);
  const r = await importProxies(b.text ?? "", b.scheme);
  return { added: r.added.map(publicProxy), skipped: r.skipped };
});
put("/proxies/:id", async ({ req, params: { id } }) => publicProxy(await saveProxy(await readJson<ProxyInput>(req), id)));
del("/proxies/:id", ({ params: { id } }) => {
  const p = getProxy(id);
  if (!p) throw new HttpError(404, `no proxy ${id}`);
  removeProxy(id);
  if (getSettings().defaultProxy === id) saveSettings({ defaultProxy: "" });
  // Runs on it fail closed at the relay until they get another proxy; say so on each.
  const runs = listRuns().filter((r) => r.proxy_id === id);
  for (const r of runs) timeline(r.id, "user", "proxy", `Proxy ${p.name} was removed; model calls fail until the run gets another proxy or none`);
  return { runs: runs.map((r) => r.id) };
});
post("/proxies/:id/test", async ({ params: { id } }) => testProxy(id, await offeredBases()));
/** Test an address before saving it (the add dialog); an id fills in the stored password when editing. */
post("/proxies/test", async ({ req }) => {
  const b = await readJson<ProxyInput & { id?: string }>(req);
  const old = b.id ? getProxy(b.id) : null;
  let u = b.url?.trim() ? await resolveProxyUrl(b.url, b.scheme) : old ? new URL(old.url) : null;
  if (!u) throw new HttpError(400, "proxy address needed");
  if (!b.url?.trim() && b.scheme && b.scheme !== "auto") u = withScheme(u, b.scheme);
  if (b.username !== undefined && (b.username.trim() || !b.url?.trim() || !u.username)) u.username = encodeURIComponent(b.username.trim());
  if (b.password) u.password = encodeURIComponent(b.password);
  else if (old && !u.password) u.password = new URL(old.url).password;
  return testProxyUrl(u.toString().replace(/\/$/, ""), await offeredBases());
});
