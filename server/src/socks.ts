/**
 * SOCKS5 proxies. Bun's fetch only speaks to HTTP(S) proxies, so a SOCKS5 proxy is reached through a
 * small bridge on loopback: fetch gets `http://<socks url>:<secret>@127.0.0.1:<port>` as its proxy,
 * sends CONNECT (or an absolute-form request for http:// targets) with those credentials, and the
 * bridge opens the connection through the SOCKS5 proxy named in them. The secret keeps it from
 * being an open proxy for anything else on the machine (agents in the single runtime share loopback).
 *
 * Also: telling what a proxy speaks when its address has no scheme (sellers list host:port:user:pass).
 */
import { connect, createServer, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url");
let port: Promise<number> | null = null;

/** The proxy URL to give fetch for `url`: itself for HTTP(S), the bridge for SOCKS5. */
export async function fetchProxy(url: string) {
  if (!url.startsWith("socks5:")) return url;
  return `http://${Buffer.from(url).toString("base64url")}:${secret}@127.0.0.1:${await bridge()}`;
}

function bridge() {
  port ??= new Promise((resolve, reject) => {
    const server = createServer((client) => void serve(client).catch(() => client.destroy()));
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    server.unref();
  });
  return port;
}

/** Bytes from a socket on demand (the SOCKS handshake reads exact lengths). */
function reader(sock: Socket) {
  let buf = Buffer.alloc(0);
  let wake: (() => void) | null = null;
  let ended = false;
  const onData = (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    wake?.();
  };
  const onEnd = () => {
    ended = true;
    wake?.();
  };
  sock.on("data", onData).on("end", onEnd).on("close", onEnd).on("error", onEnd);
  const wait = () => new Promise<void>((r) => (wake = r)).then(() => void (wake = null));
  return {
    async read(n: number) {
      while (buf.length < n) {
        if (ended) throw new Error("connection closed");
        await wait();
      }
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      return out;
    },
    async until(marker: string, max = 64 * 1024) {
      for (;;) {
        const i = buf.indexOf(marker);
        if (i >= 0) {
          const out = buf.subarray(0, i + marker.length);
          buf = buf.subarray(i + marker.length);
          return out;
        }
        if (ended || buf.length > max) throw new Error("connection closed");
        await wait();
      }
    },
    /** Stop reading; whatever was buffered past the handshake. */
    release() {
      sock.off("data", onData).off("end", onEnd).off("close", onEnd).off("error", onEnd);
      return buf;
    },
  };
}

const opened = (sock: Socket) => new Promise<void>((resolve, reject) => sock.once("connect", resolve).once("error", reject));
const withTimeout = <T>(p: Promise<T>, ms: number, what: string) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms))]);

/** A connection to host:port through the SOCKS5 proxy at `proxy` (socks5://[user:pass@]host:port). */
export async function socksConnect(proxy: string, host: string, port: number, timeoutMs = 15_000) {
  const u = new URL(proxy);
  const sock = connect(Number(u.port) || 1080, u.hostname);
  try {
    await withTimeout(opened(sock), timeoutMs, "connecting to the SOCKS proxy");
    const r = reader(sock);
    const user = Buffer.from(decodeURIComponent(u.username));
    const pass = Buffer.from(decodeURIComponent(u.password));
    sock.write(Buffer.from(user.length ? [5, 2, 0, 2] : [5, 1, 0]));
    const [ver, method] = await withTimeout(r.read(2), timeoutMs, "SOCKS greeting");
    if (ver !== 5) throw new Error("not a SOCKS5 proxy");
    if (method === 2) {
      sock.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
      if ((await withTimeout(r.read(2), timeoutMs, "SOCKS login"))[1] !== 0) throw new Error("SOCKS proxy rejected the username or password");
    } else if (method !== 0) throw new Error(method === 0xff ? "SOCKS proxy wants a username and password" : `SOCKS proxy wants an unsupported login (${method})`);
    const name = Buffer.from(host);
    sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 0xff])]));
    const head = await withTimeout(r.read(4), timeoutMs, "SOCKS connect");
    if (head[1] !== 0) throw new Error(`SOCKS proxy couldn't connect to ${host}:${port} (code ${head[1]})`);
    await r.read(head[3] === 1 ? 4 + 2 : head[3] === 4 ? 16 + 2 : (await r.read(1))[0] + 2);
    return { sock, rest: r.release() };
  } catch (e) {
    sock.destroy();
    throw e;
  }
}

