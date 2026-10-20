/**
 * Provider entries for opencode 2's config. Pixel builds them in opencode 1's shape (npm, options,
 * models with tool_call/reasoning/limit/cost, variants as an object), which is what the Models page
 * settings map onto; this turns them into opencode 2's native shape (package, settings, headers,
 * body, compatibility, capabilities, variants as a list).
 *
 * Written natively rather than left to opencode's own V1 reading because that drops the model flags
 * Pixel sets (reasoning, temperature, attachment), and because the key, prompt cache key and
 * max_completion_tokens switches only exist in the native shape.
 */

/** Model options opencode 2 reads as settings on OpenAI-compatible models; the rest go in the request body (as opencode 1 sent them). */
const COMPATIBLE_SETTINGS = new Set(["apiKey", "baseURL", "headers", "body", "extraBody", "timeout", "chunkTimeout", "headerTimeout", "disabled", "reasoningEffort", "textVerbosity", "user", "strictJsonSchema"]);
const COMPATIBLE_NPM = "@ai-sdk/openai-compatible";

const nonEmpty = <T extends Record<string, unknown>>(o: T | undefined) => (o && Object.keys(o).length ? o : undefined);
const pkg = (npm: string) => (npm.startsWith("@opencode/ai/") ? npm : `aisdk:${npm}`);

/** Options split into settings and request body the way opencode 2 wants them for this package. */
function split(options: Record<string, unknown> | undefined, compatible: boolean) {
  if (!options) return {};
  const settings: Record<string, unknown> = {};
  const body: Record<string, unknown> = {};
  let headers: Record<string, string> | undefined;
  for (const [k, v] of Object.entries(options)) {
    if (k === "headers" && v && typeof v === "object") headers = v as Record<string, string>;
    else if (k === "body" && v && typeof v === "object") Object.assign(body, v);
    else if (!compatible || COMPATIBLE_SETTINGS.has(k)) settings[k] = v;
    else body[k] = v;
  }
  return { settings: nonEmpty(settings), body: nonEmpty(body), headers: nonEmpty(headers) };
}

export interface ProviderExtras {
  apiKey?: string;
  /** Send `prompt_cache_key` (the session id). */
  cacheKey?: boolean;
  /** Send the output limit as max_completion_tokens. */
  maxCompletionTokens?: boolean;
}

/** One model entry in opencode 2's shape. */
export function nativeModel(m: Record<string, any>, providerNpm?: string) {
  const npm = m.provider?.npm ?? providerNpm;
  const { settings, body, headers } = split(m.options, npm === COMPATIBLE_NPM);
  const capabilities = nonEmpty({
    ...(m.tool_call !== undefined && { tools: !!m.tool_call }),
    ...(m.attachment !== undefined && { input: m.attachment ? ["text", "image", "pdf"] : ["text"] }),
    ...(m.temperature !== undefined && { temperature: !!m.temperature }),
    // "Models can think": opencode offers these thinking levels for it.
    ...(m.reasoning !== undefined && { reasoning: m.reasoning ? { supported: true, effort: ["low", "medium", "high"] } : { supported: false } }),
  });
  const cost = m.cost && {
    input: m.cost.input ?? 0,
    output: m.cost.output ?? 0,
    ...((m.cost.cache_read !== undefined || m.cost.cache_write !== undefined) && { cache: { ...(m.cost.cache_read !== undefined && { read: m.cost.cache_read }), ...(m.cost.cache_write !== undefined && { write: m.cost.cache_write }) } }),
  };
  const variants =
    m.variants && typeof m.variants === "object"
      ? Object.entries(m.variants as Record<string, Record<string, unknown>>).map(([id, opts]) => ({ id, ...split(opts, npm === COMPATIBLE_NPM) }))
      : undefined;
  return {
    ...(m.name && { name: m.name }),
    ...(m.provider?.npm && { package: pkg(m.provider.npm) }),
    ...(settings && { settings }),
    ...((headers || m.headers) && { headers: { ...headers, ...m.headers } }),
    ...(body && { body }),
    ...(capabilities && { capabilities }),
    ...(m.limit && { limit: m.limit }),
    ...(cost && { cost }),
    ...(variants?.length && { variants }),
  };
}

/** One provider entry (opencode 1's shape, plus the key and switches) in opencode 2's shape. */
export function nativeProvider(p: Record<string, any>, extras: ProviderExtras = {}) {
  const options = { ...(p.options ?? {}) };
  const compatibility: Record<string, unknown> = {};
  if (options.setCacheKey !== undefined) compatibility.supportsPromptCacheKey = !!options.setCacheKey;
  delete options.setCacheKey;
  if (extras.cacheKey) compatibility.supportsPromptCacheKey = true;
  if (extras.maxCompletionTokens) compatibility.maxTokensField = "max_completion_tokens";
  if (extras.apiKey) options.apiKey = extras.apiKey;
  // Provider options are package settings (timeouts, baseURL, apiKey...), headers and body; nothing is guessed into the body here.
  const { settings, body, headers } = split(options, false);
  const models = p.models && Object.fromEntries(Object.entries(p.models as Record<string, any>).map(([id, m]) => [id, nativeModel(m, p.npm)]));
  return {
    ...(p.name && { name: p.name }),
    ...(p.npm && { package: pkg(p.npm) }),
    ...(settings && { settings }),
    ...(headers && { headers }),
    ...(body && { body }),
    ...(Object.keys(compatibility).length && { compatibility }),
    ...(models && Object.keys(models).length && { models }),
  };
}
