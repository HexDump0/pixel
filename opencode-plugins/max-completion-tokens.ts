/**
 * opencode plugin: for the providers listed in PIXEL_MAX_COMPLETION_TOKENS (comma-separated provider
 * ids), send the output limit as `max_completion_tokens` instead of `max_tokens` on OpenAI-style
 * chat calls. Newer OpenAI models refuse `max_tokens` ("Use 'max_completion_tokens' instead"), and
 * gateways in front of them (Snowflake Cortex, some proxies) pass that refusal on.
 *
 * Anthropic-style calls are left alone: their API requires `max_tokens`.
 * Same trick as opencode's own Cerebras plugin (checked on opencode 1.19.0).
 * Only the plugin itself is exported: opencode calls every exported function in a plugin file as a plugin.
 */
export const MaxCompletionTokens = async () => {
  const providers = new Set((process.env.PIXEL_MAX_COMPLETION_TOKENS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  return {
    "chat.params": async (
      input: { model: { providerID: string; api?: { npm?: string } } },
      output: { maxOutputTokens?: number; options?: Record<string, unknown> },
    ) => {
      if (!providers.has(input.model.providerID)) return;
      if (input.model.api?.npm?.includes("anthropic")) return;
      if (output.maxOutputTokens === undefined) return;
      output.options = { ...output.options, max_completion_tokens: output.maxOutputTokens };
      output.maxOutputTokens = undefined;
    },
  };
};
