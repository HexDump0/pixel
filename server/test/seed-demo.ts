#!/usr/bin/env bun
/**
 * Fill a scratch PIXEL_DATA with demo runs in every state (working, asking, recovering, failed, done,
 * triaged), with sessions, model calls, tool calls, todos, findings and reports, so the dashboard can be
 * looked at without real agents. Start Pixel on it with PIXEL_DETACHED=1 so nothing tries to reattach:
 *
 *   PIXEL_DATA=/tmp/pixel-demo bun server/test/seed-demo.ts
 *   PIXEL_DATA=/tmp/pixel-demo PIXEL_DETACHED=1 PIXEL_RUNTIME=local bun server/src/index.ts
 */
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

if (!process.env.PIXEL_DATA) throw new Error("set PIXEL_DATA to a scratch directory");
process.env.PIXEL_RUNTIME ??= "local";

const { db, addTimeline } = await import("../src/db.ts");
const { config } = await import("../src/config.ts");
const { workbasePath, ensureWorkbase } = await import("../src/knowledge.ts");
const { syncFindings, setVerdict } = await import("../src/findings.ts");
const { seedTemplates, render } = await import("../src/templates.ts");

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
  /** what the agent says now and then (generic remarks otherwise) */
  notes?: string[];
  /** your messages to the agent: [time, text] */
  messages?: [number, string][];
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
  // The prompt the run was started with, as the root session's first message.
  const promptText = render(readFileSync(join(import.meta.dir, "../../templates/audit.md"), "utf8"), {
    target: `/workspace/${o.repo.split("/").pop()}`, repo: o.repo, ref: o.ref ?? "main", commit: "3f9c2a7", workbase: "/workbase", workbases: "/workbases", scratch: "/scratch", disk_gib: "60",
    machine: "4 CPUs and 8 GB of memory; you are root.", previous_workbase: null,
  });
  userMessage(o.id, root, o.started, promptText);
  for (const [at, text] of o.messages ?? []) userMessage(o.id, root, at, text);
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
      if (rnd() < 0.15) addPart(o.id, sid, mid, created + S, { type: "reasoning", text: pick(THOUGHTS) });
      if (rnd() < (sid === root ? 0.3 : 0.15)) addPart(o.id, sid, mid, created + 2 * S, { type: "text", text: pick(o.notes ?? REMARKS) });
      const [tool, input] = a.tools[Math.floor(rnd() * a.tools.length)];
      const ts = completed - 2 * S;
      const pid = uid("prt");
      const running = completed >= now - 3 * S && !a.done;
      const state = running ? { status: "running", input, title: titleOf(tool, input), metadata: {}, time: { start: ts } } : toolState(tool, input, ts, 1500);
      db.query("INSERT INTO parts (id, run_id, session_id, message_id, type, data, updated_at) VALUES (?, ?, ?, ?, 'tool', ?, ?)").run(pid, o.id, sid, mid, JSON.stringify({ id: pid, sessionID: sid, messageID: mid, type: "tool", tool, callID: uid("call"), state }), ts + 1500);
      if (recent && rnd() > 0.5) {
        const [tool2, input2] = a.tools[Math.floor(rnd() * a.tools.length)];
        const p2 = uid("prt");
        const ts2 = created + dur / 2;
        db.query("INSERT INTO parts (id, run_id, session_id, message_id, type, data, updated_at) VALUES (?, ?, ?, ?, 'tool', ?, ?)").run(p2, o.id, sid, mid, JSON.stringify({ id: p2, sessionID: sid, messageID: mid, type: "tool", tool: tool2, callID: uid("call"), state: toolState(tool2, input2, ts2, 900) }), ts2 + 900);
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
    db.query("INSERT INTO parts (id, run_id, session_id, message_id, type, data, updated_at) VALUES (?, ?, ?, ?, 'tool', ?, ?)").run(pid, o.id, root, uid("msg"), JSON.stringify({ id: pid, sessionID: root, type: "tool", tool: "task", state: { status: st, input: { description: a.title, subagent_type: "general" }, title: a.title, output: a.done ? `Done: ${a.title}. Build is in /scratch/build-asan; \`make check\` passes with ASan and UBSan, no reports.` : undefined, metadata: { sessionId: sid }, time: { start: a.started, end: a.done ? a.until : undefined } } }), a.started);
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
  // Machine samples every 2 minutes over the run's life (the Machine tab's charts); the last one feeds the fleet's memory bar.
  if (o.started && o.status !== "failed") {
    const ins = db.query("INSERT INTO metrics (run_id, ts, cpu, mem_used, mem_total, disk_used, disk_total, workbase_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const stop = ["running", "recovering", "paused"].includes(o.status) ? now - 10 * S : end;
    const step = Math.max(2 * M, (stop - o.started) / 150);
    let mem = 0.8;
    for (let t = o.started + step, i = 0; t <= stop; t += step, i++) {
      const f = (t - o.started) / Math.max(1, stop - o.started);
      mem = Math.min(7.6, Math.max(0.6, mem + (rnd() - 0.45) * 0.35 + (o.ooms && f > 0.6 && f < 0.7 ? 0.8 : 0)));
      ins.run(o.id, t, 25 + rnd() * 55 + (f > 0.3 ? 15 : 0), mem * 1024 ** 3, 8 * 1024 ** 3, (4 + f * 14 + rnd() * 0.3) * 1024 ** 3, 60 * 1024 ** 3, Math.round((40 + f * 900 + i * 3) * 1024));
    }
  }
  if (o.report) writeFileSync(join(workbasePath(o.id), "REPORT.md"), o.report);
  if (o.findings) {
    // Each finding's states in time order, as the agent would have written its README.
    const row = db.query<any, [string]>("SELECT * FROM runs WHERE id = ?").get(o.id);
    const steps = o.findings.flatMap((f: DemoFinding) => f.states.map(([at, state], i) => ({ f, at, state, last: i === f.states.length - 1 }))).sort((a: any, b: any) => a.at - b.at);
    for (const { f, at, state, last } of steps) {
      const dir = join(workbasePath(o.id), "findings", f.folder);
      mkdirSync(dir, { recursive: true });
      const head = { state, severity: f.severity, location: f.location, class: f.class, poc: last ? f.poc : undefined };
      const text = `---\n${Object.entries(head).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n# ${f.title}\n\n${last ? f.body : f.body.split("\n\n")[0] + "\n"}`;
      writeFileSync(join(dir, "README.md"), text);
      utimesSync(join(dir, "README.md"), at / 1000, at / 1000);
      if (last && f.poc) writeFileSync(join(dir, f.poc), pocBytes(f.poc));
      syncFindings(row, "ses_main");
      snapshot(o.id, at);
    }
  }
}

/** A workbase history snapshot at `at`, like history.ts makes every few minutes, so the Files tab has history. */
function snapshot(runId: string, at: number) {
  const env = { ...process.env, GIT_AUTHOR_NAME: "pixel", GIT_AUTHOR_EMAIL: "pixel@localhost", GIT_COMMITTER_NAME: "pixel", GIT_COMMITTER_EMAIL: "pixel@localhost", GIT_AUTHOR_DATE: `@${Math.floor(at / 1000)}`, GIT_COMMITTER_DATE: `@${Math.floor(at / 1000)}` };
  const git = (...args: string[]) => Bun.spawnSync(["git", `--git-dir=${join(config.historyDir, `${runId}.git`)}`, `--work-tree=${workbasePath(runId)}`, ...args], { env, stdout: "ignore", stderr: "ignore" });
  git("init", "--quiet");
  git("add", "--all");
  git("commit", "--quiet", "--no-verify", "-m", "snapshot");
}
/** A small binary PoC (a PNG-looking header for .png, otherwise some bytes). */
function pocBytes(name: string) {
  const head = name.endsWith(".png") ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52] : [...new TextEncoder().encode(name.endsWith(".xml") ? "<a><a><a><a><a>" : "- [[[[[[[[[[[[[[")];
  return new Uint8Array([...head, ...Array.from({ length: 200 }, (_, i) => (i * 37 + 11) & 0xff)]);
}
function userMessage(runId: string, sid: string, at: number, text: string) {
  const mid = uid("msg");
  db.query("INSERT INTO messages (id, run_id, session_id, role, data, created_at) VALUES (?, ?, ?, 'user', ?, ?)").run(mid, runId, sid, JSON.stringify({ id: mid, sessionID: sid, role: "user", time: { created: at } }), at);
  addPart(runId, sid, mid, at, { type: "text", text });
}
function addPart(runId: string, sid: string, mid: string, at: number, part: Record<string, unknown>) {
  const pid = uid("prt");
  db.query("INSERT INTO parts (id, run_id, session_id, message_id, type, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(pid, runId, sid, mid, part.type as string, JSON.stringify({ id: pid, sessionID: sid, messageID: mid, ...part }), at);
}
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
const REMARKS = [
  "The build works with ASan and UBSan. Next: map every place a length from the input sizes an allocation.",
  "That path checks the length before the copy, so it's fine. Moving on to the next handler.",
  "The fuzzer has been flat for a while. I'll seed it with a few hand-made inputs that reach the deeper states.",
  "Two candidates so far:\n\n1. the header copy happens before the size check\n2. a count multiplied by an entry size with no overflow check\n\nI'll try to reproduce the first one.",
  "Confirmed with a minimal input:\n\n```c\n/* the length comes straight from the chunk */\nmemcpy(profile, data, 132);   /* before length >= 132 is checked */\n```\n\nWriting it up in the finding folder.",
];
const THOUGHTS = [
  "The declared length sizes the buffer, but the header copy uses a constant. If the length can be smaller than the constant, that's a read past the end. Need to check whether anything earlier rejects short lengths.",
  "The crash is in the error path, so it only matters if an attacker can reach it with a valid prefix. The fuzzer did, so yes.",
  "Better to fuzz this function in isolation than through the whole decoder; the decoder spends most of its time on CRCs.",
];
const titleOf = (tool: string, input: Record<string, unknown>) => String(tool === "bash" ? input.command : (input.filePath ?? input.description ?? input.pattern ?? tool));
const C_LINES = ["   if (length < 132)", "      return png_chunk_error(png_ptr, \"profile too short\");", "   profile = png_malloc(png_ptr, length);", "   memcpy(profile, data, 132);", "   for (i = 0; i < nentries; i++)", "      entries[i].red = png_get_uint_16(p);"];
/** A finished tool call with output that looks like the tool's. A few shell calls fail. */
function toolState(tool: string, input: Record<string, unknown>, start: number, took: number) {
  const base = { input, title: titleOf(tool, input), metadata: {} as Record<string, unknown>, time: { start, end: start + took } };
  const cmd = String(input.command ?? "");
  if (tool === "bash") {
    if (rnd() < 0.05) return { ...base, status: "error", error: `${cmd.split(" ")[0]}: exit status 1\nerror: unknown option '-j'\n` };
    const out = /make|cmake|ninja/.test(cmd)
      ? "[ 12%] Building C object CMakeFiles/png.dir/pngrutil.c.o\n[ 25%] Building C object CMakeFiles/png.dir/pngread.c.o\n[100%] Linking C static library libpng16.a\n[100%] Built target png"
      : /fuzz|harness/.test(cmd)
        ? "INFO: Seed: 4104127123\n#2097152\tpulse  cov: 1873 ft: 6211 corp: 412/88Kb exec/s: 69905 rss: 412Mb\n#4194304\tpulse  cov: 1881 ft: 6240 corp: 418/90Kb exec/s: 69905 rss: 418Mb"
        : /grep|rg/.test(cmd)
          ? "pngrutil.c:1150:   png_inflate(png_ptr, png_ptr->chunk_name, 1, &size);\npngrutil.c:1184:   memcpy(profile, data, 132);\npngrutil.c:1650:   nentries = data_length / entry_size;"
          : "";
    return { ...base, status: "completed", output: out };
  }
  if (tool === "read") return { ...base, status: "completed", output: `<file>\n${C_LINES.map((l, i) => `${String(1180 + i).padStart(5, "0")}| ${l}`).join("\n")}\n</file>` };
  if (tool === "edit") {
    const f = String(input.filePath ?? "file.c");
    base.metadata.diff = `--- a/${f}\n+++ b/${f}\n@@ -40,6 +40,9 @@\n static size_t mutate(uint8_t *data, size_t size, size_t max)\n {\n-   return LLVMFuzzerMutate(data, size, max);\n+   /* keep the declared profile length small */\n+   if (size > 12) data[11] = data[11] & 0x1f;\n+   return LLVMFuzzerMutate(data, size, max);\n }`;
    return { ...base, status: "completed", output: "Edit applied successfully." };
  }
  return { ...base, status: "completed", output: "" };
}

type DemoFinding = { folder: string; title: string; severity: string | null; location?: string; poc?: string; class?: string; body: string; states: [number, string][] };
/** A demo finding: `states` are [time, state] in order (default: just `state` at `at`); the PoC appears with the last one. */
function finding(id: string, title: string, state: string, severity: string | null, at: number, extra: { location?: string; poc?: string; class?: string; summary?: string; more?: string } = {}, states?: [number, string][]): DemoFinding {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").slice(0, 4).join("-");
  const body = [extra.summary ?? title, extra.more, extra.poc && `## Reproduce\n\n\`\`\`\n./harness ${extra.poc}\n\`\`\``].filter(Boolean).join("\n\n") + "\n";
  return { folder: `${id}-${slug}`, title, severity, location: extra.location, poc: extra.poc, class: extra.class, body, states: states ?? [[at, state]] };
}

const sh = (command: string): [string, Record<string, unknown>] => ["bash", { command }];
const rd = (filePath: string): [string, Record<string, unknown>] => ["read", { filePath }];
const ed = (filePath: string): [string, Record<string, unknown>] => ["edit", { filePath }];

run({
  id: "libpng-2026-10-14", label: "libpng chunk parsing", repo: "https://github.com/pnggroup/libpng", status: "running", started: now - (3 * H + 21 * M), hue: 0, tps: 64, continues: 1,
  messages: [[now - 75 * M, "Focus on iCCP first, zTXt can wait."]],
  agents: [
    { title: "main", started: now - (3 * H + 21 * M), tools: [["task", { description: "Fuzz the iCCP chunk handler" }], rd("pngrutil.c"), sh("grep -n png_inflate pngrutil.c")] },
    { title: "Build with ASan and UBSan", started: now - (3 * H + 12 * M), until: now - (2 * H + 40 * M), done: true, tools: [sh("cmake -DCMAKE_C_FLAGS=-fsanitize=address .."), sh("make -j4")] },
    { title: "Fuzz the iCCP chunk handler", started: now - 31 * M, tools: [sh("./fuzz/run.sh iccp -j3 -max_total_time=3600"), ed("fuzz/iccp_mutator.c"), rd("pngrutil.c:1150")] },
    { title: "Review the inflate window code", started: now - 23 * M, tools: [rd("pngrutil.c:1120-1260"), rd("pngpread.c"), sh("rg -n 'window_bits' .")] },
  ],
  todos: [["completed", "Build with ASan and UBSan"], ["completed", "Map chunk handlers and their length checks"], ["in_progress", "Fuzz iCCP with a profile-length mutator"], ["in_progress", "Review the inflate window code"], ["pending", "Check zTXt and iTXt for the same pattern"], ["pending", "Write up the iCCP overflow with a minimal PoC"]],
  findings: [
    finding("F1", "Heap overflow in iCCP decompression", "confirmed", "high", now - 52 * M, { location: "pngrutil.c:1184", poc: "iccp-0041.png", class: "heap-buffer-overflow", summary: "The declared profile length sizes the buffer, but the 132-byte header is copied before anything checks that the length is at least 132. A 2.1 KB PNG declaring a 16-byte profile reads past the allocation.", more: "Reproduced with the ASan build: heap-buffer-overflow READ of size 1 in png_handle_iCCP. The fuzzer found it after 41 minutes with the profile-length mutator." }, [
      [now - 52 * M, "suspected"],
      [now - 10 * M, "confirmed"],
    ]),
    finding("F2", "sPLT entry count is not bounded by the chunk length", "suspected", "medium", now - 6 * M, { location: "pngrutil.c:1650", class: "integer-overflow", summary: "nentries comes from the chunk length divided by the entry size, but the multiplication for the allocation can wrap on 32-bit builds." }),
    finding("F3", "png_inflate trusts the declared profile length", "lead", null, now - 80 * M, { location: "pngrutil.c:1120" }),
    finding("F4", "tRNS length checks hold on every path", "ruled_out", "low", now - 2 * H, { location: "pngrutil.c:1760", summary: "tRNS looked like it could copy more entries than the palette holds.", more: "## Why ruled out\n\npng_handle_tRNS checks the length against the palette size before copying, on both the progressive and the sequential reader." }, [
      [now - 2 * H, "lead"],
      [now - 95 * M, "ruled_out"],
    ]),
  ],
  timeline: [[now - (2 * H + 5 * M), "pixel", "continue", 'Agent went idle without REPORT.md; sending "continue your work" (1/3)']],
});

run({
  id: "tinyxml2-2026-10-13", label: "tinyxml2 parser", repo: "https://github.com/leethomason/tinyxml2", status: "running", agentStatus: "busy", started: now - (5 * H + 2 * M), hue: 3, tps: 0, continues: 2,
  agents: [{ title: "main", started: now - (5 * H + 2 * M), until: now - 12 * M, tools: [rd("tinyxml2.cpp"), sh("./xmltest"), ed("fuzz/parse.cc")] }],
  question: { text: "I have two crashes in XMLDocument::Parse, both stack exhaustion from elements nested deeper than 25 000. Write them up, or skip stack exhaustion and keep looking for memory corruption?", options: ["Write both up, keep looking", "Skip stack exhaustion", "Stop and write the report"], at: now - 12 * M },
  todos: [["completed", "Build with sanitizers"], ["completed", "Fuzz XMLDocument::Parse"], ["in_progress", "Decide on the stack exhaustion crashes"]],
  findings: [finding("F1", "Stack exhaustion on deeply nested elements", "confirmed", "low", now - 70 * M, { location: "tinyxml2.cpp:1093", poc: "deep.xml", class: "stack-overflow" })],
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
    finding("F1", "Null dereference on a merge key that aliases a scalar", "confirmed", "medium", now - (12 * H + 40 * M), { location: "nodebuilder.cpp:118", poc: "merge-scalar.yaml", class: "null-deref" }),
    finding("F2", "Unbounded recursion on nested flow sequences", "confirmed", "low", now - (13 * H + 30 * M), { location: "singledocparser.cpp:52", poc: "deep-flow.yaml", class: "stack-overflow" }),
  ],
  timeline: [[now - (12 * H + 8 * M), "pixel", "done", "REPORT.md written and the agent is idle: run done"]],
});

