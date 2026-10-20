/**
 * Provider and model telemetry: one row per model call (time to first token, duration, tokens,
 * cost, error), provider retries/errors/rate limits, a per-model leaderboard across runs, and a
 * text-only speed test.
 *
 * Calls and events are captured from the run event streams in events.ts. The speed test uses a
 * throwaway `opencode serve` in an empty folder where every permission is "ask" and Pixel rejects
 * every request, so the model can only answer in text. The tools stay in the request: opencode's own
 * gateways (Zen, Go) refuse requests whose tool set differs from opencode's, so denying or
 * switching off tools breaks free and Go models.
 */
import { db, getRun, listRuns } from "./db.ts";
import { dispositionCounts } from "./knowledge.ts";
import { keyFor } from "./providerAccounts.ts";
import { publish } from "./bus.ts";
import { getSettings } from "./settings.ts";
import { OpencodeClient } from "./opencode.ts";
import { startScratchOpencode, type ScratchOpencode } from "./scratchOpencode.ts";

db.exec(`
CREATE TABLE IF NOT EXISTS llm_calls (
  id          TEXT PRIMARY KEY,               -- assistant message id
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  created     INTEGER NOT NULL,
  first_token INTEGER,
  completed   INTEGER,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  tokens_reasoning INTEGER NOT NULL DEFAULT 0,
  tokens_cache INTEGER NOT NULL DEFAULT 0,
  cost        REAL NOT NULL DEFAULT 0,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS llm_calls_model ON llm_calls(provider, model, created);

CREATE TABLE IF NOT EXISTS provider_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  run_id   TEXT,
  provider TEXT NOT NULL,
  model    TEXT NOT NULL,
  kind     TEXT NOT NULL,                     -- ratelimit | error | retry
  message  TEXT
);
CREATE INDEX IF NOT EXISTS provider_events_ts ON provider_events(ts);

CREATE TABLE IF NOT EXISTS speedtests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  batch      TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  provider   TEXT NOT NULL,
  model      TEXT NOT NULL,
  ttft_ms    INTEGER,
  total_ms   INTEGER,
  tokens_out INTEGER,
  tps        REAL,
  ok         INTEGER NOT NULL DEFAULT 0,
  error      TEXT
);
`);

// Which API key each call went out on, for cost per key (added after llm_calls first shipped).
if (!db.query<{ name: string }, []>("PRAGMA table_info(llm_calls)").all().some((c) => c.name === "key_id")) db.exec("ALTER TABLE llm_calls ADD COLUMN key_id TEXT");

const RATE_LIMIT = /rate.?limit|429|too many requests|quota|overloaded|capacity/i;

// ---- capture (called from events.ts) ----

const upsertCall = db.query(
  `INSERT INTO llm_calls (id, run_id, session_id, provider, model, created, first_token, completed, tokens_in, tokens_out, tokens_reasoning, tokens_cache, cost, error, key_id)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
   ON CONFLICT(id) DO UPDATE SET first_token = COALESCE(llm_calls.first_token, excluded.first_token), completed = excluded.completed,
     tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out, tokens_reasoning = excluded.tokens_reasoning,
     tokens_cache = excluded.tokens_cache, cost = excluded.cost, error = excluded.error`,
);
const addEvent = db.query("INSERT INTO provider_events (ts, run_id, provider, model, kind, message) VALUES (?, ?, ?, ?, ?, ?)");

/** Assistant messages we have seen, so part events can mark their first token. */
const assistant = new Map<string, { firstToken: number | null }>();
const erroredMessages = new Set<string>();
const lastRetry = new Map<string, number>();

function event(runId: string | null, provider: string, model: string, kind: string, message: string) {
  const ts = Date.now();
  addEvent.run(ts, runId, provider, model, kind, message.slice(0, 500));
  publish("*", "provider", { ts, run: runId, provider, model, kind, message });
}

