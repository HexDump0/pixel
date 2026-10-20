/** The MCP endpoint for outside agents: access tokens (read, full, revoked, expired), handshake, tool list, read tools over a run with a finding, errors, cross-origin refusal. */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db, getRun } from "../src/db.ts";
import { workbasePath } from "../src/knowledge.ts";
import { checkFindings } from "../src/findings.ts";
import "../src/api/index.ts";
import { serveMcp } from "../src/mcp.ts";
import { createMcpToken, revokeMcpToken } from "../src/mcpTokens.ts";
import { dispatch } from "../src/api/router.ts";

const size = JSON.stringify({ cpu: 2, memoryGiB: 4, diskGiB: 20 });
const RUN = "mcp-run";
db.query("INSERT INTO runs (id, repo, model, size, status, runtime, created_at, tokens_in, tokens_out, cost) VALUES (?, 'github.com/x/libpng', 'p/m', ?, 'running', 'local', ?, 1200, 300, 0.42)").run(
  RUN,
  size,
  Date.now(),
);
const dir = join(workbasePath(RUN), "findings", "F1-uaf-png-free");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "README.md"), "---\nstate: confirmed\nseverity: high\nlocation: png.c:40\npoc: poc.png\n---\n# UAF in png_free\n\nFreed twice on the error path.\n");
writeFileSync(join(dir, "poc.png"), "x");
writeFileSync(join(workbasePath(RUN), "NOTES.md"), "hello from the agent\n");
checkFindings(getRun(RUN)!);

const full = createMcpToken({ name: "laptop claude", access: "full" }).token;
const read = createMcpToken({ name: "reader", access: "read", days: 30 }).token;

let nextId = 1;
async function rpc(method: string, params?: unknown, headers: Record<string, string> = {}, token: string | null = full) {
  const res = await serveMcp(
    new Request("http://pixel.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", host: "pixel.test", ...(token && { authorization: `Bearer ${token}` }), ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    }),
  );
  return { status: res.status, body: (await res.json()) as any };
}
async function tool(name: string, args: Record<string, unknown> = {}, token = full) {
  const { body } = await rpc("tools/call", { name, arguments: args }, {}, token);
  return { text: body.result.content[0].text as string, isError: !!body.result.isError };
}
const apiCall = async (method: string, path: string, body?: unknown) => {
  const url = new URL(`http://pixel.test/api${path}`);
  const res = await dispatch(new Request(url, { method, headers: { host: "pixel.test" }, body: body ? JSON.stringify(body) : undefined }), url);
  return { status: res.status, body: (await res.json()) as any };
};