run({
  id: "sqlite-fts5-2026-10-12", label: "sqlite fts5", repo: "https://github.com/sqlite/sqlite", status: "triaged", started: now - (30 * H), finished: now - 23 * H, triagedAt: now - 20 * H, hue: 0, tps: 30,
  agents: [{ title: "main", started: now - 30 * H, tools: [rd("ext/fts5/fts5_hash.c")], done: true }],
  report: "# sqlite fts5\n\nOne integer overflow that needs a 2 GB document.\n",
  findings: [finding("F1", "Integer overflow in fts5HashAddPoslistSize", "confirmed", "info", now - 23 * H, { location: "fts5_hash.c:212" })],
});
await setVerdict("sqlite-fts5-2026-10-12", "F1", "not_bug", "Needs a single 2 GB document; not reachable with the default SQLITE_MAX_LENGTH.");
await setVerdict("yaml-cpp-2026-10-12", "F2", "real", null);


// ---- Models page: providers with keys, offered models, an hour of model calls, a speed test ----

const { saveSettings } = await import("../src/settings.ts");
await import("../src/providers.ts"); // creates llm_calls, provider_events and speedtests
const acct = (id: string, name: string, keys: [string, string, string?][], extra: Record<string, unknown> = {}) => ({
  id, name, added: now - 9 * 24 * H, ...extra,
  keys: keys.map(([kname, note, state], i) => ({ id: `key_${id}_${i}`, name: kname, key: `sk-demo-${id}-${i}-0000000000${i}a4f2`, note, added: now - (9 - i) * 24 * H, ...(state && { status: { state, at: now - 6 * M, detail: state === "ratelimit" ? "429 Too Many Requests: tokens per minute exceeded" : "402 insufficient credit" } }) })),
});
db.query("INSERT INTO settings (key, value) VALUES ('_providers', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
  JSON.stringify({
    anthropic: acct("anthropic", "Anthropic", [["Work", "Team plan, billed to the lab"], ["Personal", "Own card, $200/month cap", "ratelimit"]]),
    openrouter: acct("openrouter", "OpenRouter", [["Credits", "Prepaid $50"]]),
    deepseek: acct("deepseek", "DeepSeek", [["Trial", "Free trial credit, expires in November", "credit"]]),
    "lab-vllm": acct("lab-vllm", "Lab vLLM", [["Internal", ""]], { baseURL: "http://10.0.4.12:8000/v1", custom: { api: "openai", models: ["qwen3-coder-480b", "glm-4.6"], context: 262144, reasoning: true } }),
  }),
);
const offered = ["anthropic/claude-opus-4-5", "anthropic/claude-sonnet-4-5", "openrouter/qwen/qwen3-coder", "openrouter/moonshotai/kimi-k2", "deepseek/deepseek-chat", "lab-vllm/qwen3-coder-480b", "opencode/big-pickle"];
saveSettings({ models: offered, defaultModel: "anthropic/claude-opus-4-5", providerLimits: { "anthropic/claude-opus-4-5": { tpm: 400_000, rpm: 50 }, "openrouter/qwen/qwen3-coder": { tpm: 120_000 } } });

