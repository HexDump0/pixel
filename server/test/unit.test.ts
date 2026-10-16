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
    const out = render("Intro\n\n{{> findings}}\n\n{{> report}}\n", { workbase: "/wb" });
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
