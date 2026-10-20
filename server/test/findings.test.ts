/** Findings as folders in the workbase (findings/F<n>-name/README.md): parsing, Pixel's sync, FINDINGS.md, verdicts, and a run through the fake opencode. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db, getRun } from "../src/db.ts";
import { config } from "../src/config.ts";
import { workbasePath } from "../src/knowledge.ts";
import { checkFindings, findingCounts, findingEvents, listFindings, parseReadme, setDisclosure, triageFinding, triageFindings } from "../src/findings.ts";
import { dispatch } from "../src/api/router.ts";
import { serveShare } from "../src/findingShare.ts";
import "../src/api/index.ts";
import { controls, createRun, startWatchdog, stopWatchdog } from "../src/runs/index.ts";
import { seedTemplates } from "../src/templates.ts";

const size = JSON.stringify({ cpu: 2, memoryGiB: 4, diskGiB: 20 });
function makeRun(id: string, status = "running") {
  db.query("INSERT INTO runs (id, repo, model, size, status, runtime, created_at) VALUES (?, 'x', 'p/m', ?, ?, 'local', ?)").run(id, size, status, Date.now());
  mkdirSync(join(workbasePath(id), ".pixel"), { recursive: true });
  return getRun(id)!;
}

let clock = Date.now() - 3_600_000;
/** Write findings/<folder>/README.md with a header and body, each write a second after the last. */
function write(runId: string, folder: string, header: Record<string, string> | null, body: string) {
  const dir = join(workbasePath(runId), "findings", folder);
  mkdirSync(dir, { recursive: true });
  const head = header ? `---\n${Object.entries(header).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n` : "";
  const file = join(dir, "README.md");
  writeFileSync(file, head + body);
  clock += 1000;
  utimesSync(file, clock / 1000, clock / 1000);
}

const timelineOf = (runId: string) => db.query<{ message: string }, [string]>("SELECT message FROM timeline WHERE run_id = ? AND kind = 'finding' ORDER BY ts").all(runId).map((r) => r.message);

describe("README header", () => {
  test("key: value lines, comments and quotes dropped", () => {
    const r = parseReadme('---\nstate: confirmed   # lead | suspected\nSeverity: "high"\nlocation: a.c:12 # where\n---\n# Title\n\nBody\n');
    expect(r.header).toBe(true);
    expect(r.fields).toEqual({ state: "confirmed", severity: "high", location: "a.c:12" });
    expect(r.body).toBe("# Title\n\nBody\n");
    expect(parseReadme("# No header\n").header).toBe(false);
  });
});