// Older runs on other models, so the leaderboard compares something.
db.query("UPDATE runs SET model = 'anthropic/claude-sonnet-4-5' WHERE id IN ('yaml-cpp-2026-10-12', 'libxml2-2026-10-14')").run();
db.query("UPDATE runs SET model = 'openrouter/qwen/qwen3-coder' WHERE id = 'sqlite-fts5-2026-10-12'").run();

const runIds = db.query<{ id: string }, []>("SELECT id FROM runs").all().map((r) => r.id);
const callIns = db.query("INSERT INTO llm_calls (id, run_id, session_id, provider, model, created, first_token, completed, tokens_in, tokens_out, tokens_reasoning, tokens_cache, cost, error, key_id) VALUES (?, ?, 'demo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
// [provider, model, calls in the last 6 h, first-token ms, tok/s, error share]
const traffic: [string, string, number, number, number, number][] = [
  ["anthropic", "claude-opus-4-5", 520, 1900, 62, 0.01],
  ["anthropic", "claude-sonnet-4-5", 260, 1100, 88, 0.02],
  ["openrouter", "qwen/qwen3-coder", 180, 2600, 140, 0.08],
  ["openrouter", "moonshotai/kimi-k2", 70, 3400, 46, 0.3],
  ["lab-vllm", "qwen3-coder-480b", 120, 650, 54, 0],
  ["opencode", "big-pickle", 40, 1500, 95, 0.03],
];
for (const [provider, model, n, ttft, tps, errShare] of traffic)
  for (let i = 0; i < n; i++) {
    const created = now - rnd() * 6 * H;
    const out = Math.round(200 + rnd() * 1800);
    const ft = created + ttft * (0.6 + rnd() * 0.9);
    const err = rnd() < errShare ? "upstream error: 502 Bad Gateway" : null;
    callIns.run(uid("call"), runIds[i % runIds.length], provider, model, created, err ? null : ft, err ? null : ft + (out / (tps * (0.7 + rnd() * 0.6))) * 1000, Math.round(20_000 + rnd() * 60_000), err ? 0 : out, 0, Math.round(rnd() * 50_000), 0, err, `key_${provider}_0`);
  }
const evIns = db.query("INSERT INTO provider_events (ts, run_id, provider, model, kind, message) VALUES (?, ?, ?, ?, ?, ?)");
evIns.run(now - 4 * M, runIds[0], "openrouter", "moonshotai/kimi-k2", "ratelimit", "429 Too Many Requests: rate limit exceeded for moonshotai/kimi-k2");
for (let i = 0; i < 5; i++) evIns.run(now - (8 + i * 6) * M, runIds[1], "openrouter", "moonshotai/kimi-k2", "retry", "Retrying after upstream 502");
evIns.run(now - 50 * M, runIds[0], "anthropic", "claude-opus-4-5", "retry", "overloaded_error: retrying in 4 s");

const stIns = db.query("INSERT INTO speedtests (batch, ts, provider, model, ttft_ms, total_ms, tokens_out, tps, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
for (const [batch, at] of [["b1", now - 26 * H], ["b2", now - 2 * H]] as const)
  for (const [provider, model, , ttft, tps] of traffic) {
    const t = Math.round(ttft * (0.8 + rnd() * 0.4));
    const sp = tps * (0.85 + rnd() * 0.3);
    const fail = batch === "b2" && model === "moonshotai/kimi-k2";
    stIns.run(batch, at, provider, model, fail ? null : t, fail ? null : Math.round(t + (340 / sp) * 1000), fail ? null : 340, fail ? null : sp, fail ? 0 : 1, fail ? "429 Too Many Requests" : null);
  }

console.log(`Seeded ${db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n} runs in ${process.env.PIXEL_DATA}`);
