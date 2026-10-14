import { describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { db, getRun } from "../src/db.ts";
import { workbasePath } from "../src/knowledge.ts";
import { checkAllProgress, checkProgress, diffCounts, lineDiff, progressDiff, progressOf, progressPath } from "../src/progress.ts";
import { dispatch } from "../src/api/router.ts";
import "../src/api/index.ts";

const size = JSON.stringify({ cpu: 2, memoryGiB: 4, diskGiB: 20 });
function makeRun(id: string, status = "running", finished_at: number | null = null) {
  db.query("INSERT INTO runs (id, repo, model, size, status, runtime, created_at, finished_at) VALUES (?, 'x', 'p/m', ?, ?, 'local', ?, ?)").run(id, size, status, Date.now(), finished_at);
  mkdirSync(workbasePath(id), { recursive: true });
  return getRun(id)!;
}

/** Write PROGRESS.md with an explicit mtime, so two writes in the same millisecond still look different. */
let tick = 1_700_000_000;
function write(id: string, text: string) {
  writeFileSync(progressPath(id), text);
  utimesSync(progressPath(id), tick, tick++);
}

describe("lineDiff", () => {
  test("marks added and removed lines, removals first, keeps the whole file", () => {
    expect(lineDiff("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual([" a", "-b", "+B", " c", "+d"]);
    expect(lineDiff("", "x\ny")).toEqual(["+x", "+y"]);
    expect(lineDiff("x\n", "")).toEqual(["-x"]);
    expect(diffCounts("a\nb\nc", "a\nc\nd\ne")).toEqual({ added: 2, removed: 1 });
  });
});

describe("PROGRESS.md", () => {
  test("each distinct version is stored once; identical rewrites are ignored", () => {
    const run = makeRun("pg-1");
    expect(checkProgress(run)).toBe(false); // no file yet
    expect(progressOf(run.id)).toEqual({ content: null, updated_at: null, versions: [] });

    write(run.id, "## Trying\n- fuzz iCCP\n");
    expect(checkProgress(run)).toBe(true);
    expect(checkProgress(run)).toBe(false); // same stat
    write(run.id, "## Trying\n- fuzz iCCP\n");
    expect(checkProgress(run)).toBe(false); // new mtime, same content

    write(run.id, "## Trying\n- fuzz zTXt\n## Found\n- crash in png_inflate\n");
    expect(checkProgress(run)).toBe(true);

    const p = progressOf(run.id);
    expect(p.content).toContain("png_inflate");
    expect(p.versions).toHaveLength(2);
    expect(p.versions[0]).toMatchObject({ added: 3, removed: 1 });
    expect(p.versions[1]).toMatchObject({ added: 2, removed: 0 });
    expect(getRun(run.id)!.progress_at).toBe(p.updated_at);

    const kinds = db.query<{ message: string }, [string]>("SELECT message FROM timeline WHERE run_id = ? AND kind = 'progress' ORDER BY id").all(run.id).map((t) => t.message);
    expect(kinds).toEqual(["Wrote PROGRESS.md", "Updated PROGRESS.md (+3 −1 lines)"]);

    // Default diff: latest against the version before it. from=0: against nothing.
    expect(progressDiff(run.id)!.lines).toEqual([" ## Trying", "-- fuzz iCCP", "+- fuzz zTXt", "+## Found", "+- crash in png_inflate"]);
    expect(progressDiff(run.id, 0)!.lines.every((l) => l.startsWith("+"))).toBe(true);
    const first = p.versions[1].ts;
    expect(progressDiff(run.id, undefined, first)).toMatchObject({ from: null, to: first });
  });

  test("huge files are cut", () => {
    const run = makeRun("pg-2");
    write(run.id, "x".repeat(200 * 1024));
    checkProgress(run);
    const c = progressOf(run.id).content!;
    expect(c.length).toBeLessThan(70 * 1024);
    expect(c).toContain("cut at 64 KB");
  });

  test("the poll covers live and just-finished runs, not old ones", () => {
    const live = makeRun("pg-3");
    const recent = makeRun("pg-4", "done", Date.now() - 60_000);
    const old = makeRun("pg-5", "done", Date.now() - 86_400_000);
    for (const r of [live, recent, old]) write(r.id, `status of ${r.id}\n`);
    checkAllProgress();
    expect(getRun(live.id)!.progress_at).not.toBeNull();
    expect(getRun(recent.id)!.progress_at).not.toBeNull();
    expect(getRun(old.id)!.progress_at).toBeNull();
  });

  test("API: current + versions, diff, one version", async () => {
    const run = makeRun("pg-6");
    write(run.id, "one\n");
    checkProgress(run);
    write(run.id, "one\ntwo\n");
    checkProgress(run);
    const call = async (path: string) => (await dispatch(new Request(`http://x/api${path}`), new URL(`http://x/api${path}`))).json();
    const p = await call(`/runs/${run.id}/progress`);
    expect(p.content).toBe("one\ntwo\n");
    expect(p.versions).toHaveLength(2);
    expect((await call(`/runs/${run.id}/progress/diff`)).lines).toEqual([" one", "+two"]);
    expect((await call(`/runs/${run.id}/progress/${p.versions[1].ts}`)).content).toBe("one\n");
    expect((await call(`/runs/pg-none/progress/diff`)).error).toBeTruthy();
  });
});