export function onMessage(runId: string, info: any) {
  if (info?.role !== "assistant" || !info.providerID || !info.modelID) return;
  let seen = assistant.get(info.id);
  if (!seen) assistant.set(info.id, (seen = { firstToken: null }));
  const t = info.tokens ?? {};
  const err = info.error && info.error.name !== "MessageAbortedError" ? `${info.error.name}: ${info.error.data?.message ?? ""}`.slice(0, 300) : null;
  upsertCall.run(
    info.id,
    runId,
    info.sessionID,
    info.providerID,
    info.modelID,
    info.time?.created ?? Date.now(),
    seen.firstToken,
    info.time?.completed ?? null,
    t.input ?? 0,
    t.output ?? 0,
    t.reasoning ?? 0,
    (t.cache?.read ?? 0) + (t.cache?.write ?? 0),
    info.cost ?? 0,
    err,
    keyFor(getRun(runId), info.providerID)?.id ?? null,
  );
  if (info.time?.completed) assistant.delete(info.id);
  if (err && !erroredMessages.has(info.id)) {
    erroredMessages.add(info.id);
    const status = info.error.data?.statusCode;
    event(runId, info.providerID, info.modelID, status === 429 || RATE_LIMIT.test(err) ? "ratelimit" : "error", err);
  }
}

/** First streamed text, reasoning or tool part of an assistant message = its first token. */
export function onPartActivity(messageId: string | undefined) {
  if (!messageId) return;
  const seen = assistant.get(messageId);
  if (!seen || seen.firstToken) return;
  seen.firstToken = Date.now();
  db.query("UPDATE llm_calls SET first_token = ? WHERE id = ? AND first_token IS NULL").run(seen.firstToken, messageId);
}

/** opencode retrying a model call (rate limits, overloads, network errors). */
export function onRetry(runId: string, model: string, sessionId: string, status: any) {
  const key = `${sessionId}:${status?.attempt ?? ""}`;
  if (lastRetry.has(key)) return;
  lastRetry.set(key, Date.now());
  if (lastRetry.size > 500) lastRetry.delete(lastRetry.keys().next().value!);
  const [provider, ...rest] = model.split("/");
  const msg = String(status?.message ?? "retry");
  event(runId, provider, rest.join("/"), RATE_LIMIT.test(msg) ? "ratelimit" : "retry", `attempt ${status?.attempt ?? "?"}: ${msg}`);
}

// ---- health: the last hour, per provider/model ----

export const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

export interface CallRow {
  provider: string;
  model: string;
  created: number;
  first_token: number | null;
  completed: number | null;
  tokens_in: number;
  tokens_out: number;
  tokens_reasoning: number;
  error: string | null;
}

export const ttftOf = (c: CallRow) => (c.first_token && c.first_token >= c.created ? c.first_token - c.created : null);
/** Output speed while streaming; very short answers say little about throughput, so they're skipped. */
export const tpsOf = (c: CallRow) => {
  const out = c.tokens_out + c.tokens_reasoning;
  if (!c.first_token || !c.completed || out < 30) return null;
  const s = (c.completed - c.first_token) / 1000;
  return s > 0.2 ? out / s : null;
};

