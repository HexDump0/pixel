/**
 * The relay for proxied runs' model calls. A proxied run's opencode gets each provider's baseURL set to
 *   http://<relay>/<subject>/<signature>/<provider>
 * where the subject is the run ("r.<id>", whose current proxy is looked up on every call, so switching
 * proxies needs no restart) or one proxy ("p.<id>", the live test). The relay finds the real endpoint
 * from the model named in the request (opencode Zen and gateways use a different one per model family),
 * and forwards the call through the proxy. Only those endpoints: it is not an open proxy, and the
 * proxy's password never leaves Pixel. It listens on its own port because agents can't reach the
 * dashboard's.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";
import { cachedCatalog, catalogProviders } from "./catalog.ts";
import { getRun } from "./db.ts";
import { getSettings, getSecret } from "./settings.ts";
import { accountBaseURL } from "./providerAccounts.ts";
import { getProxy, recordUse } from "./proxies.ts";
import { fetchProxy } from "./socks.ts";

export const runSubject = (runId: string) => `r.${runId}`;
export const proxySubject = (proxyId: string) => `p.${proxyId}`;
const sign = (subject: string) => createHmac("sha256", getSecret()).update(`relay:${subject}`).digest("base64url").slice(0, 22);

export const relayBase = () => `http://${config.relay.host}:${config.relay.port}`;
export const relayUrl = (subject: string, provider: string) => `${relayBase()}/${encodeURIComponent(subject)}/${sign(subject)}/${encodeURIComponent(provider)}`;

/** The AI SDK packages' own default endpoints, for catalogue providers that don't name one. */
const SDK_BASE: Record<string, string> = {
  "@ai-sdk/anthropic": "https://api.anthropic.com/v1",
  "@ai-sdk/openai": "https://api.openai.com/v1",
  "@ai-sdk/google": "https://generativelanguage.googleapis.com/v1beta",
  "@ai-sdk/groq": "https://api.groq.com/openai/v1",
  "@ai-sdk/mistral": "https://api.mistral.ai/v1",
  "@ai-sdk/xai": "https://api.x.ai/v1",
  "@ai-sdk/cerebras": "https://api.cerebras.ai/v1",
  "@ai-sdk/togetherai": "https://api.together.xyz/v1",
  "@ai-sdk/deepinfra": "https://api.deepinfra.com/v1",
  "@ai-sdk/perplexity": "https://api.perplexity.ai",
};

/**
 * Where a provider's calls really go (for one model when given): your endpoint for it, the
 * catalogue's for that model or provider, or the SDK's default. Null when Pixel can't tell (cloud
 * providers with per-account addresses like Azure or Bedrock): those calls can't go through a proxy.
 */
export function upstreamBase(provider: string, model?: string | null): string | null {
  const p = cachedCatalog()?.get(provider);
  const m = model ? p?.models.find((x) => x.id === model) : undefined;
  const set = getSettings().providerOverrides?.[provider]?.options?.baseURL;
  const base = accountBaseURL(provider) ?? (typeof set === "string" && set ? set : null) ?? m?.api ?? p?.api ?? SDK_BASE[m?.npm ?? p?.npm ?? ""] ?? null;
  return base && !base.includes("${") ? base.replace(/\/+$/, "") : null;
}

const HOP = ["host", "connection", "keep-alive", "content-length", "transfer-encoding", "upgrade", "proxy-authorization", "proxy-connection", "te", "trailer"];
const fail = (status: number, message: string) => Response.json({ error: { type: "relay_error", message: `Pixel relay: ${message}` } }, { status });

/** The model a request is for: the body's "model" (OpenAI, Anthropic), or the path's (Google). */
function modelOf(body: ArrayBuffer | undefined, path: string) {
  if (body?.byteLength) {
    try {
      const m = JSON.parse(new TextDecoder().decode(body)).model;
      if (typeof m === "string") return m;
    } catch {}
  }
  return path.match(/\/models\/([^/:]+)/)?.[1] ?? null;
}

export async function handleRelay(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const [rawSubject, sig, rawProvider, ...rest] = url.pathname.slice(1).split("/");
  if (!rawSubject || !sig || !rawProvider) return fail(404, "not a relay address");
  const subject = decodeURIComponent(rawSubject);
  const want = Buffer.from(sign(subject));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return fail(403, "bad signature");
  const provider = decodeURIComponent(rawProvider);

  let proxyId: string | null;
  if (subject.startsWith("r.")) {
    const run = getRun(subject.slice(2));
    if (!run) return fail(404, `no run ${subject.slice(2)}`);
    proxyId = run.proxy_id;
  } else if (subject.startsWith("p.")) proxyId = subject.slice(2);
  else return fail(404, "not a relay address");
  const proxy = proxyId ? getProxy(proxyId) : null;
  // Fail closed: a run set to a proxy that no longer exists doesn't go out directly.
  if (proxyId && !proxy) return fail(502, `proxy ${proxyId} was removed; pick another for this run`);

  if (!cachedCatalog()) await catalogProviders();
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  const base = upstreamBase(provider, modelOf(body, `/${rest.join("/")}`));
  if (!base) return fail(502, `Pixel doesn't know where ${provider}'s API is, so it can't relay it`);
  const target = new URL(`${base}/${rest.join("/")}${url.search}`);
  if (target.origin !== new URL(base).origin) return fail(400, "path leaves the provider's API");

  const headers = new Headers(req.headers);
  for (const h of HOP) headers.delete(h);
  let res: Response;
  try {
    res = await fetch(target, { method: req.method, headers, body, redirect: "manual", signal: req.signal, ...(proxy && { proxy: await fetchProxy(proxy.url) }) });
  } catch (e: any) {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    const message = e?.name === "TimeoutError" ? "timed out" : `${e?.code && e.code !== e.message ? `${e.code}: ` : ""}${e?.message ?? e}`;
    if (proxy) recordUse(proxy.id, false, message);
    return fail(502, proxy ? `proxy ${proxy.name} failed reaching ${target.host}: ${message}` : `${target.host}: ${message}`);
  }
  if (proxy) recordUse(proxy.id, true);
  const out = new Headers(res.headers);
  // fetch already decompressed the body.
  for (const h of ["content-encoding", "content-length", "transfer-encoding", "connection"]) out.delete(h);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}

export function startRelay() {
  // `bun --hot` runs this again on every change: swap the handler instead of binding the port twice.
  const g = globalThis as { __pixelRelay?: ReturnType<typeof Bun.serve> };
  if (g.__pixelRelay) return void g.__pixelRelay.reload({ fetch: handleRelay });
  try {
    const server = (g.__pixelRelay = Bun.serve({ hostname: config.relay.bind, port: config.relay.port, idleTimeout: 255, fetch: handleRelay }));
    console.log(`Model-call relay for proxies on ${server.hostname}:${server.port}`);
  } catch (e: any) {
    console.error(`Relay for proxies not started (${config.relay.bind}:${config.relay.port}): ${e.message}. Proxied runs' model calls will fail.`);
  }
}