describe("findings sync", () => {
  test("folders → table and events, once; FINDINGS.md; verdicts in TRIAGE.md and not touched by later syncs", async () => {
    const run = makeRun("fd-sync");
    expect(checkFindings(run)).toBe(0); // no findings/ yet
    write(run.id, "F1-uaf-png-free", { state: "suspected", severity: "critical", location: "png.c:40" }, "# UAF in png_free\n\nFreed twice on the error path.\n");
    expect(checkFindings(run)).toBe(1);
    expect(checkFindings(run)).toBe(0);

    mkdirSync(join(workbasePath(run.id), "findings/F1-uaf-png-free"), { recursive: true });
    writeFileSync(join(workbasePath(run.id), "findings/F1-uaf-png-free/poc.png"), "x");
    write(run.id, "F1-uaf-png-free", { state: "confirmed", severity: "critical", location: "png.c:40", poc: "poc.png" }, "# UAF in png_free\n\nFreed twice on the error path.\n\n## Reproduce\n\n./pngtest poc.png\n");
    expect(checkFindings(run)).toBe(1);
    // Only the text changes: no event, but the summary follows.
    write(run.id, "F1-uaf-png-free", { state: "confirmed", severity: "critical", location: "png.c:40", poc: "poc.png" }, "# UAF in png_free\n\nFreed twice on the error path. ASan agrees.\n");
    expect(checkFindings(run)).toBe(0);

    const [f] = listFindings({ run: run.id });
    expect(f).toMatchObject({ id: "F1", state: "confirmed", severity: "critical", title: "UAF in png_free", poc: "findings/F1-uaf-png-free/poc.png", path: "findings/F1-uaf-png-free/README.md", problem: null });
    expect(f.summary).toBe("Freed twice on the error path. ASan agrees.");
    expect(findingCounts()[run.id]).toMatchObject({ total: 1, untriaged: 1, confirmed: 1 });
    expect(timelineOf(run.id)).toEqual(["F1 added (suspected, critical): UAF in png_free", "F1 confirmed: UAF in png_free"]);
    expect(readFileSync(join(workbasePath(run.id), "FINDINGS.md"), "utf8")).toContain("| F1 | confirmed | critical | [UAF in png_free](findings/F1-uaf-png-free/README.md) | png.c:40 |  |");

    triageFinding(run.id, "F1", { disposition: "report", severity: "high", note: "nice one" });
    expect(findingCounts()[run.id].untriaged).toBe(0);
    expect(listFindings({ untriaged: true, run: run.id })).toHaveLength(0);
    expect(listFindings({ run: run.id })[0]).toMatchObject({ disposition: "report", severity_final: "high", disclosure: "ready", disposition_by: "dashboard", repo: "x" });
    const triage = readFileSync(join(workbasePath(run.id), "TRIAGE.md"), "utf8");
    expect(triage).toContain("F1 UAF in png_free: **report, high (agent: critical)**. nice one");
    expect(triage).toContain("Result: 1 to report (1 high).");
    expect(findingCounts()[run.id]).toMatchObject({ report: 1, outcome: "1 to report (1 high)" });
    expect(JSON.parse(readFileSync(join(workbasePath(run.id), ".pixel/run.json"), "utf8")).triage).toBe("1 to report (1 high)");
    expect(readFileSync(join(workbasePath(run.id), "FINDINGS.md"), "utf8")).toContain("| png.c:40 | report, high |");
    expect(readFileSync(join(config.workbasesDir, "TRIAGED.md"), "utf8")).toContain(`| [${run.id}/F1](${run.id}/findings/F1-uaf-png-free/README.md) | report, high (agent: critical) | png.c:40 | UAF in png_free | nice one |`);

    // The agent's own fields keep changing; the triage stays.
    write(run.id, "F1-uaf-png-free", { state: "confirmed", severity: "high", location: "png.c:40", poc: "poc.png" }, "# UAF in png_free\n");
    checkFindings(run);
    expect(listFindings({ run: run.id })[0]).toMatchObject({ severity: "high", disposition: "report" });
    expect(findingEvents({ run: run.id }).sort((a, b) => a.seq - b.seq).map((e) => e.action)).toEqual(["add", "update", "triage", "update"]);
  });

  test("a bad header keeps the last good state and says what's wrong", () => {
    const run = makeRun("fd-bad");
    write(run.id, "F1-x", { state: "suspected" }, "# Overflow in x\n");
    checkFindings(run);
    write(run.id, "F1-x", { state: "maybe", severity: "huge" }, "# Overflow in x\n");
    checkFindings(run);
    expect(listFindings({ run: run.id })[0]).toMatchObject({ state: "suspected", severity: null });
    expect(listFindings({ run: run.id })[0].problem).toContain('state "maybe"');
    write(run.id, "F2-no-header", null, "Just text\n");
    checkFindings(run);
    expect(listFindings({ run: run.id }).find((f) => f.id === "F2")).toMatchObject({ state: "lead", title: "no header", problem: "no --- header at the top of the README" });
  });

  test("same number twice, flat files, folders without a README, deleted and restored folders", () => {
    const run = makeRun("fd-odd");
    write(run.id, "F2-heap", { state: "suspected" }, "# Heap\n");
    write(run.id, "F2-stack", { state: "lead" }, "# Stack\n");
    mkdirSync(join(workbasePath(run.id), "findings/F3-empty"), { recursive: true });
    writeFileSync(join(workbasePath(run.id), "findings/F4-flat.md"), "---\nstate: lead\n---\n# Flat one\n");
    writeFileSync(join(workbasePath(run.id), "findings/notes.md"), "not a finding");
    checkFindings(run);
    const ids = () => listFindings({ run: run.id }).map((f) => f.id).sort();
    expect(ids()).toEqual(["F2", "F2-stack", "F4"]);
    expect(listFindings({ run: run.id }).find((f) => f.id === "F2-stack")!.problem).toContain("same number as F2-heap");

    rmSync(join(workbasePath(run.id), "findings/F2-stack"), { recursive: true });
    checkFindings(run);
    expect(ids()).toEqual(["F2", "F4"]);
    expect(listFindings({ run: run.id, includeRemoved: true }).find((f) => f.id === "F2-stack")).toMatchObject({ removed_reason: "folder deleted" });
    write(run.id, "F2-stack", { state: "lead" }, "# Stack\n");
    checkFindings(run);
    expect(ids()).toEqual(["F2", "F2-stack", "F4"]);
  });

  test("API: list, events, triage, fleet-wide untriaged", async () => {
    const run = makeRun("fd-api");
    write(run.id, "F1-int-overflow", { state: "suspected", severity: "medium" }, "# Integer overflow in png_read_chunk\n");
    checkFindings(run);
    expect((await call("GET", `/runs/${run.id}/findings`)).body).toHaveLength(1);
    expect((await call("GET", `/findings?untriaged=1`)).body.some((f: any) => f.run_id === run.id)).toBe(true);
    expect((await call("POST", `/runs/${run.id}/findings/F1/triage`, { disposition: "needs_work" })).status).toBe(400);
    expect((await call("POST", `/runs/${run.id}/findings/F1/triage`, { disposition: "invalid", note: "checked upstream" })).body).toMatchObject({ disposition: "invalid", disposition_note: "checked upstream", disclosure: null });
    expect((await call("GET", `/runs/${run.id}/findings/events`)).body[0]).toMatchObject({ action: "triage", changes: { disposition: [null, "invalid"] } });
    expect((await call("GET", `/findings?verdict=real`)).status).toBe(400);
    const runs = (await call("GET", "/runs")).body;
    expect(runs.find((r: any) => r.id === run.id).findings).toMatchObject({ total: 1, untriaged: 0, outcome: "nothing to report" });
  });
});

