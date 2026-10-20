import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { addVersion, createTemplate, render } from "../src/templates.ts";
import { detectLanguage, safeWorkbasePath } from "../src/knowledge.ts";
import { recordCrossReads, crossReadsFor } from "../src/crossreads.ts";
import { search, workbaseSizes } from "../src/search.ts";
import { repoName } from "../src/runs/create.ts";
import { db } from "../src/db.ts";

describe("templates", () => {
  test("substitutes variables and keeps unknown ones", () => {
    expect(render("a {{x}} b {{y}}", { x: "1" })).toBe("a 1 b {{y}}");
  });
  test("conditionals", () => {
    const body = "start\n{{#if prev}}\nprev: {{prev}}\n{{/if}}\nend";
    expect(render(body, { prev: "/w/old" })).toBe("start\nprev: /w/old\nend");
    expect(render(body, { prev: null })).toBe("start\nend");
  });
  test("Pixel's sections expand with their variables; unknown ones are refused", () => {
    const out = render("Intro\n\n{{> findings}}\n\n{{> report}}\n", { workbase: "/wb", workbases: "/workbases" });
    expect(out).toContain("`/workbases/TRIAGED.md`");
    expect(out).toContain("## Findings");
    expect(out).toContain("`/wb/findings/F<n>-<short-name>/README.md`");
    expect(out).toContain("Write your final report to `/wb/REPORT.md`");
    expect(out).not.toContain("{{");
    expect(render("{{> environment}}", { target: "/t", repo: "r", ref: null, previous_workbase: null })).not.toContain("follow-up");
    expect(() => render("{{> nope}}", {})).toThrow(/unknown section \{\{> nope\}\}/);
    createTemplate("parts-test", "parts-test", "{{> findings}}");
    expect(() => addVersion("parts-test", "{{> findngs}}")).toThrow(/unknown section/);
  });
});

describe("knowledge", () => {
  test("workbase paths cannot escape", () => {
    expect(safeWorkbasePath("r1", "notes/a.md")).toBe(join(config.workbasesDir, "r1", "notes/a.md"));
    expect(() => safeWorkbasePath("r1", "../r2/x")).toThrow();
    expect(() => safeWorkbasePath("r1", "/../../etc/passwd")).toThrow();
  });
  test("language detection picks the most common", () => {
    expect(detectLanguage("a.c\nb.c\nc.h\nREADME.md\nx.py")).toBe("C");
    expect(detectLanguage("README.md")).toBeNull();
  });
  test("repo names", () => {
    expect(repoName("https://github.com/glennrp/libpng.git")).toBe("libpng");
    expect(repoName("git@github.com:madler/zlib.git")).toBe("zlib");
    expect(repoName("https://example.com/Some Repo/")).toBe("some-repo");
  });
});

describe("cross-reads", () => {
  test("detects reads of other workbases from tool inputs", () => {
    db.query("INSERT INTO runs (id, repo, model, size, status, runtime, created_at) VALUES ('cr-a', 'x', 'p/m', '{}', 'running', 'local', 0)").run();
    expect(recordCrossReads("cr-a", "/workbases", "read", { filePath: "/workbases/zlib-1/REPORT.md" })).toEqual(["zlib-1"]);
    expect(recordCrossReads("cr-a", "/workbases", "read", { filePath: "/workbases/cr-a/notes.md" })).toEqual([]);
    expect(recordCrossReads("cr-a", "/workbases", "bash", { command: "cat /workbases/INDEX.md && ls /workbases/libpng-2/" }).sort()).toEqual(["*", "libpng-2"]);
    expect(crossReadsFor("cr-a").length).toBe(3);
  });
});

