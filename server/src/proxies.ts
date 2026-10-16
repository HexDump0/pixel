/**
 * Proxies for runs' model calls (HTTP or HTTPS proxies; Bun's fetch has no SOCKS). Stored like the
 * provider accounts, with their credentials kept in Pixel: agents only ever see the relay (relay.ts).
 * A test asks ipinfo.io for the exit IP and location, and checks the providers' APIs answer through it.
 */
import { db } from "./db.ts";

export interface ProxyTest {
  at: number;
  ok: boolean;
  /** Time to the exit-IP answer through the proxy. */
  ms: number | null;
  ip?: string;
  city?: string;
  region?: string;
  country?: string;
  org?: string;
  error?: string;
  /** Provider APIs tried through the proxy: any HTTP answer means they're reachable. */
  reach?: { host: string; ms: number | null; status: number | null; error?: string }[];
}

export interface ProxyAccount {
  id: string;
  name: string;
  /** http(s)://user:password@host:port */
  url: string;
  note: string;
  added: number;
  test?: ProxyTest;
}

const KEY = "_proxies";
const newId = () => `px_${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString("hex")}`;

function load(): Record<string, ProxyAccount> {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(KEY);
  try {
    return row ? JSON.parse(row.value) : {};
  } catch {
    return {};
  }
}
function store(all: Record<string, ProxyAccount>) {
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(all));
}

/** A proxy URL Bun can use, or an error that says what's wrong with it. */
export function parseProxyUrl(raw: string) {
  let u: URL;
  try {
    u = new URL(raw.trim().includes("://") ? raw.trim() : `http://${raw.trim()}`);
  } catch {
    throw new Error("proxy address must look like http://host:port");
  }
  if (u.protocol.startsWith("socks")) throw new Error("SOCKS proxies aren't supported yet; use an HTTP or HTTPS proxy");
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("proxy address must start with http:// or https://");
  if (!u.hostname) throw new Error("proxy address needs a host");
  if (u.pathname !== "/" || u.search || u.hash) throw new Error("proxy address is just scheme, host and port, like http://host:8080");
  return u;
}

/** What the dashboard sees: never the password. */
export function publicProxy(p: ProxyAccount) {
  const u = new URL(p.url);
  return {
    id: p.id,
    name: p.name,
    note: p.note,
    added: p.added,
    scheme: u.protocol.replace(":", ""),
    host: u.hostname,
    port: u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80,
    user: decodeURIComponent(u.username) || null,
    hasPassword: !!u.password,
    test: p.test ?? null,
    use: usage(p.id),
  };
}
export type PublicProxy = ReturnType<typeof publicProxy>;

export const listProxies = () => Object.values(load()).sort((a, b) => a.added - b.added);
export const getProxy = (id: string) => load()[id] ?? null;
export const proxyUrl = (id: string) => load()[id]?.url ?? null;

export interface ProxyInput {
  name?: string;
  /** Address, with or without credentials. */
  url?: string;
  /** Override the address's user and password; an empty password on an edit keeps the stored one. */
  username?: string;
  password?: string;
  note?: string;
}

export function saveProxy(input: ProxyInput, id?: string): ProxyAccount {
  const all = load();
  const old = id ? all[id] : undefined;
  if (id && !old) throw new Error(`no proxy ${id}`);
  const u = input.url?.trim() ? parseProxyUrl(input.url) : old ? new URL(old.url) : null;
  if (!u) throw new Error("proxy address needed");
  const oldUrl = old ? new URL(old.url) : null;
  if (input.username !== undefined) u.username = encodeURIComponent(input.username.trim());
  if (input.password) u.password = encodeURIComponent(input.password);
  // Same host and user as before, no new password: keep the stored one.
  else if (oldUrl && !u.password && oldUrl.password && oldUrl.host === u.host && oldUrl.username === u.username) u.password = oldUrl.password;
  const name = input.name?.trim() || old?.name || u.hostname;
  const p: ProxyAccount = { id: old?.id ?? newId(), name, url: u.toString().replace(/\/$/, ""), note: input.note?.trim() ?? old?.note ?? "", added: old?.added ?? Date.now(), ...(old?.test && old.url === u.toString().replace(/\/$/, "") && { test: old.test }) };
  all[p.id] = p;
  store(all);
  return p;
}

export function removeProxy(id: string) {
  const all = load();
  if (!all[id]) throw new Error(`no proxy ${id}`);
  delete all[id];
  store(all);
  stats.delete(id);
}

// ---- use, as the relay sees it (since Pixel started) ----

const stats = new Map<string, { calls: number[]; failures: number[]; lastError: { at: number; message: string } | null; lastOk: number | null }>();
const HOUR = 3600_000;

export function recordUse(id: string, ok: boolean, error?: string) {
  let s = stats.get(id);
  if (!s) stats.set(id, (s = { calls: [], failures: [], lastError: null, lastOk: null }));
  const now = Date.now();
  s.calls.push(now);
  if (ok) s.lastOk = now;
  else {
    s.failures.push(now);
    s.lastError = { at: now, message: error ?? "failed" };
  }
  for (const xs of [s.calls, s.failures]) while (xs.length && xs[0] < now - HOUR) xs.shift();
}

function usage(id: string) {
  const s = stats.get(id);
  const since = Date.now() - HOUR;
  return { callsLastHour: s?.calls.filter((t) => t >= since).length ?? 0, failuresLastHour: s?.failures.filter((t) => t >= since).length ?? 0, lastError: s?.lastError ?? null, lastOk: s?.lastOk ?? null };
}

// ---- test ----

async function timed(url: string, proxy: string, timeoutMs: number) {
  const t = performance.now();
  const res = await fetch(url, { proxy, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
  return { res, ms: Math.round(performance.now() - t) };
}
const why = (e: any) => (e?.name === "TimeoutError" ? "timed out" : (e?.code && e.code !== e.message ? `${e.code}: ` : "") + (e?.message ?? String(e)));

/** Exit IP and location through the proxy, then whether each provider API answers (GET {base}/models). */
export async function testProxyUrl(url: string, bases: string[]): Promise<ProxyTest> {
  const proxy = url;
  const out: ProxyTest = { at: Date.now(), ok: false, ms: null };
  try {
    const { res, ms } = await timed("https://ipinfo.io/json", proxy, 15_000);
    out.ms = ms;
    if (!res.ok) throw new Error(`ipinfo.io answered HTTP ${res.status} through the proxy`);
    const j: any = await res.json();
    Object.assign(out, { ok: true, ip: j.ip, city: j.city, region: j.region, country: j.country, org: j.org });
  } catch (e: any) {
    out.error = why(e);
    return out;
  }
  out.reach = await Promise.all(
    [...new Set(bases)].slice(0, 5).map(async (base) => {
      const host = new URL(base).host;
      try {
        const { res, ms } = await timed(`${base.replace(/\/+$/, "")}/models`, proxy, 10_000);
        await res.body?.cancel().catch(() => {});
        return { host, ms, status: res.status };
      } catch (e: any) {
        return { host, ms: null, status: null, error: why(e) };
      }
    }),
  );
  return out;
}

export async function testProxy(id: string, bases: string[]) {
  const p = getProxy(id);
  if (!p) throw new Error(`no proxy ${id}`);
  const test = await testProxyUrl(p.url, bases);
  const all = load();
  if (all[id]) {
    all[id].test = test;
    store(all);
  }
  return test;
}
