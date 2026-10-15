#!/usr/bin/env bun
/**
 * Fill a scratch PIXEL_DATA with demo runs in every state (working, asking, recovering, failed, done,
 * triaged), with sessions, model calls, tool calls, todos, findings and reports, so the dashboard can be
 * looked at without real agents. Start Pixel on it with PIXEL_DETACHED=1 so nothing tries to reattach:
 *
 *   PIXEL_DATA=/tmp/pixel-demo bun server/test/seed-demo.ts
 *   PIXEL_DATA=/tmp/pixel-demo PIXEL_DETACHED=1 PIXEL_RUNTIME=local bun server/src/index.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

if (!process.env.PIXEL_DATA) throw new Error("set PIXEL_DATA to a scratch directory");
process.env.PIXEL_RUNTIME ??= "local";

const { db, addTimeline } = await import("../src/db.ts");
const { workbasePath, ensureWorkbase } = await import("../src/knowledge.ts");
const { syncFindings, setVerdict } = await import("../src/findings.ts");
const { seedTemplates } = await import("../src/templates.ts");

seedTemplates();
const S = 1000;
const M = 60 * S;
const H = 60 * M;
const now = Date.now();
let seq = 0;
let seed = 11;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const uid = (p: string) => `${p}_${(now + seq++).toString(36)}${seq}`;

interface Agent {
  title: string;
  started: number;
  /** tool calls: [kind tool, command] picked at random */
  tools: [string, Record<string, unknown>][];
  /** busy until (ms) */
  until?: number;
  parent?: string;
  done?: boolean;
}