export function health(minutes = 60) {
  const now = Date.now();
  const from = now - minutes * 60_000;
  const BUCKETS = 30;
  const size = (now - from) / BUCKETS;
  const calls = db.query<CallRow, [number]>("SELECT provider, model, created, first_token, completed, tokens_in, tokens_out, tokens_reasoning, error FROM llm_calls WHERE created >= ?").all(from);
  const events = db.query<{ ts: number; provider: string; model: string; kind: string; message: string }, [number]>("SELECT ts, provider, model, kind, message FROM provider_events WHERE ts >= ? ORDER BY ts DESC").all(from);
  const limits = getSettings().providerLimits;
  const keys = new Set([...calls.map((c) => `${c.provider}/${c.model}`), ...events.map((e) => `${e.provider}/${e.model}`)]);
  return [...keys].sort().map((key) => {
    const cs = calls.filter((c) => `${c.provider}/${c.model}` === key);
    const es = events.filter((e) => `${e.provider}/${e.model}` === key);
    const buckets = Array.from({ length: BUCKETS }, (_, i) => {
      const b = cs.filter((c) => c.created >= from + i * size && c.created < from + (i + 1) * size);
      return {
        calls: b.length,
        ttft: pct(b.map(ttftOf).filter((x): x is number => x != null), 50),
        tps: pct(b.map(tpsOf).filter((x): x is number => x != null), 50),
        errors: b.filter((c) => c.error).length + es.filter((e) => e.ts >= from + i * size && e.ts < from + (i + 1) * size && e.kind !== "error").length,
      };
    });
    const ttfts = cs.map(ttftOf).filter((x): x is number => x != null);
    const tps = cs.map(tpsOf).filter((x): x is number => x != null);
    // Rate over the last 5 minutes, to compare with a provider's per-minute limits.
    const recent = cs.filter((c) => c.created >= now - 5 * 60_000);
    const tokensPerMin = recent.reduce((a, c) => a + c.tokens_in + c.tokens_out + c.tokens_reasoning, 0) / 5;
    const errors = cs.filter((c) => c.error).length;
    const rateLimits = es.filter((e) => e.kind === "ratelimit").length;
    const retries = es.filter((e) => e.kind === "retry").length;
    const errorRate = cs.length ? errors / cs.length : 0;
    return {
      key,
      calls: cs.length,
      ttft: { p50: pct(ttfts, 50), p90: pct(ttfts, 90) },
      tps: { p50: pct(tps, 50) },
      errors,
      rateLimits,
      retries,
      errorRate,
      tokensPerMin,
      requestsPerMin: recent.length / 5,
      limit: limits[key] ?? null,
      state: rateLimits > 0 && es.find((e) => e.kind === "ratelimit")!.ts > now - 10 * 60_000 ? "limited" : errorRate > 0.2 || retries > 3 ? "degraded" : cs.length ? "ok" : "idle",
      lastEvent: es[0] ?? null,
      buckets,
    };
  });
}

// ---- leaderboard: every run, grouped by model ----

export function leaderboard() {
  const runs = listRuns();
  const byRun = dispositionCounts();
  const callStats = db
    .query<CallRow, []>("SELECT provider, model, created, first_token, completed, tokens_in, tokens_out, tokens_reasoning, error FROM llm_calls")
    .all();
  const models = [...new Set(runs.map((r) => r.model))];
  return models
    .map((model) => {
      const rs = runs.filter((r) => r.model === model);
      const finished = rs.filter((r) => ["done", "triaged"].includes(r.status) || r.report_ready);
      const gaveUp = rs.filter((r) => ["stopped", "failed"].includes(r.status) && !r.report_ready);
      const closed = finished.length + gaveUp.length;
      const durations = finished.filter((r) => r.started_at && r.finished_at).map((r) => r.finished_at! - r.started_at!);
      // Triage across the model's runs: how many of its findings held up, and how many were worth reporting.
      const verdicts: Record<string, number> = {};
      let real = 0;
      let report = 0;
      let triaged = 0;
      for (const r of rs) {
        const v = byRun[r.id];
        if (!v) continue;
        for (const [sev, n] of Object.entries(v.reportBySeverity)) verdicts[`report ${sev}`] = (verdicts[`report ${sev}`] ?? 0) + n;
        for (const k of ["known", "duplicate", "weak", "invalid"] as const) if (v[k]) verdicts[k] = (verdicts[k] ?? 0) + v[k];
        // Real bugs: new, already public, or not worth disclosing. Duplicates count once, through the finding they repeat.
        real += v.report + v.known + v.weak;
        report += v.report;
        triaged += v.report + v.known + v.weak + v.invalid;
      }
      const cost = rs.reduce((a, r) => a + r.cost, 0);
      const tokens = rs.reduce((a, r) => a + r.tokens_in + r.tokens_out + r.tokens_reasoning, 0);
      const cs = callStats.filter((c) => `${c.provider}/${c.model}` === model);
      return {
        model,
        runs: rs.length,
        active: rs.filter((r) => ["preparing", "running", "recovering", "paused"].includes(r.status)).length,
        finished: finished.length,
        gaveUp: gaveUp.length,
        finishRate: closed ? finished.length / closed : null,
        medianDuration: pct(durations, 50),
        avgTokens: rs.length ? tokens / rs.length : 0,
        avgCost: rs.length ? cost / rs.length : 0,
        totalCost: cost,
        avgContinues: rs.length ? rs.reduce((a, r) => a + r.continues, 0) / rs.length : 0,
        avgOom: rs.length ? rs.reduce((a, r) => a + r.oom_restarts, 0) / rs.length : 0,
        triaged,
        real,
        realRate: triaged ? real / triaged : null,
        costPerReal: real ? cost / real : null,
        report,
        costPerReport: report ? cost / report : null,
        verdicts,
        calls: cs.length,
        ttftP50: pct(cs.map(ttftOf).filter((x): x is number => x != null), 50),
        tpsP50: pct(cs.map(tpsOf).filter((x): x is number => x != null), 50),
        callErrorRate: cs.length ? cs.filter((c) => c.error).length / cs.length : null,
      };
    })
    .sort((a, b) => b.runs - a.runs);
}

