import { expect, test } from "bun:test";
import { MaxCompletionTokens } from "../../opencode-plugins/max-completion-tokens.ts";

test("max_completion_tokens replaces max_tokens on OpenAI-style calls of the listed providers only", async () => {
  process.env.PIXEL_MAX_COMPLETION_TOKENS = "cortex, other";
  const hooks = await MaxCompletionTokens();
  const call = async (providerID: string, npm: string) => {
    const out: { maxOutputTokens?: number; options?: Record<string, unknown> } = { maxOutputTokens: 32000, options: { a: 1 } };
    await hooks["chat.params"]({ model: { providerID, api: { npm } } }, out);
    return out;
  };
  expect(await call("cortex", "@ai-sdk/openai-compatible")).toEqual({ maxOutputTokens: undefined, options: { a: 1, max_completion_tokens: 32000 } });
  // Anthropic's API requires max_tokens.
  expect(await call("cortex", "@ai-sdk/anthropic")).toEqual({ maxOutputTokens: 32000, options: { a: 1 } });
  expect(await call("groq", "@ai-sdk/openai-compatible")).toEqual({ maxOutputTokens: 32000, options: { a: 1 } });
  delete process.env.PIXEL_MAX_COMPLETION_TOKENS;
});