const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await dispatch(new Request(`http://x/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), new URL(`http://x/api${path}`));
  return { status: res.status, body: await res.json() };
};

describe("triage and disclosure", () => {
  test("duplicates need what they repeat; partial updates; report starts a disclosure; leaving report", () => {
    const run = makeRun("fd-tri");
    write(run.id, "F1-a", { state: "confirmed", severity: "high", location: "a.c:1" }, "# Overflow in a\n");
    write(run.id, "F2-b", { state: "confirmed", severity: "high", location: "a.c:1", duplicate_of: "F1" }, "# Same overflow, other caller\n");
    write(run.id, "F3-c", { state: "suspected", severity: "low" }, "# Something in c\n");
    checkFindings(run);
    expect(listFindings({ run: run.id }).find((f) => f.id === "F2")!.agent_duplicate_of).toBe(`${run.id}/F1`);

    expect(() => triageFinding(run.id, "F3", { disposition: "duplicate" })).toThrow(/needs duplicate_of/);
    expect(() => triageFinding(run.id, "F3", { disposition: "duplicate", duplicate_of: "F3" })).toThrow(/itself/);
    expect(() => triageFinding(run.id, "F3", { disposition: "duplicate", duplicate_of: "F9" })).toThrow(/no finding/);
    // The agent's suggestion is used when none is given.
    expect(triageFinding(run.id, "F2", { disposition: "duplicate" })).toMatchObject({ disposition: "duplicate", duplicate_of: `${run.id}/F1` });
    expect(listFindings({ duplicateOf: `${run.id}/F1` }).map((f) => f.id)).toEqual(["F2"]);

    // Severity alone; the agent's own severity means agree (null).
    expect(triageFinding(run.id, "F3", { severity: "medium" })).toMatchObject({ disposition: null, severity_final: "medium" });
    expect(triageFinding(run.id, "F3", { severity: "low" }).severity_final).toBeNull();
    expect(triageFinding(run.id, "F3", { disposition: "weak", severity: "none" })).toMatchObject({ disposition: "weak", severity_final: "none", disclosure: null });
    expect(listFindings({ run: run.id, finalSeverity: "none" }).map((f) => f.id)).toEqual(["F3"]);

    expect(triageFinding(run.id, "F1", { disposition: "report" }).disclosure).toBe("ready");
    expect(() => setDisclosure(run.id, "F3", { disclosure: "reported" })).toThrow(/isn't triaged as report/);
    expect(() => setDisclosure(run.id, "F1", { disclosure: "dropped" })).toThrow(/why/);
    const sent = setDisclosure(run.id, "F1", { disclosure: "reported", report_url: "https://github.com/x/y/security/advisories/GHSA-1" });
    expect(sent.reported_at).toBeGreaterThan(0);
    expect(listFindings({ view: "report" }).some((f) => f.run_id === run.id && f.id === "F1")).toBe(true);
    // Sent: changing the disposition needs the disclosure taken back first.
    expect(() => triageFinding(run.id, "F1", { disposition: "weak" })).toThrow(/already reported/);
    expect(setDisclosure(run.id, "F1", { disclosure: "fixed", fix_ref: "v1.6.44" })).toMatchObject({ disclosure: "fixed", fix_ref: "v1.6.44" });
    expect(listFindings({ view: "resolved", run: run.id }).map((f) => f.id)).toEqual(["F1"]);
    expect(listFindings({ view: "report", run: run.id })).toHaveLength(0);
    expect(readFileSync(join(config.workbasesDir, "TRIAGED.md"), "utf8")).toContain("report, high, fixed upstream");
    expect(findingEvents({ run: run.id, finding: "F1" }).map((e) => e.action)).toContain("disclosure");

    setDisclosure(run.id, "F1", { disclosure: "ready", reported_at: null });
    expect(triageFinding(run.id, "F1", { disposition: "known", note: "CVE-2025-1234" })).toMatchObject({ disposition: "known", disclosure: null, report_url: null });
    expect(listFindings({ view: "reviewed", run: run.id }).map((f) => f.id).sort()).toEqual(["F1", "F2", "F3"]);
    expect(listFindings({ view: "triage", run: run.id })).toHaveLength(0);
  });

  test("many at once: each item reports, files once; MCP can't set the disclosure", async () => {
    const run = makeRun("fd-bulk");
    for (let i = 1; i <= 3; i++) write(run.id, `F${i}-x${i}`, { state: "confirmed", severity: "medium" }, `# Bug ${i}\n`);
    checkFindings(run);
    const res = triageFindings(
      [
        { run: run.id, finding: "F1", disposition: "report" },
        { run: run.id, finding: "F2", disposition: "duplicate", duplicate_of: `${run.id}/F1` },
        { run: run.id, finding: "F3", disposition: "bogus" as any },
        { run: run.id, finding: "F9", disposition: "weak" },
      ],
      "MCP: laptop",
    );
    expect(res.map((r) => r.ok)).toEqual([true, true, false, false]);
    expect(listFindings({ run: run.id, disposition: "report,duplicate" }).map((f) => f.disposition_by)).toEqual(["MCP: laptop", "MCP: laptop"]);
    expect(listFindings({ run: run.id, disposition: "none" }).map((f) => f.id)).toEqual(["F3"]);

    const api = await call("POST", "/findings/triage", { items: [{ run: run.id, finding: "F3", disposition: "invalid" }] });
    expect(api.body).toMatchObject({ ok: 1, failed: 0 });
    expect((await call("POST", `/runs/${run.id}/findings/F1/disclosure`, { disclosure: "reported" }, { "x-pixel-mcp-token": "laptop" })).status).toBe(403);
    expect((await call("POST", `/runs/${run.id}/findings/F1/disclosure`, { disclosure: "reported" })).body.disclosure).toBe("reported");
  });

  test("search: every word somewhere, best match first, with the repo", () => {
    const a = makeRun("fd-s1");
    const b = makeRun("fd-s2");
    db.query("UPDATE runs SET repo = 'https://github.com/pnggroup/libpng' WHERE id IN ('fd-s1', 'fd-s2')").run();
    write(a.id, "F1-chunk", { state: "confirmed", location: "pngrutil.c:900" }, "# Auth bypass in chunk parser\n\nNo check of the length before the heap copy.\n");
    write(b.id, "F1-heap", { state: "confirmed", location: "pngread.c:12" }, "# Heap overflow in png_read\n\nThe chunk length is trusted.\n");
    checkFindings(a);
    checkFindings(b);
    expect(listFindings({ q: "heap chunk" }).map((f) => `${f.run_id}/${f.id}`)).toEqual(["fd-s2/F1", "fd-s1/F1"]);
    expect(listFindings({ q: '"auth bypass" pngrutil' }).map((f) => f.run_id)).toEqual(["fd-s1"]);
    expect(listFindings({ q: "heap", repo: "LIBPNG", run: a.id })).toHaveLength(1);
    expect(listFindings({ q: "nowhere" })).toHaveLength(0);
  });
});

describe("copy for LLM", () => {
  test("one text with the README, the PoC and small files inline, and a signed link to all of them", async () => {
    const run = makeRun("fd-llm");
    const dir = join(workbasePath(run.id), "findings/F2-iccp-overflow");
    mkdirSync(join(dir, "logs"), { recursive: true });
    writeFileSync(join(dir, "poc.py"), "print('```boom```')\n");
    writeFileSync(join(dir, "crash.bin"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(dir, "logs/asan.txt"), "ERROR: AddressSanitizer: heap-buffer-overflow\n");
    write(run.id, "F2-iccp-overflow", { state: "confirmed", severity: "high", location: "pngrutil.c:1184", poc: "poc.py" }, "# Heap overflow in iCCP\n\nRead past the end.\n");
    checkFindings(run);

    const brief = async () => {
      const res = await dispatch(new Request(`http://pixel.test/api/runs/${run.id}/findings/F2/llm`), new URL(`http://pixel.test/api/runs/${run.id}/findings/F2/llm`));
      return (await res.json()).text as string;
    };
    const text = await brief();
    expect(text).toContain("# F2: Heap overflow in iCCP");
    expect(text).toContain("- Location: pngrutil.c:1184");
    expect(text).toContain("state: confirmed"); // the README verbatim, header included
    expect(text).toContain("````\nprint('```boom```')\n````"); // a fence the file can't close
    expect(text).toContain("### logs/asan.txt");
    expect(text).toContain("- crash.bin (4 B)");
    expect(text).toContain("'http://pixel.test/api/share/F2.tar.gz'");
    expect(text).not.toMatch(/share\/[^'\s]*pxf_/); // the token is never in a URL
    const token = /PIXEL_TOKEN='(pxf_[\w-]+)'/.exec(text)![1];
    expect(db.query("SELECT COUNT(*) AS n FROM share_tokens WHERE hash = ?").get(token)).toEqual({ n: 0 }); // stored hashed

    const get = (path: string, t: string | null = token) => serveShare(new Request(`http://pixel.test${path}`, { headers: t ? { authorization: `Bearer ${t}` } : {} }), path);
    expect((await get("/api/share/F2.tar.gz", null)).status).toBe(401);
    expect((await get("/api/share/F2.tar.gz", token.slice(0, -2) + "xx")).status).toBe(401);
    expect((await get("/api/share/F1.tar.gz")).status).toBe(403); // another finding
    expect((await get("/api/share/F2/files/../../TRIAGE.md")).status).toBe(404); // only the finding's own files
    expect(await (await get("/api/share/F2/files/logs/asan.txt")).text()).toContain("heap-buffer-overflow");

    const files = await new Bun.Archive(await (await get("/api/share/F2.tar.gz")).blob()).files();
    expect([...files.keys()].sort()).toEqual(["F2/README.md", "F2/crash.bin", "F2/logs/asan.txt", "F2/poc.py"]);
    expect(await files.get("F2/logs/asan.txt")!.text()).toContain("heap-buffer-overflow");

    // Each copy gets its own token; an expired one stops working.
    const other = /PIXEL_TOKEN='(pxf_[\w-]+)'/.exec(await brief())![1];
    expect(other).not.toBe(token);
    db.query("UPDATE share_tokens SET expires = 0").run();
    expect((await get("/api/share/F2.tar.gz")).status).toBe(401);
  });

  test("the task follows the triage; prior art from the same project; a list as one text", async () => {
    const run = makeRun("fd-llm2");
    db.query("UPDATE runs SET repo = 'https://example.org/llm2' WHERE id = ?").run(run.id);
    write(run.id, "F1-a", { state: "confirmed", severity: "high", location: "a.c:10" }, "# Overflow in a\n\nThe length is trusted.\n");
    write(run.id, "F2-b", { state: "confirmed", severity: "medium", location: "b.c:20" }, "# Leak in b\n");
    checkFindings(run);
    triageFinding(run.id, "F2", { disposition: "known", note: "CVE-2024-0001" });
    const brief = async (q = "") => (await call("GET", `/runs/${run.id}/findings/F1/llm${q}`)).body;
    const check = await brief();
    expect(check.purpose).toBe("verify");
    expect(check.text).toContain("## Already triaged in this project (1)");
    expect(check.text).toContain(`- ${run.id}/F2 (known, medium): Leak in b, at b.c:20`);
    triageFinding(run.id, "F1", { disposition: "report", severity: "critical" });
    const disclose = await brief();
    expect(disclose.purpose).toBe("disclose");
    expect(disclose.text).toContain("- Triage (human): report, critical (the agent said high)");
    expect(disclose.text).toContain("Write the security report");
    expect((await brief("?purpose=variants")).text).toContain("search the rest of the codebase");
    expect((await brief("?purpose=nope")).text).toBeUndefined();

    const list = await call("POST", "/findings/llm", { ids: [`${run.id}/F1`, `${run.id}/F2`, `${run.id}/F9`], purpose: "triage", title: "To triage" });
    expect(list.body.count).toBe(2);
    expect(list.body.text).toContain("# To triage (2)");
    expect(list.body.text).toContain(`### ${run.id}/F1: Overflow in a`);
    expect(list.body.text).toContain("The length is trusted.");
    expect(list.body.text).toContain(`(Not found: ${run.id}/F9)`);
    expect(list.body.text).toContain("Answer as a table");
    expect(list.body.text).not.toContain("pxf_");
  });
});

describe("findings in a run (fake opencode)", () => {
  beforeAll(() => {
    seedTemplates();
    startWatchdog();
  });
  afterAll(async () => {
    stopWatchdog();
    for (const r of db.query<{ id: string }, []>("SELECT id FROM runs WHERE id LIKE 'fd-run%'").all()) await controls.deleteRun(r.id, true).catch(() => {});
  });

  test("a write under findings/ is picked up right away", async () => {
    const repo = join(config.dataDir, "fd-repo");
    mkdirSync(repo, { recursive: true });
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    for (const cmd of [["git", "init", "-q"], ["sh", "-c", "echo 'int main(){}' > main.c"], ["git", "add", "."], ["git", "commit", "-qm", "init"]]) Bun.spawnSync(cmd, { cwd: repo, env });
    const readme = "---\nstate: suspected\nseverity: high\n---\n# Stack overflow in parse_args\n\nargv copied into a fixed buffer\n";
    const prompt = [`WRITE ${JSON.stringify({ path: "{{workbase}}/findings/F1-parse-args/README.md", content: readme })}`, "REPORT {{workbase}}/REPORT.md"].join("\n");
    const run = createRun({ repo, templateId: "audit", name: "fd-run", promptOverride: prompt });
    const end = Date.now() + 15_000;
    while (Date.now() < end && !listFindings({ run: run.id }).length) await Bun.sleep(100);
    expect(listFindings({ run: run.id })[0]).toMatchObject({ id: "F1", state: "suspected", severity: "high", title: "Stack overflow in parse_args" });
    expect(existsSync(join(workbasePath(run.id), "FINDINGS.md"))).toBe(true);
  });
});

describe("upgrade", () => {
  test("verdicts become dispositions; a 'Triage: KNOWN, severity medium' note sets both, once", () => {
    const dir = join(config.dataDir, "upgrade-test");
    mkdirSync(dir, { recursive: true });
    const env = { ...process.env, PIXEL_DATA: dir };
    const bun = (code: string) => {
      const r = Bun.spawnSync(["bun", "-e", code], { env, cwd: join(import.meta.dir, "..") });
      if (r.exitCode) throw new Error(r.stderr.toString());
      return r.stdout.toString();
    };
    const db = (sql: string) => `import { db } from "./src/db.ts"; ${sql}`;
    // A database as it was before: findings with the verdict columns, schema 1.
    bun(
      db(`
      db.exec("INSERT INTO runs (id, repo, model, size, status, runtime, created_at) VALUES ('old', 'x', 'p/m', '{}', 'done', 'local', 1)");
      for (const c of ["severity_final", "agent_duplicate_of", "disclosure", "disclosure_note", "disclosure_at", "reported_at", "report_url", "fixed_at", "fix_ref"]) db.exec("ALTER TABLE findings DROP COLUMN " + c);
      for (const [a, b] of [["disposition", "verdict"], ["disposition_note", "verdict_note"], ["disposition_at", "verdict_at"], ["disposition_by", "verdict_by"]]) db.exec("ALTER TABLE findings RENAME COLUMN " + a + " TO " + b);
      const ins = db.query("INSERT INTO findings (run_id, id, state, severity, title, created, updated, verdict, verdict_note, verdict_at) VALUES ('old', ?, 'confirmed', 'high', 't', 1, 1, ?, ?, 5)");
      ins.run("F1", "real", null);
      ins.run("F2", "not_bug", "nope");
      ins.run("F3", "duplicate", null);
      ins.run("F4", "needs_work", null);
      ins.run("F5", "real", "Triage: KNOWN, severity medium. CVE-2024-1");
      ins.run("F6", "real", "Triage: REPORT, severity high");
      db.exec("PRAGMA user_version = 1");
    `),
    );
    const out = bun(db(`console.log(JSON.stringify(db.query("SELECT id, disposition, disposition_note, severity_final, disclosure FROM findings ORDER BY id").all()))`));
    expect(JSON.parse(out.trim().split("\n").pop()!)).toEqual([
      { id: "F1", disposition: "report", disposition_note: null, severity_final: null, disclosure: "ready" },
      { id: "F2", disposition: "invalid", disposition_note: "nope", severity_final: null, disclosure: null },
      { id: "F3", disposition: "duplicate", disposition_note: null, severity_final: null, disclosure: null },
      { id: "F4", disposition: null, disposition_note: null, severity_final: null, disclosure: null },
      { id: "F5", disposition: "known", disposition_note: "Triage: KNOWN, severity medium. CVE-2024-1", severity_final: "medium", disclosure: null },
      { id: "F6", disposition: "report", disposition_note: "Triage: REPORT, severity high", severity_final: null, disclosure: "ready" },
    ]);
    expect(existsSync(join(dir, "pre-upgrade.db"))).toBe(true);
    // Later starts leave a changed triage alone, whatever the note says.
    bun(db(`db.exec("UPDATE findings SET disposition = 'weak' WHERE id = 'F5'")`));
    expect(bun(db(`console.log(db.query("SELECT disposition FROM findings WHERE id = 'F5'").get().disposition)`)).trim()).toBe("weak");
  });
});
