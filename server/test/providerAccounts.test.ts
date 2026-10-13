import { beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { getSettings, saveSettings } from "../src/settings.ts";
import { catalogProvider, catalogProviders } from "../src/catalog.ts";
import { saveGithub } from "../src/github.ts";
import { addKey, agentCredentials, connectedProviders, discoverModels, editKey, findKey, keyFor, orderKeys, providerKeys, RATELIMIT_MARK_MS, removeAccount, removeKey, saveAccount, setKeyStatus, testKey } from "../src/providerAccounts.ts";
import { classifyKeyError, nextKey } from "../src/runs/keys.ts";
import { db } from "../src/db.ts";

beforeAll(() => {
  // A tiny catalogue in place of models.dev (PIXEL_MODELS_URL is empty in tests, so nothing is downloaded).
  writeFileSync(
    join(config.dataDir, "models.json"),
    JSON.stringify({
      anthropic: { id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"], npm: "@ai-sdk/anthropic", models: { "claude-x": { id: "claude-x", name: "Claude X", tool_call: true, limit: { context: 200000, output: 64000 }, cost: { input: 3, output: 15 } } } },
      groq: { id: "groq", name: "Groq", env: ["GROQ_API_KEY"], models: { "llama-y": { id: "llama-y", name: "Llama Y", tool_call: false } } },
      opencode: { id: "opencode", name: "OpenCode Zen", env: ["OPENCODE_API_KEY"], models: {} },
      coralbricks: { id: "coralbricks", name: "CoralBricks", env: ["CORAL_API_KEY"], npm: "@ai-sdk/openai-compatible", api: "https://inference.coralbricks.ai/v1", models: {} },
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
  test("a catalogue provider's key goes into auth.json, merged with Settings", async () => {
    saveSettings({ agentAuthJson: JSON.stringify({ other: { type: "api", key: "o-1" } }), agentEnv: { GITHUB_TOKEN: "gh" } });
    await saveAccount({ id: "anthropic", key: "sk-ant-secret-1234" });
    const c = agentCredentials();
    expect(JSON.parse(c.authJson)).toEqual({ other: { type: "api", key: "o-1" }, anthropic: { type: "api", key: "sk-ant-secret-1234" } });
    expect(c.env).toEqual({ GITHUB_TOKEN: "gh" });

    // Editing without a key keeps the stored one.
    await saveAccount({ id: "anthropic", baseURL: "https://proxy.example.com/v1/" });
    const again = agentCredentials();
    expect(JSON.parse(again.authJson).anthropic.key).toBe("sk-ant-secret-1234");
    expect(JSON.parse(again.env.OPENCODE_CONFIG_CONTENT).provider.anthropic).toEqual({ options: { baseURL: "https://proxy.example.com/v1" } });
  });

  test("custom endpoints become opencode providers for both API types", async () => {
    saveSettings({ agentEnv: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ share: "disabled", provider: { keep: { options: {} } } }) } });
    await saveAccount({ id: "gw", name: "Gateway", baseURL: "https://gw.example.com/v1", key: "gw-key", custom: { api: "anthropic", models: ["m-a", " m-a ", "m-b"], context: 64000 } });
    await saveAccount({ id: "home", baseURL: "http://10.0.0.5:11434/v1", key: "", custom: { models: ["qwen"] } });
    const cfg = JSON.parse(agentCredentials().env.OPENCODE_CONFIG_CONTENT);
    expect(cfg.share).toBe("disabled");
    expect(cfg.provider.keep).toEqual({ options: {} });
    expect(cfg.provider.gw).toMatchObject({ npm: "@ai-sdk/anthropic", name: "Gateway", options: { baseURL: "https://gw.example.com/v1" } });
    expect(Object.keys(cfg.provider.gw.models)).toEqual(["m-a", "m-b"]);
    expect(cfg.provider.gw.models["m-a"].limit.context).toBe(64000);
    expect(cfg.provider.home).toMatchObject({ npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://10.0.0.5:11434/v1" } });
    expect(cfg.provider.home.models.qwen.limit.context).toBe(128000);
    // No key, no auth.json entry.
    expect(JSON.parse(agentCredentials().authJson).home).toBeUndefined();
  });

  test("Coral Bricks gets a prompt cache key through the plugin", async () => {
    await saveAccount({ id: "coralbricks", key: "cb-1" });
    expect(agentCredentials().env.PIXEL_CACHE_KEY_PROVIDERS).toBe("coralbricks");
    await saveAccount({ id: "coralbricks", cacheKey: false });
    expect(agentCredentials().env.PIXEL_CACHE_KEY_PROVIDERS).toBeUndefined();
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
    expect(by.anthropic.keyHint).toBe("sk-…1234");
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
    expect(work).toEqual({ id: work.id, name: "Work", note: "company card", hint: "gsk…efgh", added: expect.any(Number), status: null });
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
    expect(JSON.parse(agentCredentials().authJson).groq.key).toBe(first.key);
    expect(JSON.parse(agentCredentials(undefined, { key_id: second.id }).authJson).groq.key).toBe(second.key);
    // A key from another provider (the run changed model) falls back to the default.
    expect(JSON.parse(agentCredentials(undefined, { key_id: "k_elsewhere" }).authJson).groq.key).toBe(first.key);
    expect(keyFor({ key_id: second.id }, "groq")!.id).toBe(second.id);
    expect(findKey(second.id)!.provider).toBe("groq");
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