// ---- speed test: a fixed text-only prompt per model ----

const SPEED_PROMPT =
  "Write about 250 words explaining how a hash table resolves collisions, comparing separate chaining and open addressing. Plain prose in two or three paragraphs, no lists, no code, no headings.";
const SPEED_TIMEOUT_MS = 120_000;


let speedRunning: { batch: string; models: string[]; current: string | null } | null = null;

export function speedTestStatus() {
  return { running: speedRunning?.batch ?? null, models: speedRunning?.models ?? [], current: speedRunning?.current ?? null };
}

export function speedTests(limit = 200) {
  return db.query("SELECT * FROM speedtests ORDER BY ts DESC LIMIT ?").all(limit);
}

export function startSpeedTest(models: string[]) {
  if (speedRunning) throw new Error("a speed test is already running");
  const list = [...new Set(models.map((m) => m.trim()).filter((m) => m.includes("/")))].slice(0, 12);
  if (!list.length) throw new Error("pick at least one model (provider/model)");
  const batch = `st-${Date.now().toString(36)}`;
  speedRunning = { batch, models: list, current: null };
  void runSpeedTest(batch, list).finally(() => {
    speedRunning = null;
    publish("*", "speedtest", { batch, done: true });
  });
  return { batch, models: list };
}

/** Rejects every permission request and question while a speed test call is running. */
function rejectTools(client: OpencodeClient, tries: { n: number }) {
  let on = true;
  const loop = async () => {
    while (on) {
      for (const p of await client.pendingPermissions().catch(() => [])) {
        tries.n++;
        await client.replyPermission(p.id, "reject", p.sessionID).catch(() => {});
      }
      for (const q of await client.pendingQuestions().catch(() => [])) {
        tries.n++;
        await client.rejectQuestion(q.id, "Answer in text only; no tools or questions in this test.").catch(() => {});
      }
      await Bun.sleep(300);
    }
  };
  void loop();
  return { stop: () => void (on = false) };
}

/**
 * Send one prompt and follow it on the event stream until the session goes idle: when it was sent,
 * the first streamed token, when the last answer finished, output tokens, the text, or the error.
 */
