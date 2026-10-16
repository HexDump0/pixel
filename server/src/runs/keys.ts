/**
 * API key failover. A model call that fails because of the key (rejected, out of credit, or rate
 * limited for longer than RATELIMIT_FAILOVER_MS) marks the key, and a run with failover on moves to
 * the provider's next key that isn't marked: its opencode restarts with the new key and gets
 * "continue". With failover off, or no key left, the run pauses and says why.
 *
 * Runs in the run's serial queue, so it never overlaps idle handling (which would otherwise send
 * "continue" to an agent still on the dead key) or the watchdog's recovery.
 */
import { getRun, type RunRow } from "../db.ts";
import { getSettings } from "../settings.ts";
import { keyFailing, keyFor, NO_KEY, providerKeys, setKeyStatus, type ApiKey, type KeyState } from "../providerAccounts.ts";
import { clientFor, notifyRun, restartOpencode, setRun, setStatus, timeline } from "./state.ts";
import { getWatcher, serial, syncTranscript } from "./events.ts";
import { sendPrompt } from "./lifecycle.ts";
import { getProxy } from "../proxies.ts";

/** opencode retries 429s by itself; only a limit that outlasts this moves the run to another key. */
export const RATELIMIT_FAILOVER_MS = 10 * 60_000;
/** After a switch, errors still arriving from calls made with the old key are ignored this long. */
const SETTLE_MS = 30_000;

const STATE_TEXT: Record<KeyState, string> = { rejected: "was rejected", credit: "is out of credit", ratelimit: "has been rate limited for 10 minutes" };

/** Is this error the key's fault, and how? Network errors and overloaded servers aren't. */
export function classifyKeyError(status: number | null | undefined, message: string): KeyState | null {
  const m = message.toLowerCase();
  if (status === 401 || status === 403 || /invalid.{0,12}(api.?)?key|unauthori[sz]ed|incorrect api key|authentication|providerautherror|api key not valid|permission denied/.test(m)) return "rejected";
  if (status === 402 || /insufficient|balance|credit|billing|payment required|exceeded your current quota|quota exceeded|out of quota/.test(m)) return "credit";
  if (status === 429 || /rate.?limit|too many requests/.test(m)) return "ratelimit";
  return null;
}

const rateLimitedSince = new Map<string, number>();
const busy = new Set<string>();
const switchedAt = new Map<string, number>();

/** The key the run is on for its model's provider, when that provider's keys are managed here. */
function currentKey(run: RunRow): { provider: string; key: ApiKey } | null {
  const provider = run.model.split("/")[0];
  const key = keyFor(run, provider);
  return key ? { provider, key } : null;
}

/** A failed model call or session error from the run's opencode. */
export function onCallError(runId: string, error: any) {
  if (!error || error.name === "MessageAbortedError") return;
  const d = error.data ?? {};
  const state = classifyKeyError(d.statusCode, `${error.name ?? ""} ${d.message ?? ""} ${d.responseBody ?? ""}`);
  if (!state) return;
  if (state === "ratelimit") return onRateLimit(runId, `${d.statusCode ? `HTTP ${d.statusCode}: ` : ""}${d.message ?? "rate limited"}`);
  keyFailed(runId, state, `${d.statusCode ? `HTTP ${d.statusCode}: ` : ""}${String(d.message ?? error.name).slice(0, 200)}`);
}

/** opencode is retrying a call (session.status "retry"). */
export function onRetry(runId: string, status: any) {
  const msg = String(status?.message ?? "");
  if (classifyKeyError(null, msg) === "ratelimit") onRateLimit(runId, msg.slice(0, 200));
}

function onRateLimit(runId: string, detail: string) {
  const now = Date.now();
  const since = rateLimitedSince.get(runId) ?? now;
  rateLimitedSince.set(runId, since);
  if (now - since >= RATELIMIT_FAILOVER_MS) keyFailed(runId, "ratelimit", detail);
}

/** A model call finished fine: the key works, so any mark on it goes and the rate-limit clock resets. */
export function onCallOk(runId: string, info: any) {
  if (info?.role !== "assistant" || !info.time?.completed || info.error) return;
  rateLimitedSince.delete(runId);
  const run = getRun(runId);
  const k = run && info.providerID ? keyFor(run, info.providerID) : null;
  if (k?.status) setKeyStatus(info.providerID, k.id, null);
}

function keyFailed(runId: string, state: KeyState, detail: string) {
  const run = getRun(runId);
  if (!run || !["running", "recovering"].includes(run.status)) return;
  if (busy.has(runId) || Date.now() - (switchedAt.get(runId) ?? 0) < SETTLE_MS) return;
  const cur = currentKey(run);
  if (!cur) return; // a key from Settings (env, auth.json): nothing to switch between
  setKeyStatus(cur.provider, cur.key.id, { state, at: Date.now(), detail });
  rateLimitedSince.delete(runId);
  busy.add(runId);
  const task = () => switchKey(runId, cur.provider, cur.key, state, detail).finally(() => busy.delete(runId));
  const w = getWatcher(runId);
  if (w) void serial(w, task);
  else void task();
}

