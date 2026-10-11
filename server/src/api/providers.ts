/** /api/providers, /api/catalog and /api/speedtests: connected providers, the model catalogue, provider health, the model leaderboard, and text-only speed tests. */
import { health, leaderboard, speedTests, speedTestStatus, startSpeedTest } from "../providers.ts";
import { catalogProvider, catalogProviders } from "../catalog.ts";
import { liveAbort, livePrompt, liveStatus, modelVariants } from "../liveTest.ts";
import { cachedCatalog } from "../catalog.ts";
import { getSettings } from "../settings.ts";
import { connectedProviders, discoverModels, removeAccount, saveAccount, type AccountInput } from "../providerAccounts.ts";
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
post("/providers/discover", async ({ req }) => {
  const b = await readJson<{ baseURL?: string; key?: string; id?: string; api?: "openai" | "anthropic" }>(req);
  return discoverModels(b.baseURL ?? "", b.key, b.id, b.api === "anthropic" ? "anthropic" : "openai");
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
      const m = cachedCatalog()?.get(provider)?.models.find((x) => x.id === id);
      const p = names.get(provider);
      return {
        model: full,
        provider,
        providerName: p?.name ?? cachedCatalog()?.get(provider)?.name ?? provider,
        name: m?.name ?? id,
        context: m?.context ?? p?.custom?.context ?? null,
        costIn: m?.costIn ?? null,
        costOut: m?.costOut ?? null,
        reasoning: m?.reasoning ?? !!p?.custom?.reasoning,
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
