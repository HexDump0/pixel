import { beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { getSettings, saveSettings } from "../src/settings.ts";
import { catalogProvider, catalogProviders } from "../src/catalog.ts";
import { saveGithub } from "../src/github.ts";
import { accountBaseURL, addKey, agentCredentials, connectedProviders, NO_KEY, discoverModels, editKey, findKey, keyFor, orderKeys, providerKeys, RATELIMIT_MARK_MS, removeAccount, removeKey, saveAccount, setKeyStatus, testKey } from "../src/providerAccounts.ts";
import { classifyKeyError, nextKey } from "../src/runs/keys.ts";
import { db } from "../src/db.ts";

/** opencode config the agents get, and one provider's key in it. */
const cfgOf = (c: { env: Record<string, string> }) => JSON.parse(c.env.OPENCODE_CONFIG_CONTENT ?? "{}");
const keyIn = (c: { env: Record<string, string> }, id: string) => cfgOf(c).providers?.[id]?.settings?.apiKey;

beforeAll(() => {
  // A tiny catalogue in place of models.dev (PIXEL_MODELS_URL is empty in tests, so nothing is downloaded).
  writeFileSync(
    join(config.dataDir, "models.json"),
    JSON.stringify({
      anthropic: { id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"], npm: "@ai-sdk/anthropic", models: { "claude-x": { id: "claude-x", name: "Claude X", tool_call: true, limit: { context: 200000, output: 64000 }, cost: { input: 3, output: 15 } } } },
      groq: { id: "groq", name: "Groq", env: ["GROQ_API_KEY"], models: { "llama-y": { id: "llama-y", name: "Llama Y", tool_call: false } } },
      opencode: { id: "opencode", name: "OpenCode Zen", env: ["OPENCODE_API_KEY"], models: {} },
      coralbricks: { id: "coralbricks", name: "CoralBricks", env: ["CORAL_API_KEY"], npm: "@ai-sdk/openai-compatible", api: "https://inference.coralbricks.ai/v1", models: {} },
      "snowflake-cortex": { id: "snowflake-cortex", name: "Snowflake Cortex", env: ["SNOWFLAKE_ACCOUNT", "SNOWFLAKE_CORTEX_PAT"], npm: "@ai-sdk/openai-compatible", api: "https://${SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/api/v2/cortex/v1", models: {} },
    }),
  );
});

describe("catalogue", () => {
  test("lists providers with model counts and serves one provider's models", async () => {
    const list = await catalogProviders();
    expect(list.providers.find((p) => p.id === "anthropic")).toMatchObject({ name: "Anthropic", env: ["ANTHROPIC_API_KEY"], modelCount: 1, toolModels: 1 });
    expect((await catalogProvider("anthropic"))!.models[0]).toMatchObject({ id: "claude-x", context: 200000, costIn: 3, costOut: 15, tools: true });
    expect(await catalogProvider("nope")).toBeNull();
  });
});

describe("provider accounts", () => {
  test("a catalogue provider's key goes into the opencode config, with Settings' API keys", async () => {
    const settingsAuth = JSON.stringify({ other: { type: "api", key: "o-1" }, sso: { type: "oauth", refresh: "r" } });
    saveSettings({ agentAuthJson: settingsAuth, agentEnv: { GITHUB_TOKEN: "gh" } });
    await saveAccount({ id: "anthropic", key: "sk-ant-secret-1234" });
    const c = agentCredentials();
    expect(cfgOf(c).providers).toEqual({ anthropic: { settings: { apiKey: "sk-ant-secret-1234" } }, other: { settings: { apiKey: "o-1" } } });
    // auth.json stays what Settings has (opencode imports its logins on first start).
    expect(c.authJson).toBe(settingsAuth);
    expect(c.env.GITHUB_TOKEN).toBe("gh");

    // Editing without a key keeps the stored one.
    await saveAccount({ id: "anthropic", baseURL: "https://proxy.example.com/v1/" });
    const again = agentCredentials();
    expect(cfgOf(again).providers.anthropic).toEqual({ settings: { baseURL: "https://proxy.example.com/v1", apiKey: "sk-ant-secret-1234" } });

    // noKey drops every key; the provider stays connected and agents get no key for it.
    addKey("anthropic", { name: "Second", key: "sk-ant-second-5678" });
    await saveAccount({ id: "anthropic", noKey: true });
    expect(providerKeys("anthropic")).toEqual([]);
    expect(connectedProviders().find((p) => p.id === "anthropic")?.via).toContain("pixel");
    expect(keyIn(agentCredentials(), "anthropic")).toBeUndefined();
    await saveAccount({ id: "anthropic", key: "sk-ant-secret-1234" });
  });

  test("custom endpoints become opencode providers for both API types", async () => {
    saveSettings({ agentEnv: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ share: "disabled", provider: { keep: { options: {} } } }) } });
    await saveAccount({ id: "gw", name: "Gateway", baseURL: "https://gw.example.com/v1", key: "gw-key", custom: { api: "anthropic", models: ["m-a", " m-a ", "m-b"], context: 64000 } });
    await saveAccount({ id: "home", baseURL: "http://10.0.0.5:11434/v1", key: "", custom: { models: ["qwen"] } });
    const cfg = JSON.parse(agentCredentials().env.OPENCODE_CONFIG_CONTENT);
    expect(cfg.share).toBe("disabled");
    expect(cfg.provider.keep).toEqual({ options: {} });
    expect(cfg.providers.gw).toMatchObject({ package: "aisdk:@ai-sdk/anthropic", name: "Gateway", settings: { baseURL: "https://gw.example.com/v1", apiKey: "gw-key" } });
    expect(Object.keys(cfg.providers.gw.models)).toEqual(["m-a", "m-b"]);
    expect(cfg.providers.gw.models["m-a"]).toMatchObject({ capabilities: { tools: true }, limit: { context: 64000 } });
    expect(cfg.providers.home).toMatchObject({ package: "aisdk:@ai-sdk/openai-compatible", settings: { baseURL: "http://10.0.0.5:11434/v1" } });
    expect(cfg.providers.home.models.qwen.limit.context).toBe(128000);
    // No key, none in the config.
    expect(cfg.providers.home.settings.apiKey).toBeUndefined();
  });

  test("Coral Bricks gets a prompt cache key", async () => {
    await saveAccount({ id: "coralbricks", key: "cb-1" });
    expect(cfgOf(agentCredentials()).providers.coralbricks.compatibility).toEqual({ supportsPromptCacheKey: true });
    await saveAccount({ id: "coralbricks", cacheKey: false });
    expect(cfgOf(agentCredentials()).providers.coralbricks.compatibility).toBeUndefined();
    removeAccount("coralbricks");
  });

  test("rejects bad input", async () => {
    await expect(saveAccount({ id: "Bad Id", key: "x" })).rejects.toThrow("provider id");
    await expect(saveAccount({ id: "unknown-provider", key: "x" })).rejects.toThrow("custom endpoint");
    await expect(saveAccount({ id: "groq", baseURL: "https://x/v1", custom: { models: ["a"] } })).rejects.toThrow("catalogue provider");
    await expect(saveAccount({ id: "nourl", custom: { models: ["a"] } })).rejects.toThrow("base URL");
    await expect(saveAccount({ id: "nomodels", baseURL: "https://x/v1", custom: { models: [" "] } })).rejects.toThrow("model id");
    await expect(saveAccount({ id: "ftp", baseURL: "ftp://x", custom: { models: ["a"] } })).rejects.toThrow("http");
  });

  test("connected providers show how each is set up, never the key", async () => {
    saveSettings({ agentEnv: { GROQ_API_KEY: "gsk-1" }, agentAuthJson: JSON.stringify({ hand: { type: "api", key: "h" } }) });
    const list = connectedProviders();
    const by = Object.fromEntries(list.map((p) => [p.id, p]));
    expect(by.anthropic.via).toEqual(["pixel"]);
    expect(by.anthropic.keyHint).toBe("sk-...1234");
    expect(JSON.stringify(list)).not.toContain("secret");
    expect(by.groq).toMatchObject({ via: ["env"], envVars: ["GROQ_API_KEY"] });
    expect(by.hand.via).toEqual(["auth.json"]);
    expect(by.opencode.via).toEqual(["builtin"]);
    expect(by.gw.custom).toMatchObject({ api: "anthropic", models: ["m-a", "m-b"] });
  });

  test("removing a provider drops its models and moves the default", async () => {
    saveSettings({ models: ["gw/m-a", "gw/m-b", "opencode/big-pickle"], defaultModel: "gw/m-a" });
    removeAccount("gw");
    expect(getSettings()).toMatchObject({ models: ["opencode/big-pickle"], defaultModel: "opencode/big-pickle" });
    expect(connectedProviders().some((p) => p.id === "gw")).toBe(false);
    expect(() => removeAccount("gw")).toThrow("no provider");
  });

  test("without accounts, Settings pass through unchanged", async () => {
    removeAccount("anthropic");
    removeAccount("home");
    saveSettings({ agentEnv: { A: "1" }, agentAuthJson: "not json" });
    expect(agentCredentials()).toEqual({ env: { A: "1" }, authJson: "not json" });
  });
});

