import { describe, expect, test } from "bun:test";
import { db, getRun } from "../src/db.ts";
import { runtime } from "../src/runtime/index.ts";
import { describeCall, fleetSnapshot, kindOf, lanes, recentActivity, startFleet, stopFleet } from "../src/fleet.ts";

const now = Date.now();
const S = 1000;

function addRun(id: string, extra: Record<string, unknown> = {}) {
  const row = { id, repo: "x", model: "fl/m", size: JSON.stringify({ cpu: 2, memoryGiB: 4, diskGiB: 20 }), status: "running", runtime: "local", created_at: now - 3_600_000, ...extra };
  const cols = Object.keys(row);
  db.query(`INSERT INTO runs (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...(Object.values(row) as any[]));
}
const addSession = (id: string, run: string, parent: string | null, title: string, created: number) =>
  db.query("INSERT INTO sessions (id, run_id, parent_id, title, created_at) VALUES (?, ?, ?, ?, ?)").run(id, run, parent, title, created);
let n = 0;
function addTool(run: string, session: string, tool: string, state: Record<string, unknown>, updated: number) {
  const id = `prt-fl-${n++}`;
  const part = { id, sessionID: session, messageID: "m", type: "tool", tool, callID: id, state };
  db.query("INSERT INTO parts (id, run_id, session_id, message_id, type, data, updated_at) VALUES (?, ?, ?, 'm', 'tool', ?, ?)").run(id, run, session, JSON.stringify(part), updated);
}

// One running run: the main agent is waiting on a subagent that is building; another subagent finished.
addRun("fl-1", { session_id: "fl-root", agent_status: "busy", cost: 2.5, vm_name: "vm-1" });
const target = runtime.paths(getRun("fl-1")!).target;
addSession("fl-root", "fl-1", null, "audit", now - 3_600_000);
addSession("fl-done", "fl-1", "fl-root", "Map the API (@general subagent)", now - 300 * S);
addSession("fl-child", "fl-1", "fl-root", "Look at parser (@general subagent)", now - 60 * S);
addTool("fl-1", "fl-root", "read", { status: "completed", input: { filePath: `${target}/src/a.c`, offset: 10 }, time: { start: now - 400 * S, end: now - 399 * S } }, now - 399 * S);
addTool("fl-1", "fl-root", "task", { status: "completed", input: { description: "Map the API" }, metadata: { sessionId: "fl-done" }, time: { start: now - 300 * S, end: now - 200 * S } }, now - 200 * S);
addTool("fl-1", "fl-root", "task", { status: "running", input: { description: "Look at parser" }, metadata: { sessionId: "fl-child" }, time: { start: now - 60 * S } }, now - 60 * S);
addTool("fl-1", "fl-child", "bash", { status: "running", input: { command: `make -C ${target}/src` }, time: { start: now - 10 * S } }, now - 10 * S);
db.query("INSERT INTO timeline (run_id, ts, actor, kind, message) VALUES ('fl-1', ?, 'pixel', 'recover', 'restarted opencode')").run(now - 90 * S);
// Context: the newest assistant message is still streaming (no counts yet), so the one before counts.
const msg = db.query("INSERT INTO messages (id, run_id, session_id, role, data, created_at) VALUES (?, 'fl-1', 'fl-root', 'assistant', ?, ?)");
msg.run("fl-m1", JSON.stringify({ tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 500, write: 0 } } }), now - 50 * S);
msg.run("fl-m2", JSON.stringify({ tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }), now - 5 * S);
db.query("INSERT INTO metrics (run_id, ts, cpu, mem_used, mem_total, cost) VALUES ('fl-1', ?, 0.5, ?, NULL, 2.5)").run(now - 10 * S, 1024 ** 3);
db.query("INSERT INTO cross_reads (run_id, other_run, tool, path, ts) VALUES ('fl-1', 'zlib-1', 'read', 'REPORT.md', ?)").run(now);

// A stopped run whose subagent never finished, and a run triaged two days ago (archived).
addRun("fl-2", { status: "stopped", session_id: "fl2-root", finished_at: now - 100 * S });
addSession("fl2-root", "fl-2", null, "audit", now - 3_600_000);
addSession("fl2-child", "fl-2", "fl2-root", "Fuzz it", now - 500 * S);
addTool("fl-2", "fl2-root", "task", { status: "error", error: "Tool execution aborted", input: { description: "Fuzz it" }, metadata: { sessionId: "fl2-child", interrupted: true }, time: { start: now - 500 * S, end: now - 100 * S } }, now - 100 * S);
addRun("fl-3", { status: "triaged", triaged_at: now - 2 * 86_400_000 });

describe("fleet", () => {
  test("tool kinds and one-line descriptions with the run's paths shortened", () => {
    const run = getRun("fl-1")!;
    expect(kindOf("bash")).toBe("shell");
    expect(kindOf("grep")).toBe("read");
    expect(kindOf("apply_patch")).toBe("edit");
    expect(kindOf("mystery")).toBe("other");
    expect(describeCall(run, "read", { input: { filePath: `${target}/src/a.c`, offset: 118 } })).toBe("src/a.c:118");
    expect(describeCall(run, "bash", { input: { command: `cd ${target} &&\n  make   -j4` } })).toBe("cd . && make -j4");
    expect(describeCall(run, "grep", { input: { pattern: "memcpy", path: `${target}/lib` } })).toBe("memcpy lib");
    expect(describeCall(run, "bash", { input: { command: `cp out ${runtime.paths(run).scratch}/x` } })).toBe("cp out scratch/x");
    expect(describeCall(undefined, "custom", { title: "did a thing" })).toBe("did a thing");
  });

  test("snapshot: agents, activity, context, machine, spend and links", async () => {
    const snap = await fleetSnapshot();
    const ids = snap.runs.map((r) => r.id);
    expect(ids).toContain("fl-1");
    expect(ids).toContain("fl-2");
    expect(ids).not.toContain("fl-3");

    const r = snap.runs.find((x) => x.id === "fl-1")!;
    expect(r.agents.main).toBe("waiting");
    expect(r.now).toMatchObject({ tool: "task", kind: "task", text: "Look at parser", status: "running" });
    const subs = Object.fromEntries(r.agents.subs.map((s) => [s.id, s]));
    expect(subs["fl-child"]).toMatchObject({ title: "Look at parser", status: "running", parent: null, now: { tool: "bash", kind: "shell", text: "make -C src" } });
    expect(subs["fl-done"]).toMatchObject({ title: "Map the API", status: "done" });

    expect(r.activity.length).toBe(60);
    expect(r.activity.reduce((a, b) => a + b.n, 0)).toBe(4);
    expect(r.activity.filter((b) => b.alert).length).toBe(1);
    expect(r.activity[59]).toMatchObject({ n: 1, k: "shell" });

    expect(r.context).toEqual({ used: 1700, limit: null });
    expect(r.cpu).toBe(0.5);
    expect(r.mem).toEqual({ used: 1024 ** 3, total: 4 * 1024 ** 3 });
    expect(r.disk.total).toBe(20 * 1024 ** 3);
    expect(r.machine.name).toBe("vm-1");

    const stopped = snap.runs.find((x) => x.id === "fl-2")!;
    expect(stopped.agents.main).toBe("finished");
    expect(stopped.agents.subs[0].status).toBe("interrupted");
    expect(stopped.cpu).toBeNull();

    expect(snap.spend.total).toBeGreaterThanOrEqual(2.5);
    expect(snap.spend.hourly.length).toBe(new Date(now).getHours() + 1);
    expect(snap.spend.projected).toBeGreaterThanOrEqual(snap.spend.total);
    expect(snap.links).toContainEqual(expect.objectContaining({ run_id: "fl-1", other_run: "zlib-1", n: 1 }));
    expect(snap.memory.total).toBeGreaterThan(0);
  });

  test("swimlanes: segments per agent and Pixel's interventions", () => {
    const l = lanes("fl-1", 30)!;
    expect(l.lanes.map((x) => x.title)).toEqual(["Main agent", "Look at parser"]);
    const [main, child] = l.lanes;
    expect(main.segs.map((s) => s[2])).toEqual(["read", "task", "task"]);
    expect(main.segs[1]).toEqual([now - 300 * S, now - 200 * S, "task"]);
    expect(main.marks).toContainEqual([now - 90 * S, "recover"]);
    expect(child.sub).toBe(true);
    expect(child.segs[0][0]).toBe(now - 10 * S);
    expect(child.segs[0][1]).toBeGreaterThanOrEqual(now); // still running: runs to "now"
    // A short window clips older calls.
    expect(lanes("fl-1", 2)!.lanes[0].segs.length).toBe(1);
    expect(lanes("nope", 30)).toBeNull();
  });

  test("recent activity: tool calls and timeline, newest first", () => {
    const a = recentActivity(10, "fl-1");
    expect(a.calls.length).toBe(4);
    expect(a.calls[0]).toMatchObject({ agent: "Look at parser", tool: "bash", text: "make -C src", status: "running" });
    expect(a.calls[3]).toMatchObject({ agent: null, tool: "read", text: "src/a.c:10" });
    expect(a.events).toEqual([expect.objectContaining({ kind: "recover", actor: "pixel" })]);
    expect(recentActivity(1, "fl-1").calls.length).toBe(1);
  });

  test("tokens per second are sampled every second for active runs", async () => {
    startFleet();
    try {
      await Bun.sleep(1200);
      db.query("UPDATE runs SET tokens_in = tokens_in + 500, tokens_out = tokens_out + 20 WHERE id = 'fl-1'").run();
      await Bun.sleep(1100);
    } finally {
      stopFleet();
    }
    const snap = await fleetSnapshot();
    const tps = snap.runs.find((r) => r.id === "fl-1")!.tps;
    expect(tps.length).toBe(snap.window);
    expect(tps).toContain(520);
    expect(snap.runs.find((r) => r.id === "fl-2")!.tps).toEqual([]);
  });
});
