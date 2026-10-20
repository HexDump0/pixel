import { beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { getSettings, saveSettings } from "../src/settings.ts";
import { catalogProviders } from "../src/catalog.ts";
import { agentCredentials, removeAccount, saveAccount } from "../src/providerAccounts.ts";
import { effective, opencodeModel, overriddenContext, validateModelOverrides, validateProviderOverrides } from "../src/modelOverrides.ts";

beforeAll(async () => {
  writeFileSync(
    join(config.dataDir, "models.json"),
    // Same catalogue as providerAccounts.test.ts (the catalogue is cached for the whole test process).
    JSON.stringify({
      anthropic: { id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"], npm: "@ai-sdk/anthropic", models: { "claude-x": { id: "claude-x", name: "Claude X", tool_call: true, limit: { context: 200000, output: 64000 }, cost: { input: 3, output: 15, cache_read: 0.3 } } } },
      groq: { id: "groq", name: "Groq", env: ["GROQ_API_KEY"], models: { "llama-y": { id: "llama-y", name: "Llama Y", tool_call: false } } },
      opencode: { id: "opencode", name: "OpenCode Zen", env: ["OPENCODE_API_KEY"], models: {} },
      coralbricks: { id: "coralbricks", name: "CoralBricks", env: ["CORAL_API_KEY"], npm: "@ai-sdk/openai-compatible", api: "https://inference.coralbricks.ai/v1", models: {} },
      "snowflake-cortex": { id: "snowflake-cortex", name: "Snowflake Cortex", env: ["SNOWFLAKE_ACCOUNT", "SNOWFLAKE_CORTEX_PAT"], npm: "@ai-sdk/openai-compatible", api: "https://${SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/api/v2/cortex/v1", models: {} },
    }),
  );
  await catalogProviders();
});

describe("model overrides", () => {
  test("fill the other half of limit and cost from the catalogue", () => {
    expect(opencodeModel("anthropic/claude-x", { context: 100000 })).toEqual({ limit: { context: 100000, output: 64000 } });
    expect(opencodeModel("anthropic/claude-x", { cost: { output: 10 } })).toEqual({ cost: { input: 3, output: 10, cache_read: 0.3 } });
    expect(opencodeModel("anthropic/unknown", { context: 64000 })).toEqual({ limit: { context: 64000, output: 16000 } });
  });

  test("go into opencode's config with provider timeouts, and Pixel's numbers follow", async () => {
    await saveAccount({ id: "anthropic", key: "sk-ant-secret-1234" });
    saveSettings({
      modelOverrides: { "anthropic/claude-x": { context: 150000, reasoning: false, options: { temperature: 0.2 }, headers: { "X-Test": "1" } } },
      providerOverrides: { anthropic: { timeout: 0, chunkTimeout: 600000 } },
    });
    const cfg = JSON.parse(agentCredentials().env.OPENCODE_CONFIG_CONTENT);
    expect(cfg.provider.anthropic.options).toEqual({ timeout: false, chunkTimeout: 600000 });
    expect(cfg.provider.anthropic.models["claude-x"]).toEqual({ limit: { context: 150000, output: 64000 }, reasoning: false, options: { temperature: 0.2 }, headers: { "X-Test": "1" } });
    expect(effective("anthropic/claude-x", getSettings())).toMatchObject({ context: 150000, costIn: 3, overridden: true });
    expect(overriddenContext("anthropic/claude-x")).toBe(150000);
    saveSettings({ modelOverrides: {}, providerOverrides: {} });
    removeAccount("anthropic");
  });

  test("bad values are refused", () => {
    expect(() => validateModelOverrides({ "no-slash": {} })).toThrow();
    expect(() => validateModelOverrides({ "a/b": { context: -1 } })).toThrow();
    expect(() => validateModelOverrides({ "a/b": { options: [] } })).toThrow();
    expect(() => validateModelOverrides({ "a/b": { headers: { "bad header": "x" } } })).toThrow();
    expect(() => validateProviderOverrides({ a: { timeout: "soon" } })).toThrow();
    expect(() => validateModelOverrides({ "a/b": { context: 8000, cost: { input: 0 }, tool_call: true } })).not.toThrow();
  });
});