describe("github", () => {
  test("the token reaches agents as env and as a read-only MCP server", () => {
    saveSettings({ agentEnv: { GITHUB_TOKEN: "typed-by-hand" }, agentAuthJson: "" });
    expect(() => saveGithub({ token: "not a token!" })).toThrow("GitHub token");
    saveGithub({ token: "github_pat_" + "a".repeat(40), toolsets: "repos, issues" });
    const c = agentCredentials();
    expect(c.env.GITHUB_TOKEN).toBe("github_pat_" + "a".repeat(40));
    expect(c.env.GH_TOKEN).toBe(c.env.GITHUB_TOKEN);
    const gh = JSON.parse(c.env.OPENCODE_CONFIG_CONTENT).mcp.github;
    expect(gh).toMatchObject({ type: "remote", url: "https://api.githubcopilot.com/mcp/readonly", oauth: false, enabled: true });
    expect(gh.headers).toMatchObject({ "X-MCP-Readonly": "true", "X-MCP-Toolsets": "repos,issues" });

    saveGithub({ mcp: false });
    expect(agentCredentials().env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    saveGithub({ token: "" });
    expect(agentCredentials().env.GITHUB_TOKEN).toBe("typed-by-hand");
  });
});

describe("model discovery", () => {
  test("asks /models with the right auth for each API type", async () => {
    const seen: Record<string, string | null>[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization"), xkey: req.headers.get("x-api-key"), version: req.headers.get("anthropic-version") });
        return Response.json({ data: [{ id: "b-model" }, { id: "a-model" }, { id: "a-model" }] });
      },
    });
    try {
      const base = `http://127.0.0.1:${server.port}/v1`;
      expect(await discoverModels(base, "k1")).toEqual({ models: ["a-model", "b-model"] });
      await discoverModels(`${base}/`, "k2", undefined, "anthropic");
      expect(seen).toEqual([
        { path: "/v1/models", auth: "Bearer k1", xkey: null, version: null },
        { path: "/v1/models", auth: null, xkey: "k2", version: "2023-06-01" },
      ]);
    } finally {
      server.stop(true);
    }
  });

  test("reports an endpoint that refuses", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("bad key", { status: 401 }) });
    try {
      await expect(discoverModels(`http://127.0.0.1:${server.port}/v1`)).rejects.toThrow("401 bad key");
    } finally {
      server.stop(true);
    }
  });
});

