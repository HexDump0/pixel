/**
 * opencode plugin: send OpenAI's `prompt_cache_key` (the session id) to the providers listed in
 * PIXEL_CACHE_KEY_PROVIDERS (comma-separated provider ids), so a session's repeated prompt prefix
 * is routed to the same cache.
 *
 * opencode only adds a cache key by itself for OpenAI, xAI, Mistral, DeepInfra, Cerebras and its own
 * gateways. Its `setCacheKey` option for other OpenAI-compatible providers sends the field as
 * `promptCacheKey`, which OpenAI-style servers ignore (checked on opencode 1.18.23).
 *
 * Only the plugin itself is exported: opencode calls every exported function in a plugin file as a plugin.
 * Install: copy this file to ~/.config/opencode/plugin/ and set PIXEL_CACHE_KEY_PROVIDERS.
 */
export const PromptCacheKey = async () => {
  const providers = new Set((process.env.PIXEL_CACHE_KEY_PROVIDERS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  return {
    "chat.params": async (input: { sessionID: string; model: { providerID: string } }, output: { options?: Record<string, unknown> }) => {
      if (!providers.has(input.model.providerID)) return;
      output.options = { ...output.options, prompt_cache_key: input.sessionID };
    },
  };
};
