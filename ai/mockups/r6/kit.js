/*
 * Pixel mockups, round 6. Builds on ../shared.js (fake runs, live simulation, actions, renderers) and adds:
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
      title: "Heap overflow in iCCP decompression", cls: "heap-buffer-overflow, read of 1 byte", where: "pngrutil.c:1184", fn: "png_inflate ← png_handle_iCCP", poc: "poc/iccp-0041.png",
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
  function catchup() {
    const ev = {
      "libpng-2026-10-14": [{ k: "prog", t: "PROGRESS.md changed 9 times", at: T0 - 27 * S }, { k: "", t: "1 automatic continue", at: T0 - (2 * H + 5 * M) }],
      "tinyxml2-2026-10-13": [{ k: "warn", t: "Asked you a question", at: T0 - 12 * M, act: "answer" }, { k: "warn", t: "2 of 3 continues used", at: T0 - 40 * M }],
      "expat-2026-10-13": [{ k: "bad", t: "OOM-killed twice linking the MSan build", at: T0 - 2 * M }, { k: "warn", t: "Recovering, attempt 2 of 3", at: T0 - 2 * M }],
      "zlib-2026-10-14": [{ k: "", t: "Started by you", at: T0 - (1 * H + 26 * M) }, { k: "prog", t: "No findings yet", at: T0 - 14 * M }],
      "yaml-cpp-2026-10-12": [{ k: "done", t: "Finished after 9h 02m · REPORT.md written", at: T0 - (12 * H + 8 * M), act: "triage" }],
      "libxml2-2026-10-14": [{ k: "bad", t: "Failed while preparing: git clone timed out", at: T0 - 28 * M, act: "retry" }],
    };
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

  /* ---------- health: one status sentence, plus flags only when something is off ---------- */
  const busy = (r) => r.agents.filter((a) => a.status === "running").length;
  function health(r) {
    const flags = [];
    let tone = "", st;
    const live = isLive(r);
    if (r.question) (tone = "warn"), (st = `Waiting for you · ${dur(Date.now() - r.question.at)}`);
    else if (r.status === "recovering") (tone = "warn"), (st = "Recovering");
    else if (r.status === "failed") (tone = "bad"), (st = "Failed");
    else if (r.status === "preparing") (tone = "warn"), (st = r.detail || "Preparing");
    else if (r.status === "stopped") (tone = "warn"), (st = "Stopped");
    else if (r.status === "paused") st = "Paused";
    else if (r.status === "done") (tone = "info"), (st = "Report ready");
    else if (r.status === "triaged") st = `Triaged · ${r.verdict}`;
    else if (r.agent === "idle") (tone = "warn"), (st = "Idle");
    else { const n = busy(r); tone = "ok"; st = n ? `Working · ${n} agent${n > 1 ? "s" : ""} busy` : "Working"; }
    if (live) {
      if (r.progressAt && Date.now() - r.progressAt > 45 * M) flags.push(`PROGRESS.md quiet for ${dur(Date.now() - r.progressAt)}`);
      if (r.ctx / r.ctxMax > 0.55) flags.push(`Context ${Math.round((r.ctx / r.ctxMax) * 100)}% full`);
      if (r.continues >= 2) flags.push(`${r.continues} of 3 continues used`);
      if (r.ooms) flags.push(`${r.ooms} OOM restart${r.ooms > 1 ? "s" : ""}`);
    }
    const frame = r.question || ["recovering", "stopped"].includes(r.status) ? "warn" : r.status === "failed" ? "bad" : "";
    return { tone, st, flags, frame };
  }

  /* ---------- small helpers ---------- */
  const chip = (r) => `<span class="chip" style="background:var(--r${r.hue})" aria-hidden="true"></span>`;
  const STOP = new Set(["the", "a", "an", "with", "and", "for", "of", "to", "against"]);
  const shortTitle = (a) => (a.id === "main" ? "main" : a.title.split(" ").filter((w) => !STOP.has(w.toLowerCase())).slice(0, 2).join(" "));
  const age = (ts) => { const s = Math.max(0, Math.round((Date.now() - ts) / S)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`; };
  // [████░░] 59%: block meter in text
  const meter = (pct, n = 8, warn = false) => { const k = Math.round((pct / 100) * n); return `<span class="meter ${warn ? "warn" : ""}">${"█".repeat(k)}<i>${"░".repeat(n - k)}</i></span> <b>${pct}%</b>`; };
  // ▁▂▃▅▇ sparkline in text
  const tspark = (vals, n = 24) => { const v = vals.slice(-n), mx = Math.max(1, ...v); return `<span class="tspark" aria-hidden="true">${v.map((x) => "▁▂▃▄▅▆▇█"[Math.min(7, Math.round((x / mx) * 7))]).join("")}</span>`; };
  const elapsed = (r) => dur((r.finished || Date.now()) - r.started);
  const ctxPct = (r) => (r.ctxMax ? Math.round((r.ctx / r.ctxMax) * 100) : 0);
  const barcode = (r, w, h) => R.barcode(r, w, h).replace('<svg class="x-barcode"', '<svg class="x-barcode" preserveAspectRatio="none"');
  const icon = {
    pause: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6v12M15 6v12"/></svg>',
    play: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z"/></svg>',
    stop: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/></svg>',
    more: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>',
    msg: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v10H9l-4 4z"/></svg>',
    close: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    retry: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4"/></svg>',
    down: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>',
    send: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
    expand: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M10 19H5v-5M19 5l-6 6M5 19l6-6"/></svg>',
    collapse: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 10h-5V5M5 14h5v5M14 10l6-6M10 14l-6 6"/></svg>',
  };
  const brand = `<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="0" y="0" width="9" height="9" rx="0.5" style="fill:var(--r0)"/><rect x="11" y="0" width="9" height="9" rx="0.5" style="fill:var(--r1)"/><rect x="0" y="11" width="9" height="9" rx="0.5" style="fill:var(--r3)"/><rect x="11" y="11" width="9" height="9" rx="0.5" style="fill:var(--ink)"/></svg>`;


  /* ---------- tile parts ---------- */
  function nowRows(r, max = 4) {
    const ag = r.agents.filter((a) => a.status !== "done");
    if (!ag.length) return "";
    const kids = r.agents.filter((a) => a.parent === "main" && a.status === "running").length;
    const shown = ag.slice(0, max);
    const lastKid = [...shown].reverse().find((a) => a.parent);
    const rows = shown.map((a) => {
      let cmd;
      if (a.status === "waiting") cmd = `<span class="cmd quiet">waiting on ${kids} subagent${kids === 1 ? "" : "s"}</span>`;
      else if (a.status === "idle") cmd = `<span class="cmd quiet">idle</span>`;
      else if (a.status === "interrupted") cmd = `<span class="cmd quiet">interrupted · resumes on restart</span>`;
      else if (a.now) cmd = `<span class="cmd"><span class="x-tool" data-kind="${kindOf(a.now.tool)}">${esc(a.now.tool)}</span>${esc(a.now.text)}</span>`;
      else cmd = `<span class="cmd quiet">thinking…</span>`;
      return `<li data-agent="${esc(a.id)}"><span class="x-ring" data-s="${a.status}"></span><span class="who" title="${esc(a.title)}">${a.parent ? `<span class="tree">${a === lastKid ? "└─" : "├─"}</span>` : ""}${esc(shortTitle(a))}</span>${cmd}<span class="age">${a.status === "running" ? age(a.nowAt) : ""}</span></li>`;
    });
    if (ag.length > max) rows.push(`<li class="more">+${ag.length - max} more agents</li>`);
    return rows.join("");
  }
  function tileBody(r, h) {
    if (r.question) {
      const q = r.question;
      return `<form class="t-body" data-tone="warn" data-ask="${r.id}"><span class="lab">Asked ${ago(q.at)}</span><p class="q">${esc(q.text)}</p><div class="opts">${q.options.map((o, i) => `<button type="button" class="x-opt" data-opt="${esc(o)}"><kbd>${i + 1}</kbd>${esc(o)}</button>`).join("")}</div></form>`;
    }
    if (r.status === "recovering") {
      const n = Math.min(3, r.ooms || 1);
      return `<div class="t-body" data-tone="warn"><p>${esc(r.detail)}</p><div class="attempts"><span class="meter warn">[${"■".repeat(n)}<i>${"□".repeat(3 - n)}</i>]</span><span>attempt ${n} of 3</span></div></div>`;
    }
    if (r.status === "failed")
      return `<div class="t-body" data-tone="bad"><p>${esc(r.detail)}</p><div class="opts"><button type="button" class="btn sm" data-act="retry" data-run="${r.id}">${icon.retry}Retry</button><button type="button" class="btn sm ghost" data-act="edit-retry" data-run="${r.id}">Edit and retry…</button></div></div>`;
    if (r.status === "done") {
      const n = findingsOf(r.id).filter((f) => !f.verdict).length;
      return `<div class="t-body" data-tone="info"><p>REPORT.md is written. ${n ? `${n} finding${n > 1 ? "s" : ""} to triage.` : ""}</p><div class="opts"><button type="button" class="btn sm" data-act="triage" data-run="${r.id}">Triage</button></div></div>`;
    }
    if (r.status === "paused" || r.status === "stopped")
      return `<div class="t-body"><p>${r.status === "paused" ? "Paused by you. The machine keeps running." : "Stopped. The machine and workbase are kept."}</p><div class="opts"><button type="button" class="btn sm" data-act="resume" data-run="${r.id}">${icon.play}Resume</button></div></div>`;
    return `<ul class="now" data-slot="now">${nowRows(r)}</ul>`;
  }
  function tileFind(r, h, { headline = true } = {}) {
    const fs = findingsOf(r.id);
    const lines = [];
    if (h.flags.length) lines.push(`<div class="flags">${h.flags.map((f) => `<span>${esc(f)}</span>`).join("")}</div>`);
    if (fs.length) {
      const f = fs[0];
      const more = fs.length - 1;
      lines.push(`<div class="fline"><span class="sev" data-sev="${f.sev}">${f.sev}</span><span class="tx">${esc(f.title)}${f.agent === "suspected" ? ' <span class="tag">suspected</span>' : ""}</span>${more ? `<span class="d">+${more}</span>` : ""}</div>`);
    } else {
      const hl = headline && R.headline(r);
      if (!headline) {}
      else if (hl) lines.push(`<div class="fline"><span class="tag">${esc(hl.label)}</span><span class="tx">${esc(hl.text).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "$1")}</span></div>`);
      else lines.push(`<div class="fline"><span class="tx" style="color:var(--ink-3)">No PROGRESS.md yet</span></div>`);
    }
    return lines.join("");
  }
  function tileFoot(r) {
    const live = isLive(r);
    const c = ctxPct(r);
    return `<span><b>${r.tps ? r.tps : "–"}</b> tok/s</span><span class="bc">${barcode(r, 150, 18)}</span>${live ? `<span class="${c > 55 ? "warn" : ""}">ctx ${meter(c, 6, c > 55)}</span>` : ""}<span><b>${money(r.cost)}</b></span>`;
  }
  function tileActs(r) {
    const live = isLive(r);
    const pp = r.status === "paused" ? `<button type="button" class="btn xs icon ghost" data-act="resume" data-run="${r.id}" title="Resume" aria-label="Resume">${icon.play}</button>` : live ? `<button type="button" class="btn xs icon ghost" data-act="pause" data-run="${r.id}" title="Pause" aria-label="Pause">${icon.pause}</button>` : "";
    return `<button type="button" class="btn xs icon ghost" data-act="msg" data-run="${r.id}" title="Message (m)" aria-label="Message">${icon.msg}</button>${pp}<button type="button" class="btn xs icon ghost" data-act="menu" data-run="${r.id}" title="More" aria-label="More actions" aria-haspopup="menu">${icon.more}</button>`;
  }
  function tile(r, { sel = false, reply = false } = {}) {
    const h = health(r);
    return `<article class="tile" data-run="${r.id}" data-tone="${h.frame}" tabindex="0" aria-selected="${sel}" aria-label="${esc(name(r))}, ${esc(h.st)}">
      <div class="t-h">${chip(r)}<div class="t-name"><span>${esc(name(r))}</span>${r.unseen ? '<i class="unseen" title="PROGRESS.md changed since you looked"></i>' : ""}</div><div class="t-acts">${tileActs(r)}</div>
        <div class="t-sub"><span class="st" data-tone="${h.tone}">${esc(h.st)}</span><span class="meta">· ${esc(repoShort(r))} · ${esc(shortModel(r.model))} · ${elapsed(r)}</span></div></div>
      ${tileBody(r, h)}
      <div class="t-find" data-slot="find">${tileFind(r, h)}</div>
      <div class="t-f" data-slot="foot">${tileFoot(r)}</div>
      ${reply ? `<form class="t-reply" data-reply="${r.id}"><input id="reply-${r.id}" name="msg" placeholder="Message ${esc(name(r))}" autocomplete="off" aria-label="Message ${esc(name(r))}"></form>` : ""}
    </article>`;
  }
  // live update of one tile without losing focus or typed text
  function patchTile(el, r) {
    const now = el.querySelector('[data-slot="now"]');
    if (now) now.innerHTML = nowRows(r);
    el.querySelector('[data-slot="foot"]').innerHTML = tileFoot(r);
  }
  function miniLine(r) {
    if (r.question) return `<div class="mline warn">Waiting for you · ${esc(r.question.text)}</div>`;
    if (r.status === "recovering") return `<div class="mline warn">${esc(r.detail)}</div>`;
    if (r.status === "failed") return `<div class="mline bad">${esc(r.detail)}</div>`;
    if (r.status === "done") { const n = findingsOf(r.id).filter((f) => !f.verdict).length; return `<div class="mline">Report ready${n ? ` · ${n} to triage` : ""}</div>`; }
    if (r.status === "triaged") return `<div class="mline">Triaged · ${esc(r.verdict)}</div>`;
    if (r.status === "paused" || r.status === "stopped") return `<div class="mline">${r.status === "paused" ? "Paused" : "Stopped"}</div>`;
    const a = r.agents.filter((x) => x.status === "running" && x.now).sort((x, y) => y.nowAt - x.nowAt)[0];
    return a ? `<div class="mline"><span class="x-tool" data-kind="${kindOf(a.now.tool)}">${esc(a.now.tool)}</span>${esc(a.now.text)}</div>` : `<div class="mline">idle</div>`;
  }
  function mini(r, sel) {
    const h = health(r);
    const n = findingsOf(r.id).filter((f) => !f.verdict).length;
    return `<article class="tile mini" data-run="${r.id}" data-tone="${h.frame}" tabindex="0" aria-selected="${sel}" aria-label="${esc(name(r))}, ${esc(h.st)}"><div class="t-h">${chip(r)}<div class="t-name"><span>${esc(name(r))}</span>${r.unseen ? '<i class="unseen"></i>' : ""}</div><span class="st-mini" style="font:12px var(--mono);color:var(--ink-3)">${n ? `<span class="sev" data-sev="${findingsOf(r.id)[0].sev}">${n}</span>` : isLive(r) ? (r.tps ? `${r.tps} tok/s` : "") : ""}</span>${miniLine(r)}</div></article>`;
  }

  // up to n PROGRESS.md items, lines changed since you looked first
  function progressExcerpt(r, n = 4, { skipFound = false } = {}) {
    if (!r.progress) return `<div class="x-empty">No PROGRESS.md yet</div>`;
    const items = [];
    let sec = "";
    for (const l of r.progress.split("\n")) {
      if (l.startsWith("{-}")) continue;
      const h = l.match(/^## (.*)/);
      if (h) { sec = h[1]; continue; }
      const isNew = l.startsWith("{+}");
      const t = l.replace(/^\{\+\}/, "");
      if (skipFound && /^Found/.test(sec)) continue;
      if (t.startsWith("- ") && !/Nothing yet/.test(t)) items.push({ isNew, sec, t: t.slice(2) });
    }
    const pick = [...items.filter((x) => x.isNew), ...items.filter((x) => !x.isNew)].slice(0, n);
    return `<ul class="pex">${pick.map((x) => `<li class="${x.isNew ? "new" : ""}"><span class="sec">${esc(x.sec.replace(/ \/ confirmed/, ""))}</span><span class="tx">${R.md("- " + x.t).replace(/^<ul><li>|<\/li><\/ul>$/g, "")}</span></li>`).join("")}</ul>`;
  }

  /* ---------- finished list row ---------- */
  function lrow(r, sel) {
    const n = findingsOf(r.id);
    const open = n.filter((f) => !f.verdict).length;
    const s = r.status === "triaged" ? `Triaged · ${r.verdict}` : r.status === "done" ? `Report ready · ${ago(r.finished)}` : r.status === "failed" ? "Failed" : r.status;
    const btn = r.status === "done" ? `<button type="button" class="btn sm primary" data-act="triage" data-run="${r.id}">Triage${open ? ` ${open}` : ""}</button>` : `<button type="button" class="btn sm" data-act="open" data-run="${r.id}">Open</button>`;
    return `<div class="lrow" data-run="${r.id}" tabindex="0" aria-selected="${sel}">${chip(r)}<span class="n">${esc(name(r))}</span><span class="s"><span class="x-dot" data-s="${r.status}"></span><span>${esc(s)} · ${n.length} finding${n.length === 1 ? "" : "s"}</span></span><span class="m">${elapsed(r)}</span><span class="m">${money(r.cost)}</span>${btn}</div>`;
  }

  /* ---------- fleet strip ---------- */
  function strip({ catchupBtn = false } = {}) {
    const fl = PX.fleet();
    const live = runs.filter(isLive).length;
    const needs = runs.filter((r) => r.question || ["failed", "stopped"].includes(r.status)).length;
    const tri = untriaged().length;
    const tpsHist = Array.from({ length: 90 }, (_, i) => runs.reduce((a, r) => a + (r.tpsHist[i] || 0), 0));
    const cu = catchup();
    return `<div class="counts"><span class="cnt"><span class="x-dot" data-s="running"></span><b>${live}</b> live</span>${needs ? `<span class="cnt warn"><b>${needs}</b> need${needs === 1 ? "s" : ""} you</span>` : ""}${tri ? `<button type="button" class="cnt info" data-act="findings"><b>${tri}</b> findings to triage</button>` : ""}${catchupBtn && cu.runs.length ? `<button type="button" class="cnt" data-act="catchup">Since you looked · ${dur(Date.now() - cu.since)} ago</button>` : ""}</div>
      <div class="readouts"><span class="ro">${tspark(tpsHist, 28)}<b>${Math.round(fl.tps)}</b> tok/s</span><span class="ro"><b>${tok(fl.tokensToday)}</b> tokens today</span><span class="ro"><b>${money(fl.spend)}</b> today, ${money(fl.projected)} projected</span><span class="ro"><b>${fl.memUsed.toFixed(1)}</b>/ ${fl.memTotal} GB memory</span></div>`;
  }

  /* ---------- catch-up block ---------- */
  function catchupHTML({ dismiss = true } = {}) {
    const c = catchup();
    if (!c.runs.length) return `<div class="cu"><div class="cu-h"><h2>All caught up</h2><span class="since">Nothing new since ${ago(c.since)}</span></div></div>`;
    const s = c.sum;
    const acts = (r, list) => {
      const a = list.find((e) => e.act);
      if (a?.act === "answer") return `<button type="button" class="btn xs" data-act="open" data-run="${r.id}">Answer</button>`;
      if (a?.act === "triage") return `<button type="button" class="btn xs primary" data-act="triage" data-run="${r.id}">Triage</button>`;
      if (a?.act === "retry") return `<button type="button" class="btn xs" data-act="retry" data-run="${r.id}">${icon.retry}Retry</button>`;
      return `<button type="button" class="btn xs ghost" data-act="open" data-run="${r.id}">Open</button>`;
    };
    return `<section class="cu" aria-label="Since you last looked"><div class="cu-h"><h2>Since you last looked</h2><span class="since">${dur(Date.now() - c.since)} ago</span>
      <div class="sum"><span><b>${s.found}</b> new findings</span><span><b>${s.finished}</b> finished</span><span><b>${s.failed}</b> failed</span><span><b>${s.asks}</b> question</span><span><b>${money(s.spent)}</b> spent</span></div>
      ${dismiss ? `<div class="right"><button type="button" class="btn xs" data-act="seen-all">Mark all seen</button></div>` : ""}</div>
      <ul class="cu-runs">${c.runs.map(({ run: r, ev }) => `<li class="cu-run">${chip(r)}<button type="button" class="n" data-act="open" data-run="${r.id}">${esc(name(r))}</button><div class="cu-ev">${ev.slice(0, 3).map((e) => `<span${e.finding ? ` role="button" tabindex="0" data-finding="${e.finding}" style="cursor:pointer"` : ""}><i data-k="${e.k}"></i>${esc(e.t)}<em>${age(e.at)}</em></span>`).join("")}${ev.length > 3 ? `<span style="color:var(--ink-3)">+${ev.length - 3} more</span>` : ""}</div><div class="acts">${acts(r, ev)}</div></li>`).join("")}</ul></section>`;
  }

  /* ---------- run detail ---------- */
  const TABS = [["overview", "Overview"], ["findings", "Findings"], ["transcript", "Transcript"], ["files", "Files"], ["timeline", "Timeline"], ["terminal", "Terminal"], ["machine", "Machine"]];
  function detailHead(r, { close = false, expand = null } = {}) {
    const h = health(r);
    const live = isLive(r);
    const pillTone = h.tone === "ok" ? "ok" : h.tone;
    const acts = [];
    if (r.status === "failed") acts.push(`<button type="button" class="btn sm" data-act="retry" data-run="${r.id}">${icon.retry}Retry</button>`);
    else if (r.status === "paused" || r.status === "stopped") acts.push(`<button type="button" class="btn sm" data-act="resume" data-run="${r.id}">${icon.play}Resume</button>`);
    else if (live) acts.push(`<button type="button" class="btn sm" data-act="pause" data-run="${r.id}">${icon.pause}Pause</button>`, `<button type="button" class="btn sm danger" data-act="stop" data-run="${r.id}">${icon.stop}Stop</button>`);
    acts.push(`<button type="button" class="btn sm icon" data-act="menu" data-run="${r.id}" aria-label="More actions" aria-haspopup="menu">${icon.more}</button>`);
    if (expand) acts.push(`<button type="button" class="btn sm icon" data-act="${expand}" data-run="${r.id}" aria-label="${expand === "collapse" ? "Back to the wall" : "Open full width"}" title="${expand === "collapse" ? "Back to the wall (Esc)" : "Full width"}">${expand === "collapse" ? icon.collapse : icon.expand}</button>`);
    if (close) acts.push(`<button type="button" class="btn sm icon" data-act="close" aria-label="Close" title="Close (Esc)">${icon.close}</button>`);
    const notice = r.detail && ["recovering", "failed", "preparing"].includes(r.status) ? `<div class="notice ${r.status === "failed" ? "bad" : ""}">${esc(r.detail)}</div>` : "";
    return `<div class="dh"><div class="dh-top">${chip(r)}<h1 data-rename="${r.id}" title="Double-click to rename">${esc(name(r))}</h1><span class="pill" data-tone="${pillTone}">${esc(h.st)}</span><div class="acts">${acts.join("")}</div></div>
      <div class="dh-meta"><span>${esc(repoShort(r))}</span><span>${esc(r.ref)}${r.commit ? ` @ ${esc(r.commit.slice(0, 7))}` : ""}</span><span>${esc(r.template)}</span><span>started ${ago(r.started)}</span>${r.label ? `<span>${esc(r.id)}</span>` : ""}</div>
      ${notice}
      <dl class="facts"><div><dt>Model</dt><dd><button type="button" class="fact-btn" data-act="model" data-run="${r.id}" aria-haspopup="menu">${esc(shortModel(r.model))} <small>${esc(r.variant)}</small>${icon.down}</button></dd></div><div><dt>API key</dt><dd><button type="button" class="fact-btn" data-act="key" data-run="${r.id}" aria-haspopup="menu">${esc(r.key)} <small>${r.failover ? "failover" : "no failover"}</small>${icon.down}</button></dd></div><div><dt>Autopilot</dt><dd><span class="${r.continues >= 2 ? "warn" : ""}">${r.autopilot ? "on" : "off"} · ${r.continues}/3</span></dd></div><div><dt>Tokens</dt><dd>${tok(r.tokens.in + r.tokens.out)}</dd></div><div><dt>Cost</dt><dd>${money(r.cost)}</dd></div>${live ? `<div><dt>Context</dt><dd><span class="${ctxPct(r) > 55 ? "warn" : ""}">${ctxPct(r)}%</span> <small>of ${tok(r.ctxMax)}</small></dd></div>` : ""}<div><dt>Machine</dt><dd>${r.machine.cpu} CPU · ${r.machine.mem} GiB</dd></div></dl></div>`;
  }
  function tabsHTML(r, tab) {
    const nf = findingsOf(r.id).filter((f) => !f.verdict).length;
    return `<div class="tabs" role="tablist" aria-label="Run views">${TABS.map(([id, l]) => `<button type="button" role="tab" data-tab="${id}" aria-selected="${tab === id}">${l}${id === "findings" && findingsOf(r.id).length ? `<span class="badge ${nf ? "warn" : ""}">${nf ? nf + " new" : findingsOf(r.id).length}</span>` : ""}${id === "overview" && r.question ? '<span class="badge warn">1 question</span>' : ""}</button>`).join("")}</div>`;
  }
  function findingsMini(r) {
    const fs = findingsOf(r.id);
    if (!fs.length) return "";
    return `<section><div class="sec-h"><h2>Findings</h2><span class="meta">${fs.length}</span></div><ul class="fl">${fs.map((f) => `<li data-finding="${f.id}" tabindex="0"><span class="sev" data-sev="${f.sev}">${f.sev}</span><span class="ft">${esc(f.title)}</span>${verdictTag(f)}</li>`).join("")}</ul></section>`;
  }
  const verdictTag = (f) => `<span class="verdict" data-v="${f.verdict || "new"}">${f.verdict ? esc(f.verdict) : f.agent === "suspected" ? "suspected" : "to triage"}</span>`;
  const agentsCard = (r) => `<div class="sec-h"><h2>Agents</h2><span class="meta">${busy(r)} of ${r.agents.length} working</span></div>${R.agents(r)}`;
  function overview(r, st) {
    const changes = st.mode === "changes";
    const u = r.unseen;
    return `<div class="ov"><div class="ov-main">${r.question ? R.question(r) : ""}
      <section><div class="sec-h"><h2>Progress</h2><span class="meta">${r.progressAt ? `updated ${ago(r.progressAt)}` : ""}</span>${u ? `<span class="delta">+${u.add} −${u.del} since you looked</span>` : ""}<div class="right"><div class="seg" role="group" aria-label="Progress view"><button type="button" data-mode="text" aria-pressed="${!changes}">Text</button><button type="button" data-mode="changes" aria-pressed="${changes}">Changes</button></div></div></div>${R.progress(r, changes ? "changes" : "text")}</section>
      </div><div class="ov-side">${findingsMini(r)}
      ${r.agents.length ? `<section class="side-card" data-slot="agents">${agentsCard(r)}</section>` : ""}
      ${isLive(r) ? `<section><div class="sec-h"><h2>Last 60 minutes</h2></div>${R.lanes(r)}${R.legend()}</section>` : ""}
      ${r.todos.length ? `<section><div class="sec-h"><h2>Todos</h2><span class="meta">${r.todos.filter((t) => t[0] === "completed").length} of ${r.todos.length}</span></div>${R.todos(r)}</section>` : ""}
      ${r.reads.length || r.readBy.length ? `<section><div class="sec-h"><h2>Other workbases</h2></div>${R.crossReads(r)}</section>` : ""}</div></div>`;
  }
  function findingCard(f, { full = true } = {}) {
    const r = find(f.run);
    const live = r && isLive(r);
    const dup = f.dupHint ? fById(f.dupHint) : null;
    return `<article class="fd" data-fd="${f.id}">
      <div class="fd-h"><div class="fd-meta"><span class="sev" data-sev="${f.sev}">${f.sev}</span><span>${esc(f.id)}</span><span>${f.agent === "suspected" ? "agent: suspected, not reproduced" : "agent: confirmed"}</span><span>found ${ago(f.at)}</span>${full && r ? `<span>${chip(r)} <button type="button" class="x-link" data-act="open" data-run="${r.id}">${esc(name(r))}</button></span>` : ""}</div>
      <h2>${esc(f.title)}</h2><div class="fd-meta"><code>${esc(f.where)}</code><span>${esc(f.fn || "")}</span><span>${esc(f.cls)}</span></div></div>
      <p>${esc(f.summary).replace(/`([^`]+)`/g, "<code>$1</code>")}</p>
      ${dup ? `<p class="flags" style="font-size:13px"><span>Looks like the same root cause as ${dup.id}, “${esc(dup.title)}”</span></p>` : ""}
      ${f.evidence ? `<div><div class="lbl">Evidence</div><pre>${esc(f.evidence)}</pre></div>` : ""}
      <div class="links">${f.poc ? `<button type="button" class="btn xs" data-act="file" data-run="${f.run}" data-file="${esc(f.poc)}">${esc(f.poc)}</button>` : ""}${f.repro ? `<button type="button" class="btn xs" data-act="copy" data-text="${esc(f.repro)}" title="Copy">Copy repro: <code>${esc(f.repro)}</code></button>` : ""}<button type="button" class="btn xs ghost" data-act="tab" data-tab="transcript" data-run="${f.run}">Where it was found in the transcript</button></div>
      <div class="vbox"><div class="lbl" style="margin:0">Your verdict <span style="font-weight:400">· written to TRIAGE.md${live ? ", and sent to the agent" : ""}</span></div>
        <div class="vbtns">${VERDICTS.map((v) => `<button type="button" class="vbtn" data-v="${v.v}" data-verdict="${f.id}" aria-pressed="${f.verdict === v.v}"><b>${v.label}<kbd>${v.key.toUpperCase()}</kbd></b><small>${v.hint}</small></button>`).join("")}</div>
        <textarea id="note-${f.id}" data-note="${f.id}" rows="2" placeholder="Note (optional): why, upstream issue, CVE…">${esc(f.note)}</textarea></div>
    </article>`;
  }
  function findingsTab(r) {
    const fs = findingsOf(r.id);
    const rep = r.report ? `<section class="x-report-wrap" style="margin-top:28px"><div class="sec-h"><h2>REPORT.md</h2></div>${R.report(r).replace(/<form class="x-triage"[\s\S]*<\/form>/, "")}</section>` : `<p class="x-empty" style="margin-top:20px">${isLive(r) ? "No REPORT.md yet. Findings appear here as the agent lists them in PROGRESS.md." : "No REPORT.md."}</p>`;
    return `<div class="pad">${fs.length ? `<div style="display:flex;flex-direction:column;gap:14px">${fs.map((f) => `<div class="side-card" style="padding:0;background:var(--tile);box-shadow:var(--shadow)">${findingCard(f, { full: false })}</div>`).join("")}</div>` : `<p class="x-empty">No findings yet.</p>`}${rep}</div>`;
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
    return `<form class="compose" data-compose="${r.id}"><div class="cbox"><span class="prompt" aria-hidden="true">&gt;_</span><textarea id="compose-${r.id}" name="msg" rows="1" placeholder="Message ${esc(name(r))}" aria-label="Message the agent"></textarea><span class="hint"><kbd>⌘</kbd><kbd>↵</kbd></span><button type="submit" class="btn sm primary icon" aria-label="Send">${icon.send}</button></div></form>`;
  }
  function detail(r, st, opts = {}) {
    return `${detailHead(r, opts)}${tabsHTML(r, st.tab)}<div class="db" data-slot="db">${tabBody(r, st)}</div>${composer(r)}`;
  }

  /* ---------- findings across runs ---------- */
  function findingsTable(sel, { group = "status" } = {}) {
    const open = findings.filter((f) => !f.verdict).sort((a, b) => sevRank(a) - sevRank(b) || b.at - a.at);
    const done = findings.filter((f) => f.verdict).sort((a, b) => b.at - a.at);
    const row = (f) => { const r = find(f.run); return `<div class="frow" data-finding="${f.id}" tabindex="0" aria-selected="${sel === f.id}"><span class="sev" data-sev="${f.sev}">${f.sev}</span><span class="ft"><b>${esc(f.title)}</b><span>${esc(f.where)} · ${esc(f.cls)}</span></span><span class="fr">${r ? chip(r) : ""}<span>${esc(r ? name(r) : f.run)}</span></span><span class="fa">${age(f.at)}</span>${verdictTag(f)}</div>`; };
    return `<div class="ftable" role="listbox" aria-label="Findings">${open.length ? `<div class="fgroup">To triage <span style="font-weight:400">${open.length}</span></div>${open.map(row).join("")}` : ""}${done.length ? `<div class="fgroup">Triaged <span style="font-weight:400">${done.length}</span></div>${done.map(row).join("")}` : ""}</div>`;
  }


  /* ---------- delegated behaviour shared by all pages ---------- */
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
        case "expand": case "collapse": u[a]?.(id); return;
        case "findings": u.openPage?.("Findings"); return;
        case "catchup": u.catchup?.(); return;
        case "seen-all": markAllSeen(); return;
        case "edit-retry": u.newRun?.({ repo: find(id).repo }); return;
        case "tab": u.openRun?.(id, { tab: b.dataset.tab }); return;
        case "file": u.openRun?.(id, { tab: "files", file: b.dataset.file.includes("/") ? b.dataset.file : b.dataset.file }); return;
        case "copy": try { await navigator.clipboard.writeText(b.dataset.text); PX.toast("Copied"); } catch { PX.toast("Copy blocked here; select the text instead"); } return;
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
  document.addEventListener("input", (e) => { const n = e.target.closest("[data-note]"); if (n) fById(n.dataset.note).note = n.value; });
  document.addEventListener("submit", (e) => {
    const f = e.target.closest("[data-reply], [data-compose]");
    if (!f) return;
    e.preventDefault();
    const input = f.querySelector("input, textarea");
    const text = input.value.trim();
    if (!text) return;
    PX.message(f.dataset.reply || f.dataset.compose, text);
    input.value = "";
  });
  document.addEventListener("keydown", (e) => {
    const ta = e.target.closest?.("[data-compose] textarea");
    if (ta && e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ta.form.requestSubmit(); }
  });
  document.addEventListener("keydown", (e) => {
    if (!plainKey(e)) return;
    const card = document.querySelector(".scrim-c [data-fd]");
    const v = card && VERDICTS.find((x) => x.key === e.key.toLowerCase());
    if (v) { e.preventDefault(); setVerdict(card.dataset.fd, v.v); }
  });
  document.addEventListener("dblclick", (e) => { const h = e.target.closest("[data-rename]"); if (h) ui().rename?.(h.dataset.rename); });

  // keyboard: is the event something the page may treat as a shortcut?
  const plainKey = (e) => !(e.metaKey || e.ctrlKey || e.altKey) && !e.target.closest("input, textarea, select, [contenteditable], .x-pal, .x-dialog-scrim, .x-menu");

  // inline rename (no prompt(), which the artifact viewer blocks)
  function rename(id, h1) {
    const r = find(id);
    if (!h1) return;
    const input = document.createElement("input");
    input.value = name(r);
    input.setAttribute("aria-label", "Run name");
    input.style.cssText = "font:700 22px var(--sans);letter-spacing:-.02em;border:1px solid var(--line);border-radius:8px;padding:0 8px;min-width:0;width:100%;background:var(--tile)";
    h1.replaceWith(input);
    input.focus();
    input.select();
    const done = (save) => { if (save) act(id, "rename", input.value.trim() === r.id ? "" : input.value.trim()); else emit("change", { run: id, quiet: true }); };
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") done(true); if (ev.key === "Escape") { ev.stopPropagation(); done(false); } });
    input.addEventListener("blur", () => done(true), { once: true });
  }

  /* ---------- mockup switcher ---------- */
  function switcher(cur) {
    const el = document.createElement("nav");
    el.className = "mk";
    el.setAttribute("aria-label", "Mockups");
    let hidden = false;
    try { hidden = sessionStorage.getItem("pixel-mock-switch") === "hidden"; } catch {}
    const theme = () => { try { return localStorage.getItem("pixel-mock-theme") || "system"; } catch { return "system"; } };
    el.innerHTML = `<button type="button" class="open" title="Show the mockup switcher">◧ ${cur.toUpperCase()}</button><span class="full"><a href="index.html" title="Research and all directions">≡<span class="mk-l"> Notes</span></a><span class="sep"></span>
      <a href="d-docked.html" ${cur === "d" ? 'aria-current="page"' : ""}>D<span class="mk-l"> Docked wall</span></a><a href="e-findings.html" ${cur === "e" ? 'aria-current="page"' : ""}>E<span class="mk-l"> Wall + findings</span></a><a href="f-control.html" ${cur === "f" ? 'aria-current="page"' : ""}>F<span class="mk-l"> Control room</span></a>
      <span class="sep"></span><button type="button" class="theme" title="Theme: system, light, dark">◐ <span data-theme-label>${theme()}</span></button><button type="button" class="hide" aria-label="Hide the mockup switcher">×</button></span>`;
    const setMin = (v) => { el.classList.toggle("min", v); try { sessionStorage.setItem("pixel-mock-switch", v ? "hidden" : "shown"); } catch {} };
    setMin(hidden);
    el.querySelector(".theme").addEventListener("click", PX.cycleTheme);
    el.querySelector(".hide").addEventListener("click", () => setMin(true));
    el.querySelector(".open").addEventListener("click", () => setMin(false));
    document.body.appendChild(el);
  }

  function dialog(html, label) {
    const d = document.createElement("div");
    d.className = "scrim-c";
    d.innerHTML = `<div class="card-dlg" role="dialog" aria-modal="true" aria-label="${esc(label)}">${html}</div>`;
    document.body.appendChild(d);
    const close = () => { d.remove(); document.removeEventListener("keydown", key, true); };
    const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    d.addEventListener("mousedown", (e) => { if (e.target === d) close(); });
    d.addEventListener("click", (e) => { if (e.target.closest('[data-act="open"], [data-act="triage"], [data-act="tab"], [data-act="file"], [data-act="close"]')) close(); });
    document.addEventListener("keydown", key, true);
    d.querySelector("button, input, textarea")?.focus();
    return { el: d, close };
  }

  const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+=<>/\\|";
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

  window.K = {
    decrypt, meter, tspark,
    findings, fById, findingsOf, untriaged, setVerdict, VERDICTS, catchup, catchupHTML, markAllSeen, seenAt, health,
    tile, patchTile, mini, nowRows, tileBody, tileFind, tileFoot, tileActs, progressExcerpt, agentsCard, busy, lrow, strip, detail, detailHead, tabsHTML, tabBody, findingCard, findingsTable, chip, icon, brand, age,
    plainKey, rename, switcher, dialog, sevRank,
  };
})();