/** One client of the bridge: CONNECT host:port, or an absolute-form request for an http:// target. */
async function serve(client: Socket) {
  const r = reader(client);
  const head = (await r.until("\r\n\r\n")).toString("latin1");
  const [line, ...headers] = head.split("\r\n");
  const [method, target, version] = line.split(" ");
  const auth = headers.find((h) => /^proxy-authorization:/i.test(h))?.replace(/^[^:]+:\s*Basic\s+/i, "") ?? "";
  const [id, key] = Buffer.from(auth, "base64").toString().split(":");
  if (key !== secret) return void client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
  const socks = Buffer.from(id, "base64url").toString();

  let host: string, port: number, first: Buffer | null = null;
  if (method === "CONNECT") {
    const i = target.lastIndexOf(":");
    [host, port] = [target.slice(0, i).replace(/^\[|\]$/g, ""), Number(target.slice(i + 1))];
  } else {
    const t = new URL(target);
    [host, port] = [t.hostname, Number(t.port) || 80];
    // To the origin: its own request line, without the proxy's headers.
    const kept = headers.filter((h) => h && !/^proxy-(authorization|connection):/i.test(h));
    first = Buffer.from(`${method} ${t.pathname}${t.search} ${version}\r\n${kept.join("\r\n")}\r\n\r\n`, "latin1");
  }
  let up: Awaited<ReturnType<typeof socksConnect>>;
  try {
    up = await socksConnect(socks, host, port);
  } catch (e: any) {
    return void client.end(`HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\n\r\n${e.message}`);
  }
  const extra = r.release();
  if (method === "CONNECT") client.write("HTTP/1.1 200 Connection established\r\n\r\n");
  else up.sock.write(first!);
  if (up.rest.length) client.write(up.rest);
  if (extra.length) up.sock.write(extra);
  up.sock.pipe(client).on("error", () => up.sock.destroy());
  client.pipe(up.sock).on("error", () => client.destroy());
  client.on("error", () => up.sock.destroy()).on("close", () => up.sock.destroy());
  up.sock.on("error", () => client.destroy()).on("close", () => client.destroy());
}

/** Send `hello` to host:port (over TLS if asked) and return the first bytes back, or null. */
function probe(host: string, port: number, hello: Buffer, tls = false, timeoutMs = 6000) {
  return new Promise<Buffer | null>((resolve) => {
    const sock = tls ? tlsConnect({ host, port, servername: /^[\d.]+$/.test(host) ? undefined : host, rejectUnauthorized: false }) : connect(port, host);
    const done = (b: Buffer | null) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(b);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    sock.once(tls ? "secureConnect" : "connect", () => sock.write(hello));
    sock.once("data", (d: Buffer) => done(d));
    sock.once("error", () => done(null));
    sock.once("close", () => done(null));
  });
}

/**
 * What a proxy at host:port speaks: an HTTP proxy answers CONNECT with an HTTP status (any, 407
 * included), a SOCKS5 one answers its greeting with version 5, an HTTPS one does both over TLS.
 * Tried in that order, so a port that speaks both HTTP and SOCKS5 is used as HTTP (no bridge).
 * null when nothing answered.
 */
export async function detectProxyScheme(host: string, port: number): Promise<"http" | "https" | "socks5" | null> {
  // A name that never resolves: the proxy answers (407, 502, ...) without connecting anywhere.
  const connectReq = Buffer.from("CONNECT pixel-probe.invalid:443 HTTP/1.1\r\nHost: pixel-probe.invalid:443\r\n\r\n");
  if ((await probe(host, port, connectReq))?.toString("latin1").startsWith("HTTP/")) return "http";
  if ((await probe(host, port, Buffer.from([5, 2, 0, 2])))?.[0] === 5) return "socks5";
  if ((await probe(host, port, connectReq, true))?.toString("latin1").startsWith("HTTP/")) return "https";
  return null;
}