describe("mcp", () => {
  test("handshake, notifications and tool list", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    expect(init.body.result.protocolVersion).toBe("2025-06-18");
    expect(init.body.result.capabilities.tools).toBeTruthy();
    expect((await rpc("initialize", { protocolVersion: "1999-01-01" })).body.result.protocolVersion).toBe("2025-11-25");

    const note = await serveMcp(new Request("http://pixel.test/api/mcp", { method: "POST", headers: { authorization: `Bearer ${full}` }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }));
    expect(note.status).toBe(202);

    const { body } = await rpc("tools/list");
    const names = body.result.tools.map((t: any) => t.name);
    expect(names).toContain("list_findings");
    expect(names).toContain("token_usage");
    const raw = body.result.tools.find((t: any) => t.name === "pixel_api");
    expect(raw.description).toContain("GET /fleet");
    expect(raw.description).not.toContain("/mcp");
    expect(body.result.tools.find((t: any) => t.name === "get_finding").annotations.readOnlyHint).toBe(true);

    expect((await rpc("nope/nothing")).body.error.code).toBe(-32601);
  });

  test("runs, findings, files and tokens", async () => {
    const runs = JSON.parse((await tool("list_runs", { status: "running" })).text);
    const r = runs.runs.find((x: any) => x.id === RUN);
    expect(r.tokens.input).toBe(1200);
    expect(r.costUsd).toBe(0.42);
    expect(r.findings).toBeTruthy();
    expect(JSON.parse((await tool("list_runs", { status: "done" })).text).runs.some((x: any) => x.id === RUN)).toBe(false);

    const findings = JSON.parse((await tool("list_findings", { run: RUN })).text);
    expect(findings.findings[0]).toMatchObject({ id: "F1", severity: "high", state: "confirmed", location: "png.c:40" });

    const brief = await tool("get_finding", { run: RUN, finding: "F1" });
    expect(brief.text).toContain("Freed twice on the error path");
    expect(brief.text).toContain("http://pixel.test/api/share/");

    const set = JSON.parse((await tool("set_finding_verdict", { run: RUN, finding: "F1", verdict: "real", note: "checked" })).text);
    expect(set.verdict).toBe("real");

    expect((await tool("list_files", { run: RUN })).text).toContain("NOTES.md");
    expect((await tool("read_file", { run: RUN, path: "NOTES.md" })).text).toBe("hello from the agent\n");
    expect((await tool("read_file", { run: RUN, path: "../../etc/passwd" })).isError).toBe(true);

    const usage = JSON.parse((await tool("token_usage", { run: RUN })).text);
    expect(usage.tokens.output).toBe(300);
    const all = JSON.parse((await tool("token_usage", { days: 3 })).text);
    expect(all.window.days).toBe(3);
    expect(all.totals).toBeTruthy();
    expect(all.series).toBeUndefined();

    const fleet = await tool("pixel_api", { method: "GET", path: "/fleet" });
    expect(fleet.isError).toBe(false);
  });

  test("errors come back as tool errors, not crashes", async () => {
    expect((await tool("get_run", { run: "no-such-run" })).isError).toBe(true);
    expect((await tool("control_run", { run: RUN, action: "explode" })).isError).toBe(true);
    expect((await tool("pixel_api", { method: "POST", path: "/mcp" })).isError).toBe(true);
    expect((await rpc("tools/call", { name: "missing" })).body.error.code).toBe(-32602);
  });

  test("a page from another site is refused", async () => {
    const { status } = await rpc("tools/list", undefined, { origin: "https://evil.example" });
    expect(status).toBe(403);
    expect((await rpc("tools/list", undefined, { origin: "http://pixel.test" })).status).toBe(200);
  });

  test("tokens: none, read only, revoked, expired, managed from the API", async () => {
    expect((await rpc("tools/list", undefined, {}, null)).status).toBe(401);
    expect((await rpc("tools/list", undefined, {}, "pxm_made-up")).status).toBe(401);
    expect((await rpc("tools/list", undefined, {}, "the-dashboard-password")).status).toBe(401);

    const names = (await rpc("tools/list", undefined, {}, read)).body.result.tools.map((t: any) => t.name);
    expect(names).toContain("list_findings");
    expect(names).not.toContain("send_message");
    expect(names).not.toContain("pixel_api");
    const refused = await tool("set_finding_verdict", { run: RUN, finding: "F1", verdict: null }, read);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("read only");
    expect(JSON.parse((await tool("get_run", { run: RUN }, read)).text).attach).toBeUndefined();

    // Settings' view: no hashes, use is counted, the address is given.
    const list = await apiCall("GET", "/mcp/tokens");
    expect(list.body.url).toBe("http://pixel.test/api/mcp");
    const mine = list.body.tokens.find((t: any) => t.name === "laptop claude");
    expect(mine.hash).toBeUndefined();
    expect(mine.uses).toBeGreaterThan(0);
    expect(mine.used_tool).toBeTruthy();
    expect(list.body.tokens.find((t: any) => t.name === "reader").expires).toBeGreaterThan(Date.now());
    expect((await apiCall("POST", "/mcp/tokens", { name: "", access: "full" })).status).toBe(400);
    expect((await apiCall("POST", "/mcp/tokens", { name: "x", access: "admin" })).status).toBe(400);

    // A token can't make more tokens through pixel_api.
    expect((await tool("pixel_api", { method: "POST", path: "/mcp/tokens", body: { name: "sneaky", access: "full" } })).isError).toBe(true);

    const made = await apiCall("POST", "/mcp/tokens", { name: "short lived", access: "full" });
    expect(made.body.token).toStartWith("pxm_");
    expect((await rpc("ping", undefined, {}, made.body.token)).status).toBe(200);
    expect((await apiCall("PUT", `/mcp/tokens/${made.body.info.id}`, { access: "read" })).body.access).toBe("read");
    revokeMcpToken(made.body.info.id);
    expect((await rpc("ping", undefined, {}, made.body.token)).status).toBe(401);

    const old = createMcpToken({ name: "old", access: "read", days: 1 }, Date.now() - 2 * 86_400_000).token;
    expect((await rpc("ping", undefined, {}, old)).status).toBe(401);
  });
});