describe("search", () => {
  test("finds files containing every term, with marked snippets, skipping .git", async () => {
    const dir = join(config.workbasesDir, "search-run");
    mkdirSync(join(dir, "findings", "F1-chunk"), { recursive: true });
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, "notes.md"), "The png_read_chunk length check is missing.");
    writeFileSync(join(dir, "findings", "F1-chunk", "README.md"), "Heap overflow in PNG_READ_CHUNK when the length is huge.");
    writeFileSync(join(dir, "other.md"), "png_read_chunk only");
    writeFileSync(join(dir, ".git", "x"), "png_read_chunk length");
    const hits = await search("png_read_chunk length");
    expect(hits.map((h) => h.path).sort()).toEqual(["findings/F1-chunk/README.md", "notes.md"]);
    expect(hits.every((h) => h.run_id === "search-run")).toBe(true);
    expect(hits.find((h) => h.path === "notes.md")!.snippet).toBe("The [[png_read_chunk]] [[length]] check is missing.");
    expect(await search("   ")).toEqual([]);
    expect(await search("no-such-text-anywhere")).toEqual([]);
    const size = (await workbaseSizes()).get("search-run")!;
    expect(size.files).toBe(3);
  });
});

describe("derived tables", () => {
  test("model calls follow inserts, upserts and deletes of assistant messages", () => {
    db.query("INSERT INTO runs (id, repo, model, size, status, runtime, created_at) VALUES ('mt-1', 'x', 'p/m', '{}', 'running', 'local', 1)").run();
    const upsert = db.query("INSERT INTO messages (id, run_id, session_id, role, data, created_at) VALUES (?, 'mt-1', 's', ?, ?, 1) ON CONFLICT(id) DO UPDATE SET data = excluded.data WHERE messages.data IS NOT excluded.data");
    const totals = () => db.query("SELECT COUNT(*) AS n, SUM(input) AS input, SUM(cache_read) AS cr, SUM(cache_write) AS cw, SUM(cost) AS cost FROM model_calls WHERE run_id = 'mt-1'").get();
    upsert.run("m1", "assistant", JSON.stringify({ providerID: "p", modelID: "m", tokens: { input: 0 } })); // still streaming
    upsert.run("m1", "assistant", JSON.stringify({ providerID: "p", modelID: "m", cost: 0.5, time: { completed: 9 }, tokens: { input: 100, output: 7, cache: { read: 50, write: 10 } } }));
    upsert.run("m2", "assistant", JSON.stringify({ tokens: { input: 5, cache: { read: 1, write: 0 } }, error: { name: "APIError" } }));
    upsert.run("u1", "user", JSON.stringify({ tokens: { input: 999 } }));
    expect(totals()).toEqual({ n: 2, input: 105, cr: 51, cw: 10, cost: 0.5 });
    expect(db.query("SELECT provider, model, completed, output, error FROM model_calls WHERE id = 'm1'").get()).toEqual({ provider: "p", model: "m", completed: 9, output: 7, error: null });
    expect(db.query("SELECT error FROM model_calls WHERE id = 'm2'").get()).toEqual({ error: "APIError" });
    db.query("DELETE FROM messages WHERE id = 'm2'").run();
    expect(totals()).toEqual({ n: 1, input: 100, cr: 50, cw: 10, cost: 0.5 });
  });
});

describe("deleting a run", () => {
  test("takes its messages, parts and derived rows with it", () => {
    db.query("INSERT INTO runs (id, repo, model, size, status, runtime, created_at) VALUES ('del-1', 'x', 'p/m', '{}', 'done', 'local', 1)").run();
    db.query("INSERT INTO messages (id, run_id, session_id, role, data, created_at) VALUES ('del-m', 'del-1', 's', 'assistant', ?, 1)").run(JSON.stringify({ tokens: { input: 3 } }));
    db.query("INSERT INTO parts (id, run_id, session_id, message_id, type, data, updated_at) VALUES ('del-p', 'del-1', 's', 'del-m', 'tool', ?, 1)").run(JSON.stringify({ tool: "bash", state: { status: "completed" } }));
    db.query("DELETE FROM runs WHERE id = 'del-1'").run();
    for (const t of ["messages", "parts", "tool_calls", "model_calls"]) expect(db.query(`SELECT COUNT(*) AS n FROM ${t} WHERE run_id = 'del-1'`).get()).toEqual({ n: 0 });
  });
});