function run(o: {
  id: string;
  label?: string;
  repo: string;
  ref?: string;
  status: string;
  detail?: string;
  started: number;
  finished?: number;
  model?: string;
  hue: number;
  agentStatus?: string;
  continues?: number;
  ooms?: number;
  report?: string;
  verdict?: string;
  triagedAt?: number;
  tps?: number;
  agents?: Agent[];
  todos?: [string, string][];
  question?: { text: string; options: string[]; at: number };
  findings?: any[];
  timeline?: [number, "pixel" | "user" | "agent", string, string][];
}) {
  const size = JSON.stringify({ cpu: 4, memoryGiB: 8, diskGiB: 60 });
  const root = uid("ses");
  db.query(
    `INSERT INTO runs (id, repo, ref, commit_sha, language, template_id, template_version, model, size, status, status_detail, runtime, session_id, agent_status, continues, oom_restarts,
      report_ready, created_at, started_at, finished_at, last_activity, triaged_at, triage_verdict, label, hue, key_failover, vm_name)
     VALUES (?, ?, ?, ?, 'C', 'audit', 1, ?, ?, ?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(
    o.id, o.repo, o.ref ?? "main", "3f9c2a71d0b8e4c5a6f7d8e9b0c1d2e3f4a5b6c7", o.model ?? "anthropic/claude-opus-4-5", size, o.status, o.detail ?? null, root, o.agentStatus ?? "busy",
    o.continues ?? 0, o.ooms ?? 0, o.report ? 1 : 0, o.started - 2 * M, o.started, o.finished ?? null, o.finished ?? now - 5 * S, o.triagedAt ?? null, o.verdict ?? null, o.label ?? null, o.hue, `local-${o.id}`,
  );
  ensureWorkbase(o.id);
  const end = o.finished ?? now;
  // sessions: root + subagents
  const sessions = [{ id: root, parent: null as string | null, title: o.label ?? o.id, started: o.started }];
  const agentSession = new Map<Agent, string>();
  for (const a of o.agents ?? []) {
    if (!a.parent && a.title === "main") {
      agentSession.set(a, root);
      continue;
    }
    const sid = uid("ses");
    agentSession.set(a, sid);
    sessions.push({ id: sid, parent: root, title: `${a.title} (@general subagent)`, started: a.started });
  }
  let costTotal = 0;
  const tokTotal = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  const perSession = new Map<string, { cost: number; tokens: typeof tokTotal }>();
  // model calls every ~40 s for every agent while it was busy; tool calls in between
  const agents = o.agents?.length ? o.agents : [{ title: "main", started: o.started, tools: [["read", { filePath: "src/main.c" }]] as [string, Record<string, unknown>][] }];
  for (const a of agents) {
    const sid = agentSession.get(a) ?? root;
    const stop = Math.min(end, a.until ?? end);
    let t = a.started;
    let ctx = 18_000;
    const acc = perSession.get(sid) ?? { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
    // older history sparser so the seed stays small; the last 40 minutes dense
    while (t < stop) {
      const recent = end - t < 40 * M;
      const dur = (recent ? 14 : 60) * S + rnd() * 30 * S;
      const created = t;
      const completed = Math.min(stop, t + dur);
      const out = Math.round(((o.tps ?? 50) / Math.max(1, agents.length)) * ((completed - created) / 1000) * (0.6 + rnd() * 0.8));
      ctx = Math.min(180_000, ctx + 1500 + rnd() * 2500);
      const read = Math.round(ctx * 0.86);
      const tokens = { input: Math.round(ctx - read), output: out, reasoning: Math.round(out * 0.2), cache: { read, write: Math.round(1500 + rnd() * 900) } };
      const cost = (tokens.input * 3 + tokens.cache.write * 3.75 + tokens.cache.read * 0.3 + (tokens.output + tokens.reasoning) * 15) / 1e6 / 6;
      const mid = uid("msg");
      const info = { id: mid, sessionID: sid, role: "assistant", time: { created, completed }, providerID: "anthropic", modelID: "claude-opus-4-5", tokens, cost };
      db.query("INSERT INTO messages (id, run_id, session_id, role, data, created_at) VALUES (?, ?, ?, 'assistant', ?, ?)").run(mid, o.id, sid, JSON.stringify(info), created);
      const [tool, input] = a.tools[Math.floor(rnd() * a.tools.length)];
      const ts = completed - 2 * S;
      const pid = uid("prt");
      const state = { status: completed >= now - 3 * S && !a.done ? "running" : "completed", input, output: "ok", title: tool, metadata: {}, time: { start: ts, end: ts + 1500 } };
      db.query("INSERT INTO parts (id, run_id, session_id, message_id, type, data, updated_at) VALUES (?, ?, ?, ?, 'tool', ?, ?)").run(pid, o.id, sid, mid, JSON.stringify({ id: pid, sessionID: sid, messageID: mid, type: "tool", tool, callID: uid("call"), state }), ts + 1500);
      if (recent && rnd() > 0.5) {
        const [tool2, input2] = a.tools[Math.floor(rnd() * a.tools.length)];
        const p2 = uid("prt");
        const ts2 = created + dur / 2;
        db.query("INSERT INTO parts (id, run_id, session_id, message_id, type, data, updated_at) VALUES (?, ?, ?, ?, 'tool', ?, ?)").run(p2, o.id, sid, mid, JSON.stringify({ id: p2, sessionID: sid, messageID: mid, type: "tool", tool: tool2, callID: uid("call"), state: { status: "completed", input: input2, output: "ok", title: tool2, metadata: {}, time: { start: ts2, end: ts2 + 900 } } }), ts2 + 900);
      }
      acc.cost += cost;
      acc.tokens.input += tokens.input;
      acc.tokens.output += tokens.output;
      acc.tokens.reasoning += tokens.reasoning;
      acc.tokens.cache.read += tokens.cache.read;
      acc.tokens.cache.write += tokens.cache.write;
      t = completed + (recent ? 4 : 30) * S;
    }
    perSession.set(sid, acc);
  }
  for (const s of sessions) {
    const acc = perSession.get(s.id) ?? { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
    db.query("INSERT INTO sessions (id, run_id, parent_id, title, agent, cost, tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(s.id, o.id, s.parent, s.title, s.parent ? "general" : "build", acc.cost, JSON.stringify(acc.tokens), s.started);
    costTotal += acc.cost;
    tokTotal.input += acc.tokens.input;
    tokTotal.output += acc.tokens.output;
    tokTotal.reasoning += acc.tokens.reasoning;
    tokTotal.cache.read += acc.tokens.cache.read;
    tokTotal.cache.write += acc.tokens.cache.write;
  }
  db.query("UPDATE runs SET tokens_in = ?, tokens_out = ?, tokens_reasoning = ?, tokens_cache = ?, cost = ? WHERE id = ?").run(tokTotal.input, tokTotal.output, tokTotal.reasoning, tokTotal.cache.read + tokTotal.cache.write, costTotal, o.id);
  // subagent task calls on the root session, so states come out right (running / done)
  for (const [a, sid] of agentSession) {
    if (sid === root) continue;
    const pid = uid("prt");
    const st = a.done ? "completed" : "running";
    db.query("INSERT INTO parts (id, run_id, session_id, message_id, type, data, updated_at) VALUES (?, ?, ?, ?, 'tool', ?, ?)").run(pid, o.id, root, uid("msg"), JSON.stringify({ id: pid, sessionID: root, type: "tool", tool: "task", state: { status: st, input: { description: a.title }, metadata: { sessionId: sid }, time: { start: a.started, end: a.done ? a.until : undefined } } }), a.started);
  }
  if (o.todos) db.query("INSERT INTO todos (session_id, run_id, data) VALUES (?, ?, ?)").run(root, o.id, JSON.stringify(o.todos.map(([status, content], i) => ({ id: String(i), content, status, priority: "medium" }))));
  if (o.question) {
    const qid = uid("que");
    db.query("INSERT INTO questions (id, run_id, session_id, data, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)").run(
      qid, o.id, root, JSON.stringify({ id: qid, sessionID: root, questions: [{ question: o.question.text, header: "Next step", options: o.question.options.map((label) => ({ label })) }] }), o.question.at,
    );
    addTimeline(o.id, "agent", "question", `Agent asked: ${o.question.text}`, undefined, o.question.at);
  }
  addTimeline(o.id, "user", "created", `Run created: ${o.repo}, ${o.model ?? "anthropic/claude-opus-4-5"}, template audit v1`, undefined, o.started - 2 * M);
  for (const [ts, actor, kind, msg] of o.timeline ?? []) addTimeline(o.id, actor, kind, msg, undefined, ts);
  // memory use for the fleet's memory bar
  if (["running", "recovering", "paused"].includes(o.status))
    db.query("INSERT INTO metrics (run_id, ts, cpu, mem_used, mem_total, disk_used, disk_total) VALUES (?, ?, ?, ?, ?, ?, ?)").run(o.id, now - 10 * S, 40 + rnd() * 50, (1 + rnd() * 2.5) * 1024 ** 3, 8 * 1024 ** 3, 12 * 1024 ** 3, 60 * 1024 ** 3);
  if (o.report) writeFileSync(join(workbasePath(o.id), "REPORT.md"), o.report);
  if (o.findings) {
    const file = { version: 1, next: o.findings.length + 1, findings: o.findings };
    mkdirSync(workbasePath(o.id), { recursive: true });
    writeFileSync(join(workbasePath(o.id), "FINDINGS.json"), JSON.stringify(file, null, 2));
    syncFindings(db.query<any, [string]>("SELECT * FROM runs WHERE id = ?").get(o.id), JSON.stringify(file));
  }
}

const iso = (t: number) => new Date(t).toISOString();
function finding(id: string, title: string, state: string, severity: string | null, at: number, extra: Record<string, unknown> = {}, history?: any[]) {
  return {
    id, title, state, ...(severity && { severity }), summary: (extra.summary as string) ?? title, location: extra.location, poc: extra.poc, class: extra.class,
    created: iso(at), updated: iso(history?.at(-1)?.at ? Date.parse(history.at(-1).at) : at), by: "ses_main", removed: extra.removed ?? null,
    history: history ?? [{ at: iso(at), by: "ses_main", action: "add", changes: {} }],
  };
}

const sh = (command: string): [string, Record<string, unknown>] => ["bash", { command }];
const rd = (filePath: string): [string, Record<string, unknown>] => ["read", { filePath }];
const ed = (filePath: string): [string, Record<string, unknown>] => ["edit", { filePath }];

run({
  id: "libpng-2026-10-14", label: "libpng chunk parsing", repo: "https://github.com/pnggroup/libpng", status: "running", started: now - (3 * H + 21 * M), hue: 0, tps: 64, continues: 1,
  agents: [
    { title: "main", started: now - (3 * H + 21 * M), tools: [["task", { description: "Fuzz the iCCP chunk handler" }], rd("pngrutil.c"), sh("grep -n png_inflate pngrutil.c")] },
    { title: "Build with ASan and UBSan", started: now - (3 * H + 12 * M), until: now - (2 * H + 40 * M), done: true, tools: [sh("cmake -DCMAKE_C_FLAGS=-fsanitize=address .."), sh("make -j4")] },
    { title: "Fuzz the iCCP chunk handler", started: now - 31 * M, tools: [sh("./fuzz/run.sh iccp -j3 -max_total_time=3600"), ed("fuzz/iccp_mutator.c"), rd("pngrutil.c:1150")] },
    { title: "Review the inflate window code", started: now - 23 * M, tools: [rd("pngrutil.c:1120-1260"), rd("pngpread.c"), sh("rg -n 'window_bits' .")] },
  ],
  todos: [["completed", "Build with ASan and UBSan"], ["completed", "Map chunk handlers and their length checks"], ["in_progress", "Fuzz iCCP with a profile-length mutator"], ["in_progress", "Review the inflate window code"], ["pending", "Check zTXt and iTXt for the same pattern"], ["pending", "Write up the iCCP overflow with a minimal PoC"]],
  findings: [
    finding("F1", "Heap overflow in iCCP decompression", "confirmed", "high", now - 52 * M, { location: "pngrutil.c:1184", poc: "poc/iccp-0041.png", class: "heap-buffer-overflow", summary: "The declared profile length sizes the buffer, but the 132-byte header is copied before anything checks that the length is at least 132. A 2.1 KB PNG declaring a 16-byte profile reads past the allocation." }, [
      { at: iso(now - 52 * M), by: "ses_main", action: "add", changes: {} },
      { at: iso(now - 10 * M), by: "ses_main", action: "update", changes: { state: ["suspected", "confirmed"], poc: [null, "poc/iccp-0041.png"] }, note: "Reproduced with the ASan build: heap-buffer-overflow READ of size 1" },
    ]),
    finding("F2", "sPLT entry count is not bounded by the chunk length", "suspected", "medium", now - 6 * M, { location: "pngrutil.c:1650", class: "integer-overflow", summary: "nentries comes from the chunk length divided by the entry size, but the multiplication for the allocation can wrap on 32-bit builds." }),
    finding("F3", "png_inflate trusts the declared profile length", "lead", null, now - 80 * M, { location: "pngrutil.c:1120" }),
    finding("F4", "tRNS length checks hold on every path", "ruled_out", "low", now - 2 * H, { location: "pngrutil.c:1760" }, [
      { at: iso(now - 2 * H), by: "ses_main", action: "add", changes: {} },
      { at: iso(now - 95 * M), by: "ses_main", action: "update", changes: { state: ["lead", "ruled_out"] }, note: "png_handle_tRNS checks the length against the palette size before copying" },
    ]),
  ],
  timeline: [[now - (2 * H + 5 * M), "pixel", "continue", 'Agent went idle without REPORT.md; sending "continue your work" (1/3)']],
});

run({
  id: "tinyxml2-2026-10-13", label: "tinyxml2 parser", repo: "https://github.com/leethomason/tinyxml2", status: "running", agentStatus: "busy", started: now - (5 * H + 2 * M), hue: 3, tps: 0, continues: 2,
  agents: [{ title: "main", started: now - (5 * H + 2 * M), until: now - 12 * M, tools: [rd("tinyxml2.cpp"), sh("./xmltest"), ed("fuzz/parse.cc")] }],
  question: { text: "I have two crashes in XMLDocument::Parse, both stack exhaustion from elements nested deeper than 25 000. Write them up, or skip stack exhaustion and keep looking for memory corruption?", options: ["Write both up, keep looking", "Skip stack exhaustion", "Stop and write the report"], at: now - 12 * M },
  todos: [["completed", "Build with sanitizers"], ["completed", "Fuzz XMLDocument::Parse"], ["in_progress", "Decide on the stack exhaustion crashes"]],
  findings: [finding("F1", "Stack exhaustion on deeply nested elements", "confirmed", "low", now - 70 * M, { location: "tinyxml2.cpp:1093", poc: "poc/deep.xml", class: "stack-overflow" })],
});

run({
  id: "expat-2026-10-13", repo: "https://github.com/libexpat/libexpat", status: "recovering", detail: "OOM-killed while linking the MSan build", started: now - (7 * H + 40 * M), hue: 2, tps: 58, ooms: 2,
  agents: [
    { title: "main", started: now - (7 * H + 40 * M), until: now - 2 * M, tools: [rd("lib/xmlparse.c"), sh("make check")] },
    { title: "Build the MSan variant", started: now - 50 * M, until: now - 2 * M, tools: [sh("clang -fsanitize=memory -o xmlwf ..."), sh("ninja -j8")] },
    { title: "Review entity expansion", started: now - 40 * M, until: now - 2 * M, tools: [rd("lib/xmlparse.c:5400"), rd("lib/xmltok.c")] },
  ],
  todos: [["completed", "Build with ASan"], ["in_progress", "Build the MSan variant"], ["pending", "Review entity expansion"]],
  findings: [finding("F1", "Stack exhaustion with deeply nested entity references", "suspected", "low", now - 3 * H, { location: "lib/xmlparse.c:5512" })],
  timeline: [[now - 2 * M - 10 * S, "pixel", "recover", "opencode is not answering; state: oom"], [now - 2 * M, "pixel", "recover", "Restarting opencode"]],
});

run({
  id: "zlib-2026-10-14", repo: "https://github.com/madler/zlib", status: "running", started: now - (1 * H + 26 * M), hue: 1, tps: 104,
  agents: [
    { title: "main", started: now - (1 * H + 26 * M), tools: [sh("python3 tools/window_edges.py"), rd("inflate.c"), rd("inftrees.c")] },
    { title: "Differential test against zlib-ng", started: now - 44 * M, tools: [sh("./difftest --streams 40000"), ed("tools/difftest.c")] },
    { title: "Read inflateBack", started: now - 20 * M, tools: [rd("infback.c:250"), rd("infback.c")] },
  ],
  todos: [["completed", "Build"], ["completed", "Map window handling"], ["in_progress", "Differential test against zlib-ng"], ["pending", "Write up"]],
  findings: [finding("F1", "Differential test against zlib-ng: 40 000 random streams, windowBits 8 to 15", "lead", null, now - 14 * M, { summary: "No differences so far; worth checking windowBits 8 with raw deflate." })],
});

run({
  id: "libxml2-2026-10-14", repo: "https://gitlab.gnome.org/GNOME/libxml2", status: "failed", detail: "git clone timed out after 10 min (gitlab.gnome.org)", started: now - 40 * M, finished: now - 28 * M, hue: 4, tps: 0, agents: [],
  timeline: [[now - 28 * M, "pixel", "failed", "Preparing failed: git clone timed out after 10 min (gitlab.gnome.org)"]],
});

run({
  id: "yaml-cpp-2026-10-12", label: "yaml-cpp", repo: "https://github.com/jbeder/yaml-cpp", status: "done", started: now - (21 * H + 10 * M), finished: now - (12 * H + 8 * M), hue: 5, tps: 40,
  agents: [{ title: "main", started: now - (21 * H + 10 * M), tools: [rd("src/nodebuilder.cpp"), sh("./util/parse poc/merge-scalar.yaml")], done: true }],
  todos: [["completed", "Build with ASan"], ["completed", "Fuzz the parser"], ["completed", "Write the report"]],
  report: "# yaml-cpp audit\n\nTwo confirmed bugs, both reachable from `YAML::Load` on untrusted input.\n\n## F1: Null dereference on a merge key that aliases a scalar\n\n`<<: *a` where the anchor is a scalar reaches `NodeBuilder::OnMapEnd` with a null map node.\n\n```\n./util/parse poc/merge-scalar.yaml\n```\n\nConfirmed with ASan (SEGV on unknown address 0x000000000000).\n\n## F2: Unbounded recursion on nested flow sequences\n\n`YAML::Load` on 40 000 nested `[` overflows the stack. Denial of service only.\n",
  findings: [
    finding("F1", "Null dereference on a merge key that aliases a scalar", "confirmed", "medium", now - (12 * H + 40 * M), { location: "nodebuilder.cpp:118", poc: "poc/merge-scalar.yaml", class: "null-deref" }),
    finding("F2", "Unbounded recursion on nested flow sequences", "confirmed", "low", now - (13 * H + 30 * M), { location: "singledocparser.cpp:52", poc: "poc/deep-flow.yaml", class: "stack-overflow" }),
  ],
  timeline: [[now - (12 * H + 8 * M), "pixel", "done", "REPORT.md written and the agent is idle: run done"]],
});

run({
  id: "sqlite-fts5-2026-10-12", label: "sqlite fts5", repo: "https://github.com/sqlite/sqlite", status: "triaged", verdict: "partly real", started: now - (30 * H), finished: now - 23 * H, triagedAt: now - 20 * H, hue: 0, tps: 30,
  agents: [{ title: "main", started: now - 30 * H, tools: [rd("ext/fts5/fts5_hash.c")], done: true }],
  report: "# sqlite fts5\n\nOne integer overflow that needs a 2 GB document.\n",
  findings: [finding("F1", "Integer overflow in fts5HashAddPoslistSize", "confirmed", "info", now - 23 * H, { location: "fts5_hash.c:212" })],
});
await setVerdict("sqlite-fts5-2026-10-12", "F1", "not_bug", "Needs a single 2 GB document; not reachable with the default SQLITE_MAX_LENGTH.");
await setVerdict("yaml-cpp-2026-10-12", "F2", "real", null);

console.log(`Seeded ${db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n} runs in ${process.env.PIXEL_DATA}`);
