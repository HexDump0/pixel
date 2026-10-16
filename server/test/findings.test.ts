/** Findings as folders in the workbase (findings/F<n>-name/README.md): parsing, Pixel's sync, FINDINGS.md, verdicts, and a run through the fake opencode. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db, getRun } from "../src/db.ts";
import { config } from "../src/config.ts";
import { workbasePath } from "../src/knowledge.ts";
import { checkFindings, findingCounts, findingEvents, listFindings, parseReadme, setVerdict } from "../src/findings.ts";
import { dispatch } from "../src/api/router.ts";
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

    setVerdict(run.id, "F1", "real", "nice one");
    expect(findingCounts()[run.id].untriaged).toBe(0);
    expect(listFindings({ untriaged: true, run: run.id })).toHaveLength(0);
    expect(readFileSync(join(workbasePath(run.id), "TRIAGE.md"), "utf8")).toContain("F1 UAF in png_free: **real**. nice one");
    expect(readFileSync(join(workbasePath(run.id), "TRIAGE.md"), "utf8")).toContain("Result: 1 real (1 critical).");
    expect(findingCounts()[run.id]).toMatchObject({ real: 1, outcome: "1 real (1 critical)" });
    expect(JSON.parse(readFileSync(join(workbasePath(run.id), ".pixel/run.json"), "utf8")).triage).toBe("1 real (1 critical)");
    expect(readFileSync(join(workbasePath(run.id), "FINDINGS.md"), "utf8")).toContain("| png.c:40 | real |");
    expect(existsSync(join(workbasePath(run.id), ".pixel/triage.json"))).toBe(false);

    write(run.id, "F1-uaf-png-free", { state: "confirmed", severity: "high", location: "png.c:40", poc: "poc.png" }, "# UAF in png_free\n");
    checkFindings(run);
    expect(listFindings({ run: run.id })[0]).toMatchObject({ severity: "high", verdict: "real" });
    expect(findingEvents({ run: run.id }).sort((a, b) => a.seq - b.seq).map((e) => e.action)).toEqual(["add", "update", "verdict", "update"]);
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

  test("API: list, events, verdict, fleet-wide untriaged", async () => {
    const run = makeRun("fd-api");
    write(run.id, "F1-int-overflow", { state: "suspected", severity: "medium" }, "# Integer overflow in png_read_chunk\n");
    checkFindings(run);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await dispatch(new Request(`http://x/api${path}`, { method, body: body ? JSON.stringify(body) : undefined }), new URL(`http://x/api${path}`));
      return { status: res.status, body: await res.json() };
    };
    expect((await call("GET", `/runs/${run.id}/findings`)).body).toHaveLength(1);
    expect((await call("GET", `/findings?untriaged=1`)).body.some((f: any) => f.run_id === run.id)).toBe(true);
    expect((await call("POST", `/runs/${run.id}/findings/F1/verdict`, { verdict: "needs_work" })).status).toBe(400);
    expect((await call("POST", `/runs/${run.id}/findings/F1/verdict`, { verdict: "not_bug", note: "checked upstream" })).body).toMatchObject({ verdict: "not_bug", verdict_note: "checked upstream" });
    expect((await call("GET", `/runs/${run.id}/findings/events`)).body[0]).toMatchObject({ action: "verdict", changes: { verdict: [null, "not_bug"] } });
    const runs = (await call("GET", "/runs")).body;
    expect(runs.find((r: any) => r.id === run.id).findings).toMatchObject({ total: 1, untriaged: 0 });
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
