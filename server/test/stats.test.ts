import { describe, expect, test } from "bun:test";
import { db } from "../src/db.ts";
import { modelStats, stats } from "../src/stats.ts";

const now = Date.now();
const H = 3_600_000;

const row = { repo: "x", model: "st/m", size: JSON.stringify({ cpu: 2, memoryGiB: 4, diskGiB: 20 }), runtime: "local" };
db.query("INSERT INTO runs (id, repo, model, size, status, runtime, created_at, started_at, finished_at, continues) VALUES (?, ?, ?, ?, 'done', ?, ?, ?, ?, 3)").run(
  "st-1", row.repo, row.model, row.size, row.runtime, now - 5 * H, now - 5 * H, now - 3 * H,
);
db.query("INSERT INTO findings (run_id, id, state, severity, title, created, updated, disposition) VALUES ('st-1', 'F1', 'confirmed', 'high', 't', ?, ?, 'report')").run(now - 4 * H, now - 4 * H);
db.query("INSERT INTO sessions (id, run_id, parent_id, created_at) VALUES ('st-root', 'st-1', NULL, ?), ('st-sub', 'st-1', 'st-root', ?)").run(now - 5 * H, now - 4 * H);
const msg = db.query("INSERT INTO messages (id, run_id, session_id, role, data, created_at) VALUES (?, 'st-1', 'st-root', ?, ?, ?)");
const call = (id: string, at: number, tokens: object, extra: object = {}) =>
  msg.run(id, "assistant", JSON.stringify({ id, role: "assistant", providerID: "stp", modelID: "m1", tokens, cost: 0.01, time: { created: at, completed: at + 2000 }, ...extra }), at);
call("st-m1", now - 4 * H, { input: 1000, output: 100, reasoning: 50, cache: { read: 0, write: 3000 } });
call("st-m2", now - 4 * H + 60_000, { input: 200, output: 100, reasoning: 0, cache: { read: 3000, write: 0 } });
call("st-m3", now - 2 * H, { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, { error: { name: "APIError", data: { message: "boom" } } });
call("st-m4", now - 2 * H, { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, { error: { name: "MessageAbortedError" } });
call("st-old", now - 40 * 24 * H, { input: 999, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
msg.run("st-user", "user", JSON.stringify({ role: "user" }), now - 4 * H);
const part = db.query("INSERT INTO parts (id, run_id, session_id, message_id, type, data, updated_at) VALUES (?, 'st-1', 'st-root', 'st-m1', 'tool', ?, ?)");
part.run("st-p1", JSON.stringify({ tool: "st_tool", state: { status: "completed", time: { start: now - H, end: now - H + 400 } } }), now - H);
part.run("st-p2", JSON.stringify({ tool: "st_tool", state: { status: "error", time: { start: now - H, end: now - H + 600 } } }), now - H);

describe("stats", () => {
  test("per-model and per-run totals with cache hit rate; aborted calls aren't errors", async () => {
    const s = await stats(7);
    const m = s.byModel.find((x) => x.provider === "stp")!;
    expect(m.calls).toBe(4);
    expect(m.input).toBe(1300);
    expect(m.cacheRead).toBe(3000);
    expect(m.cacheWrite).toBe(3000);
    expect(m.output).toBe(200);
    expect(m.reasoning).toBe(50);
    expect(m.errors).toBe(1);
    expect(m.hitRate).toBeCloseTo(3000 / 7300);
    expect(m.medianMs).toBe(2000);
    const r = s.byRun.find((x) => x.id === "st-1")!;
    expect(r.calls).toBe(4);
    expect(r.status).toBe("done");
  });

  test("window, buckets, tools, runs and system checks", async () => {
    const week = await stats(7);
    expect(week.window.bucketMs).toBe(6 * H);
    expect(week.series.length).toBe(28);
    expect(week.series.reduce((n, b) => n + b.calls, 0)).toBe(week.totals.calls);
    expect(week.tools.find((t) => t.tool === "st_tool")).toMatchObject({ n: 2, errors: 1, avgMs: 500, kind: "other" });
    expect(week.runs.dispositions.report).toBeGreaterThanOrEqual(1);
    expect(week.runs.agentMs).toBeGreaterThanOrEqual(2 * H);
    expect(week.system.checks.map((c) => c.name)).toContain("Data disk");
    expect(week.system.db.rows.messages).toBeGreaterThan(0);

    const day = await stats(1);
    expect(day.window.bucketMs).toBe(H);
    expect(day.series.length).toBe(24);
    // The 40-day-old call only shows up in the all-time totals and the 90-day window.
    expect((await stats(90)).byModel.find((x) => x.provider === "stp")!.calls).toBe(5);
    expect(week.allTime.calls).toBeGreaterThanOrEqual(5);
  });
});

test("stats: buckets start on the viewer's clock", async () => {
  const s = await stats(1, 330);
  expect((s.window.to + 330 * 60_000) % H).toBe(0);
  const d = await stats(30, 330);
  expect((d.window.to + 330 * 60_000) % (24 * H)).toBe(0);
});

test("one model: totals, speed from llm_calls, per-call averages, errors, runs; byModel gets speed", async () => {
  const llm = db.query(
    "INSERT INTO llm_calls (id, run_id, session_id, provider, model, created, first_token, completed, tokens_in, tokens_out, tokens_reasoning) VALUES (?, 'st-1', 'st-root', 'stp', 'm1', ?, ?, ?, 0, ?, 0)",
  );
  // 100 tok/s after 500 ms, 200 tok/s after 1500 ms; a 10-token answer says nothing about speed.
  llm.run("st-l1", now - 4 * H, now - 4 * H + 500, now - 4 * H + 1500, 100);
  llm.run("st-l2", now - 4 * H, now - 4 * H + 1500, now - 4 * H + 2500, 200);
  llm.run("st-l3", now - 4 * H, now - 4 * H + 100, now - 4 * H + 200, 10);

  const m = await modelStats("stp/m1", 7);
  expect(m.totals.calls).toBe(4);
  expect(m.allTime.calls).toBe(5);
  expect(m.speedSummary.measured).toBe(2);
  expect(m.speedSummary.tpsP50).toBe(200);
  expect(m.speedSummary.ttftP50).toBe(500);
  expect(m.errors).toEqual({ APIError: 1 });
  expect(m.aborted).toBe(1);
  // Per call, over the three that weren't aborted.
  expect(m.perCall.output).toBeCloseTo(200 / 3);
  expect(m.byRun[0]).toMatchObject({ id: "st-1", calls: 4, tpsP50: 200 });
  expect(m.series.reduce((n, b) => n + b.calls, 0)).toBe(4);
  expect(m.tpsSpread.reduce((n, b) => n + b.n, 0)).toBe(2);
  expect(m.speed.some((b) => b.tps === 200)).toBe(true);

  const s = await stats(7);
  expect(s.byModel.find((x) => x.provider === "stp")).toMatchObject({ tpsP50: 200, ttftP50: 500, runs: 1 });
  await expect(modelStats("nomodel", 7)).rejects.toThrow("provider/model");
});
