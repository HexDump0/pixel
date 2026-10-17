/** The MCP endpoint for outside agents: handshake, tool list, read tools over a run with a finding, errors, cross-origin refusal. */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db, getRun } from "../src/db.ts";
import { workbasePath } from "../src/knowledge.ts";
import { checkFindings } from "../src/findings.ts";
import "../src/api/index.ts";
import { serveMcp } from "../src/mcp.ts";

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

let nextId = 1;
async function rpc(method: string, params?: unknown, headers: Record<string, string> = {}) {
  const res = await serveMcp(
    new Request("http://pixel.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", host: "pixel.test", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }) }),
  );
  return { status: res.status, body: (await res.json()) as any };
}
async function tool(name: string, args: Record<string, unknown> = {}) {
  const { body } = await rpc("tools/call", { name, arguments: args });
  return { text: body.result.content[0].text as string, isError: !!body.result.isError };
}

describe("mcp", () => {
  test("handshake, notifications and tool list", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    expect(init.body.result.protocolVersion).toBe("2025-06-18");
    expect(init.body.result.capabilities.tools).toBeTruthy();
    expect((await rpc("initialize", { protocolVersion: "1999-01-01" })).body.result.protocolVersion).toBe("2025-11-25");

    const note = await serveMcp(new Request("http://pixel.test/api/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }));
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
});