async function promptAndWait(client: OpencodeClient, session: string, text: string, model: string, timeoutMs: number) {
  const r = { created: Date.now(), first: null as number | null, completed: null as number | null, out: 0, text: "", error: null as string | null };
  const ctl = new AbortController();
  const done = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    r.error ??= `no answer within ${timeoutMs / 1000}s`;
    done.resolve();
  }, timeoutMs);
  const texts = new Map<string, string>();
  const outs = new Map<string, number>();
  const finishedMsgs = new Set<string>();
  const connected = Promise.withResolvers<void>();
  void client
    .streamEvents((e) => {
      const p = e.properties ?? {};
      if (e.type === "server.connected") return connected.resolve();
      const sid = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID;
      if (sid !== session) return;
      if (e.type === "message.part.delta" && p.field === "text") r.first ??= Date.now();
      else if (e.type === "message.part.updated" && p.part?.type === "text") texts.set(p.part.id, p.part.text ?? "");
      else if (e.type === "message.updated" && p.info?.role === "assistant") {
        const info = p.info;
        // Timed on Pixel's clock like the start and the first token, when the answer is seen finishing.
        if (info.time?.completed && !finishedMsgs.has(info.id)) {
          finishedMsgs.add(info.id);
          r.completed = Date.now();
        }
        outs.set(info.id, (info.tokens?.output ?? 0) + (info.tokens?.reasoning ?? 0));
        if (info.error && info.error.name !== "MessageAbortedError") r.error = `${info.error.name}: ${info.error.data?.message ?? ""}`.slice(0, 300);
      } else if (e.type === "session.error" && p.error?.name !== "MessageAbortedError") r.error ??= `${p.error?.name ?? "error"}: ${p.error?.data?.message ?? ""}`.slice(0, 300);
      else if (e.type === "session.idle") done.resolve();
    }, ctl.signal)
    .catch(() => {})
    .finally(() => connected.resolve());
  await connected.promise;
  try {
    r.created = Date.now();
    await client.prompt(session, text, model, null);
    await done.promise;
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
  r.text = [...texts.values()].join("");
  r.out = [...outs.values()].reduce((a, b) => a + b, 0);
  return r;
}

async function runSpeedTest(batch: string, models: string[]) {
  const record = (model: string, r: { ttft?: number | null; total?: number | null; out?: number | null; tps?: number | null; ok: boolean; error?: string | null }) => {
    const [provider, ...rest] = model.split("/");
    const row = { batch, ts: Date.now(), provider, model: rest.join("/"), ttft_ms: r.ttft ?? null, total_ms: r.total ?? null, tokens_out: r.out ?? null, tps: r.tps ?? null, ok: r.ok ? 1 : 0, error: r.error ?? null };
    db.query("INSERT INTO speedtests (batch, ts, provider, model, ttft_ms, total_ms, tokens_out, tps, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      row.batch, row.ts, row.provider, row.model, row.ttft_ms, row.total_ms, row.tokens_out, row.tps, row.ok, row.error,
    );
    publish("*", "speedtest", { batch, result: row });
  };
  let oc: ScratchOpencode;
  try {
    oc = await startScratchOpencode("speedtest");
  } catch (e: any) {
    for (const m of models) record(m, { ok: false, error: e.message });
    return;
  }
  const client = oc.client;
  try {
    for (const model of models) {
      if (speedRunning) speedRunning.current = model;
      publish("*", "speedtest", { batch, current: model });
      const unknown = await oc.check(model);
      if (unknown) {
        record(model, { ok: false, error: unknown });
        continue;
      }
      const toolTries = { n: 0 };
      const guard = rejectTools(client, toolTries);
      try {
        const session = await client.createSession(`speed test ${model}`, model);
        const r = await promptAndWait(client, session.id, SPEED_PROMPT, model, SPEED_TIMEOUT_MS);
        if (toolTries.n) {
          record(model, { ok: false, error: "tried to use a tool instead of answering in text (rejected)" });
          continue;
        }
        if (r.error) {
          record(model, { ok: false, error: r.error });
          continue;
        }
        const streamS = r.first && r.completed ? (r.completed - r.first) / 1000 : null;
        record(model, {
          ttft: r.first ? r.first - r.created : null,
          total: (r.completed ?? Date.now()) - r.created,
          out: r.out,
          tps: streamS && streamS > 0.2 ? r.out / streamS : null,
          ok: r.text.trim().length > 0,
          error: r.text.trim() ? null : "empty answer",
        });
      } catch (e: any) {
        record(model, { ok: false, error: String(e.message ?? e).slice(0, 300) });
      } finally {
        guard.stop();
      }
    }
  } finally {
    await oc.stop();
  }
}

export type ProviderHealth = ReturnType<typeof health>;
export type Leaderboard = ReturnType<typeof leaderboard>;
