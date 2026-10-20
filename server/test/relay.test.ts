import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db } from "../src/db.ts";
import { cachedCatalog, catalogProviders } from "../src/catalog.ts";
import { agentCredentials, removeAccount, saveAccount } from "../src/providerAccounts.ts";
import { connect, createServer, type Socket } from "node:net";
import { getProxy, importProxies, listProxies, parseProxyUrl, proxyLineToUrl, publicProxy, removeProxy, saveProxy, testProxyUrl } from "../src/proxies.ts";
import { detectProxyScheme, fetchProxy } from "../src/socks.ts";
import { handleRelay, proxySubject, relayBase, relayUrl, runSubject } from "../src/relay.ts";

// A provider that echoes what it got, and an HTTP proxy that remembers what went through it.
const upstream = Bun.serve({
  port: 0,
  fetch: async (r) => {
    const body = r.method === "POST" ? await r.json() : null;
    return Response.json({ path: new URL(r.url).pathname, model: body?.model ?? null, auth: r.headers.get("authorization") });
  },
});
const seen: { url: string; auth: string | null }[] = [];
const proxy = Bun.serve({
  port: 0,
  fetch: (r) => {
    if (r.method === "CONNECT") return new Response(null, { status: 502 });
    seen.push({ url: r.url, auth: r.headers.get("proxy-authorization") });
    return fetch(r.url, { method: r.method, headers: r.headers, body: r.body });
  },
});
const up = `http://127.0.0.1:${upstream.port}`;

const call = (subject: string, provider: string, path: string, model: string) =>
  handleRelay(new Request(`${relayUrl(subject, provider)}${path}`, { method: "POST", headers: { authorization: "Bearer sk-test", "content-type": "application/json" }, body: JSON.stringify({ model }) }));

let proxyId = "";
beforeAll(async () => {
  await catalogProviders();
  await saveAccount({ id: "lab", name: "Lab", key: "sk-lab-1234567890", baseURL: `${up}/v1`, custom: { api: "openai", models: ["m1"], context: 8000 } });
  // A gateway whose models live under different paths, like opencode Zen.
  cachedCatalog()!.set("zenlike", {
    id: "zenlike",
    name: "Zen-like",
    env: [],
    doc: null,
    api: `${up}/openai/v1`,
    npm: "@ai-sdk/openai-compatible",
    models: [
      { id: "claude", name: "Claude", family: null, context: 1000, output: 100, costIn: 0, costOut: 0, costCacheRead: null, tools: true, reasoning: false, openWeights: false, released: null, status: null, api: `${up}/anthropic/v1`, npm: "@ai-sdk/anthropic" },
      { id: "gpt", name: "GPT", family: null, context: 1000, output: 100, costIn: 0, costOut: 0, costCacheRead: null, tools: true, reasoning: false, openWeights: false, released: null, status: null, api: null, npm: null },
    ],
  });
  proxyId = (await saveProxy({ name: "Test proxy", url: `http://127.0.0.1:${proxy.port}`, username: "u", password: "p@ss" })).id;
});
afterAll(() => {
  cachedCatalog()!.delete("zenlike");
  removeAccount("lab");
  for (const p of listProxies()) removeProxy(p.id);
  upstream.stop(true);
  proxy.stop(true);
});

describe("proxies", () => {
  test("addresses are checked and passwords never shown", () => {
    expect(parseProxyUrl("socks5h://h:1080").toString()).toBe("socks5://h:1080");
    expect(() => parseProxyUrl("socks4://h:1080")).toThrow(/SOCKS4/);
    expect(() => parseProxyUrl("ftp://h")).toThrow();
    expect(parseProxyUrl("10.0.0.2:3128").toString()).toBe("http://10.0.0.2:3128/");
    const p = publicProxy(getProxy(proxyId)!);
    expect(p).toMatchObject({ name: "Test proxy", user: "u", hasPassword: true, host: "127.0.0.1" });
    expect(JSON.stringify(p)).not.toContain("p%40ss");
  });

  test("an edit without a password keeps the stored one", async () => {
    await saveProxy({ name: "Renamed", url: `http://127.0.0.1:${proxy.port}`, username: "u" }, proxyId);
    expect(new URL(getProxy(proxyId)!.url).password).toBe("p%40ss");
    await saveProxy({ name: "Test proxy" }, proxyId);
  });
});

