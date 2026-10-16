/**
 * Proxies for runs' model calls: HTTP, HTTPS or SOCKS5 (through the bridge in socks.ts, since Bun's fetch has no SOCKS). Stored like the
 * provider accounts, with their credentials kept in Pixel: agents only ever see the relay (relay.ts).
 * A test asks ipinfo.io for the exit IP and location, and checks the providers' APIs answer through it.
 */
import { db } from "./db.ts";
import { detectProxyScheme, fetchProxy } from "./socks.ts";

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
  /** http(s)://user:password@host:port or socks5://… */
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

/**
 * host:port:user:password (how proxy sellers list them; user:password:host:port too) as a URL with the
 * credentials in it. Anything with :// or @ is already one.
 */
export function proxyLineToUrl(raw: string) {
  const s = raw.trim();
  if (s.includes("://") || s.includes("@")) return s;
  const p = s.split(":");
  const e = encodeURIComponent;
  if (p.length >= 4 && /^\d+$/.test(p[1])) return `http://${e(p[2])}:${e(p.slice(3).join(":"))}@${p[0]}:${p[1]}`;
  if (p.length === 4 && /^\d+$/.test(p[3])) return `http://${e(p[0])}:${e(p[1])}@${p[2]}:${p[3]}`;
  return s;
}

export const SCHEMES = ["http", "https", "socks5"] as const;
export type ProxyScheme = (typeof SCHEMES)[number];

/** A proxy URL, or an error that says what's wrong with it. No scheme means http (resolveProxyUrl detects it instead). */
export function parseProxyUrl(raw: string) {
  let u: URL;
  const s = proxyLineToUrl(raw).replace(/^socks5h:/i, "socks5:");
  try {
    u = new URL(s.includes("://") ? s : `http://${s}`);
  } catch {
    throw new Error("proxy address must look like host:port, host:port:user:password or http://host:port");
  }
  if (u.protocol.startsWith("socks") && u.protocol !== "socks5:") throw new Error("only SOCKS5 is supported, not SOCKS4");
  if (!SCHEMES.includes(u.protocol.replace(":", "") as ProxyScheme)) throw new Error("proxy address must start with http://, https:// or socks5://");
  if (!u.hostname) throw new Error("proxy address needs a host");
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) throw new Error("proxy address is just scheme, host and port, like http://host:8080");
  return u;
}

/** `u` with another scheme (the URL setter can't switch between http and socks5). */
export function withScheme(u: URL, scheme: ProxyScheme) {
  const auth = u.username ? `${u.username}${u.password ? `:${u.password}` : ""}@` : "";
  return new URL(`${scheme}://${auth}${u.host}`);
}

const explicitScheme = (raw: string) => /^\w+:\/\//.test(raw.trim());

/**
 * parseProxyUrl, with the scheme chosen: `scheme` if given, else the one in the address, else whatever the
 * proxy turns out to speak (http when nothing answers, so a proxy that's down can still be saved and tested later).
 */
export async function resolveProxyUrl(raw: string, scheme?: ProxyScheme | "auto") {
  const u = parseProxyUrl(raw);
  if (scheme && scheme !== "auto") return withScheme(u, scheme);
  if (explicitScheme(raw)) return u;
  const found = await detectProxyScheme(u.hostname, Number(u.port) || 80);
  return found ? withScheme(u, found) : u;
}

const clean = (u: URL) => u.toString().replace(/\/$/, "");

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
    port: u.port ? Number(u.port) : u.protocol === "https:" ? 443 : u.protocol === "socks5:" ? 1080 : 80,
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
  /** What the proxy speaks; "auto" (or none) = the address's scheme, else detected. */
  scheme?: ProxyScheme | "auto";
  /** Override the address's user and password; an empty password on an edit keeps the stored one. */
  username?: string;
  password?: string;
  note?: string;
}

export async function saveProxy(input: ProxyInput, id?: string): Promise<ProxyAccount> {
  if (id && !load()[id]) throw new Error(`no proxy ${id}`);
  let u = input.url?.trim() ? await resolveProxyUrl(input.url, input.scheme) : id ? new URL(load()[id].url) : null;
  if (!u) throw new Error("proxy address needed");
  if (!input.url?.trim() && input.scheme && input.scheme !== "auto") u = withScheme(u, input.scheme);
  // Loaded after the detection above, which can take seconds: another save may have happened meanwhile.
  const all = load();
  const old = id ? all[id] : undefined;
  if (id && !old) throw new Error(`no proxy ${id}`);
  const oldUrl = old ? new URL(old.url) : null;
  // An empty username field doesn't wipe one given in the address.
  if (input.username !== undefined && (input.username.trim() || !input.url?.trim() || !u.username)) u.username = encodeURIComponent(input.username.trim());
  if (input.password) u.password = encodeURIComponent(input.password);
  // Same host and user as before, no new password: keep the stored one.
  else if (oldUrl && !u.password && oldUrl.password && oldUrl.host === u.host && oldUrl.username === u.username) u.password = oldUrl.password;
  const name = input.name?.trim() || old?.name || u.hostname;
  const p: ProxyAccount = { id: old?.id ?? newId(), name, url: clean(u), note: input.note?.trim() ?? old?.note ?? "", added: old?.added ?? Date.now(), ...(old?.test && old.url === clean(u) && { test: old.test }) };
  all[p.id] = p;
  store(all);
  return p;
}

/** Proxies pasted one per line (any form parseProxyUrl takes; blank lines and # comments skipped). Ones already stored are skipped. */
export async function importProxies(text: string, scheme: ProxyScheme | "auto" = "auto") {
  const key = (u: URL) => `${u.username}@${u.host}`;
  const known = new Set(listProxies().map((p) => key(new URL(p.url))));
  const names = new Set(listProxies().map((p) => p.name));
  const skipped: { line: number; reason: string }[] = [];
  const todo: { line: number; raw: string }[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    try {
      const u = parseProxyUrl(line);
      if (known.has(key(u))) return skipped.push({ line: i + 1, reason: `${u.host} is already there` });
      known.add(key(u));
      todo.push({ line: i + 1, raw: line });
    } catch (e: any) {
      skipped.push({ line: i + 1, reason: e.message });
    }
  });
  // Detect a few at a time; a dead proxy takes a few seconds per probe.
  const resolved: (URL | null)[] = new Array(todo.length).fill(null);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, todo.length) }, async () => {
      while (next < todo.length) {
        const i = next++;
        resolved[i] = await resolveProxyUrl(todo[i].raw, scheme);
      }
    }),
  );
  const added: ProxyAccount[] = [];
  for (const u of resolved) {
    const name = names.has(u!.hostname) ? u!.host : u!.hostname;
    names.add(name);
    added.push(await saveProxy({ url: clean(u!), name }));
  }
  return { added, skipped: skipped.sort((a, b) => a.line - b.line) };
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
  const res = await fetch(url, { proxy: await fetchProxy(proxy), signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
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