describe("several keys per provider", () => {
  test("an account saved before keys becomes one key named Default, with a stable id", () => {
    db.query("INSERT INTO settings (key, value) VALUES ('_providers', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      JSON.stringify({ groq: { id: "groq", name: "Groq", key: "gsk-old-123456789", added: 5 } }),
    );
    const [k] = providerKeys("groq");
    expect(k).toMatchObject({ name: "Default", key: "gsk-old-123456789", note: "", added: 5 });
    expect(providerKeys("groq")[0].id).toBe(k.id);
    expect(JSON.parse(db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = '_providers'").get()!.value).groq.key).toBeUndefined();
  });

  test("add, edit, order and remove keys; the dashboard only sees hints", () => {
    const work = addKey("groq", { name: " Work ", key: "gsk-work-abcdefgh", note: "company card" });
    const spare = addKey("groq", { key: "gsk-spare-abcdefgh" });
    expect(spare.name).toBe("Key 3");
    expect(work).toEqual({ id: work.id, name: "Work", note: "company card", hint: "gsk...efgh", added: expect.any(Number), status: null });
    expect(() => addKey("groq", { key: " " })).toThrow("paste the API key");

    // Editing without a key keeps it; a new key clears any failure mark.
    setKeyStatus("groq", work.id, { state: "credit", at: Date.now(), detail: "HTTP 402" });
    editKey("groq", work.id, { note: "ask first" });
    expect(providerKeys("groq").find((k) => k.id === work.id)).toMatchObject({ key: "gsk-work-abcdefgh", note: "ask first", status: { state: "credit" } });
    editKey("groq", work.id, { key: "gsk-work-new-12345" });
    expect(providerKeys("groq").find((k) => k.id === work.id)!.status).toBeUndefined();

    const ids = providerKeys("groq").map((k) => k.id);
    orderKeys("groq", [work.id, ids[0], spare.id]);
    expect(providerKeys("groq").map((k) => k.name)).toEqual(["Work", "Default", "Key 3"]);
    expect(connectedProviders().find((p) => p.id === "groq")!.keys.map((k) => k.name)).toEqual(["Work", "Default", "Key 3"]);
    expect(JSON.stringify(connectedProviders())).not.toContain("gsk-work-new-12345");

    removeKey("groq", spare.id);
    expect(providerKeys("groq").length).toBe(2);
  });

  test("each run gets its own key for its provider, the default otherwise", () => {
    const [first, second] = providerKeys("groq");
    expect(keyIn(agentCredentials(), "groq")).toBe(first.key);
    expect(keyIn(agentCredentials(undefined, { key_id: second.id }), "groq")).toBe(second.key);
    // A key from another provider (the run changed model) falls back to the default.
    expect(keyIn(agentCredentials(undefined, { key_id: "k_elsewhere" }), "groq")).toBe(first.key);
    expect(keyFor({ key_id: second.id }, "groq")!.id).toBe(second.id);
    expect(findKey(second.id)!.provider).toBe("groq");
  });

  test("a run with no key gets nothing for its model's provider, other providers keep theirs", () => {
    saveSettings({ agentEnv: { GROQ_API_KEY: "gsk-env", OTHER: "x" } });
    const run = { key_id: NO_KEY, model: "groq/llama-3.3-70b" };
    const c = agentCredentials(undefined, run);
    expect(keyIn(c, "groq")).toBeUndefined();
    // Every other provider keeps its key.
    const keyed = (x: typeof c) => Object.entries(cfgOf(x).providers ?? {}).filter(([, p]: [string, any]) => p.settings?.apiKey).map(([id]) => id);
    expect(keyed(c)).toEqual(keyed(agentCredentials()).filter((k) => k !== "groq"));
    expect(c.env.GROQ_API_KEY).toBeUndefined();
    expect(c.env.OTHER).toBe("x");
    expect(keyFor(run, "groq")).toBeNull();
    expect(keyFor({ key_id: NO_KEY, model: "anthropic/x" }, "groq")!.id).toBe(providerKeys("groq")[0].id);
    saveSettings({ agentEnv: {} });
  });

  test("failover order skips failing keys; rate-limit marks wear off", () => {
    const [a, b] = providerKeys("groq");
    expect(nextKey("groq", a.id)!.id).toBe(b.id);
    setKeyStatus("groq", b.id, { state: "rejected", at: Date.now(), detail: "401" });
    expect(nextKey("groq", a.id)).toBeNull();
    setKeyStatus("groq", b.id, { state: "ratelimit", at: Date.now() - RATELIMIT_MARK_MS - 1, detail: "429" });
    expect(nextKey("groq", a.id)!.id).toBe(b.id);
    setKeyStatus("groq", b.id, null);
  });

  test("which errors are the key's fault", () => {
    expect(classifyKeyError(401, "")).toBe("rejected");
    expect(classifyKeyError(null, "Invalid API key provided")).toBe("rejected");
    expect(classifyKeyError(402, "")).toBe("credit");
    expect(classifyKeyError(429, "You exceeded your current quota, please check your plan and billing")).toBe("credit");
    expect(classifyKeyError(429, "Rate limit reached for requests")).toBe("ratelimit");
    expect(classifyKeyError(null, "Too Many Requests")).toBe("ratelimit");
    expect(classifyKeyError(500, "boom")).toBeNull();
    expect(classifyKeyError(529, "overloaded")).toBeNull();
  });

  test("testing a key marks it from the provider's answer", async () => {
    const server = Bun.serve({ port: 0, fetch: (req) => (req.headers.get("authorization") === "Bearer good-key-123456" ? Response.json({ data: [] }) : new Response("invalid api key", { status: 401 })) });
    try {
      await saveAccount({ id: "tk", baseURL: `http://127.0.0.1:${server.port}/v1`, key: "bad-key-1234567", custom: { models: ["m"] } });
      const good = addKey("tk", { name: "Good", key: "good-key-123456" });
      const [bad] = providerKeys("tk");
      expect(await testKey("tk", bad.id)).toMatchObject({ ok: false, status: 401 });
      expect(providerKeys("tk")[0].status).toMatchObject({ state: "rejected" });
      expect(await testKey("tk", good.id)).toMatchObject({ ok: true });
      await expect(testKey("groq", providerKeys("groq")[0].id)).rejects.toThrow("can't test the key directly");
    } finally {
      server.stop(true);
    }
  });
});

describe("variables, mixed APIs and how requests go out", () => {
  const cfg = (run?: Parameters<typeof agentCredentials>[1]) => JSON.parse(agentCredentials(getSettings(), run).env.OPENCODE_CONFIG_CONTENT ?? "{}");

  test("a catalogue provider's variables reach agents and fill its API address", async () => {
    saveSettings({ agentEnv: {}, agentAuthJson: "" });
    await saveAccount({ id: "snowflake-cortex", key: "pat-1234567890" });
    expect(connectedProviders().find((p) => p.id === "snowflake-cortex")?.missingVars).toEqual(["SNOWFLAKE_ACCOUNT"]);
    expect(accountBaseURL("snowflake-cortex")).toBeNull();

    // A pasted account URL is cut down to the identifier.
    await saveAccount({ id: "snowflake-cortex", vars: { SNOWFLAKE_ACCOUNT: "https://abc-xy123.snowflakecomputing.com/", EXTRA_TOKEN: "tok-abcdefghijk" } });
    const c = agentCredentials();
    expect(c.env).toMatchObject({ SNOWFLAKE_ACCOUNT: "abc-xy123", EXTRA_TOKEN: "tok-abcdefghijk" });
    expect(cfg().providers["snowflake-cortex"].settings.baseURL).toBe("https://abc-xy123.snowflakecomputing.com/api/v2/cortex/v1");
    expect(accountBaseURL("snowflake-cortex")).toBe("https://abc-xy123.snowflakecomputing.com/api/v2/cortex/v1");
    const p = connectedProviders().find((x) => x.id === "snowflake-cortex")!;
    expect(p.missingVars).toEqual([]);
    expect(p.vars).toEqual([
      { name: "SNOWFLAKE_ACCOUNT", value: "abc-xy123", hint: null, secret: false },
      { name: "EXTRA_TOKEN", value: null, hint: "tok...hijk", secret: true },
    ]);

    // null keeps a stored secret, a name left out drops it; reserved names are refused.
    await saveAccount({ id: "snowflake-cortex", vars: { SNOWFLAKE_ACCOUNT: "abc-xy123", EXTRA_TOKEN: null } });
    expect(agentCredentials().env.EXTRA_TOKEN).toBe("tok-abcdefghijk");
    await saveAccount({ id: "snowflake-cortex", vars: { SNOWFLAKE_ACCOUNT: "abc-xy123" } });
    expect(agentCredentials().env.EXTRA_TOKEN).toBeUndefined();
    await expect(saveAccount({ id: "snowflake-cortex", vars: { PATH: "/x" } })).rejects.toThrow("set by Pixel");
    await expect(saveAccount({ id: "snowflake-cortex", vars: { "1BAD": "x" } })).rejects.toThrow("letters, digits");
    removeAccount("snowflake-cortex");
  });

  test("an endpoint serving models on both APIs, with Bearer auth and max_completion_tokens", async () => {
    saveSettings({ providerOverrides: { cx: { headers: { "X-Extra": "1" } } } });
    await saveAccount({
      id: "cx",
      name: "Cortex",
      baseURL: "https://${ACCT}.example.com/v1",
      vars: { ACCT: "a1" },
      key: "pat-abcdefghijkl",
      bearer: true,
      maxCompletionTokens: true,
      custom: { api: "openai", models: ["claude-x", "gpt-z"], context: 100000, modelApi: { "claude-x": "anthropic", "gpt-z": "openai", "not-listed": "anthropic" } },
    });
    expect(connectedProviders().find((p) => p.id === "cx")?.custom?.modelApi).toEqual({ "claude-x": "anthropic" });
    const p = cfg().providers.cx;
    expect(p).toMatchObject({
      package: "aisdk:@ai-sdk/openai-compatible",
      settings: { baseURL: "https://a1.example.com/v1", apiKey: "pat-abcdefghijkl" },
      headers: { Authorization: "Bearer pat-abcdefghijkl", "X-Extra": "1" },
      compatibility: { maxTokensField: "max_completion_tokens" },
    });
    // A model the catalogue knows takes its name and limits; the other gets the endpoint's.
    expect(p.models["claude-x"]).toMatchObject({ name: "Claude X", package: "aisdk:@ai-sdk/anthropic", limit: { context: 200000, output: 64000 } });
    expect(p.models["gpt-z"]).toMatchObject({ name: "gpt-z", limit: { context: 100000, output: 25000 } });
    expect(p.models["gpt-z"].package).toBeUndefined();

    // The header carries the run's own key, and nothing for a run set to go without one.
    const second = addKey("cx", { name: "Second", key: "pat-second-12345" });
    expect(cfg({ key_id: second.id, model: "cx/claude-x" }).providers.cx.headers.Authorization).toBe("Bearer pat-second-12345");
    expect(cfg({ key_id: NO_KEY, model: "cx/claude-x" }).providers.cx.headers).toEqual({ "X-Extra": "1" });
    expect(cfg({ key_id: NO_KEY, model: "cx/claude-x" }).providers.cx.settings.apiKey).toBeUndefined();
    saveSettings({ providerOverrides: {} });
    removeAccount("cx");
  });

  test("discovery fills variables in the base URL and sends the key as Bearer when asked", async () => {
    const seen: Record<string, string | null>[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization"), xkey: req.headers.get("x-api-key"), version: req.headers.get("anthropic-version") });
        return Response.json({ data: [{ id: "m" }] });
      },
    });
    try {
      const base = `http://127.0.0.1:${server.port}/\${SEG}`;
      await expect(discoverModels(base, "k", undefined, "anthropic", {})).rejects.toThrow("Set SEG first");
      expect(await discoverModels(base, "k", undefined, "anthropic", { SEG: "v1" }, true)).toEqual({ models: ["m"] });
      expect(seen).toEqual([{ path: "/v1/models", auth: "Bearer k", xkey: null, version: "2023-06-01" }]);
    } finally {
      server.stop(true);
    }
  });
});