describe("relay", () => {
  test("forwards a call through the proxy to the provider's endpoint, with the proxy's credentials", async () => {
    seen.length = 0;
    const res = await call(proxySubject(proxyId), "lab", "/chat/completions", "m1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "/v1/chat/completions", model: "m1", auth: "Bearer sk-test" });
    expect(seen).toEqual([{ url: `${up}/v1/chat/completions`, auth: `Basic ${btoa("u:p@ss")}` }]);
    expect(publicProxy(getProxy(proxyId)!).use.callsLastHour).toBe(1);
  });

  test("picks each model's own endpoint on a gateway", async () => {
    expect((await (await call(proxySubject(proxyId), "zenlike", "/messages", "claude")).json()).path).toBe("/anthropic/v1/messages");
    expect((await (await call(proxySubject(proxyId), "zenlike", "/chat/completions", "gpt")).json()).path).toBe("/openai/v1/chat/completions");
  });

  test("refuses bad signatures and unknown providers, fails closed on a removed or broken proxy", async () => {
    const forged = await handleRelay(new Request(`${relayBase()}/${proxySubject(proxyId)}/AAAAAAAAAAAAAAAAAAAAAA/lab/chat/completions`, { method: "POST", body: "{}" }));
    expect(forged.status).toBe(403);
    expect((await call(proxySubject(proxyId), "nowhere", "/x", "m")).status).toBe(502);
    expect((await call(proxySubject("px_gone"), "lab", "/chat/completions", "m1")).status).toBe(502);
    const dead = await saveProxy({ name: "Dead", url: "http://127.0.0.1:1" });
    const res = await call(proxySubject(dead.id), "lab", "/chat/completions", "m1");
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toContain("Dead");
    expect(publicProxy(getProxy(dead.id)!).use).toMatchObject({ failuresLastHour: 1 });
    removeProxy(dead.id);
  });

  test("a run's calls follow its current proxy, and go direct with none", async () => {
    db.query("INSERT INTO runs (id, repo, model, size, status, runtime, created_at, proxy_id) VALUES ('relay-run', 'r', 'lab/m1', '{}', 'running', 'local', 0, ?)").run(proxyId);
    seen.length = 0;
    expect((await call(runSubject("relay-run"), "lab", "/chat/completions", "m1")).status).toBe(200);
    expect(seen.length).toBe(1);
    db.query("UPDATE runs SET proxy_id = NULL WHERE id = 'relay-run'").run();
    expect((await call(runSubject("relay-run"), "lab", "/chat/completions", "m1")).status).toBe(200);
    expect(seen.length).toBe(1);
    db.query("DELETE FROM runs WHERE id = 'relay-run'").run();
  });

  test("a proxied run's opencode config points its providers at the relay; others are untouched", () => {
    const cfg = JSON.parse(agentCredentials(undefined, { id: "some-run", key_id: null, model: "lab/m1", proxy_id: proxyId }).env.OPENCODE_CONFIG_CONTENT);
    expect(cfg.providers.lab.settings.baseURL).toBe(relayUrl(runSubject("some-run"), "lab"));
    expect(cfg.providers.lab.models.m1).toBeDefined();
    const direct = JSON.parse(agentCredentials(undefined, { id: "some-run", key_id: null, model: "lab/m1", proxy_id: null }).env.OPENCODE_CONFIG_CONTENT);
    expect(direct.providers.lab.settings.baseURL).toBe(`${up}/v1`);
  });

  test("a test through a broken proxy says why", async () => {
    const t = await testProxyUrl("http://127.0.0.1:1", []);
    expect(t.ok).toBe(false);
    expect(t.error).toBeTruthy();
  });
});

// A SOCKS5 server with a username and password, like the ones proxy sellers hand out.
const socksSeen: string[] = [];
const socks = createServer((c: Socket) => {
  let stage = 0;
  c.once("data", function step(d: Buffer) {
    if (stage === 0) {
      stage = 1;
      c.write(Buffer.from([5, 2]));
    } else if (stage === 1) {
      const user = d.subarray(2, 2 + d[1]).toString();
      const pass = d.subarray(3 + d[1], 3 + d[1] + d[2 + d[1]]).toString();
      if (user !== "su" || pass !== "s:pw") return void c.end(Buffer.from([1, 1]));
      stage = 2;
      c.write(Buffer.from([1, 0]));
    } else {
      const host = d.subarray(5, 5 + d[4]).toString();
      const port = d.readUInt16BE(5 + d[4]);
      socksSeen.push(`${host}:${port}`);
      const out = connect(port, host, () => {
        c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        c.pipe(out).pipe(c);
      });
      out.on("error", () => c.destroy());
      return;
    }
    c.once("data", step);
  });
});
let socksPort = 0;

describe("SOCKS5 and pasted proxies", () => {
  beforeAll(() => new Promise<void>((r) => socks.listen(0, "127.0.0.1", () => ((socksPort = (socks.address() as any).port), r()))));
  afterAll(() => void socks.close());

  test("seller lines become URLs", () => {
    expect(proxyLineToUrl("45.41.128.10:8001:dc_x:_9w:k")).toBe("http://dc_x:_9w%3Ak@45.41.128.10:8001");
    expect(proxyLineToUrl("user:pw:h.example:3128")).toBe("http://user:pw@h.example:3128");
    expect(proxyLineToUrl("http://u:p@h:1")).toBe("http://u:p@h:1");
  });

  test("detects what a proxy speaks", async () => {
    expect(await detectProxyScheme("127.0.0.1", socksPort)).toBe("socks5");
    expect(await detectProxyScheme("127.0.0.1", proxy.port!)).toBe("http");
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as any).port;
    closed.close();
    expect(await detectProxyScheme("127.0.0.1", port)).toBeNull();
  });

  test("imports pasted lines, detecting each one's protocol", async () => {
    const r = await importProxies(`127.0.0.1:${socksPort}:su:s:pw\n# comment\n\nnot a proxy::\n127.0.0.1:${socksPort}:su:s:pw`);
    expect(r.added.map((p) => new URL(p.url).protocol)).toEqual(["socks5:"]);
    expect(r.skipped.map((x) => x.line)).toEqual([4, 5]);
    const id = r.added[0].id;

    // A model call through it (http:// target: absolute-form through the bridge).
    socksSeen.length = 0;
    const res = await call(proxySubject(id), "lab", "/chat/completions", "m1");
    expect(res.status).toBe(200);
    expect((await res.json()).path).toBe("/v1/chat/completions");
    expect(socksSeen).toEqual([`127.0.0.1:${upstream.port}`]);
    removeProxy(id);
  });

  test("the bridge tunnels CONNECT and refuses anyone without its secret", async () => {
    const via = new URL(await fetchProxy(`socks5://su:s%3Apw@127.0.0.1:${socksPort}`));
    const talk = (auth: string, then?: string) =>
      new Promise<string>((resolve) => {
        const s = connect(Number(via.port), "127.0.0.1", () => s.write(`CONNECT 127.0.0.1:${upstream.port} HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from(auth).toString("base64")}\r\n\r\n`));
        let got = "";
        s.on("data", (d) => {
          got += d.toString();
          if (then && got.includes("established") && !got.includes("path")) s.write(then);
          if (!then || got.includes("path")) s.end();
        });
        s.on("close", () => resolve(got));
      });
    expect(await talk(`${via.username}:wrong`)).toContain("407");
    const got = await talk(`${via.username}:${via.password}`, `GET /tunnel HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    expect(got).toContain("200 Connection established");
    expect(got).toContain('"path":"/tunnel"');
  });
});