describe("mcp: big lists, filters and edge cases", () => {
  const BIG = "mcp-big";
  db.query("INSERT INTO runs (id, repo, model, size, status, runtime, created_at) VALUES (?, 'github.com/x/big', 'p/m', ?, 'running', 'local', ?)").run(BIG, size, Date.now());
  const ins = db.query("INSERT INTO findings (run_id, id, state, severity, title, location, poc, summary, created, updated) VALUES (?, ?, ?, ?, ?, 'a.c:1', ?, ?, ?, ?)");
  for (let i = 1; i <= 150; i++) {
    const state = i % 10 === 0 ? "lead" : "suspected";
    ins.run(BIG, `F${i}`, state, i % 10 === 0 ? null : i % 3 ? "high" : "low", `Bug ${i}`, "p".repeat(5000), "s".repeat(12_000), Date.now() - i * 1000, Date.now() - i * 1000);
  }
  const parse = (t: { text: string; isError: boolean }) => {
    expect(t.isError).toBe(false);
    return JSON.parse(t.text);
  };

  test("list_findings pages and stays parseable; brief fits more; verdict is always there", async () => {
    const first = parse(await tool("list_findings", { run: BIG, limit: 150 }));
    expect(first.total).toBe(150);
    expect(first.returned).toBeLessThan(150);
    expect(first.next).toBe(first.returned);
    expect(first.note).toContain("offset");
    expect(first.findings[0]).toHaveProperty("verdict", null);
    expect(first.findings[0].created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const second = parse(await tool("list_findings", { run: BIG, limit: 10, offset: first.next }));
    expect(second.offset).toBe(first.next);
    expect(second.findings[0].id).not.toBe(first.findings[0].id);
    const brief = parse(await tool("list_findings", { run: BIG, limit: 150, brief: true }));
    expect(brief.returned).toBe(150);
    expect(brief.next).toBeNull();
    expect(brief.findings[0].summary).toBeUndefined();
  });

  test("filters: case doesn't matter, typos are errors, none finds no severity, several states", async () => {
    expect(parse(await tool("list_findings", { run: BIG, severity: "High", brief: true })).total).toBe(90);
    expect(parse(await tool("list_findings", { run: BIG, severity: "none", brief: true })).total).toBe(15);
    expect(parse(await tool("list_findings", { run: BIG, state: "lead,suspected", brief: true })).total).toBe(150);
    const bad = await tool("list_findings", { severity: "hgih" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("severity must be one of");
  });

  test("list_runs counts leads apart and pages", async () => {
    const runs = parse(await tool("list_runs", { limit: 1 }));
    expect(runs.returned).toBe(1);
    expect(runs.next).toBe(1);
    const big = parse(await tool("list_runs", { repo: "x/big" })).runs[0];
    expect(big.findings).toMatchObject({ total: 135, leads: 15 });
  });

  test("API routes take limit and offset; pixel_api refuses an answer it would have to cut", async () => {
    expect((await apiCall("GET", "/findings?limit=1")).body).toHaveLength(1);
    expect((await apiCall("GET", `/runs/${BIG}/findings?limit=2&offset=1`)).body.map((f: any) => f.id)).toEqual(["F2", "F3"]);
    expect((await apiCall("GET", `/runs/${BIG}/findings?severity=LOW`)).body.length).toBe(45);
    expect((await apiCall("GET", "/runs?limit=1")).body).toHaveLength(1);
    const huge = await tool("pixel_api", { method: "GET", path: `/runs/${BIG}/findings` });
    expect(huge.isError).toBe(true);
    expect(huge.text).toContain("limit and offset");
    expect(parse(await tool("pixel_api", { method: "GET", path: `/runs/${BIG}/findings?limit=2` }))).toHaveLength(2);
  });

  test("get_report is null without a report; workbase paths are relative and errors don't show the server's", async () => {
    expect(parse(await tool("get_report", { run: BIG }))).toBeNull();
    const abs = await tool("read_file", { run: RUN, path: "/etc/hostname" });
    expect(abs.isError).toBe(true);
    expect(abs.text).toContain("relative to the workbase");
    const missing = await tool("read_file", { run: RUN, path: "nope/x.md" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toBe("no nope/x.md in the workbase");
    expect((await tool("read_file", { run: RUN, path: "../../etc/passwd" })).text).toContain("outside the workbase");
  });
});
