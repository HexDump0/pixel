/*
 * Pixel mockup, round 12. Builds on ../shared.js (fake runs, live simulation, actions, renderers) and adds:
 * findings as their own objects with a verdict each, "since you last looked", run health, the health-first
 * tile, the run detail, the findings view and keyboard helpers. Pages own their layout and call these.
 */
(function () {
  "use strict";
  const { runs, find, name, repoShort, isLive, kindOf, fmt, r: R, on, emit, act } = PX;
  const { esc, dur, ago, tok, money, shortModel } = fmt;
  const S = 1000, M = 60 * S, H = 60 * M;
  const T0 = Date.now();
  const ui = () => PX.ui;

  /* ---------- when each agent's current step started (ages on the tile) ---------- */
  for (const r of runs)
    for (const a of r.agents) {
      const last = [...r.log].reverse().find((e) => e.agent === a.id);
      a.nowAt = last ? last.ts : T0 - (8 + ((a.id.length * 7) % 30)) * S;
    }
  on("tick", (ev) => {
    const r = find(ev.run);
    const a = r && r.agents.find((x) => x.id === ev.agent);
    if (a) a.nowAt = ev.ts;
  });

  /* ---------- findings ---------- */
  const findings = [
    {
      id: "F-1", run: "libpng-2026-10-14", sev: "high", agent: "confirmed", at: T0 - 10 * M, verdict: null, note: "",
      title: "Heap overflow in iCCP decompression", cls: "heap-buffer-overflow, read of 1 byte", where: "pngrutil.c:1184", fn: "png_inflate, from png_handle_iCCP", poc: "poc/iccp-0041.png",
      summary: "The declared profile length (the first 4 bytes of the profile header) sizes the buffer, but the 132-byte header is copied before anything checks that the length is at least 132. A 2.1 KB PNG declaring a 16-byte profile reads past the allocation.",
      repro: "./build-asan/pngtest poc/iccp-0041.png",
      evidence: "==41213==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x6020000000f1\nREAD of size 1 at 0x6020000000f1 thread T0\n    #0 0x55d1c3 in png_inflate pngrutil.c:1184\n    #1 0x55e0a7 in png_handle_iCCP pngrutil.c:1402\n    #2 0x5629f2 in png_read_info pngread.c:174\nSUMMARY: AddressSanitizer: heap-buffer-overflow pngrutil.c:1184 in png_inflate",
    },
    {
      id: "F-2", run: "libpng-2026-10-14", sev: "medium", agent: "suspected", at: T0 - 6 * M, verdict: null, note: "",
      title: "sPLT entry count is not bounded by the chunk length", cls: "possible heap overflow", where: "pngrutil.c:1650", fn: "png_handle_sPLT",
      summary: "The entry count is derived from the chunk length with no upper bound before the allocation. Not reproduced yet; the agent lists it under Promising.",
      evidence: null,
    },
    {
      id: "F-3", run: "tinyxml2-2026-10-13", sev: "low", agent: "confirmed", at: T0 - 58 * M, verdict: null, note: "",
      title: "Stack exhaustion in XMLNode::ParseDeep on deeply nested elements", cls: "stack-overflow (denial of service)", where: "tinyxml2.cpp:2398", fn: "XMLNode::ParseDeep", poc: "poc/deep-30000.xml",
      summary: "Elements nested deeper than about 25 000 levels overflow the 8 MB stack. XMLDocument::Parse has no depth limit.",
      repro: "./xmltest poc/deep-30000.xml",
      evidence: "==7731==ERROR: AddressSanitizer: stack-overflow on address 0x7ffd3c2f9ff8\n    #0 0x4f8a21 in tinyxml2::XMLNode::ParseDeep tinyxml2.cpp:2398\n    #1 0x4f8c90 in tinyxml2::XMLElement::ParseDeep tinyxml2.cpp:2071\n    ... 24 993 more frames\nSUMMARY: AddressSanitizer: stack-overflow tinyxml2.cpp:2398",
    },
    {
      id: "F-4", run: "tinyxml2-2026-10-13", sev: "low", agent: "confirmed", at: T0 - 52 * M, verdict: null, note: "", dupHint: "F-3",
      title: "Stack exhaustion through nested elements inside comments", cls: "stack-overflow (denial of service)", where: "tinyxml2.cpp:2398", fn: "XMLNode::ParseDeep", poc: "poc/deep-comment.xml",
      summary: "Same frame as F-3, reached with comments between the nested elements. Probably the same root cause.",
      evidence: "SUMMARY: AddressSanitizer: stack-overflow tinyxml2.cpp:2398 in tinyxml2::XMLNode::ParseDeep",
    },
    {
      id: "F-5", run: "expat-2026-10-13", sev: "low", agent: "confirmed", at: T0 - (4 * H + 12 * M), verdict: null, note: "",
      title: "Stack exhaustion with deeply nested entity references", cls: "stack-overflow, needs XML_DTD", where: "xmlparse.c:5872", fn: "processInternalEntity", poc: "poc/nested-entities.xml",
      summary: "A 1.2 MB document with nested entity references exhausts the stack when XML_DTD is on. The agent thinks this is the same class as CVE-2013-0340 and probably not new.",
      evidence: "SUMMARY: AddressSanitizer: stack-overflow xmlparse.c:5872 in processInternalEntity",
    },
    {
      id: "F-6", run: "yaml-cpp-2026-10-12", sev: "medium", agent: "confirmed", at: T0 - (12 * H + 40 * M), verdict: null, note: "",
      title: "Null dereference on a merge key that aliases a scalar", cls: "SEGV on unknown address 0x000000000000", where: "nodebuilder.cpp:118", fn: "NodeBuilder::OnMapEnd", poc: "poc/merge-scalar.yaml",
      summary: "`<<: *a` where the anchor is a scalar reaches NodeBuilder::OnMapEnd with a null map node.",
      repro: "./util/parse poc/merge-scalar.yaml",
      evidence: "==5120==ERROR: AddressSanitizer: SEGV on unknown address 0x000000000000\n    #0 0x5a31f0 in YAML::NodeBuilder::OnMapEnd() nodebuilder.cpp:118\n    #1 0x5b0a44 in YAML::SingleDocParser::HandleBlockMap singledocparser.cpp:233",
    },
    {
      id: "F-7", run: "yaml-cpp-2026-10-12", sev: "low", agent: "confirmed", at: T0 - (13 * H + 30 * M), verdict: null, note: "",
      title: "Unbounded recursion on nested flow sequences", cls: "stack-overflow (denial of service)", where: "singledocparser.cpp:52", fn: "SingleDocParser::HandleNode", poc: "poc/deep-flow.yaml",
      summary: "YAML::Load on 40 000 nested `[` overflows the stack.",
      evidence: "SUMMARY: AddressSanitizer: stack-overflow singledocparser.cpp:52 in YAML::SingleDocParser::HandleNode",
    },
    {
      id: "F-8", run: "sqlite-fts5-2026-10-12", sev: "info", agent: "confirmed", at: T0 - 23 * H, verdict: "not a bug", note: "Needs a single 2 GB document; not reachable with the default SQLITE_MAX_LENGTH.",
      title: "Integer overflow in fts5HashAddPoslistSize", cls: "integer overflow", where: "fts5_hash.c:212", fn: "fts5HashAddPoslistSize",
      summary: "Needs a single 2 GB document; not reachable with default limits.", evidence: null,
    },
  ];
  const fById = (id) => findings.find((f) => f.id === id);
  const SEV = { high: 0, medium: 1, low: 2, info: 3 };
  const sevRank = (f) => SEV[f.sev] ?? 4;
  // untriaged first, then by severity, then newest
  const findingsOf = (runId) => findings.filter((f) => f.run === runId).sort((a, b) => !!a.verdict - !!b.verdict || sevRank(a) - sevRank(b) || b.at - a.at);
  const untriaged = () => findings.filter((f) => !f.verdict);
  const VERDICTS = [
    { v: "real", key: "r", label: "Real", hint: "Goes in the write-up" },
    { v: "not a bug", key: "n", label: "Not a bug", hint: "False positive or out of scope" },
    { v: "duplicate", key: "d", label: "Duplicate", hint: "Known, or same as another finding" },
    { v: "needs work", key: "w", label: "Needs work", hint: "Send it back to the agent" },
  ];
  function setVerdict(id, v, { tell = true } = {}) {
    const f = fById(id);
    if (!f) return;
    f.verdict = f.verdict === v ? null : v;
    const r = find(f.run);
    if (f.verdict && tell && r && isLive(r)) {
      const msg = v === "needs work" ? `Triage on ${f.id} “${f.title}”: needs more work.${f.note ? " " + f.note : ""}` : `Triage on ${f.id} “${f.title}”: ${v}.${f.note ? " " + f.note : ""}`;
      PX.message(r.id, msg);
    } else PX.toast(f.verdict ? `${f.id} marked ${v} · saved to TRIAGE.md` : `${f.id} verdict cleared`);
    emit("change", { run: f.run, action: "verdict", finding: id });
  }

  /* ---------- since you last looked ---------- */
  let lastSeen = T0 - 14 * H;
  const seenAt = () => lastSeen;
  const EVENTS = {
      "libpng-2026-10-14": [{ k: "prog", t: "PROGRESS.md changed 9 times", at: T0 - 27 * S }, { k: "", t: "1 automatic continue", at: T0 - (2 * H + 5 * M) }],
      "tinyxml2-2026-10-13": [{ k: "warn", t: "Asked you a question", at: T0 - 12 * M, act: "answer" }, { k: "warn", t: "2 of 3 continues used", at: T0 - 40 * M }],
      "expat-2026-10-13": [{ k: "bad", t: "OOM-killed twice linking the MSan build", at: T0 - 2 * M }, { k: "warn", t: "Recovering, attempt 2 of 3", at: T0 - 2 * M }],
      "zlib-2026-10-14": [{ k: "", t: "Started by you", at: T0 - (1 * H + 26 * M) }, { k: "prog", t: "No findings yet", at: T0 - 14 * M }],
      "yaml-cpp-2026-10-12": [{ k: "done", t: "Finished after 9h 02m · REPORT.md written", at: T0 - (12 * H + 8 * M), act: "triage" }],
      "libxml2-2026-10-14": [{ k: "bad", t: "Failed while preparing: git clone timed out", at: T0 - 28 * M, act: "retry" }],
  };
  // the latest things that happened across all runs, newest first
  const FEED_T = { "libpng-2026-10-14": [{ k: "prog", t: "PROGRESS.md updated", at: T0 - 27 * S }], "tinyxml2-2026-10-13": [{ k: "ask", t: "Asked: write up both crashes, or keep looking?", at: T0 - 12 * M, act: "answer" }], "expat-2026-10-13": [{ k: "bad", t: "OOM-killed linking the MSan build", at: T0 - 2 * M - 10 * S }], "zlib-2026-10-14": [{ k: "", t: "Started differential test against zlib-ng", at: T0 - 44 * M }], "yaml-cpp-2026-10-12": [{ k: "done", t: "Finished · REPORT.md written", at: T0 - (12 * H + 8 * M), act: "triage" }], "libxml2-2026-10-14": [{ k: "bad", t: "git clone timed out", at: T0 - 28 * M, act: "retry" }] };
  function feed(n = 8) {
    const out = [];
    for (const r of runs) {
      for (const e of FEED_T[r.id] || []) out.push({ ...e, run: r });
      for (const f of findingsOf(r.id)) out.push({ k: "find", sev: f.sev, t: f.title, at: f.at, finding: f.id, run: r });
    }
    return out.sort((a, b) => b.at - a.at).slice(0, n);
  }
  function catchup() {
    const ev = EVENTS;
    const out = [];
    for (const r of runs) {
      const list = (ev[r.id] || []).filter((e) => e.at > lastSeen).slice();
      for (const f of findingsOf(r.id)) if (f.at > lastSeen && !f.verdict) list.unshift({ k: "find", t: `Found: ${f.title}`, at: f.at, finding: f.id, sev: f.sev });
      if (list.length) out.push({ run: r, ev: list.sort((a, b) => b.at - a.at) });
    }
    const all = out.flatMap((x) => x.ev);
    return {
      since: lastSeen, runs: out,
      sum: { found: all.filter((e) => e.k === "find").length, finished: all.filter((e) => e.k === "done").length, failed: all.filter((e) => e.k === "bad" && /Failed/.test(e.t)).length, asks: all.filter((e) => e.act === "answer").length, spent: runs.reduce((a, r) => a + r.costToday, 0) + 0.68 },
    };
  }
  function markAllSeen() { lastSeen = Date.now(); runs.forEach((r) => (r.unseen = null)); emit("change", { action: "seen-all" }); PX.toast("Marked everything as seen"); }

  /* ---------- icons (Tabler, from icons.js) ---------- */
  const TI = (n, cls = "") => `<svg class="ti ${cls}" viewBox="0 0 24 24" aria-hidden="true">${(window.TABLER || {})[n] || ""}</svg>`;
  window.TI = TI;
  // agent-state icons for markup that shared.js renders (<span class="x-ring" data-s>), as CSS masks
  (function ringIcons() {
    const svg = (n) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${(window.TABLER || {})[n] || ""}</svg>`)}")`;
    const map = { "": "point", running: "loader-2", starting: "loader-2", waiting: "hourglass-high", idle: "player-pause", interrupted: "alert-triangle", done: "check", failed: "x" };
    const css = Object.entries(map).map(([s, n]) => `.x-ring${s ? `[data-s="${s}"]` : ""} { --ic: ${svg(n === "point" ? "circle-dot" : n)}; }`).join("\n");
    const el = document.createElement("style");
    el.textContent = css;
    document.head.appendChild(el);
  })();

  /* ---------- health: one status, said once. Running says nothing but its age; words only for problems ---------- */
  const busy = (r) => r.agents.filter((a) => a.status === "running").length;
  function health(r) {
    const flags = [];
    let s, label, icon;
    const live = isLive(r);
    if (r.question) (s = "asking"), (label = `Waiting ${age(r.question.at)}`), (icon = "message-question");
    else if (r.status === "recovering") (s = "recovering"), (label = `Recovering ${Math.min(3, r.ooms || 1)}/3`), (icon = "refresh");
    else if (r.status === "failed") (s = "failed"), (label = "Failed"), (icon = "circle-x");
    else if (r.status === "preparing") (s = "preparing"), (label = "Preparing"), (icon = "loader-2");
    else if (r.status === "stopped") (s = "stopped"), (label = "Stopped"), (icon = "player-stop");
    else if (r.status === "paused") (s = "paused"), (label = "Paused"), (icon = "player-pause");
    else if (r.status === "done") (s = "done"), (label = "Done"), (icon = "file-check");
    else if (r.status === "triaged") (s = "triaged"), (label = r.verdict), (icon = "circle-check");
    else if (r.agent === "idle") (s = "idle"), (label = "Idle"), (icon = "player-pause");
    else { s = "running"; label = elapsed(r); icon = ""; }
    if (live) {
      if (r.progressAt && Date.now() - r.progressAt > 45 * M) flags.push(`PROGRESS.md quiet ${dur(Date.now() - r.progressAt)}`);
      if (r.ctx / r.ctxMax > 0.55) flags.push(`Context ${Math.round((r.ctx / r.ctxMax) * 100)}%`);
      if (r.continues >= 2) flags.push(`${r.continues}/3 continues`);
    }
    return { s, label, icon, flags };
  }
  const stChip = (h) => `<span class="st" data-s="${h.s}"><span class="dot"></span>${esc(h.label)}</span>`;

  /* ---------- small helpers ---------- */
  const chip = (r) => `<span class="chip" style="background:var(--r${r.hue})" aria-hidden="true"></span>`;
  const STOP = new Set(["the", "a", "an", "with", "and", "for", "of", "to", "against"]);
  const shortTitle = (a) => (a.id === "main" ? "main" : a.title.split(" ").filter((w) => !STOP.has(w.toLowerCase())).slice(0, 2).join(" "));
  const age = (ts) => { const s = Math.max(0, Math.round((Date.now() - ts) / S)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`; };
  const elapsed = (r) => dur((r.finished || Date.now()) - r.started).replace(/ \d+s$/, "");
  const ctxPct = (r) => (r.ctxMax ? Math.round((r.ctx / r.ctxMax) * 100) : 0);
  const bar = (pct, warn) => `<span class="bar ${warn ? "warn" : ""}"><i style="width:${Math.min(100, pct)}%"></i></span>`;
  // the tile's floor: output tokens/s for the last 3 minutes as a soft area in the run's colour
  function wave(r, w = 400, h = 40) {
    const v = r.tpsHist.slice(-60), n = v.length;
    const live = v.some((x) => x > 0);
    if (!live) return `<svg class="wave flat" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="${w}" y1="${h - 1}" y2="${h - 1}"/></svg>`;
    // scaled to this run's own range so the shape reads; the number beside it gives the size
    const hi = Math.max(...v) * 1.1, lo = Math.min(...v) * 0.5, span = Math.max(20, hi - lo);
    const pts = v.map((x, i) => [(i / (n - 1)) * w, h - 2 - ((x - lo) / span) * (h - 6)]);
    // light smoothing so 2-second samples read as a flow, not a seismograph
    for (let k = 0; k < 2; k++) for (let i = 1; i < n - 1; i++) pts[i][1] = (pts[i - 1][1] + pts[i][1] * 2 + pts[i + 1][1]) / 4;
    let d = `M0,${pts[0][1].toFixed(1)}`;
    for (let i = 1; i < n; i++) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], cx = (x0 + x1) / 2; d += ` C${cx.toFixed(1)},${y0.toFixed(1)} ${cx.toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`; }
    const g = `wg-${r.id}`;
    return `<svg class="wave" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--r${r.hue});stop-opacity:.34"/><stop offset="1" style="stop-color:var(--r${r.hue});stop-opacity:0"/></linearGradient></defs><path d="${d} L${w},${h} L0,${h} Z" fill="url(#${g})"/><path d="${d}" class="ln" style="stroke:var(--r${r.hue})"/></svg>`;
  }
  const brand = `<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="0" y="0" width="9" height="9" rx="2" style="fill:var(--r0)"/><rect x="11" y="0" width="9" height="9" rx="2" style="fill:var(--r2)"/><rect x="0" y="11" width="9" height="9" rx="2" style="fill:var(--r3)"/><rect x="11" y="11" width="9" height="9" rx="2" style="fill:var(--ink)"/></svg>`;
  const agIcon = (s) => `<span class="ag" data-s="${s}" aria-hidden="true"></span>`;

  /* ---------- tile parts ---------- */
  // one lane per agent: the last 15 minutes of tool calls as ticks in the run's colour.
  // Tick height says the kind (shell tall, edits and subagents medium, reads short). Hover for the command.
  const TICK_H = { shell: 12, edit: 8, task: 8, web: 8, read: 4 };
  function nowRows(r, max = 3) {
    const ag = r.agents.filter((a) => a.status !== "done").slice(0, max);
    if (!ag.length) return "";
    const now = Date.now(), win = 15 * 60 * 1000, W = 300;
    return ag.map((a) => {
      const ticks = r.ticks.filter((t) => t.a === a.id && now - t.ts < win);
      const last = ticks.reduce((m, t) => Math.max(m, t.ts), 0);
      const lines = ticks.map((t) => { const x = (W - ((now - t.ts) / win) * W).toFixed(1), h = TICK_H[t.k] || 6; const fresh = t.ts === last && now - t.ts < 20000; return `<line x1="${x}" x2="${x}" y1="${8 - h / 2}" y2="${8 + h / 2}" style="stroke:var(--r${r.hue});stroke-opacity:${fresh ? 1 : 0.55}"/>`; }).join("");
      const what = a.status === "waiting" ? "waiting on subagents" : a.status === "idle" ? "idle" : a.status === "interrupted" ? "interrupted" : a.now ? `${a.now.tool} ${a.now.text}` : "thinking";
      return `<li data-agent="${esc(a.id)}" class="${a.parent ? "kid" : ""}" title="${esc(a.title)}: ${esc(what)}"><span class="who">${esc(shortTitle(a))}</span><svg viewBox="0 0 ${W} 16" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="${W}" y1="8" y2="8" class="base ${a.status === "waiting" ? "dash" : ""}"/>${lines}</svg></li>`;
    }).join("");
  }
  function tileBody(r) {
    if (r.question) {
      const q = r.question;
      return `<form class="t-body" data-ask="${r.id}"><p class="q">${esc(q.text)}</p><div class="opts">${q.options.map((o, i) => `<button type="button" class="x-opt" data-opt="${esc(o)}"><kbd>${i + 1}</kbd>${esc(o)}</button>`).join("")}</div></form>`;
    }
    if (r.status === "recovering") {
      const n = Math.min(3, r.ooms || 1);
      return `<div class="t-body"><p>${esc(r.detail)}</p><div class="steps" title="Attempt ${n} of 3">${[1, 2, 3].map((i) => `<i class="${i <= n ? "on" : ""}"></i>`).join("")}</div></div><ul class="lanes" data-slot="now">${nowRows(r)}</ul>`;
    }
    if (r.status === "failed")
      return `<div class="t-body"><p class="mono-t">${esc(r.detail)}</p><div class="opts"><button type="button" class="btn sm" data-act="retry" data-run="${r.id}">${TI("refresh", "sm")}Retry</button><button type="button" class="btn sm ghost" data-act="edit-retry" data-run="${r.id}">Edit</button></div></div>`;
    if (r.status === "paused" || r.status === "stopped")
      return `<div class="t-body"><div class="opts"><button type="button" class="btn sm" data-act="resume" data-run="${r.id}">${TI("player-play", "sm")}Resume</button></div></div>`;
    return `<ul class="lanes" data-slot="now">${nowRows(r)}</ul>`;
  }
  const md1 = (t) => esc(t).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "$1");
  function tileFind(r) {
    const fs = findingsOf(r.id);
    if (fs.length) {
      const f = fs[0], more = fs.length - 1;
      return `<div class="fline" title="${esc(f.sev)} · ${f.agent}"><span class="sev" data-sev="${f.sev}"></span><span class="tx">${esc(f.title)}</span>${more ? `<span class="d">+${more}</span>` : ""}</div>`;
    }
    const hl = R.headline(r);
    return hl ? `<div class="fline muted"><span class="tx">${md1(hl.text)}</span></div>` : "";
  }
  function tileFoot(r) {
    const live = isLive(r);
    const todos = r.todos.length ? `<span class="todo" title="Todos: ${r.todos.filter((t) => t[0] === "completed").length} of ${r.todos.length} done">${r.todos.map(([st]) => `<i data-s="${st}"></i>`).join("")}</span>` : "";
    return `${todos}<span class="sp"></span>${live && r.tps ? `<span class="m" title="Output tokens per second"><b>${r.tps}</b> tok/s</span>` : ""}${r.cost ? `<span class="m" title="Cost so far"><b>${money(r.cost)}</b></span>` : ""}`;
  }
  function tileActs(r) {
    const live = isLive(r);
    const pp = r.status === "paused" ? `<button type="button" class="btn xs icon ghost" data-act="resume" data-run="${r.id}" title="Resume" aria-label="Resume">${TI("player-play", "sm")}</button>` : live ? `<button type="button" class="btn xs icon ghost" data-act="pause" data-run="${r.id}" title="Pause" aria-label="Pause">${TI("player-pause", "sm")}</button>` : "";
    return `<button type="button" class="btn xs icon ghost" data-act="msg" data-run="${r.id}" title="Message (m)" aria-label="Message">${TI("message", "sm")}</button>${pp}<button type="button" class="btn xs icon ghost" data-act="menu" data-run="${r.id}" title="More" aria-label="More actions" aria-haspopup="menu">${TI("dots", "sm")}</button>`;
  }
  const TONE = { asking: "warn", recovering: "warn", idle: "warn", stopped: "warn", failed: "bad" };
  function tile(r, { sel = false } = {}) {
    const h = health(r);
    return `<article class="tile" data-run="${r.id}" data-tone="${TONE[h.s] || ""}" tabindex="0" aria-selected="${sel}" aria-label="${esc(name(r))}, ${esc(h.label)}" title="${esc(repoShort(r))}">
      <div class="t-h">${chip(r)}<div class="t-name"><span>${esc(name(r))}</span>${r.unseen ? '<i class="unseen" title="PROGRESS.md changed since you looked"></i>' : ""}</div><div class="t-right">${stChip(h)}<div class="t-acts">${tileActs(r)}</div></div></div>
      ${tileBody(r)}
      <div class="t-find" data-slot="find">${r.question ? "" : tileFind(r)}</div>
      <div class="t-f" data-slot="foot">${tileFoot(r)}</div>
      <div class="t-wave" data-slot="wave">${wave(r)}</div>
    </article>`;
  }
  function patchTile(el, r) {
    const now = el.querySelector('[data-slot="now"]');
    if (now) now.innerHTML = nowRows(r);
    el.querySelector('[data-slot="foot"]').innerHTML = tileFoot(r);
    el.querySelector('[data-slot="wave"]').innerHTML = wave(r);
    const st = el.querySelector(".t-right .st");
    if (st) st.outerHTML = stChip(health(r));
  }
  function miniLine(r) {
    if (r.question) return `<div class="mline warn"><span>${esc(r.question.text)}</span></div>`;
    if (r.status === "recovering") return `<div class="mline warn"><span>${esc(r.detail)}</span></div>`;
    if (r.status === "failed") return `<div class="mline bad"><span>${esc(r.detail)}</span></div>`;
    if (r.status === "done" || r.status === "triaged") return "";
    if (r.status === "paused" || r.status === "stopped") return "";
    const a = r.agents.filter((x) => x.status === "running" && x.now).sort((x, y) => y.nowAt - x.nowAt)[0];
    return a ? `<div class="mline"><span class="tool">${esc(a.now.tool)}</span><span>${esc(a.now.text)}</span></div>` : "";
  }
  function mini(r, sel) {
    const fs = findingsOf(r.id).filter((f) => !f.verdict);
    const h = health(r);
    const right = h.s === "running" ? (fs.length ? `<span class="sev" data-sev="${fs[0].sev}"></span><span class="m">${fs.length}</span>` : "") : stChip(h);
    return `<article class="tile mini" data-run="${r.id}" data-tone="${TONE[h.s] || ""}" tabindex="0" aria-selected="${sel}" aria-label="${esc(name(r))}"><div class="t-h">${chip(r)}<div class="t-name"><span>${esc(name(r))}</span>${r.unseen ? '<i class="unseen"></i>' : ""}</div><div class="t-right">${right}</div>${miniLine(r)}</div></article>`;
  }
  function lrow(r, sel) {
    const n = findingsOf(r.id);
    const open = n.filter((f) => !f.verdict).length;
    const btn = r.status === "done" && open ? `<button type="button" class="btn sm primary" data-act="triage" data-run="${r.id}">Triage ${open}</button>` : `<button type="button" class="btn sm ghost" data-act="open" data-run="${r.id}">Open</button>`;
    const dots = `<span class="sevs" title="${n.length} finding${n.length === 1 ? "" : "s"}">${n.map((f) => `<span class="sev ${f.verdict ? "done" : ""}" data-sev="${f.sev}"></span>`).join("")}</span>`;
    return `<div class="lrow" data-run="${r.id}" tabindex="0" aria-selected="${sel}">${chip(r)}<span class="n">${esc(name(r))}</span>${dots}<span class="s">${r.status === "triaged" ? `<span class="vt">${esc(r.verdict)}</span>` : ""}</span><span class="m">${r.finished ? ago(r.finished) : ""}</span><span class="m">${elapsed(r)}</span><span class="m">${money(r.cost)}</span>${btn}</div>`;
  }

  // one table row per run for the list view, with a checkbox for bulk actions
  function trow(r, picked) {
    const h = health(r), fs = findingsOf(r.id), live = isLive(r);
    return `<div class="trow" data-run="${r.id}" data-tone="${TONE[h.s] || ""}" tabindex="0" role="row"><label class="ck" title="Select"><input type="checkbox" data-pick="${r.id}" ${picked ? "checked" : ""} aria-label="Select ${esc(name(r))}"></label>${chip(r)}<span class="tn"><b>${esc(name(r))}</b>${r.unseen ? '<i class="unseen"></i>' : ""}<small>${esc(repoShort(r))}</small></span><span class="tst">${stChip(h)}</span><span class="tw">${live ? wave(r, 160, 24) : ""}</span><span class="sevs">${fs.map((f) => `<span class="sev ${f.verdict ? "done" : ""}" data-sev="${f.sev}"></span>`).join("")}</span><span class="tm">${esc(shortModel(r.model).replace(/^claude-/, ""))}</span><span class="m">${live && r.tps ? r.tps : "–"}</span><span class="m">${money(r.cost)}</span><span class="m">${elapsed(r)}</span><span class="ta">${tileActs(r)}</span></div>`;
  }

  /* ---------- counts row ---------- */
  function counts() {
    const live = runs.filter(isLive).length;
    const needs = runs.filter((r) => r.question || ["failed", "stopped"].includes(r.status)).length;
    const tri = untriaged().length;
    const cu = catchup();
    return `<span class="cnt"><b>${live}</b> live</span>${needs ? `<button type="button" class="cnt warn" data-act="first-need">${TI("alert-triangle", "sm")}<b>${needs}</b> need${needs === 1 ? "s" : ""} you</button>` : ""}${tri ? `<button type="button" class="cnt tri" data-act="findings">${TI("bug", "sm")}<b>${tri}</b> findings to triage</button>` : ""}${cu.runs.length ? `<button type="button" class="cnt since" data-act="catchup">${TI("history", "sm")}Since you looked <b>${dur(Date.now() - cu.since)}</b></button>` : ""}<span class="sp"></span><span class="clock" id="clock"></span>`;
  }

  /* ---------- catch-up block ---------- */
  const EV_ICON = { find: "bug", prog: "file", warn: "alert-triangle", bad: "circle-x", done: "file-check", "": "circle-dot" };
  function catchupHTML({ dismiss = true } = {}) {
    const c = catchup();
    if (!c.runs.length) return `<div class="cu"><div class="cu-h"><h2>All caught up</h2><span class="since">Nothing new since ${ago(c.since)}</span></div></div>`;
    const s = c.sum;
    const acts = (r, list) => {
      const a = list.find((e) => e.act);
      if (a?.act === "answer") return `<button type="button" class="btn xs warn" data-act="open" data-run="${r.id}">Answer</button>`;
      if (a?.act === "triage") return `<button type="button" class="btn xs primary" data-act="triage" data-run="${r.id}">Triage</button>`;
      if (a?.act === "retry") return `<button type="button" class="btn xs" data-act="retry" data-run="${r.id}">${TI("refresh", "xs")}Retry</button>`;
      return `<button type="button" class="btn xs ghost" data-act="open" data-run="${r.id}">Open</button>`;
    };
    return `<section class="cu" aria-label="Since you last looked"><div class="cu-h"><h2>Since you last looked</h2><span class="since">${dur(Date.now() - c.since)} ago</span>
      <div class="sum"><span><b>${s.found}</b> new findings</span><span><b>${s.finished}</b> finished</span><span><b>${s.failed}</b> failed</span><span><b>${s.asks}</b> question</span><span><b>${money(s.spent)}</b> spent</span></div>
      ${dismiss ? `<div class="right"><button type="button" class="btn xs" data-act="seen-all">Mark all seen</button></div>` : ""}</div>
      <ul class="cu-runs">${c.runs.map(({ run: r, ev }) => `<li class="cu-run">${chip(r)}<button type="button" class="n" data-act="open" data-run="${r.id}">${esc(name(r))}</button><div class="cu-ev">${ev.slice(0, 4).map((e) => `<span data-k="${e.k}"${e.finding ? ` role="button" tabindex="0" data-finding="${e.finding}" style="cursor:pointer"` : ""}><i class="evd"></i>${esc(e.t)}<em>${age(e.at)}</em></span>`).join("")}${ev.length > 4 ? `<span style="color:var(--ink-3)">${ev.length - 4} more</span>` : ""}</div><div class="acts">${acts(r, ev)}</div></li>`).join("")}</ul></section>`;
  }

  /* ---------- run detail ---------- */
  const TABS = [["overview", "Overview", "layout-grid"], ["findings", "Findings", "bug"], ["transcript", "Transcript", "message"], ["files", "Files", "folder"], ["timeline", "Timeline", "history"], ["terminal", "Terminal", "terminal-2"], ["machine", "Machine", "cpu"]];
  function detailHead(r, { close = false } = {}) {
    const h = health(r);
    const live = isLive(r);
    const acts = [];
    if (r.status === "failed") acts.push(`<button type="button" class="btn sm" data-act="retry" data-run="${r.id}">${TI("refresh", "sm")}Retry</button>`);
    else if (r.status === "paused" || r.status === "stopped") acts.push(`<button type="button" class="btn sm" data-act="resume" data-run="${r.id}">${TI("player-play", "sm")}Resume</button>`);
    else if (live) acts.push(`<button type="button" class="btn sm" data-act="pause" data-run="${r.id}">${TI("player-pause", "sm")}Pause</button>`, `<button type="button" class="btn sm icon danger" data-act="stop" data-run="${r.id}" title="Stop" aria-label="Stop">${TI("player-stop", "sm")}</button>`);
    acts.push(`<button type="button" class="btn sm icon" data-act="menu" data-run="${r.id}" aria-label="More actions" aria-haspopup="menu">${TI("dots", "sm")}</button>`);
    if (close) acts.push(`<button type="button" class="btn sm icon ghost" data-act="close" aria-label="Close" title="Close (Esc)">${TI("x", "sm")}</button>`);
    const notice = r.detail && ["recovering", "failed", "preparing"].includes(r.status) ? `<div class="notice" data-tone="${r.status === "failed" ? "bad" : "warn"}">${esc(r.detail)}</div>` : "";
    const c = ctxPct(r);
    const hours = Math.max(0.25, ((r.finished || Date.now()) - r.started) / H);
    const work = r.agents.filter((a) => a.status === "running").length;
    const cell = (k, v, extra = "", cls = "") => `<div class="ds ${cls}"><span class="k">${k}</span><b>${v}</b>${extra}</div>`;
    const stats = [
      live ? cell("tok/s", r.tps || 0, `<span class="dsw">${wave(r, 120, 22)}</span>`) : "",
      cell("Cost", money(r.cost), `<small>${money(r.cost / hours)}/h</small>`),
      cell("Tokens", tok(r.tokens.in + r.tokens.out), `<small>${Math.round((r.cached || 0.86) * 100)}% cached</small>`),
      live ? cell("Context", `${c}%`, bar(c, c > 55), c > 55 ? "warn" : "") : "",
      r.agents.length ? cell("Agents", `${work}<i>/${r.agents.length}</i>`, `<span class="agd">${r.agents.map((a) => agIcon(a.status)).join("")}</span>`) : "",
      r.autopilot ? cell("Continues", `${r.continues}<i>/3</i>`, "", r.continues >= 2 ? "warn" : "") : "",
    ].join("");
    return `<div class="dh"><div class="dh-top">${chip(r)}<h1 data-rename="${r.id}" title="Double-click to rename">${esc(name(r))}</h1>${stChip(h)}<div class="acts">${acts.join("")}</div></div>
      <div class="dh-meta"><span>${esc(repoShort(r))} · ${esc(r.ref)}${r.commit ? `@${esc(r.commit.slice(0, 7))}` : ""} · ${esc(r.template)}</span><span class="dh-pills"><button type="button" class="pill" data-act="model" data-run="${r.id}" title="Model" aria-haspopup="menu">${TI("brain", "sm")}${esc(shortModel(r.model))} <small>${esc(r.variant)}</small>${TI("chevron-down", "xs")}</button><button type="button" class="pill" data-act="key" data-run="${r.id}" title="${r.failover ? "API key, fails over to the next key" : "API key"}" aria-haspopup="menu">${TI("key", "sm")}${esc(r.key)}${TI("chevron-down", "xs")}</button><span class="pill" title="Machine">${TI("cpu", "sm")}${r.machine.cpu} · ${r.machine.mem} GB</span></span></div>
      ${notice}<div class="dh-stats">${stats}</div></div>`;
  }
  function tabsHTML(r, tab) {
    const nf = findingsOf(r.id).filter((f) => !f.verdict).length;
    return `<div class="tabs" role="tablist" aria-label="Run views">${TABS.map(([id, l, ic]) => `<button type="button" role="tab" data-tab="${id}" aria-selected="${tab === id}">${TI(ic, "sm")}${l}${id === "findings" && findingsOf(r.id).length ? `<span class="badge ${nf ? "warn" : ""}">${nf ? nf : findingsOf(r.id).length}</span>` : ""}${id === "overview" && r.question ? '<span class="badge warn">1</span>' : ""}</button>`).join("")}</div>`;
  }
  const verdictTag = (f) => `<span class="verdict" data-v="${f.verdict || "new"}">${f.verdict ? esc(f.verdict) : f.agent === "suspected" ? "suspected" : ""}</span>`;
  function findingsMini(r) {
    const fs = findingsOf(r.id);
    if (!fs.length) return "";
    return `<section><div class="sec-h"><h2>Findings</h2></div><ul class="fcards">${fs.map((f) => `<li data-finding="${f.id}" tabindex="0"><span class="sev" data-sev="${f.sev}"></span><div class="fc-b"><b>${esc(f.title)}</b><span>${esc(f.where || "")}</span></div>${verdictTag(f)}</li>`).join("")}</ul></section>`;
  }
  // one row per agent: state, title, age, what it runs now, and its last 60 minutes of tool calls
  function agentRows(r, minutes = 60) {
    const now = Date.now(), W = 600;
    const row = (a) => {
      const ticks = r.ticks.filter((t) => t.a === a.id && now - t.ts < minutes * M);
      const lines = ticks.map((t) => { const x = (W - ((now - t.ts) / (minutes * M)) * W).toFixed(1); return `<line x1="${x}" x2="${x}" y1="${a.status === "done" ? 3 : 1}" y2="${a.status === "done" ? 9 : 11}" style="stroke:var(--k-${t.k})"/>`; }).join("");
      const kids = r.agents.filter((k) => k.parent === a.id);
      const what = R.agentNow(r, a);
      return `<li class="agr" data-s="${a.status}"><div class="agr-top">${agIcon(a.status)}<span class="t" title="${esc(a.title)}">${esc(a.title)}</span><span class="age">${dur(now - a.started).replace(/ \d+s$/, "")}</span></div>${what ? `<div class="agr-now">${what}</div>` : ""}<svg class="agr-lane" viewBox="0 0 ${W} 12" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="${W}" y1="6" y2="6" class="base"/>${lines}</svg>${kids.length ? `<ul>${kids.map(row).join("")}</ul>` : ""}</li>`;
    };
    return `<ul class="agrs">${r.agents.filter((a) => !a.parent).map(row).join("")}</ul><div class="agr-axis"><span>${minutes}m</span><span>now</span></div>${R.legend()}`;
  }
  const agentsCard = (r) => `<div class="sec-h"><h2>Agents</h2></div>${agentRows(r)}`;
  function todosCard(r) {
    const d = r.todos.filter((t) => t[0] === "completed").length;
    return `<section><div class="sec-h"><h2>Todos</h2><span class="meta">${d}/${r.todos.length}</span></div><div class="tbar"><i style="width:${(d / r.todos.length) * 100}%"></i></div>${R.todos(r)}</section>`;
  }
  function overview(r, st) {
    const changes = st.mode === "changes";
    const u = r.unseen;
    return `<div class="ov"><div class="ov-main">${r.question ? R.question(r) : ""}
      <section class="doc"><div class="sec-h"><h2>${TI("file", "sm")}PROGRESS.md</h2>${u ? `<span class="delta" title="Lines changed since you looked">+${u.add} −${u.del}</span>` : ""}<div class="right"><div class="seg" role="group" aria-label="Progress view"><button type="button" data-mode="text" aria-pressed="${!changes}">Text</button><button type="button" data-mode="changes" aria-pressed="${changes}">Changes</button></div></div></div>${R.progress(r, changes ? "changes" : "text")}</section>
      </div><div class="ov-side">${findingsMini(r)}
      ${r.agents.length ? `<section data-slot="agents">${agentsCard(r)}</section>` : ""}
      ${r.todos.length ? todosCard(r) : ""}
      ${r.reads.length || r.readBy.length ? `<section><div class="sec-h"><h2>Other workbases</h2></div>${R.crossReads(r)}</section>` : ""}</div></div>`;
  }
  function findingCard(f, { full = true } = {}) {
    const r = find(f.run);
    const live = r && isLive(r);
    const dup = f.dupHint ? fById(f.dupHint) : null;
    return `<article class="fd" data-fd="${f.id}">
      <div class="fd-h"><div class="fd-meta"><span class="sev" data-sev="${f.sev}">${f.sev}</span><span>${esc(f.id)}</span><span>${f.agent === "suspected" ? "suspected, not reproduced" : "confirmed by the agent"}</span><span>${ago(f.at)}</span>${full && r ? `<span>${chip(r)}<button type="button" class="x-link" data-act="open" data-run="${r.id}">${esc(name(r))}</button></span>` : ""}</div>
      <h2>${esc(f.title)}</h2><div class="fd-meta"><code>${esc(f.where)}</code><span>${esc(f.fn || "")}</span><span>${esc(f.cls)}</span></div></div>
      <p>${esc(f.summary).replace(/`([^`]+)`/g, "<code>$1</code>")}</p>
      ${dup ? `<div class="flags" style="font-size:13px"><span>Looks like the same root cause as ${dup.id}, “${esc(dup.title)}”</span></div>` : ""}
      ${f.evidence ? `<div><div class="lbl">Evidence</div><pre>${esc(f.evidence)}</pre></div>` : ""}
      <div class="links">${f.poc ? `<button type="button" class="btn xs" data-act="file" data-run="${f.run}" data-file="${esc(f.poc)}">${TI("file", "xs")}${esc(f.poc)}</button>` : ""}${f.repro ? `<button type="button" class="btn xs" data-act="copy" data-text="${esc(f.repro)}" title="Copy">${TI("copy", "xs")}<code>${esc(f.repro)}</code></button>` : ""}<button type="button" class="btn xs ghost" data-act="tab" data-tab="transcript" data-run="${f.run}">${TI("message", "xs")}Find it in the transcript</button></div>
      <div class="vbox"><div class="lbl" style="margin:0">Your verdict · written to TRIAGE.md${live ? ", and sent to the agent" : ""}</div>
        <div class="vbtns">${VERDICTS.map((v) => `<button type="button" class="vbtn" data-v="${v.v}" data-verdict="${f.id}" aria-pressed="${f.verdict === v.v}"><b>${v.label}<kbd>${v.key.toUpperCase()}</kbd></b><small>${v.hint}</small></button>`).join("")}</div>
        <textarea id="note-${f.id}" data-note="${f.id}" rows="2" placeholder="Note (optional): why, upstream issue, CVE">${esc(f.note)}</textarea></div>
    </article>`;
  }
  function findingsTab(r) {
    const fs = findingsOf(r.id);
    const rep = r.report ? `<section style="margin-top:28px"><div class="sec-h"><h2>REPORT.md</h2></div>${R.report(r).replace(/<form class="x-triage"[\s\S]*<\/form>/, "")}</section>` : `<p class="x-empty" style="margin-top:20px">${isLive(r) ? "No REPORT.md yet. Findings appear here as the agent lists them in PROGRESS.md." : "No REPORT.md."}</p>`;
    return `<div class="pad">${fs.length ? `<div style="display:flex;flex-direction:column;gap:12px">${fs.map((f) => `<div style="border:1px solid var(--line);border-radius:8px;background:var(--s1)">${findingCard(f, { full: false })}</div>`).join("")}</div>` : `<p class="x-empty">No findings yet.</p>`}${rep}</div>`;
  }
  function tabBody(r, st) {
    switch (st.tab) {
      case "findings": return findingsTab(r);
      case "transcript": return `<div class="pad">${R.transcript(r)}</div>`;
      case "files": return `<div class="pad">${R.files(r, st.file)}</div>`;
      case "timeline": return `<div class="pad">${R.timeline(r)}</div>`;
      case "terminal": return `<div class="pad">${R.terminal(r)}</div>`;
      case "machine": return `<div class="pad">${R.machine(r)}</div>`;
      default: return overview(r, st);
    }
  }
  function composer(r) {
    if (["triaged", "failed"].includes(r.status)) return "";
    const quick = isLive(r) ? ["What are you doing right now?", "Write up what you have so far", "Wrap up and write the report"] : [];
    return `<form class="compose" data-compose="${r.id}">${quick.length ? `<div class="quick">${quick.map((q) => `<button type="button" class="qk" data-quick="${esc(q)}">${esc(q)}</button>`).join("")}</div>` : ""}<div class="cbox">${TI("terminal-2", "sm")}<textarea id="compose-${r.id}" name="msg" rows="1" placeholder="Message ${esc(name(r))}" aria-label="Message the agent"></textarea><span class="hint"><kbd>${TI("command")}</kbd><kbd>${TI("corner-down-left")}</kbd></span><button type="submit" class="btn sm primary icon" aria-label="Send">${TI("arrow-up", "sm")}</button></div></form>`;
  }
  function detail(r, st, opts = {}) {
    return `${detailHead(r, opts)}${tabsHTML(r, st.tab)}<div class="db" data-slot="db">${tabBody(r, st)}</div>${composer(r)}`;
  }

  /* ---------- findings across runs ---------- */
  function findingsTable(sel, { openOnly = false } = {}) {
    const open = findings.filter((f) => !f.verdict).sort((a, b) => sevRank(a) - sevRank(b) || b.at - a.at);
    const done = openOnly ? [] : findings.filter((f) => f.verdict).sort((a, b) => b.at - a.at);
    const row = (f) => { const r = find(f.run); return `<div class="frow" data-finding="${f.id}" tabindex="0" aria-selected="${sel === f.id}"><span class="sev" data-sev="${f.sev}">${f.sev}</span><span class="ft"><b>${esc(f.title)}</b><span>${esc(f.where)} · ${esc(f.cls)}</span></span><span class="fr">${r ? chip(r) : ""}<span>${esc(r ? name(r) : f.run)}</span></span><span class="fa">${age(f.at)}</span>${verdictTag(f)}</div>`; };
    return `<div class="ftable" role="listbox" aria-label="Findings">${open.length ? `<div class="fgroup">To triage <span>${open.length}</span></div>${open.map(row).join("")}` : ""}${done.length ? `<div class="fgroup">Triaged <span>${done.length}</span></div>${done.map(row).join("")}` : ""}</div>`;
  }

  /* ---------- delegated behaviour ---------- */
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (b) {
      const id = b.dataset.run, a = b.dataset.act, u = ui();
      e.stopPropagation();
      switch (a) {
        case "pause": case "resume": case "stop": case "retry": act(id, a); return;
        case "menu": PX.runMenu(b, id); return;
        case "model": PX.modelMenu(b, id); return;
        case "key": PX.keyMenu(b, id); return;
        case "open": u.openRun?.(id); return;
        case "triage": u.openRun?.(id, { tab: "findings" }); return;
        case "msg": u.message?.(id); return;
        case "close": u.close?.(); return;
        case "findings": u.openPage?.("Findings"); return;
        case "catchup": u.catchup?.(); return;
        case "first-need": { const r = runs.find((x) => x.question) || runs.find((x) => ["failed", "stopped"].includes(x.status)); if (r) u.openRun?.(r.id); return; }
        case "seen-all": markAllSeen(); return;
        case "edit-retry": u.newRun?.({ repo: find(id).repo }); return;
        case "tab": u.openRun?.(id, { tab: b.dataset.tab }); return;
        case "file": u.openRun?.(id, { tab: "files", file: b.dataset.file }); return;
        case "theme": toggleTheme(); return;
        case "copy": try { await navigator.clipboard.writeText(b.dataset.text); PX.toast("Copied"); } catch { PX.toast("Copy is blocked here; select the text instead"); } return;
      }
    }
    const v = e.target.closest("[data-verdict]");
    if (v) { setVerdict(v.dataset.verdict, v.dataset.v); return; }
    const fi = e.target.closest("[data-finding]");
    if (fi) { ui().openFinding?.(fi.dataset.finding); return; }
    const tab = e.target.closest("[data-tab]");
    if (tab) { ui().setTab?.(tab.dataset.tab); return; }
    const mode = e.target.closest("[data-mode]");
    if (mode) { ui().setMode?.(mode.dataset.mode); return; }
  });
  document.addEventListener("click", (e) => { const q = e.target.closest("[data-quick]"); if (!q) return; const ta = q.closest("form").querySelector("textarea"); ta.value = q.dataset.quick; ta.focus(); });
  document.addEventListener("input", (e) => { const n = e.target.closest("[data-note]"); if (n) fById(n.dataset.note).note = n.value; });
  document.addEventListener("submit", (e) => {
    const f = e.target.closest("[data-compose]");
    if (!f) return;
    e.preventDefault();
    const input = f.querySelector("textarea");
    const text = input.value.trim();
    if (!text) return;
    PX.message(f.dataset.compose, text);
    input.value = "";
  });
  document.addEventListener("keydown", (e) => {
    const ta = e.target.closest?.("[data-compose] textarea");
    if (ta && e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ta.form.requestSubmit(); }
  });
  const plainKey = (e) => !(e.metaKey || e.ctrlKey || e.altKey) && !e.target.closest("input, textarea, select, [contenteditable], .x-pal, .x-dialog-scrim, .x-menu");
  document.addEventListener("keydown", (e) => {
    if (!plainKey(e)) return;
    const card = document.querySelector(".scrim-c [data-fd]");
    const v = card && VERDICTS.find((x) => x.key === e.key.toLowerCase());
    if (v) { e.preventDefault(); setVerdict(card.dataset.fd, v.v); }
  });
  document.addEventListener("dblclick", (e) => { const h = e.target.closest("[data-rename]"); if (h) ui().rename?.(h.dataset.rename); });

  function rename(id, h1) {
    const r = find(id);
    if (!h1) return;
    const input = document.createElement("input");
    input.value = name(r);
    input.setAttribute("aria-label", "Run name");
    input.style.cssText = "font:650 22px var(--sans);letter-spacing:-.02em;border:1px solid var(--line);border-radius:6px;padding:0 8px;min-width:0;width:100%;background:var(--s2)";
    h1.replaceWith(input);
    input.focus();
    input.select();
    const done = (save) => { if (save) act(id, "rename", input.value.trim() === r.id ? "" : input.value.trim()); else emit("change", { run: id, quiet: true }); };
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") done(true); if (ev.key === "Escape") { ev.stopPropagation(); done(false); } });
    input.addEventListener("blur", () => done(true), { once: true });
  }

  // run names decrypt in when a run opens
  const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+=<>/";
  function decrypt(el) {
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const text = el.textContent;
    let f = 0;
    const tick = () => {
      if (!el.isConnected) return;
      const done = Math.floor(f / 2);
      el.textContent = [...text].map((c, i) => (i < done || c === " " ? c : GLYPHS[(Math.random() * GLYPHS.length) | 0])).join("");
      if (done < text.length) (f++, requestAnimationFrame(tick));
      else el.textContent = text;
    };
    tick();
  }

  // dark by default; light only when picked here
  function toggleTheme() {
    const light = document.documentElement.getAttribute("data-theme") === "light";
    if (light) document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", "light");
    try { localStorage.setItem("pixel-r7-theme", light ? "dark" : "light"); } catch {}
    emit("theme");
  }
  try { if (localStorage.getItem("pixel-r7-theme") === "light") document.documentElement.setAttribute("data-theme", "light"); else document.documentElement.removeAttribute("data-theme"); } catch { document.documentElement.removeAttribute("data-theme"); }

  function dialog(html, label) {
    const d = document.createElement("div");
    d.className = "scrim-c";
    d.innerHTML = `<div class="card-dlg" role="dialog" aria-modal="true" aria-label="${esc(label)}">${html}</div>`;
    document.body.appendChild(d);
    const close = () => { d.remove(); document.removeEventListener("keydown", key, true); };
    const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    d.addEventListener("mousedown", (e) => { if (e.target === d) close(); });
    d.addEventListener("click", (e) => { if (e.target.closest('[data-act="open"], [data-act="triage"], [data-act="tab"], [data-act="file"], [data-act="close"], [data-act="retry"]')) close(); });
    document.addEventListener("keydown", key, true);
    d.querySelector("button, input, textarea")?.focus();
    return { el: d, close };
  }

  window.K = {
    findings, fById, findingsOf, untriaged, setVerdict, VERDICTS, catchup, catchupHTML, markAllSeen, seenAt, health, stChip,
    tile, patchTile, mini, nowRows, tileBody, tileFind, tileFoot, agentsCard, busy, lrow, counts, detail, detailHead, tabsHTML, tabBody,
    findingCard, findingsTable, chip, brand, age, TI, feed, trow, wave, agentRows, needsYou: PX.needsYou, plainKey, rename, decrypt, dialog, sevRank, toggleTheme,
  };
})();
