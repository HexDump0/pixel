import { describe, expect, test } from "bun:test";
import { db } from "../src/db.ts";
import { health, leaderboard, onMessage, onPartActivity, onRetry, speedTests, speedTestStatus, startSpeedTest } from "../src/providers.ts";

const addRun = (id: string, model: string, extra: Record<string, unknown> = {}) => {
  const row = { id, repo: "x", model, size: "{}", status: "running", runtime: "local", created_at: Date.now(), ...extra };
  const cols = Object.keys(row);
  db.query(`INSERT INTO runs (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...(Object.values(row) as any[]));
};

const assistant = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  sessionID: "ses-p",
  role: "assistant",
  providerID: "hp",
  modelID: "m1",
  time: { created: Date.now() - 5000 },
  tokens: { input: 1000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  cost: 0,
  ...over,
});

describe("capture", () => {
  test("a model call gets its first token, totals and errors", () => {
    addRun("pv-a", "hp/m1");
    const created = Date.now() - 5000;
    onMessage("pv-a", assistant("msg-1", { time: { created } }));
    onPartActivity("msg-1");
    const first = db.query<{ first_token: number }, []>("SELECT first_token FROM llm_calls WHERE id = 'msg-1'").get()!.first_token;
    expect(first).toBeGreaterThanOrEqual(created);
    onPartActivity("msg-1"); // later parts don't move it
    onMessage("pv-a", assistant("msg-1", { time: { created, completed: Date.now() }, tokens: { input: 1000, output: 400, reasoning: 100, cache: { read: 50, write: 0 } }, cost: 0.02 }));
    const row = db.query<any, []>("SELECT * FROM llm_calls WHERE id = 'msg-1'").get();
    expect(row).toMatchObject({ first_token: first, tokens_out: 400, tokens_reasoning: 100, tokens_cache: 50, cost: 0.02, error: null });

    // A 429 is a rate limit, recorded once however often the message updates.
    const err = { name: "APIError", data: { message: "Too Many Requests", statusCode: 429 } };
    onMessage("pv-a", assistant("msg-2", { error: err }));
    onMessage("pv-a", assistant("msg-2", { error: err, time: { created, completed: Date.now() } }));
    // Aborts are the user's doing, not the provider's.
    onMessage("pv-a", assistant("msg-3", { error: { name: "MessageAbortedError", data: {} } }));
    const events = db.query<{ kind: string }, []>("SELECT kind FROM provider_events WHERE run_id = 'pv-a'").all();
    expect(events.map((e) => e.kind)).toEqual(["ratelimit"]);
    expect(db.query<{ error: string | null }, []>("SELECT error FROM llm_calls WHERE id = 'msg-3'").get()!.error).toBeNull();
  });

  test("retries are recorded once per attempt", () => {
    addRun("pv-r", "hr/m");
    onRetry("pv-r", "hr/m", "ses-r", { attempt: 1, message: "Provider is overloaded" });
    onRetry("pv-r", "hr/m", "ses-r", { attempt: 1, message: "Provider is overloaded" });
    onRetry("pv-r", "hr/m", "ses-r", { attempt: 2, message: "socket hang up" });
    const rows = db.query<{ kind: string; provider: string; model: string }, []>("SELECT kind, provider, model FROM provider_events WHERE run_id = 'pv-r' ORDER BY id").all();
    expect(rows).toEqual([
      { kind: "ratelimit", provider: "hr", model: "m" },
      { kind: "retry", provider: "hr", model: "m" },
    ]);
  });

  test("user messages and messages without a model are ignored", () => {
    onMessage("pv-a", { id: "msg-u", role: "user", providerID: "hp", modelID: "m1" });
    onMessage("pv-a", { id: "msg-n", role: "assistant" });
    expect(db.query("SELECT id FROM llm_calls WHERE id IN ('msg-u', 'msg-n')").all()).toEqual([]);
  });
});

describe("health", () => {
  const call = db.query("INSERT INTO llm_calls (id, run_id, session_id, provider, model, created, first_token, completed, tokens_in, tokens_out, error) VALUES (?, ?, 's', 'hh', ?, ?, ?, ?, ?, ?, ?)");

  test("latency, speed, usage and state per provider/model", () => {
    addRun("pv-h", "hh/good");
    const now = Date.now();
    // Four healthy calls a minute ago: first token after 1, 2, 3, 4 s; 1000 tokens over 10 s = 100 tok/s.
    for (let i = 1; i <= 4; i++) call.run(`hh-${i}`, "pv-h", "good", now - 60_000, now - 60_000 + i * 1000, now - 60_000 + i * 1000 + 10_000, 2000, 1000, null);
    // Short answers say nothing about throughput and are left out of tok/s.
    call.run("hh-short", "pv-h", "good", now - 30_000, now - 29_000, now - 28_000, 100, 5, null);
    // Another model: 1 error in 2 calls, and a recent rate limit.
    call.run("hh-e1", "pv-h", "flaky", now - 60_000, null, now - 59_000, 0, 0, "APIError: boom");
    call.run("hh-e2", "pv-h", "flaky", now - 60_000, now - 59_000, now - 50_000, 10, 100, null);
    db.query("INSERT INTO provider_events (ts, run_id, provider, model, kind, message) VALUES (?, 'pv-h', 'hh', 'flaky', 'ratelimit', '429')").run(now - 1000);

    const rows = health(60).filter((h) => h.key.startsWith("hh/"));
    const good = rows.find((h) => h.key === "hh/good")!;
    const flaky = rows.find((h) => h.key === "hh/flaky")!;
    expect(good.calls).toBe(5);
    expect(good.ttft.p50).toBe(2000); // sorted [1000, 1000, 2000, 3000, 4000]
    expect(good.tps.p50).toBe(100);
    expect(good.state).toBe("ok");
    expect(good.requestsPerMin).toBe(1); // 5 calls in the last 5 minutes
    expect(good.tokensPerMin).toBe((4 * 3000 + 105) / 5);
    expect(good.buckets.length).toBe(30);
    expect(good.buckets.reduce((a, b) => a + b.calls, 0)).toBe(5);
    expect(flaky.errors).toBe(1);
    expect(flaky.rateLimits).toBe(1);
    expect(flaky.state).toBe("limited");
    expect(flaky.lastEvent?.kind).toBe("ratelimit");

    // Outside the window: gone.
    expect(health(5).find((h) => h.key === "hh/good")?.calls).toBe(5);
    call.run("hh-old", "pv-h", "old", now - 3 * 3_600_000, null, null, 0, 0, null);
    expect(health(60).some((h) => h.key === "hh/old")).toBe(false);
  });
});

describe("leaderboard", () => {
  test("finish rate, finding triage, cost per real finding and per one to report", () => {
    const h = 3_600_000;
    const t = Date.now() - 10 * h;
    addRun("lb-1", "lb/a", { status: "triaged", report_ready: 1, started_at: t, finished_at: t + 2 * h, cost: 3, tokens_in: 1000, tokens_out: 500, continues: 1 });
    addRun("lb-2", "lb/a", { status: "done", report_ready: 1, started_at: t, finished_at: t + 4 * h, cost: 5, tokens_in: 3000, tokens_out: 500 });
    addRun("lb-3", "lb/a", { status: "stopped", started_at: t, cost: 1, oom_restarts: 2 });
    addRun("lb-4", "lb/a", { status: "running", started_at: t, cost: 1 });
    addRun("lb-5", "lb/b", { status: "failed" });
    const verdict = db.query("INSERT INTO findings (run_id, id, state, severity, title, created, updated, disposition, removed_at) VALUES (?, ?, 'confirmed', ?, 't', 1, 1, ?, ?)");
    verdict.run("lb-1", "F1", "high", "report", null);
    verdict.run("lb-1", "F2", "low", "invalid", null);
    verdict.run("lb-2", "F1", "medium", "duplicate", null);
    verdict.run("lb-2", "F3", "low", "weak", null);
    verdict.run("lb-2", "F2", "medium", "report", 5); // removed: doesn't count

    const a = leaderboard().find((m) => m.model === "lb/a")!;
    // Duplicates count through the finding they repeat: triaged = report, weak, invalid.
    expect(a).toMatchObject({ runs: 4, active: 1, finished: 2, gaveUp: 1, triaged: 3, real: 2, report: 1, totalCost: 10, costPerReport: 10 });
    expect(a.finishRate).toBeCloseTo(2 / 3);
    expect(a.realRate).toBeCloseTo(2 / 3);
    expect(a.costPerReal).toBe(5);
    expect(a.avgCost).toBe(2.5);
    expect(a.avgTokens).toBe(1250);
    expect(a.avgContinues).toBe(0.25);
    expect(a.avgOom).toBe(0.5);
    expect(a.medianDuration).toBe(4 * h); // upper median of [2h, 4h]
    expect(a.verdicts).toEqual({ "report high": 1, invalid: 1, duplicate: 1, weak: 1 });

    const b = leaderboard().find((m) => m.model === "lb/b")!;
    expect(b).toMatchObject({ runs: 1, finished: 0, gaveUp: 1, finishRate: 0, realRate: null, costPerReal: null, medianDuration: null });
  });
});

describe("speed test", () => {
  const settle = async () => {
    for (let i = 0; i < 200 && speedTestStatus().running; i++) await Bun.sleep(50);
    expect(speedTestStatus().running).toBeNull();
  };

  test("times each model, rejects tool use and reports bad models", async () => {
    const { batch, models } = startSpeedTest(["fake/fast", "fake/broken", "fake/tool", "fake/missing", "nope/x", "fake/fast", "no-slash"]);
    expect(models).toEqual(["fake/fast", "fake/broken", "fake/tool", "fake/missing", "nope/x"]);
    expect(speedTestStatus()).toMatchObject({ running: batch, models });
    expect(() => startSpeedTest(["fake/fast"])).toThrow(/already running/);
    await settle();

    const rows = (speedTests() as any[]).filter((r) => r.batch === batch);
    const by = (m: string) => rows.find((r) => `${r.provider}/${r.model}` === m);
    expect(rows.length).toBe(5);
    const fast = by("fake/fast");
    expect(fast.ok).toBe(1);
    expect(fast.tokens_out).toBe(300);
    expect(fast.ttft_ms).toBeGreaterThanOrEqual(20);
    expect(fast.total_ms).toBeGreaterThanOrEqual(fast.ttft_ms + 250);
    expect(fast.tps).toBeGreaterThan(300 / 0.6);
    expect(fast.tps).toBeLessThan(300 / 0.25);
    expect(by("fake/broken")).toMatchObject({ ok: 0, error: "APIError: boom" });
    expect(by("fake/tool")).toMatchObject({ ok: 0, error: expect.stringContaining("tried to use a tool") });
    expect(by("fake/missing")).toMatchObject({ ok: 0, error: "unknown model for fake" });
    expect(by("nope/x")).toMatchObject({ ok: 0, error: expect.stringContaining("provider nope not configured") });
  }, 20_000);

  test("needs at least one provider/model", () => {
    expect(() => startSpeedTest(["", "plain"])).toThrow(/at least one/);
  });
});