/** The next key after `from` in the provider's order that isn't marked as failing. */
export function nextKey(provider: string, from: string): ApiKey | null {
  const keys = providerKeys(provider);
  const i = keys.findIndex((k) => k.id === from);
  for (let n = 1; n < keys.length; n++) {
    const k = keys[(i + n) % keys.length];
    if (k.key && !keyFailing(k)) return k;
  }
  return null;
}

async function switchKey(runId: string, provider: string, failed: ApiKey, state: KeyState, detail: string) {
  let run = getRun(runId);
  if (!run || !["running", "recovering"].includes(run.status)) return;
  const what = `Key ${failed.name} ${STATE_TEXT[state]} (${detail})`;
  const next = run.key_failover ? nextKey(provider, failed.id) : null;
  if (!next) {
    const why = run.key_failover ? `${what}, and no other ${provider} key is working` : `${what}; failover is off for this run`;
    run = setStatus(runId, "paused", `${why}. Fix or change the key, then resume.`)!;
    timeline(runId, "pixel", "key", `${why}. Paused the run.`);
    notifyRun("stopped", run, "Run paused: API key", why);
    if (run.session_id) await clientFor(run).abort(run.session_id).catch(() => {});
    return;
  }
  switchedAt.set(runId, Date.now());
  setRun(runId, { key_id: next.id });
  run = setStatus(runId, "recovering", `Switching to key ${next.name}`)!;
  timeline(runId, "pixel", "key", `${what}. Switched to key ${next.name} and restarting the agent.`);
  notifyRun("stopped", run, "Run switched API key", `${what}. Now on ${next.name}.`);
  try {
    await restartOpencode(run);
    await clientFor(run).waitHealthy(180_000);
    run = setStatus(runId, "running", null)!;
    await syncTranscript(runId);
    const msg = getSettings().continueMessage;
    timeline(runId, "pixel", "continue", `Back on key ${next.name}; sending "${msg}"`);
    await sendPrompt(run, msg);
  } catch (e: any) {
    const r = setStatus(runId, "paused", `Switching to key ${next.name} failed: ${e.message}`)!;
    timeline(runId, "pixel", "key", `Switching to key ${next.name} failed: ${e.message}. Paused the run.`);
    notifyRun("stopped", r, "Run paused: API key", `Switching to key ${next.name} failed: ${e.message}`);
  }
}

/**
 * Put a run on another key (from the dashboard). An idle or stopped agent's opencode restarts with
 * it right away; a busy one picks it up the next time it goes idle or is resumed.
 */
export async function chooseKey(runId: string, keyId: string | null) {
  const run = getRun(runId);
  if (!run) throw new Error(`no run ${runId}`);
  const provider = run.model.split("/")[0];
  const noKey = keyId === NO_KEY;
  const key = keyId && !noKey ? providerKeys(provider).find((k) => k.id === keyId) : null;
  if (keyId && !noKey && !key) throw new Error(`key ${keyId} does not belong to ${provider}`);
  const next = noKey ? NO_KEY : (key?.id ?? null);
  if ((run.key_id ?? null) === next) return;
  setRun(runId, { key_id: next });
  const name = noKey ? "no key" : ((key ?? keyFor(null, provider))?.name ?? "default");
  const live = ["running", "recovering"].includes(run.status) && run.endpoint;
  const idle = live && run.agent_status === "idle";
  timeline(runId, "user", "key", `Key changed to ${name}${live && !idle ? "; the agent picks it up when it next goes idle or is resumed" : ""}`);
  if (!idle) return;
  const task = async () => {
    const r = getRun(runId)!;
    await restartOpencode(r);
    await clientFor(r).waitHealthy(180_000);
  };
  const w = getWatcher(runId);
  await (w ? serial(w, task) : task());
}

/**
 * Send a run's model calls through another proxy, or none. Between two proxies it applies from the next
 * call (the relay looks the proxy up each time). Turning the proxy on or off changes where opencode
 * sends its calls, so an idle agent's opencode restarts now and a busy one's when it next goes idle.
 */
export async function chooseProxy(runId: string, proxyId: string | null) {
  const run = getRun(runId);
  if (!run) throw new Error(`no run ${runId}`);
  const proxy = proxyId ? getProxy(proxyId) : null;
  if (proxyId && !proxy) throw new Error(`no proxy ${proxyId}`);
  if ((run.proxy_id ?? null) === (proxy?.id ?? null)) return;
  setRun(runId, { proxy_id: proxy?.id ?? null });
  const live = ["running", "recovering"].includes(run.status) && run.endpoint;
  const idle = live && run.agent_status === "idle";
  const restart = !run.proxy_id !== !proxy;
  const what = proxy ? `Model calls now go through proxy ${proxy.name}` : "Model calls now go straight to the provider";
  timeline(runId, "user", "proxy", `${what}${restart && live && !idle ? "; the agent picks it up when it next goes idle or is resumed" : ""}`);
  if (!restart || !idle) return;
  const task = async () => {
    const r = getRun(runId)!;
    await restartOpencode(r);
    await clientFor(r).waitHealthy(180_000);
  };
  const w = getWatcher(runId);
  await (w ? serial(w, task) : task());
}

export function setFailover(runId: string, on: boolean) {
  const run = getRun(runId);
  if (!run) throw new Error(`no run ${runId}`);
  setRun(runId, { key_failover: on ? 1 : 0 });
  timeline(runId, "user", "key", `Key failover ${on ? "on" : "off"}`);
}
