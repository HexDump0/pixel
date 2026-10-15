/** The finding tools (opencode plugin), Pixel's sync of FINDINGS.json, verdicts, and a run through the fake opencode. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Findings } from "../../opencode-plugins/findings.ts";
import { db, getRun } from "../src/db.ts";
import { config } from "../src/config.ts";
import { workbasePath } from "../src/knowledge.ts";
import { checkFindings, findingCounts, findingEvents, findingsPath, listFindings, setVerdict } from "../src/findings.ts";
import { dispatch } from "../src/api/router.ts";
import "../src/api/index.ts";
import { controls, createRun, startWatchdog, stopWatchdog } from "../src/runs/index.ts";
import { seedTemplates } from "../src/templates.ts";

const size = JSON.stringify({ cpu: 2, memoryGiB: 4, diskGiB: 20 });
function makeRun(id: string, status = "running") {
  db.query("INSERT INTO runs (id, repo, model, size, status, runtime, created_at) VALUES (?, 'x', 'p/m', ?, ?, 'local', ?)").run(id, size, status, Date.now());
  mkdirSync(workbasePath(id), { recursive: true });
  return getRun(id)!;
}

const ctx = (sessionID = "ses_main") => ({ sessionID, messageID: "msg_1", agent: "build" }) as any;

async function tools(runId: string) {
  process.env.PIXEL_WORKBASE = workbasePath(runId);
  return (await Findings()).tool as Record<string, { execute: (a: any, c: any) => Promise<string> }>;
}

describe("finding tools", () => {
  test("add, update, remove, list; FINDINGS.json and FINDINGS.md written", async () => {
    const run = makeRun("fd-tools");
    const t = await tools(run.id);
    expect(await t.finding_list.execute({}, ctx())).toBe("No findings yet.");

    expect(await t.finding_add.execute({ title: "png_inflate trusts the declared length", summary: "Worth checking." }, ctx())).toStartWith("Added F1 (lead)");
    const add2 = await t.finding_add.execute({ title: "Heap overflow in iCCP", summary: "ASan read past the buffer", state: "suspected", severity: "high", location: "pngrutil.c:1184" }, ctx("ses_sub"));
    expect(add2).toStartWith("Added F2 (suspected, high)");

    await expect(t.finding_update.execute({ id: "F2", state: "confirmed" }, ctx())).rejects.toThrow(/note/);
    mkdirSync(join(workbasePath(run.id), "poc"), { recursive: true });
    writeFileSync(join(workbasePath(run.id), "poc/iccp.png"), "x");
    const up = await t.finding_update.execute({ id: "f2", state: "confirmed", poc: "poc/iccp.png", note: "reproduced with ASan" }, ctx());
    expect(up).toContain("state suspected → confirmed");
    expect(up).not.toContain("doesn't exist");
    expect(await t.finding_update.execute({ id: "1", state: "ruled_out", note: "length is checked earlier" }, ctx())).toContain("lead → ruled_out");
    expect(await t.finding_add.execute({ title: "Same iCCP overflow", summary: "dup", state: "suspected", poc: "poc/missing.png" }, ctx())).toContain("doesn't exist");
    expect(await t.finding_remove.execute({ id: "F3", reason: "duplicate", duplicate_of: "F2" }, ctx())).toBe("Removed F3.");
    await expect(t.finding_update.execute({ id: "F9", title: "x" }, ctx())).rejects.toThrow(/No finding F9/);
    await expect(t.finding_add.execute({ title: "x".repeat(121), summary: "s" }, ctx())).rejects.toThrow(/120/);

    const list = await t.finding_list.execute({}, ctx());
    expect(list.split("\n")).toHaveLength(2);
    expect(list.split("\n")[0]).toStartWith("F2 confirmed high");
    expect(await t.finding_list.execute({ include_removed: true }, ctx())).toContain("[removed: duplicate of F2]");

    const file = JSON.parse(readFileSync(findingsPath(run.id), "utf8"));
    expect(file.next).toBe(4);
    const f2 = file.findings.find((f: any) => f.id === "F2");
    expect(f2.history.map((h: any) => h.action)).toEqual(["add", "update"]);
    expect(f2.history[1].changes.state).toEqual(["suspected", "confirmed"]);
    const md = readFileSync(join(workbasePath(run.id), "FINDINGS.md"), "utf8");
    expect(md).toContain("## Confirmed");
    expect(md).toContain("Ruled out: length is checked earlier");
  });

  test("parallel calls from subagents don't lose writes", async () => {
    const run = makeRun("fd-parallel");
    const t = await tools(run.id);
    await Promise.all(Array.from({ length: 12 }, (_, i) => t.finding_add.execute({ title: `lead ${i}`, summary: "s" }, ctx(`ses_${i}`))));
    const file = JSON.parse(readFileSync(findingsPath(run.id), "utf8"));
    expect(new Set(file.findings.map((f: any) => f.id)).size).toBe(12);
  });
});

describe("findings sync", () => {
  test("file → table and events, once; verdicts written back and shown to the agent", async () => {
    const run = makeRun("fd-sync");
    const t = await tools(run.id);
    await t.finding_add.execute({ title: "UAF in png_free", summary: "s", state: "suspected", severity: "critical" }, ctx());
    expect(checkFindings(run)).toBe(1);
    expect(checkFindings(run)).toBe(0);
    await t.finding_update.execute({ id: "F1", state: "confirmed", note: "reproduced" }, ctx());
    expect(checkFindings(run, true)).toBe(1);
    expect(checkFindings(run, true)).toBe(0); // same history, no new events

    const [f] = listFindings({ run: run.id });
    expect(f).toMatchObject({ id: "F1", state: "confirmed", severity: "critical", session_id: "ses_main" });
    expect(findingCounts()[run.id]).toMatchObject({ total: 1, untriaged: 1, confirmed: 1 });
    const tl = db.query<{ message: string }, [string]>("SELECT message FROM timeline WHERE run_id = ? AND kind = 'finding' ORDER BY ts").all(run.id).map((r) => r.message);
    expect(tl).toEqual(["F1 added (suspected, critical): UAF in png_free", "F1 confirmed: UAF in png_free: reproduced"]);

    await setVerdict(run.id, "F1", "real", "nice one");
    expect(findingCounts()[run.id].untriaged).toBe(0);
    expect(listFindings({ untriaged: true, run: run.id })).toHaveLength(0);
    const triage = JSON.parse(readFileSync(join(workbasePath(run.id), ".pixel/triage.json"), "utf8"));
    expect(triage.findings.F1).toMatchObject({ verdict: "real", note: "nice one" });
    expect(readFileSync(join(workbasePath(run.id), "TRIAGE.md"), "utf8")).toContain("F1 UAF in png_free: **real**. nice one");
    expect(await t.finding_list.execute({}, ctx())).toContain("[triage: real: nice one]");
    // A later sync of the file doesn't touch the verdict.
    await t.finding_update.execute({ id: "F1", severity: "high" }, ctx());
    checkFindings(run, true);
    expect(listFindings({ run: run.id })[0]).toMatchObject({ severity: "high", verdict: "real" });
    expect(findingEvents({ run: run.id }).map((e) => e.action)).toEqual(["update", "verdict", "update", "add"]);
  });

  test("API: list, events, verdict, fleet-wide untriaged", async () => {
    const run = makeRun("fd-api");
    const t = await tools(run.id);
    await t.finding_add.execute({ title: "Integer overflow in png_read_chunk", summary: "s", state: "suspected", severity: "medium" }, ctx());
    checkFindings(run);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await dispatch(new Request(`http://x/api${path}`, { method, body: body ? JSON.stringify(body) : undefined }), new URL(`http://x/api${path}`));
      return { status: res.status, body: await res.json() };
    };
    expect((await call("GET", `/runs/${run.id}/findings`)).body).toHaveLength(1);
    expect((await call("GET", `/findings?untriaged=1`)).body.some((f: any) => f.run_id === run.id)).toBe(true);
    expect((await call("POST", `/runs/${run.id}/findings/F1/verdict`, { verdict: "bogus" })).status).toBe(400);
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

  test("a finding tool call is picked up right away", async () => {
    const repo = join(config.dataDir, "fd-repo");
    mkdirSync(repo, { recursive: true });
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    for (const cmd of [["git", "init", "-q"], ["sh", "-c", "echo 'int main(){}' > main.c"], ["git", "add", "."], ["git", "commit", "-qm", "init"]]) Bun.spawnSync(cmd, { cwd: repo, env });
    const prompt = [
      'FINDING {"tool":"finding_add","args":{"title":"Stack overflow in parse_args","summary":"argv copied into a fixed buffer","state":"suspected","severity":"high"}}',
      "REPORT {{workbase}}/REPORT.md",
    ].join("\n");
    const run = createRun({ repo, templateId: "audit", name: "fd-run", promptOverride: prompt });
    const end = Date.now() + 15_000;
    while (Date.now() < end && !listFindings({ run: run.id }).length) await Bun.sleep(100);
    expect(listFindings({ run: run.id })[0]).toMatchObject({ id: "F1", state: "suspected", severity: "high" });
    expect(existsSync(join(workbasePath(run.id), "FINDINGS.md"))).toBe(true);
  });
});
