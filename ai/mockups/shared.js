/*
 * Pixel mockups: shared fake data, a live tool-call simulation, and the content renderers and
 * widgets (palette, menus, dialogs, toasts, new-run form) that all three directions reuse.
 * Each direction owns its layout and styles; everything here only emits markup with x-* classes.
 */
(function () {
  "use strict";
  const S = 1000, M = 60 * S, H = 60 * M;
  const T0 = Date.now();

  /* ---------- theme (applied before first paint) ---------- */
  const THEME_KEY = "pixel-mock-theme";
  const getTheme = () => { try { return localStorage.getItem(THEME_KEY) || "system"; } catch { return "system"; } };
  const applyTheme = (t) => { const r = document.documentElement; t === "system" ? r.removeAttribute("data-theme") : r.setAttribute("data-theme", t); };
  applyTheme(getTheme());

  /* ---------- formatting ---------- */
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const dur = (ms) => {
    if (ms == null) return "–";
    const s = Math.max(0, Math.floor(ms / 1000)), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
    if (m) return `${m}m`;
    return `${s}s`;
  };
  const ago = (ts) => {
    const d = Date.now() - ts;
    if (d < M) return `${Math.max(1, Math.round(d / S))}s ago`;
    if (d < H) return `${Math.round(d / M)} min ago`;
    if (d < 24 * H) return `${dur(d)} ago`;
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  const tok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n)));
  const money = (n) => "$" + n.toFixed(2);
  const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const shortModel = (m) => m.split("/").slice(1).join("/");
  const fmt = { esc, dur, ago, tok, money, clock, shortModel };

  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];

  const KIND = { bash: "shell", read: "read", grep: "read", glob: "read", list: "read", edit: "edit", write: "edit", task: "task", webfetch: "web", github: "web" };
  const kindOf = (tool) => KIND[tool] || "read";

  /* ---------- runs ---------- */
  const MODELS = ["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "anthropic/claude-haiku-5-5", "coralbricks/glm-5"];
  const KEYS = [
    { id: "work", name: "work", hint: "sk-ant-…4f2a", note: "Team account" },
    { id: "personal", name: "personal", hint: "sk-ant-…9c10", note: "Own card, low limit" },
  ];
  const TEMPLATES = ["audit.md · v7", "fuzz-first.md · v3", "review-only.md · v2"];
  const SIZES = [
    { id: "small", label: "Small", spec: "2 CPU · 3 GiB" },
    { id: "medium", label: "Medium", spec: "4 CPU · 6 GiB" },
    { id: "large", label: "Large", spec: "8 CPU · 12 GiB" },
  ];

  const runs = [
    {
      id: "libpng-2026-10-14", label: "libpng chunk parsing", repo: "github.com/pnggroup/libpng", ref: "libpng16", commit: "3f9c2ab71e", lang: "C",
      status: "running", agent: "working", hue: 0, started: T0 - (3 * H + 21 * M),
      model: "anthropic/claude-sonnet-5-5", variant: "high", key: "work", failover: true, autopilot: true, template: "audit.md · v7",
      tokens: { in: 492000, out: 36900, cache: 1640000 }, ctx: 72700, ctxMax: 200000, cost: 4.1, costToday: 4.1,
      machine: { name: "pixel-libpng-2026-10-14", cpu: 4, mem: 6, disk: 40, cpuPct: 38, memUsed: 4.4, diskUsed: 9.1, workbase: 18.4 },
      continues: 1, ooms: 0, tpsBase: 64,
      progressAt: T0 - 27 * S, unseen: { add: 3, del: 2 },
      progress: [
        "## Found / confirmed",
        "{+}- **Heap overflow** in iCCP decompression (`pngrutil.c:1184`): ASan heap-buffer-overflow, 1-byte read, PoC in `poc/iccp-0041.png`",
        "## Trying now",
        "- Fuzzing iCCP with a profile-length mutator (3 workers, 41k exec/s)",
        "- Mapping every chunk handler in `pngrutil.c` that calls `png_inflate`",
        "{+}- Checking zTXt and iTXt for the same length pattern",
        "{-}- Building with ASan and UBSan",
        "## Promising",
        "- iCCP: `png_inflate` trusts the declared profile length",
        "{+}- sPLT: the entry count comes from the chunk length with no upper bound",
        "{-}- tRNS length checks look incomplete",
        "## Ruled out",
        "- tRNS length checks hold on every path",
      ].join("\n"),
      agents: [
        { id: "main", title: "Main agent", status: "waiting", parent: null, started: T0 - (3 * H + 21 * M), now: { tool: "task", text: "waiting on 2 subagents" } },
        { id: "s3", title: "Build with ASan and UBSan", status: "done", parent: "main", started: T0 - (3 * H + 12 * M) },
        { id: "s1", title: "Fuzz the iCCP chunk handler", status: "running", parent: "main", started: T0 - 31 * M, now: { tool: "bash", text: "./fuzz/run.sh iccp -j3 -max_total_time=3600" } },
        { id: "s2", title: "Review the inflate window code", status: "running", parent: "main", started: T0 - 23 * M, now: { tool: "read", text: "pngrutil.c:1120-1260" } },
      ],
      todos: [
        ["completed", "Build with ASan and UBSan"],
        ["completed", "Map chunk handlers and their length checks"],
        ["in_progress", "Fuzz iCCP with a profile-length mutator"],
        ["in_progress", "Review the inflate window code"],
        ["pending", "Check zTXt and iTXt for the same pattern"],
        ["pending", "Write up the iCCP overflow with a minimal PoC"],
      ],
      reads: [{ run: "zlib-2026-10-14", n: 3 }], readBy: [],
      pool: {
        main: [["edit", "PROGRESS.md"], ["bash", "git log --oneline -5 -- pngrutil.c"], ["read", "findings/iccp-heap-overflow.md"]],
        s1: [["bash", "./fuzz/run.sh iccp -j3 -max_total_time=3600"], ["bash", "ls -t /scratch/crashes | head"], ["bash", "./build-asan/pngtest /scratch/crashes/crash-7f3a1c"], ["read", "fuzz/iccp_mutator.c"], ["edit", "fuzz/iccp_mutator.c"], ["bash", "llvm-cov report build-cov/pngtest -sources pngrutil.c"], ["bash", "tail -n 20 /scratch/fuzz-w2.log"]],
        s2: [["read", "pngrutil.c:1120-1260"], ["grep", "png_inflate( pngrutil.c"], ["read", "pngrutil.c:640-720"], ["grep", "PNG_USER_CHUNK_MALLOC_MAX *.h"], ["read", "pngpriv.h:1880-1910"], ["github", "search issues \"iCCP length\" repo:pnggroup/libpng"], ["read", "pngrutil.c:2410-2480"]],
      },
      weights: { main: 1, s1: 4, s2: 4 },
    },
    {
      id: "zlib-2026-10-14", label: null, repo: "github.com/madler/zlib", ref: "develop", commit: "51b7f2abda", lang: "C",
      status: "running", agent: "working", hue: 1, started: T0 - (1 * H + 26 * M),
      model: "anthropic/claude-sonnet-5-5", variant: "medium", key: "work", failover: true, autopilot: true, template: "audit.md · v7",
      tokens: { in: 201000, out: 18200, cache: 690000 }, ctx: 41300, ctxMax: 200000, cost: 1.93, costToday: 1.93,
      machine: { name: "pixel-zlib-2026-10-14", cpu: 4, mem: 6, disk: 40, cpuPct: 71, memUsed: 2.8, diskUsed: 4.2, workbase: 3.1 },
      continues: 0, ooms: 0, tpsBase: 138,
      progressAt: T0 - 14 * M, unseen: null,
      progress: [
        "## Trying now",
        "- Differential test against zlib-ng: 40 000 random streams, `windowBits` 8 to 15",
        "- Reading `inflate.c` window handling when `windowBits` is 8",
        "## Promising",
        "- `inflateGetDictionary` copies `state->whave` bytes with no size argument (documented contract, probably not a bug)",
        "## Found / confirmed",
        "- Nothing yet",
      ].join("\n"),
      agents: [
        { id: "main", title: "Main agent", status: "running", parent: null, started: T0 - (1 * H + 26 * M), now: { tool: "read", text: "inflate.c:1210-1300" } },
        { id: "s1", title: "Differential test against zlib-ng", status: "running", parent: "main", started: T0 - 44 * M, now: { tool: "bash", text: "./difftest --corpus /scratch/streams --jobs 2" } },
        { id: "s2", title: "Read inflateBack", status: "running", parent: "main", started: T0 - 9 * M, now: { tool: "read", text: "infback.c:250-330" } },
      ],
      todos: [
        ["completed", "Build with ASan"],
        ["in_progress", "Differential test against zlib-ng"],
        ["in_progress", "Window handling at windowBits 8"],
        ["pending", "inflateBack and its callbacks"],
      ],
      reads: [], readBy: [{ run: "libpng-2026-10-14", n: 3 }],
      pool: {
        main: [["read", "inflate.c:1210-1300"], ["grep", "whave inflate.c"], ["bash", "make -C build test"], ["read", "inffast.c:60-140"], ["bash", "python3 tools/window_edge.py --bits 8"], ["edit", "NOTES.md"]],
        s1: [["bash", "./difftest --corpus /scratch/streams --jobs 2"], ["bash", "wc -l /scratch/diff-mismatch.log"], ["read", "/scratch/diff-mismatch.log"], ["bash", "python3 gen_streams.py --n 40000 --seed 7"]],
        s2: [["read", "infback.c:250-330"], ["grep", "windowBits infback.c"], ["read", "zlib.h:1100-1160"]],
      },
      weights: { main: 3, s1: 3, s2: 2 },
    },
    {
      id: "tinyxml2-2026-10-13", label: "tinyxml2 parser", repo: "github.com/leethomason/tinyxml2", ref: "master", commit: "9a89766acc", lang: "C++",
      status: "running", agent: "idle", hue: 3, started: T0 - (5 * H + 48 * M),
      model: "anthropic/claude-opus-5-5", variant: "high", key: "personal", failover: false, autopilot: true, template: "audit.md · v7",
      tokens: { in: 388000, out: 29400, cache: 1210000 }, ctx: 96100, ctxMax: 200000, cost: 6.42, costToday: 2.38,
      machine: { name: "pixel-tinyxml2-2026-10-13", cpu: 2, mem: 3, disk: 20, cpuPct: 1, memUsed: 1.9, diskUsed: 3.3, workbase: 6.7 },
      continues: 2, ooms: 0, tpsBase: 52,
      progressAt: T0 - 13 * M, unseen: { add: 2, del: 0 },
      question: {
        at: T0 - 12 * M,
        text: "I have two crashes in XMLDocument::Parse, both stack exhaustion from elements nested deeper than 25 000. Write them up, or skip stack exhaustion and keep looking for memory corruption?",
        options: ["Write both up, keep looking", "Skip stack exhaustion", "Stop and write the report"],
      },
      progress: [
        "## Found / confirmed",
        "{+}- Two crashes in `XMLDocument::Parse` with elements nested deeper than 25 000, both stack exhaustion in `XMLNode::ParseDeep`",
        "## Waiting",
        "{+}- Asked whether to write these up or keep looking for memory corruption",
        "## Promising",
        "- `XMLUtil::GetCharacterRef` handles `&#x` with nine or more digits oddly",
      ].join("\n"),
      agents: [
        { id: "main", title: "Main agent", status: "idle", parent: null, started: T0 - (5 * H + 48 * M), now: null },
        { id: "s1", title: "Minimise the two Parse crashes", status: "done", parent: "main", started: T0 - 58 * M },
        { id: "s2", title: "Check attribute parsing", status: "done", parent: "main", started: T0 - 41 * M },
      ],
      todos: [
        ["completed", "Build with ASan and UBSan"],
        ["completed", "Minimise the Parse crashes"],
        ["completed", "Check attribute parsing"],
        ["pending", "Character references with long hex values"],
      ],
      reads: [{ run: "expat-2026-10-13", n: 1 }], readBy: [],
      pool: {
        main: [["bash", "python3 gen_nested.py 30000 > /scratch/deep.xml"], ["bash", "./xmltest"], ["read", "tinyxml2.cpp:2360-2440"], ["grep", "ParseDeep tinyxml2.cpp"], ["edit", "PROGRESS.md"], ["read", "tinyxml2.cpp:410-470"]],
      },
      weights: { main: 1 },
    },
    {
      id: "expat-2026-10-13", label: null, repo: "github.com/libexpat/libexpat", ref: "master", commit: "c1e2a8d0b4", lang: "C",
      status: "recovering", agent: "recovering", hue: 2, started: T0 - (6 * H + 51 * M),
      detail: "opencode was OOM-killed while linking the MSan build. Restarting, attempt 2 of 3.",
      model: "anthropic/claude-sonnet-5-5", variant: "high", key: "work", failover: true, autopilot: true, template: "audit.md · v7",
      tokens: { in: 802000, out: 61800, cache: 2900000 }, ctx: 118400, ctxMax: 200000, cost: 14.7, costToday: 3.2,
      machine: { name: "pixel-expat-2026-10-13", cpu: 4, mem: 4, disk: 40, cpuPct: 4, memUsed: 0.4, diskUsed: 12.8, workbase: 22.9 },
      continues: 3, ooms: 2, tpsBase: 0,
      progressAt: T0 - 48 * M, unseen: null,
      progress: [
        "## Found / confirmed",
        "- **Stack exhaustion** with deeply nested entity references and `XML_DTD` on (1.2 MB input). Same class as CVE-2013-0340, probably not new",
        "## Trying now",
        "- MSan build to look for uninitialised reads in `xmlparse.c` (needs more than 4 GB to link)",
        "## Ruled out",
        "- `XML_GetBuffer` size arithmetic: the overflow checks hold on 64-bit",
      ].join("\n"),
      agents: [
        { id: "main", title: "Main agent", status: "interrupted", parent: null, started: T0 - (6 * H + 51 * M), now: null },
        { id: "s1", title: "Build with MSan", status: "interrupted", parent: "main", started: T0 - 19 * M },
        { id: "s2", title: "Review entity expansion", status: "interrupted", parent: "main", started: T0 - 33 * M },
      ],
      todos: [
        ["completed", "Build with ASan and UBSan"],
        ["completed", "Entity expansion depth"],
        ["in_progress", "MSan build"],
        ["pending", "Encoding conversion in xmltok.c"],
      ],
      reads: [], readBy: [{ run: "tinyxml2-2026-10-13", n: 1 }],
      pool: { main: [] }, weights: {},
    },
    {
      id: "yaml-cpp-2026-10-12", label: "yaml-cpp", repo: "github.com/jbeder/yaml-cpp", ref: "master", commit: "0579ae3d97", lang: "C++",
      status: "done", agent: "finished", hue: 4, started: T0 - (21 * H + 10 * M), finished: T0 - (12 * H + 8 * M),
      model: "anthropic/claude-sonnet-5-5", variant: "high", key: "work", failover: true, autopilot: true, template: "audit.md · v7",
      tokens: { in: 1104000, out: 88100, cache: 4200000 }, ctx: 0, ctxMax: 200000, cost: 9.8, costToday: 9.6,
      machine: { name: "pixel-yaml-cpp-2026-10-12", cpu: 4, mem: 6, disk: 40, cpuPct: 0, memUsed: 0, diskUsed: 7.7, workbase: 11.2 },
      continues: 4, ooms: 0, tpsBase: 0,
      progressAt: T0 - (12 * H + 9 * M), unseen: null, report: true,
      progress: [
        "## Found / confirmed",
        "- **Null dereference** with a merge key on an alias to a scalar (`NodeBuilder::OnMapEnd`)",
        "- **Unbounded recursion** on nested flow sequences, 40 000 levels",
        "## Done",
        "- Report written to `REPORT.md`",
      ].join("\n"),
      agents: [{ id: "main", title: "Main agent", status: "done", parent: null, started: T0 - (21 * H + 10 * M) }],
      todos: [["completed", "Scanner and tag parsing"], ["completed", "Anchors, aliases and merge keys"], ["completed", "Write REPORT.md"]],
      reads: [], readBy: [], pool: { main: [] }, weights: {},
    },
    {
      id: "sqlite-fts5-2026-10-12", label: "sqlite fts5", repo: "github.com/sqlite/sqlite", ref: "master", commit: "e83d1f0c42", lang: "C",
      status: "triaged", agent: "finished", hue: 5, started: T0 - (30 * H + 2 * M), finished: T0 - (22 * H + 40 * M), verdict: "partly real",
      model: "anthropic/claude-opus-5-5", variant: "high", key: "work", failover: true, autopilot: true, template: "review-only.md · v2",
      tokens: { in: 930000, out: 70300, cache: 3600000 }, ctx: 0, ctxMax: 200000, cost: 12.35, costToday: 0,
      machine: { name: "pixel-sqlite-fts5-2026-10-12", cpu: 4, mem: 6, disk: 40, cpuPct: 0, memUsed: 0, diskUsed: 0, workbase: 8.4 },
      continues: 1, ooms: 0, tpsBase: 0, progressAt: T0 - (22 * H + 41 * M), unseen: null, report: true,
      progress: "## Found / confirmed\n- Integer overflow in `fts5HashAddPoslistSize` needs a 2 GB document (not reachable with default limits)\n## Done\n- Report written",
      agents: [{ id: "main", title: "Main agent", status: "done", parent: null, started: T0 - (30 * H + 2 * M) }],
      todos: [], reads: [], readBy: [], pool: { main: [] }, weights: {},
    },
    {
      id: "libxml2-2026-10-14", label: null, repo: "gitlab.gnome.org/GNOME/libxml2", ref: "master", commit: null, lang: "C",
      status: "failed", agent: "finished", hue: 1, started: T0 - 38 * M,
      detail: "Preparing failed: git clone timed out after 10 min (gitlab.gnome.org).",
      model: "anthropic/claude-sonnet-5-5", variant: "high", key: "work", failover: true, autopilot: true, template: "audit.md · v7",
      tokens: { in: 0, out: 0, cache: 0 }, ctx: 0, ctxMax: 200000, cost: 0, costToday: 0,
      machine: { name: "pixel-libxml2-2026-10-14", cpu: 4, mem: 6, disk: 40, cpuPct: 0, memUsed: 0, diskUsed: 0.2, workbase: 0 },
      continues: 0, ooms: 0, tpsBase: 0, progressAt: null, unseen: null, progress: null,
      agents: [], todos: [], reads: [], readBy: [], pool: { main: [] }, weights: {},
    },
  ];

  const name = (r) => r.label || r.id;
  const repoShort = (r) => r.repo.replace(/^(github\.com|gitlab\.[^/]+)\//, "");
  const isLive = (r) => ["running", "recovering", "preparing"].includes(r.status);
  const needsYou = (r) => !!r.question || ["failed", "stopped"].includes(r.status);
  const working = (r) => r.agents.filter((a) => a.status === "running").length;

  /* per-run 30-minute activity (one bucket a minute, dominant tool kind) and 60-minute agent ticks */
  for (const r of runs) {
    r.activity = Array.from({ length: 30 }, (_, i) => {
      const minsAgo = 29 - i;
      if (r.status === "running" && r.agent === "idle" && minsAgo < 12) return { n: 0 };
      if (r.status === "recovering" && minsAgo < 3) return minsAgo === 2 ? { n: 6, k: "bad" } : { n: 0 };
      if (!isLive(r)) return { n: 0 };
      const n = Math.round(2 + rnd() * (r.tpsBase > 100 ? 13 : 10));
      return { n, k: pick(["shell", "shell", "read", "read", "read", "edit", "task", "web"].slice(0, r.id.startsWith("zlib") ? 7 : 8)) };
    });
    r.ticks = [];
    for (const a of r.agents) {
      const from = Math.min(60, (T0 - a.started) / M);
      let to = 0;
      if (a.status === "done") to = Math.max(0, from - 9 - rnd() * 6);
      if (r.status === "recovering") to = 3;
      if (r.agent === "idle") to = 12;
      if (from <= to) continue;
      const pool = (r.pool[a.id] || []).map((p) => kindOf(p[0]));
      const kinds = pool.length ? pool : ["shell", "read", "read", "edit"];
      const waiting = a.status === "waiting";
      const step = waiting ? 1.6 : 0.9;
      for (let m = from; m > to; m -= step * (0.4 + rnd() * 1.2)) {
        if (waiting && m < 31 && rnd() < 0.85) continue;
        r.ticks.push({ a: a.id, ts: T0 - m * M, k: pick(kinds) });
      }
    }
    r.log = [];
    const ids = Object.keys(r.weights || {});
    if (r.status === "running" && r.agent === "working") {
      for (let i = 6; i > 0; i--) {
        const aid = pick(ids), [tool, text] = pick(r.pool[aid]);
        r.log.push({ ts: T0 - i * 9 * S, run: r.id, agent: aid, tool, text, kind: kindOf(tool) });
      }
    } else if (r.id.startsWith("tinyxml2")) {
      r.log = [
        { ts: T0 - 13 * M, run: r.id, agent: "main", tool: "edit", text: "PROGRESS.md", kind: "edit" },
        { ts: T0 - 12 * M, run: r.id, agent: "main", tool: "question", text: "asked you a question", kind: "task" },
      ];
    }
    r.tps = r.agent === "working" ? r.tpsBase : 0;
    r.tpsHist = Array.from({ length: 90 }, () => (r.agent === "working" ? Math.max(0, r.tpsBase * (0.45 + rnd() * 1.1)) : 0));
  }

  /* ---------- transcripts, files, timelines, reports ---------- */
  const transcripts = {
    "libpng-2026-10-14": [
      { role: "user", who: "Pixel", ts: T0 - (3 * H + 20 * M), text: "Audit pnggroup/libpng (libpng16 @ 3f9c2ab) for memory-safety bugs reachable from untrusted PNG input. Keep PROGRESS.md short and current; write REPORT.md when you are done.", note: "audit.md · v7" },
      { role: "assistant", ts: T0 - (3 * H + 19 * M), text: "Starting with an ASan and UBSan build so every crash reports cleanly, then I'll map the chunk handlers and their length checks." },
      { role: "tool", tool: "bash", ts: T0 - (3 * H + 18 * M), title: "cmake -B build-asan -DCMAKE_C_FLAGS=\"-fsanitize=address,undefined -g\" && cmake --build build-asan -j4", out: "-- The C compiler identification is Clang 19.1.7\n-- Configuring done (1.9s)\n[ 97%] Linking C executable pngtest\n[100%] Built target pngtest", took: "2m 14s" },
      { role: "tool", tool: "task", ts: T0 - 31 * M, title: "Fuzz the iCCP chunk handler", out: "Subagent started · ses_8f21c", took: "running" },
      { role: "tool", tool: "read", ts: T0 - 26 * M, title: "pngrutil.c:1168-1190", out: "1168      if (png_inflate_claim(png_ptr, png_iCCP) == Z_OK)\n1169      {\n1170         png_uint_32 profile_length = png_get_uint_32(profile_header);\n1176         profile = png_read_buffer(png_ptr, profile_length, 2/*silent*/);\n1184         memcpy(profile, profile_header, (sizeof profile_header));", took: "4 ms" },
      { role: "reasoning", ts: T0 - 25 * M, text: "profile_length comes straight from the profile header. png_read_buffer allocates that size, but the copy at 1184 and the following inflate assume at least 132 bytes. A tiny declared length with a large compressed stream should read past the buffer." },
      { role: "tool", tool: "bash", ts: T0 - 11 * M, title: "./build-asan/pngtest /scratch/crashes/crash-iccp-0041.png", out: "==41213==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x6020000000f1\nREAD of size 1 at 0x6020000000f1 thread T0\n    #0 0x55d1c3 in png_inflate pngrutil.c:1184\n    #1 0x55e0a7 in png_handle_iCCP pngrutil.c:1402\n    #2 0x5629f2 in png_read_info pngread.c:174\nSUMMARY: AddressSanitizer: heap-buffer-overflow pngrutil.c:1184 in png_inflate", took: "0.4 s", error: true },
      { role: "assistant", ts: T0 - 10 * M, text: "Confirmed: heap-buffer-overflow in png_inflate through iCCP. Saving the PoC to poc/iccp-0041.png and updating PROGRESS.md." },
      { role: "tool", tool: "edit", ts: T0 - 27 * S, title: "PROGRESS.md", out: "+3 −2", took: "2 ms" },
    ],
  };
  const genericTranscript = (r) => [
    { role: "user", who: "Pixel", ts: r.started, text: `Audit ${repoShort(r)} for memory-safety bugs reachable from untrusted input. Keep PROGRESS.md short and current; write REPORT.md when you are done.`, note: r.template },
    { role: "assistant", ts: r.started + 40 * S, text: "Building with sanitizers first, then reading the parser entry points." },
    ...r.log.slice(-4).map((e) => ({ role: "tool", tool: e.tool, ts: e.ts, title: e.text, out: e.kind === "shell" ? "exit 0" : "", took: "1.2 s" })),
  ];

  const libpngFiles = {
    "PROGRESS.md": null,
    "NOTES.md": "# Notes\n\nChunk handlers that inflate: iCCP, zTXt, iTXt.\npng_inflate() is shared; the length guard lives in each caller.\n\nCorpus: 2 140 PNGs from the libpng test suite plus PngSuite.\nFuzzer: libFuzzer with a custom mutator that rewrites the iCCP profile length.",
    "findings/iccp-heap-overflow.md": "# Heap overflow in iCCP decompression\n\n- File: pngrutil.c:1184 (png_inflate, called from png_handle_iCCP)\n- Input: poc/iccp-0041.png (2.1 KB)\n- ASan: heap-buffer-overflow, READ of size 1\n\nThe declared profile length (bytes 0-3 of the profile header) is used to size the\nbuffer; the copy of the 132-byte header happens before any check that the declared\nlength is at least 132.",
    "poc/iccp-0041.png": "(binary, 2.1 KB)",
    "scripts/fuzz-iccp.sh": "#!/bin/sh\nset -eu\nexec ./build-fuzz/iccp_fuzzer -jobs=3 -workers=3 \\\n  -max_total_time=3600 -artifact_prefix=/scratch/crashes/ \\\n  /scratch/corpus",
    "scripts/build-asan.sh": "#!/bin/sh\ncmake -B build-asan -DCMAKE_C_FLAGS=\"-fsanitize=address,undefined -g\"\ncmake --build build-asan -j4",
    "logs/fuzz-iccp-w1.log": "#2097152 pulse  cov: 3121 ft: 9874 corp: 812/1.9Mb exec/s: 13981\n#4194304 pulse  cov: 3130 ft: 9921 corp: 819/1.9Mb exec/s: 14002\n==3==ERROR: AddressSanitizer: heap-buffer-overflow (saved crash-7f3a1c)",
  };

  const timelines = {
    "libpng-2026-10-14": [
      { ts: T0 - (3 * H + 21 * M), actor: "pixel", msg: "Started machine pixel-libpng-2026-10-14 (4 CPU, 6 GiB)" },
      { ts: T0 - (3 * H + 20 * M), actor: "pixel", msg: "Cloned pnggroup/libpng at 3f9c2ab71e" },
      { ts: T0 - (3 * H + 20 * M), actor: "pixel", msg: "Session started with audit.md v7 on claude-sonnet-5-5 (high)" },
      { ts: T0 - (2 * H + 5 * M), actor: "pixel", msg: "Agent idle for 4 min; sent continue (1 of 5)" },
      { ts: T0 - (1 * H + 12 * M), actor: "user", msg: "You: “Focus on chunk handlers that decompress (iCCP, zTXt, iTXt).”" },
      { ts: T0 - 31 * M, actor: "agent", msg: "Started subagent “Fuzz the iCCP chunk handler”" },
      { ts: T0 - 23 * M, actor: "agent", msg: "Started subagent “Review the inflate window code”" },
      { ts: T0 - 27 * S, actor: "agent", msg: "Updated PROGRESS.md (+3 −2)" },
    ],
  };
  const genericTimeline = (r) => {
    const t = [{ ts: r.started, actor: "pixel", msg: `Started machine ${r.machine.name} (${r.machine.cpu} CPU, ${r.machine.mem} GiB)` }];
    if (r.commit) t.push({ ts: r.started + 40 * S, actor: "pixel", msg: `Cloned ${repoShort(r)} at ${r.commit}` });
    if (r.status === "failed") t.push({ ts: r.started + 10 * M, actor: "pixel", msg: r.detail });
    if (r.ooms) t.push({ ts: T0 - 3 * H, actor: "pixel", msg: "opencode was OOM-killed; restarted (1 of 3)" }, { ts: T0 - 2 * M, actor: "pixel", msg: "opencode was OOM-killed; restarting (2 of 3)" });
    if (r.question) t.push({ ts: r.question.at, actor: "agent", msg: "Asked a question" });
    if (r.finished) t.push({ ts: r.finished, actor: "agent", msg: "Wrote REPORT.md; run finished" });
    if (r.verdict) t.push({ ts: r.finished + 2 * H, actor: "user", msg: `Triaged: ${r.verdict}` });
    return t;
  };

  const reports = {
    "yaml-cpp-2026-10-12": "# yaml-cpp audit\n\nCommit `0579ae3`, 9h 02m on claude-sonnet-5-5.\n\n## 1. Null dereference with a merge key on an alias to a scalar\n`<<: *scalar` where the anchor is a scalar reaches `NodeBuilder::OnMapEnd` with a null map. ASan SEGV. Reproducer: `poc/merge-scalar.yaml`. Severity: medium.\n\n## 2. Unbounded recursion on nested flow sequences\n`YAML::Load` on 40 000 nested `[` overflows the stack in `SingleDocParser::HandleNode`. Reproducer: `poc/deep-flow.yaml`. Severity: low (denial of service).\n\n## Checked, not issues\n- Tag handle parsing: `Scanner::ScanTag` checks its bounds\n- UTF-16 surrogate handling in `Stream`",
    "sqlite-fts5-2026-10-12": "# sqlite fts5 review\n\n## 1. Integer overflow in fts5HashAddPoslistSize\nNeeds a single 2 GB document; not reachable with default `SQLITE_MAX_LENGTH`. Severity: informational.\n\n## Checked, not issues\n- Prefix index construction\n- `fts5_vocab` cursor bounds",
  };
  const VERDICTS = ["real findings", "partly real", "false positives", "duplicate", "nothing found", "inconclusive"];

  /* ---------- events ---------- */
  const listeners = {};
  const on = (ev, fn) => (listeners[ev] = listeners[ev] || []).push(fn);
  const emit = (ev, data) => (listeners[ev] || []).forEach((fn) => fn(data));
  const feed = [];
  for (const r of runs) feed.push(...r.log);
  feed.sort((a, b) => a.ts - b.ts);

  const addTimeline = (r, actor, msg) => { (timelines[r.id] = timelines[r.id] || genericTimeline(r)).push({ ts: Date.now(), actor, msg }); };

  /* ---------- live simulation ---------- */
  function step() {
    const live = runs.filter((r) => r.status === "running" && r.agent === "working" && Object.keys(r.weights || {}).length);
    if (live.length) {
      const r = live[Math.floor(rnd() * live.length)];
      const ids = Object.keys(r.weights).filter((id) => (r.agents.find((a) => a.id === id) || {}).status !== "done");
      const bag = ids.flatMap((id) => Array(r.weights[id]).fill(id));
      const aid = pick(bag);
      const agent = r.agents.find((a) => a.id === aid);
      const [tool, text] = pick(r.pool[aid]);
      const ev = { ts: Date.now(), run: r.id, agent: aid, tool, text, kind: kindOf(tool) };
      if (agent && !(aid === "main" && r.agent === "waiting")) agent.now = { tool, text };
      r.log.push(ev);
      if (r.log.length > 8) r.log.shift();
      feed.push(ev);
      if (feed.length > 80) feed.shift();
      r.ticks.push({ a: aid, ts: ev.ts, k: ev.kind });
      const last = r.activity[r.activity.length - 1];
      last.n += 1;
      last.k = last.k || ev.kind;
      r.lastActivity = ev.ts;
      r.tokens.in += 400 + Math.round(rnd() * 3000);
      r.tokens.out += 30 + Math.round(rnd() * 240);
      r.cost += 0.002 + rnd() * 0.01;
      emit("tick", ev);
    }
    setTimeout(step, 900 + rnd() * 1500);
  }
  function rates() {
    for (const r of runs) {
      const on = r.status === "running" && r.agent === "working";
      r.tps = on ? Math.max(0, Math.round(r.tpsBase * (0.45 + rnd() * 1.1))) : 0;
      r.tpsHist.push(r.tps);
      if (r.tpsHist.length > 90) r.tpsHist.shift();
      if (on) r.machine.cpuPct = Math.max(3, Math.min(97, Math.round(r.machine.cpuPct + (rnd() - 0.5) * 12)));
    }
    emit("rates");
  }
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    setTimeout(step, 700);
    setInterval(rates, 2000);
    setInterval(() => {
      for (const r of runs) {
        r.activity.shift();
        r.activity.push({ n: 0 });
      }
      emit("minute");
    }, 60 * S);
  };

  const fleet = () => {
    const live = runs.filter(isLive);
    const tps = runs.reduce((a, r) => a + r.tps, 0);
    const spend = runs.reduce((a, r) => a + r.costToday, 0) + 0.68;
    const mem = [
      ...runs.filter((r) => r.machine.memUsed > 0).map((r) => ({ run: r, gb: r.machine.memUsed })),
      { run: null, label: "pixel + system", gb: 1.6 },
    ];
    return {
      live: live.length, working: runs.filter((r) => r.agent === "working").length, needs: runs.filter(needsYou).length, triage: runs.filter((r) => r.status === "done").length,
      tps, tokensToday: 2184000 + runs.reduce((a, r) => a + (r.agent === "working" ? r.tokens.out - 30000 : 0), 0), cached: 0.86,
      spend, projected: spend * 2.02, memTotal: 15, memUsed: mem.reduce((a, m) => a + m.gb, 0), mem,
    };
  };

  /* ---------- actions ---------- */
  const find = (id) => runs.find((r) => r.id === id);
  async function act(id, action, extra) {
    const r = find(id);
    if (!r) return;
    const done = (msg) => { emit("change", { run: id, action }); if (msg) toast(msg); };
    switch (action) {
      case "pause": r.status = "paused"; r.agent = "idle"; r.agents.forEach((a) => a.status === "running" && (a.status = "idle")); addTimeline(r, "user", "You paused the run"); return done(`Paused ${name(r)}`);
      case "resume": r.status = "running"; r.agent = "working"; r.agents.forEach((a) => a.status === "idle" && a.id !== "main" && (a.status = "running")); if (r.agents[0] && r.agent === "working") r.agents[0].status = r.agents.length > 1 ? "waiting" : "running"; addTimeline(r, "user", "You resumed the run"); return done(`Resumed ${name(r)}`);
      case "stop":
        if (!(await confirm({ title: `Stop ${name(r)}?`, body: "The agent is aborted. The machine and workbase are kept, and you can resume later.", ok: "Stop run", danger: true }))) return;
        r.status = "stopped"; r.agent = "finished"; r.agents.forEach((a) => ["running", "waiting", "idle"].includes(a.status) && (a.status = "interrupted")); addTimeline(r, "user", "You stopped the run"); return done(`Stopped ${name(r)}`);
      case "continue": addTimeline(r, "user", "You sent continue"); return done("Sent continue");
      case "abort": addTimeline(r, "user", "You aborted the current step"); return done("Aborted the current step");
      case "restart": addTimeline(r, "user", "You restarted opencode"); return done("opencode restarted");
      case "autopilot": r.autopilot = !r.autopilot; return done(`Autopilot ${r.autopilot ? "on" : "off"}`);
      case "reset": r.continues = 0; r.ooms = 0; return done("Recovery counters reset");
      case "retry": r.status = "preparing"; r.detail = "Cloning gitlab.gnome.org/GNOME/libxml2"; done("Retrying"); setTimeout(() => { r.status = "failed"; r.detail = "Preparing failed: git clone timed out after 10 min (gitlab.gnome.org)."; emit("change", { run: id }); }, 5000); return;
      case "done":
        if (!(await confirm({ title: `Mark ${name(r)} done?`, body: "The agent stops and its machine is shut down. The workbase stays.", ok: "Mark done" }))) return;
        r.status = "done"; r.agent = "finished"; r.finished = Date.now(); return done("Marked done");
      case "rerun": { const nr = createRun({ repo: r.repo, ref: r.ref, name: `${r.id}-2`, model: r.model, variant: r.variant, key: r.key, template: r.template }); toast(`Started ${nr.id}`); emit("change", { run: nr.id, action: "created" }); return nr.id; }
      case "delete": {
        const ok = await confirm({ title: `Delete ${name(r)}?`, body: "Its machine is destroyed.", ok: "Delete run", danger: true, check: "Also delete its workbase (otherwise other agents can still read it)" });
        if (!ok) return;
        runs.splice(runs.indexOf(r), 1); return done(`Deleted ${name(r)}`);
      }
      case "model": r.model = extra.model ?? r.model; r.variant = extra.variant ?? r.variant; addTimeline(r, "user", `You changed the model to ${shortModel(r.model)} (${r.variant})`); return done(`${shortModel(r.model)} · ${r.variant} from the next message`);
      case "key": r.key = extra; addTimeline(r, "user", `You switched to key “${extra}”`); return done(`Key changed to ${extra}`);
      case "failover": r.failover = !r.failover; return done(`Failover ${r.failover ? "on" : "off"}`);
      case "rename": r.label = extra || null; return done("Renamed");
      case "seen": r.unseen = null; emit("change", { run: id, action, quiet: true }); return;
      case "triage": r.status = "triaged"; r.verdict = extra || "inconclusive"; addTimeline(r, "user", `Triaged: ${r.verdict}`); return done("Saved triage");
    }
  }
  function message(id, text) {
    const r = find(id);
    if (!r || !text.trim()) return;
    (transcripts[r.id] = transcripts[r.id] || genericTranscript(r)).push({ role: "user", who: "You", ts: Date.now(), text });
    addTimeline(r, "user", `You: “${text}”`);
    toast("Sent to the agent");
    emit("change", { run: id, action: "message", quiet: true });
  }
  function answer(id, text) {
    const r = find(id);
    if (!r || !r.question) return;
    r.question = null;
    r.agent = "working";
    r.agents[0].status = "running";
    r.agents[0].now = { tool: "edit", text: "PROGRESS.md" };
    r.weights = { main: 1 };
    r.progress = r.progress.replace(/## Waiting\n[^\n]*\n/, "");
    addTimeline(r, "user", `You answered: “${text}”`);
    (transcripts[r.id] = transcripts[r.id] || genericTranscript(r)).push({ role: "user", who: "You", ts: Date.now(), text });
    toast("Answer sent");
    emit("change", { run: id, action: "answer" });
  }
  function createRun(o) {
    const repo = o.repo.replace(/^https?:\/\//, "").replace(/\.git$/, "") || "github.com/owner/project";
    const base = repo.split("/").pop();
    const id = (o.name || `${base}-2026-10-14`).trim().replace(/\s+/g, "-");
    const size = SIZES.find((s) => s.id === o.size) || SIZES[1];
    const [cpu, mem] = size.spec.match(/\d+/g).map(Number);
    const r = {
      id, label: null, repo, ref: o.ref || "default branch", commit: null, lang: "", status: "preparing", agent: "starting", hue: runs.length % 6,
      started: Date.now(), detail: "Starting machine", model: o.model || MODELS[1], variant: o.variant || "high", key: o.key || "work", failover: true, autopilot: o.autopilot !== false, template: o.template || TEMPLATES[0],
      tokens: { in: 0, out: 0, cache: 0 }, ctx: 0, ctxMax: 200000, cost: 0, costToday: 0,
      machine: { name: `pixel-${id}`, cpu, mem, disk: 40, cpuPct: 0, memUsed: 0.3, diskUsed: 0.1, workbase: 0 },
      continues: 0, ooms: 0, tpsBase: 90, tps: 0, tpsHist: Array(90).fill(0), progressAt: null, unseen: null, progress: null,
      agents: [{ id: "main", title: "Main agent", status: "starting", parent: null, started: Date.now(), now: null }], todos: [], reads: [], readBy: [],
      pool: { main: [["bash", `git -C /workspace/${base} log --oneline -3`], ["read", "README.md"], ["bash", "ls -R src | head -60"], ["grep", "memcpy src/"], ["bash", "cmake -B build-asan -DCMAKE_C_FLAGS=-fsanitize=address"], ["read", "src/parser.c:1-120"]] },
      weights: { main: 1 }, activity: Array.from({ length: 30 }, () => ({ n: 0 })), ticks: [], log: [],
    };
    runs.unshift(r);
    timelines[id] = [{ ts: Date.now(), actor: "user", msg: `You started the run (${r.template}, ${shortModel(r.model)})` }];
    setTimeout(() => { r.detail = `Cloning ${repo}`; emit("change", { run: id, quiet: true }); }, 1600);
    setTimeout(() => {
      r.status = "running"; r.agent = "working"; r.detail = null; r.commit = "a41c09e7f2"; r.agents[0].status = "running"; r.agents[0].now = { tool: "read", text: "README.md" };
      r.progressAt = Date.now(); r.progress = "## Trying now\n- Building with ASan and reading the entry points";
      timelines[id].push({ ts: Date.now(), actor: "pixel", msg: "Session started" });
      emit("change", { run: id });
    }, 4200);
    return r;
  }

  /* ---------- renderers (markup only; each direction styles the x-* classes) ---------- */
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  function md(src, mode = "text") {
    if (!src) return "";
    const out = [];
    let list = false;
    const close = () => list && (out.push("</ul>"), (list = false));
    for (let raw of src.split("\n")) {
      let mark = "";
      if (raw.startsWith("{+}")) (mark = "add"), (raw = raw.slice(3));
      else if (raw.startsWith("{-}")) {
        mark = "del";
        raw = raw.slice(3);
        if (mode !== "changes") continue;
      }
      const cls = mode === "changes" ? (mark ? ` class="${mark}"` : "") : mark === "add" ? ' class="new"' : "";
      const h = raw.match(/^(#{1,3}) (.*)/);
      if (h) { close(); const n = h[1].length + 1; out.push(`<h${n}${cls}>${inline(h[2])}</h${n}>`); }
      else if (raw.startsWith("- ")) { if (!list) out.push("<ul>"), (list = true); out.push(`<li${cls}>${inline(raw.slice(2))}</li>`); }
      else if (!raw.trim()) close();
      else { close(); out.push(`<p${cls}>${inline(raw)}</p>`); }
    }
    close();
    return out.join("");
  }
  const headline = (r) => {
    if (!r.progress) return null;
    const lines = r.progress.split("\n").filter((l) => !l.startsWith("{-}"));
    const found = lines.findIndex((l) => /^## Found/.test(l));
    const item = found >= 0 ? lines[found + 1] : null;
    if (item && !/Nothing yet/.test(item)) return { label: "Found", text: item.replace(/^\{\+\}/, "").replace(/^- /, "") };
    const t = lines.findIndex((l) => /^## Trying/.test(l));
    if (t >= 0) return { label: "Trying", text: lines[t + 1].replace(/^\{\+\}/, "").replace(/^- /, "") };
    return null;
  };

  function barcode(r, w = 120, h = 20) {
    const b = r.activity, max = Math.max(10, ...b.map((x) => x.n)), bw = w / b.length;
    return `<svg class="x-barcode" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">${b
      .map((x, i) => {
        const X = (i * bw + 0.5).toFixed(1), W = Math.max(1, bw - 1.5).toFixed(1);
        if (!x.n) return `<rect x="${X}" y="${h - 1}" width="${W}" height="1" style="fill:var(--line)"/>`;
        const bh = Math.max(2, Math.round((x.n / max) * (h - 1)));
        return `<rect x="${X}" y="${h - bh}" width="${W}" height="${bh}" style="fill:var(--k-${x.k === "bad" ? "bad" : x.k})"/>`;
      })
      .join("")}</svg>`;
  }
  function spark(values, w = 80, h = 18, color = "var(--accent)") {
    const max = Math.max(1, ...values), n = values.length;
    const pts = values.map((v, i) => `${((i / (n - 1)) * w).toFixed(1)},${(h - 1 - (v / max) * (h - 3)).toFixed(1)}`);
    return `<svg class="x-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path d="M0,${h} L${pts.join(" L")} L${w},${h} Z" style="fill:${color};opacity:.14"/><path d="M${pts.join(" L")}" style="fill:none;stroke:${color};stroke-width:1.25;vector-effect:non-scaling-stroke"/></svg>`;
  }
  /** Stacked tokens/s per run over the last 90 samples (3 minutes). */
  function stacked(list, w = 600, h = 56) {
    const n = 90, sums = Array(n).fill(0);
    const layers = list.filter((r) => r.tpsHist.some((v) => v > 0)).map((r) => {
      const lo = sums.slice();
      r.tpsHist.forEach((v, i) => (sums[i] += v));
      return { r, lo, hi: sums.slice() };
    });
    const max = Math.max(120, ...sums) * 1.1;
    const x = (i) => ((i / (n - 1)) * w).toFixed(1), y = (v) => (h - (v / max) * h).toFixed(1);
    return `<svg class="x-stacked" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="${h}" aria-hidden="true">${layers
      .map(({ r, lo, hi }) => `<path d="M${hi.map((v, i) => `${x(i)},${y(v)}`).join(" L")} L${lo.map((v, i) => `${x(n - 1 - i)},${y(lo[n - 1 - i])}`).join(" L")} Z" style="fill:var(--r${r.hue})"/>`)
      .join("")}</svg>`;
  }

  function lanes(r, minutes = 60) {
    const now = Date.now();
    const rows = r.agents.filter((a) => r.ticks.some((t) => t.a === a.id && now - t.ts < minutes * M));
    if (!rows.length) return `<div class="x-empty">No tool calls in the last ${minutes} minutes.</div>`;
    const W = 600;
    const lane = (a) => {
      const ticks = r.ticks.filter((t) => t.a === a.id && now - t.ts < minutes * M);
      const lines = ticks.map((t) => { const X = (W - ((now - t.ts) / (minutes * M)) * W).toFixed(1); return `<line x1="${X}" x2="${X}" y1="1" y2="11" style="stroke:var(--k-${t.k})"/>`; }).join("");
      return `<div class="x-lane"><span class="x-lane-n" title="${esc(a.title)}">${esc(a.title)}</span><svg viewBox="0 0 ${W} 12" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="${W}" y1="6" y2="6" style="stroke:var(--line)"/>${lines}</svg></div>`;
    };
    return `<div class="x-lanes" role="img" aria-label="Tool calls per agent, last ${minutes} minutes">${rows.map(lane).join("")}<div class="x-lane x-lane-axis"><span></span><div><span>${minutes} min ago</span><span>${minutes / 2}</span><span>now</span></div></div></div>`;
  }
  const KIND_LABEL = { shell: "shell", read: "read", edit: "edit", task: "subagent", web: "web" };
  const legend = () => `<div class="x-legend">${Object.entries(KIND_LABEL).map(([k, l]) => `<span><i style="background:var(--k-${k})"></i>${l}</span>`).join("")}</div>`;

  const AGENT_TEXT = { waiting: "waiting on subagents", idle: "idle", done: "finished", interrupted: "interrupted · resumable", starting: "starting", failed: "failed" };
  function agentNow(r, a) {
    if (a.status === "running" && a.now) return `<span class="x-tool" data-kind="${kindOf(a.now.tool)}">${esc(a.now.tool)}</span><span class="x-cmd">${esc(a.now.text)}</span>`;
    if (a.id === "main" && r.question) return `<span class="x-state warn">waiting for your answer</span>`;
    return `<span class="x-state">${AGENT_TEXT[a.status] || a.status}</span>`;
  }
  function agents(r) {
    if (!r.agents.length) return `<div class="x-empty">No agents.</div>`;
    const node = (a) => {
      const kids = r.agents.filter((k) => k.parent === a.id);
      return `<li class="x-agent" data-s="${a.status}"><div class="x-agent-top"><span class="x-ring" data-s="${a.status}"></span><span class="x-agent-t">${esc(a.title)}</span><span class="x-agent-age">${dur(Date.now() - a.started).replace(/ \d+s$/, "")}</span></div><div class="x-agent-now" data-now="${r.id}:${a.id}">${agentNow(r, a)}</div>${kids.length ? `<ul class="x-kids">${kids.map(node).join("")}</ul>` : ""}</li>`;
    };
    return `<ul class="x-agents">${r.agents.filter((a) => !a.parent).map(node).join("")}</ul>`;
  }
  const todos = (r) => (r.todos.length ? `<ul class="x-todos">${r.todos.map(([s, t]) => `<li data-s="${s}"><span class="x-check" aria-hidden="true"></span>${esc(t)}</li>`).join("")}</ul>` : `<div class="x-empty">No todos.</div>`);
  const crossReads = (r) => {
    const rows = [...r.reads.map((x) => ({ ...x, dir: "Reads" })), ...r.readBy.map((x) => ({ ...x, dir: "Read by" }))];
    if (!rows.length) return `<div class="x-empty">No cross-reads.</div>`;
    return `<ul class="x-reads">${rows.map((x) => { const o = find(x.run); return `<li><span class="x-reads-dir">${x.dir}</span><button class="x-link" data-open-run="${esc(x.run)}">${esc(o ? name(o) : x.run)}</button><span class="x-reads-n">${x.n}×</span></li>`; }).join("")}</ul>`;
  };

  function question(r) {
    const q = r.question;
    if (!q) return "";
    return `<form class="x-ask" data-ask="${r.id}"><div class="x-ask-head"><span class="x-ask-label">The agent is asking</span><span class="x-ask-ago">${ago(q.at)}</span></div><p class="x-ask-q">${esc(q.text)}</p><div class="x-ask-opts">${q.options.map((o, i) => `<button type="button" class="x-opt" data-opt="${esc(o)}"><kbd>${i + 1}</kbd>${esc(o)}</button>`).join("")}</div><div class="x-ask-custom"><input id="ask-${r.id}" name="custom" placeholder="Or type an answer" autocomplete="off" aria-label="Your own answer"><button type="submit" class="x-ask-send">Send answer</button></div></form>`;
  }

  function progress(r, mode = "text") {
    if (!r.progress) return `<div class="x-empty">No PROGRESS.md yet.</div>`;
    return `<div class="x-md ${mode === "changes" ? "changes" : ""}">${md(r.progress, mode)}</div>`;
  }

  function transcript(r) {
    const items = transcripts[r.id] || genericTranscript(r);
    return `<ol class="x-tr">${items
      .map((m) => {
        if (m.role === "tool")
          return `<li class="x-tc" data-kind="${kindOf(m.tool)}"><details ${m.error ? "open" : ""}><summary><span class="x-tool" data-kind="${kindOf(m.tool)}">${esc(m.tool)}</span><span class="x-tc-t">${esc(m.title)}</span><span class="x-tc-took ${m.error ? "bad" : ""}">${m.error ? "exit 1 · " : ""}${esc(m.took)}</span></summary>${m.out ? `<pre>${esc(m.out)}</pre>` : ""}</details></li>`;
        if (m.role === "reasoning") return `<li class="x-reason"><details><summary>Thinking</summary><p>${esc(m.text)}</p></details></li>`;
        return `<li class="x-msg" data-role="${m.role}"><div class="x-msg-who">${m.role === "user" ? esc(m.who) : "Agent"}<span>${clock(m.ts)}</span>${m.note ? `<span class="x-msg-note">${esc(m.note)}</span>` : ""}</div><p>${inline(m.text)}</p></li>`;
      })
      .join("")}</ol>`;
  }

  function filesFor(r) {
    if (r.id === "libpng-2026-10-14") return libpngFiles;
    if (!r.progress) return {};
    return { "PROGRESS.md": null, "NOTES.md": `# Notes\n\n${repoShort(r)} at ${r.commit || "?"}.` , ...(r.report ? { "REPORT.md": reports[r.id] } : {}) };
  }
  function files(r, sel) {
    const fs = filesFor(r);
    const paths = Object.keys(fs);
    if (!paths.length) return `<div class="x-empty">The workbase is empty.</div>`;
    sel = sel && paths.includes(sel) ? sel : paths[0];
    const content = sel === "PROGRESS.md" ? r.progress.split("\n").filter((l) => !l.startsWith("{-}")).map((l) => l.replace(/^\{\+\}/, "")).join("\n") : fs[sel];
    let lastDir = "";
    const tree = paths
      .map((p) => {
        const parts = p.split("/"), dir = parts.length > 1 ? parts[0] : "";
        const head = dir && dir !== lastDir ? `<li class="x-dir">${esc(dir)}/</li>` : "";
        lastDir = dir;
        return `${head}<li><button class="x-file ${dir ? "in" : ""}" data-file="${esc(p)}" aria-current="${p === sel}">${esc(parts[parts.length - 1])}</button></li>`;
      })
      .join("");
    return `<div class="x-files"><ul class="x-tree">${tree}</ul><div class="x-view"><div class="x-view-head"><span>${esc(sel)}</span><span>${content.length.toLocaleString()} bytes</span></div><pre>${esc(content)}</pre></div></div>`;
  }

  function timeline(r) {
    const t = (timelines[r.id] = timelines[r.id] || genericTimeline(r)).slice().reverse();
    return `<ol class="x-tl">${t.map((e) => `<li data-actor="${e.actor}"><span class="x-tl-time">${clock(e.ts)}</span><span class="x-tl-actor">${e.actor === "user" ? "you" : e.actor}</span><span class="x-tl-msg">${esc(e.msg)}</span></li>`).join("")}</ol>`;
  }

  function report(r) {
    if (!r.report) return `<div class="x-empty">No REPORT.md yet. The agent writes it when it finishes.</div>`;
    const v = r.verdict || "";
    return `<div class="x-report"><div class="x-md">${md(reports[r.id])}</div><form class="x-triage" data-triage="${r.id}"><h3>Triage</h3><label for="verdict-${r.id}">Overall verdict</label><select id="verdict-${r.id}" name="verdict">${["", ...VERDICTS].map((x) => `<option ${x === v ? "selected" : ""} value="${x}">${x || "Choose…"}</option>`).join("")}</select><label for="notes-${r.id}">Notes per finding</label><textarea id="notes-${r.id}" name="notes" rows="6" placeholder="1. real, reported upstream&#10;2. low impact, skip"></textarea><label class="x-checkrow"><input type="checkbox" checked> Mark triaged</label><label class="x-checkrow"><input type="checkbox"> Keep the machine</label><button type="submit" class="x-primary">Save triage</button></form></div>`;
  }

  function terminal(r) {
    const host = r.machine.name;
    const live = isLive(r);
    return `<div class="x-term"><pre>root@${esc(host)}:/workspace# ls
${esc(repoShort(r).split("/").pop())}  workbase  scratch
root@${esc(host)}:/workspace# uptime
 ${live ? "load average: 2.91, 2.64, 2.40" : "machine is stopped"}
root@${esc(host)}:/workspace# <span class="x-caret"></span></pre></div>`;
  }

  function machine(r) {
    const m = r.machine;
    const meter = (label, used, total, unit, pct) => `<div class="x-meter"><div class="x-meter-top"><span>${label}</span><span>${unit === "%" ? `${used}%` : `${used} / ${total} ${unit}`}</span></div><div class="x-meter-bar"><i style="width:${Math.min(100, pct).toFixed(1)}%"></i></div></div>`;
    return `<div class="x-machine"><div class="x-meters">${meter(`CPU · ${m.cpu} cores`, m.cpuPct, 100, "%", m.cpuPct)}${meter("Memory", m.memUsed.toFixed(1), m.mem, "GiB", (m.memUsed / m.mem) * 100)}${meter("Disk", m.diskUsed.toFixed(1), m.disk, "GiB", (m.diskUsed / m.disk) * 100)}${meter("Context", tok(r.ctx), tok(r.ctxMax), "tokens", (r.ctx / r.ctxMax) * 100)}</div><dl class="x-kv"><dt>Machine</dt><dd>${esc(m.name)}</dd><dt>Workbase</dt><dd>${m.workbase} MB · snapshot every 10 min</dd><dt>Recoveries</dt><dd>${r.continues} continues · ${r.ooms} OOM restarts</dd><dt>Autopilot</dt><dd>${r.autopilot ? "on" : "off"}</dd><dt>Tokens</dt><dd>${tok(r.tokens.in)} in · ${tok(r.tokens.out)} out · ${tok(r.tokens.cache)} cache</dd></dl></div>`;
  }

  /* ---------- widgets ---------- */
  function toast(text, kind = "") {
    let box = document.querySelector(".x-toasts");
    if (!box) {
      box = document.createElement("div");
      box.className = "x-toasts";
      box.setAttribute("role", "status");
      document.body.appendChild(box);
    }
    const t = document.createElement("div");
    t.className = `x-toast ${kind}`;
    t.textContent = text;
    box.appendChild(t);
    setTimeout(() => t.classList.add("out"), 2600);
    setTimeout(() => t.remove(), 3000);
  }

  function confirm({ title, body, ok = "OK", danger = false, check }) {
    return new Promise((resolve) => {
      const d = document.createElement("div");
      d.className = "x-dialog-scrim";
      d.innerHTML = `<div class="x-dialog" role="dialog" aria-modal="true" aria-labelledby="xd-t"><h2 id="xd-t">${esc(title)}</h2><p>${esc(body)}</p>${check ? `<label class="x-checkrow"><input type="checkbox" id="xd-check"> ${esc(check)}</label>` : ""}<div class="x-dialog-btns"><button type="button" class="x-btn" data-r="0">Cancel</button><button type="button" class="x-btn ${danger ? "x-danger" : "x-primary"}" data-r="1">${esc(ok)}</button></div></div>`;
      const close = (v) => { d.remove(); document.removeEventListener("keydown", key, true); resolve(v); };
      const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(false); } };
      d.addEventListener("click", (e) => { const b = e.target.closest("[data-r]"); if (b) close(b.dataset.r === "1"); else if (e.target === d) close(false); });
      document.addEventListener("keydown", key, true);
      document.body.appendChild(d);
      d.querySelector('[data-r="1"]').focus();
    });
  }

  let openMenuEl = null;
  function menu(anchor, items) {
    closeMenu();
    const m = document.createElement("div");
    m.className = "x-menu";
    m.setAttribute("role", "menu");
    m.innerHTML = items.map((it, i) => (it === "-" ? `<div class="x-menu-sep" role="separator"></div>` : it.head ? `<div class="x-menu-head">${esc(it.head)}</div>` : `<button type="button" role="menuitem" class="x-menu-item ${it.danger ? "danger" : ""}" data-i="${i}" ${it.disabled ? "disabled" : ""}><span class="x-menu-check">${it.checked ? "✓" : ""}</span><span>${esc(it.label)}</span>${it.hint ? `<span class="x-menu-hint">${esc(it.hint)}</span>` : ""}</button>`)).join("");
    document.body.appendChild(m);
    const a = anchor.getBoundingClientRect();
    const w = m.offsetWidth, h = m.offsetHeight;
    let left = Math.min(a.right - w, window.innerWidth - w - 8);
    left = Math.max(8, left);
    let top = a.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 6);
    m.style.left = `${left}px`;
    m.style.top = `${top}px`;
    m.addEventListener("click", (e) => {
      const b = e.target.closest("[data-i]");
      if (!b) return;
      closeMenu();
      items[+b.dataset.i].on();
    });
    m.addEventListener("keydown", (e) => {
      const btns = [...m.querySelectorAll("button:not([disabled])")];
      const i = btns.indexOf(document.activeElement);
      if (e.key === "ArrowDown") (e.preventDefault(), btns[(i + 1) % btns.length].focus());
      if (e.key === "ArrowUp") (e.preventDefault(), btns[(i - 1 + btns.length) % btns.length].focus());
    });
    openMenuEl = { m, anchor };
    anchor.setAttribute("aria-expanded", "true");
    m.querySelector("button:not([disabled])")?.focus();
  }
  function closeMenu() {
    if (!openMenuEl) return;
    openMenuEl.anchor.setAttribute("aria-expanded", "false");
    openMenuEl.m.remove();
    openMenuEl = null;
  }
  document.addEventListener("mousedown", (e) => { if (openMenuEl && !openMenuEl.m.contains(e.target) && !openMenuEl.anchor.contains(e.target)) closeMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openMenuEl) { e.stopPropagation(); const a = openMenuEl.anchor; closeMenu(); a.focus(); } }, true);

  function runMenu(anchor, id) {
    const r = find(id);
    if (!r) return;
    const live = ["running", "recovering"].includes(r.status);
    const items = [
      { label: "Send continue", on: () => act(id, "continue"), disabled: !live },
      { label: "Abort current step", on: () => act(id, "abort"), disabled: r.agent !== "working" },
      { label: "Restart opencode", on: () => act(id, "restart"), disabled: !live },
      { label: "Autopilot", checked: r.autopilot, hint: "continue when idle, restart after OOM", on: () => act(id, "autopilot") },
      { label: "Reset recovery counters", on: () => act(id, "reset") },
      "-",
      { label: "Mark done", on: () => act(id, "done"), disabled: !["running", "recovering", "paused", "stopped"].includes(r.status) },
      { label: "Re-run", on: async () => { const nid = await act(id, "rerun"); if (nid) ui().openRun(nid); } },
      { label: "Follow-up audit…", on: () => ui().newRun({ repo: r.repo, parent: r.id }) },
      { label: "Rename…", hint: "or double-click the name", on: () => ui().rename?.(id) },
      "-",
      { label: "Delete run…", danger: true, on: () => act(id, "delete") },
    ];
    menu(anchor, items);
  }
  function modelMenu(anchor, id) {
    const r = find(id);
    menu(anchor, [
      { head: "Model · applies from the next message" },
      ...MODELS.map((m) => ({ label: shortModel(m), hint: m.split("/")[0], checked: r.model === m, on: () => act(id, "model", { model: m }) })),
      "-",
      { head: "Thinking" },
      ...["low", "medium", "high"].map((v) => ({ label: v, checked: r.variant === v, on: () => act(id, "model", { variant: v }) })),
    ]);
  }
  function keyMenu(anchor, id) {
    const r = find(id);
    menu(anchor, [
      { head: "API key for anthropic" },
      ...KEYS.map((k) => ({ label: k.name, hint: k.hint, checked: r.key === k.id, on: () => act(id, "key", k.id) })),
      "-",
      { label: "Fail over to the next key", checked: r.failover, on: () => act(id, "failover") },
    ]);
  }

  /* command palette */
  function palette() {
    if (document.querySelector(".x-pal")) return;
    const cur = ui().current?.();
    const r = cur && find(cur);
    const items = [
      ...runs.map((x) => ({ group: "Runs", label: name(x), hint: x.status, run: x.id, on: () => ui().openRun(x.id) })),
      { group: "Actions", label: "New run", hint: "N", on: () => ui().newRun({}) },
      ...(r
        ? [
            r.status === "paused" || r.status === "stopped" ? { group: "Actions", label: `Resume ${name(r)}`, on: () => act(r.id, "resume") } : { group: "Actions", label: `Pause ${name(r)}`, on: () => act(r.id, "pause") },
            { group: "Actions", label: `Send continue to ${name(r)}`, on: () => act(r.id, "continue") },
            { group: "Actions", label: `Change model of ${name(r)}`, on: () => setTimeout(() => ui().modelMenu?.(r.id), 0) },
            { group: "Actions", label: `Stop ${name(r)}`, on: () => act(r.id, "stop") },
          ]
        : []),
      ...["Activity", "Models", "Stats", "Knowledge", "Templates", "Settings", "System"].map((p) => ({ group: "Go to", label: p, on: () => ui().openPage(p) })),
      { group: "Go to", label: "Toggle light / dark", on: cycleTheme },
    ];
    const d = document.createElement("div");
    d.className = "x-pal";
    d.innerHTML = `<div class="x-pal-box" role="dialog" aria-modal="true" aria-label="Command palette"><input class="x-pal-input" id="x-pal-input" placeholder="Jump to a run or run a command" autocomplete="off" aria-label="Command"><div class="x-pal-list" role="listbox"></div><div class="x-pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div></div>`;
    document.body.appendChild(d);
    const input = d.querySelector("input"), list = d.querySelector(".x-pal-list");
    let shown = items, sel = 0;
    const draw = () => {
      let g = "";
      list.innerHTML = shown.length
        ? shown.map((it, i) => { const head = it.group !== g ? `<div class="x-pal-group">${(g = it.group)}</div>` : ""; const rr = it.run && find(it.run); return `${head}<button type="button" role="option" class="x-pal-item" data-i="${i}" aria-selected="${i === sel}">${rr ? `<span class="x-dot" data-s="${rr.question ? "asking" : rr.status}"></span>` : ""}<span class="x-pal-label">${esc(it.label)}</span>${it.hint ? `<span class="x-pal-hint">${esc(it.hint)}</span>` : ""}</button>`; }).join("")
        : `<div class="x-pal-none">Nothing matches.</div>`;
      list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    };
    const close = () => { d.remove(); document.removeEventListener("keydown", key, true); };
    const run = (i) => { const it = shown[i]; close(); it?.on(); };
    const key = (e) => {
      if (e.key === "Escape") (e.stopPropagation(), close());
      else if (e.key === "ArrowDown") (e.preventDefault(), (sel = Math.min(shown.length - 1, sel + 1)), draw());
      else if (e.key === "ArrowUp") (e.preventDefault(), (sel = Math.max(0, sel - 1)), draw());
      else if (e.key === "Enter") (e.preventDefault(), run(sel));
    };
    input.addEventListener("input", () => { const q = input.value.toLowerCase().trim(); shown = items.filter((it) => !q || it.label.toLowerCase().includes(q) || it.group.toLowerCase().startsWith(q)); sel = 0; draw(); });
    list.addEventListener("click", (e) => { const b = e.target.closest("[data-i]"); if (b) run(+b.dataset.i); });
    d.addEventListener("mousedown", (e) => { if (e.target === d) close(); });
    document.addEventListener("keydown", key, true);
    draw();
    input.focus();
  }

  /* new-run form */
  function newRunForm(pre = {}) {
    const opts = (list, val) => list.map((x) => `<option value="${esc(x.v)}" ${x.v === val ? "selected" : ""}>${esc(x.l)}</option>`).join("");
    return `<form class="x-form" id="x-newrun" autocomplete="off">
      <div class="x-field wide"><label for="nr-repo">Repository</label><input id="nr-repo" name="repo" placeholder="https://github.com/owner/project" value="${esc(pre.repo ? "https://" + pre.repo : "")}" required></div>
      <div class="x-field"><label for="nr-ref">Branch, tag or commit</label><input id="nr-ref" name="ref" placeholder="default branch"></div>
      <div class="x-field"><label for="nr-name">Run name</label><input id="nr-name" name="name" placeholder="project-2026-10-14"></div>
      <div class="x-field"><label for="nr-template">Template</label><select id="nr-template" name="template">${opts(TEMPLATES.map((t) => ({ v: t, l: t })), TEMPLATES[0])}</select></div>
      <div class="x-field"><label for="nr-parent">Follow-up of</label><select id="nr-parent" name="parent">${opts([{ v: "", l: "None" }, ...runs.filter((r) => r.progress).map((r) => ({ v: r.id, l: r.id }))], pre.parent || "")}</select></div>
      <div class="x-field"><label for="nr-model">Model</label><select id="nr-model" name="model">${opts(MODELS.map((m) => ({ v: m, l: shortModel(m) })), MODELS[1])}</select></div>
      <div class="x-field"><label for="nr-variant">Thinking</label><select id="nr-variant" name="variant">${opts(["low", "medium", "high"].map((v) => ({ v, l: v })), "high")}</select></div>
      <div class="x-field"><label for="nr-key">API key</label><select id="nr-key" name="key">${opts(KEYS.map((k) => ({ v: k.id, l: `${k.name} · ${k.hint}` })), "work")}</select></div>
      <fieldset class="x-field x-seg"><legend>Machine</legend>${SIZES.map((s) => `<label><input type="radio" name="size" value="${s.id}" ${s.id === "medium" ? "checked" : ""}><span><b>${s.label}</b><small>${s.spec}</small></span></label>`).join("")}</fieldset>
      <label class="x-checkrow wide"><input type="checkbox" name="autopilot" checked> Autopilot: continue when the agent goes idle, restart after an OOM</label>
      <details class="x-preview wide"><summary>Prompt preview</summary><pre>Audit {{repo}} for memory-safety bugs reachable from untrusted input.
You are {{machine}}. Other agents' workbases are under /workbases (read-only);
look at them if useful.
Keep {{workbase}}/PROGRESS.md short and current for the human.
Write {{workbase}}/REPORT.md when you are done.</pre></details>
      <div class="x-form-btns wide"><button type="button" class="x-btn" data-cancel>Cancel</button><button type="submit" class="x-btn x-primary">Start run</button></div>
    </form>`;
  }
  function bindNewRun(form, onDone, onCancel) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const f = new FormData(form);
      const r = createRun({ repo: String(f.get("repo")), ref: String(f.get("ref") || ""), name: String(f.get("name") || ""), model: String(f.get("model")), variant: String(f.get("variant")), key: String(f.get("key")), template: String(f.get("template")), size: String(f.get("size")), autopilot: !!f.get("autopilot") });
      toast(`Starting ${r.id}`);
      emit("change", { run: r.id, action: "created" });
      onDone(r.id);
    });
    form.querySelector("[data-cancel]").addEventListener("click", onCancel);
  }

  /* shared delegated behaviour for question forms, triage forms, file trees and cross-read links */
  document.addEventListener("click", (e) => {
    const opt = e.target.closest(".x-opt");
    if (opt) { const f = opt.closest("[data-ask]"); answer(f.dataset.ask, opt.dataset.opt); return; }
    const file = e.target.closest("[data-file]");
    if (file) { ui().openFile?.(file.dataset.file); return; }
    const link = e.target.closest("[data-open-run]");
    if (link) { ui().openRun(link.dataset.openRun); }
  });
  document.addEventListener("submit", (e) => {
    const ask = e.target.closest("[data-ask]");
    if (ask) { e.preventDefault(); const v = ask.querySelector("input").value.trim(); if (v) answer(ask.dataset.ask, v); return; }
    const tri = e.target.closest("[data-triage]");
    if (tri) { e.preventDefault(); act(tri.dataset.triage, "triage", tri.querySelector("select").value); }
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); palette(); return; }
    const t = e.target;
    if (e.metaKey || e.ctrlKey || e.altKey || t.closest("input, textarea, select, .x-pal, .x-dialog-scrim")) return;
    const ask = document.querySelector("[data-ask]");
    if (ask && /^[1-3]$/.test(e.key)) { const b = ask.querySelectorAll(".x-opt")[+e.key - 1]; if (b) (e.preventDefault(), b.click()); }
  });

  /* mockup chrome: direction switcher + theme */
  function cycleTheme() {
    const order = ["system", "light", "dark"];
    const next = order[(order.indexOf(getTheme()) + 1) % 3];
    try { localStorage.setItem(THEME_KEY, next); } catch {}
    applyTheme(next);
    document.querySelectorAll("[data-theme-label]").forEach((el) => (el.textContent = next));
    emit("theme");
  }
  function switcher(current) {
    const el = document.createElement("nav");
    el.className = "mk-switch";
    el.setAttribute("aria-label", "Mockup directions");
    let hidden = false;
    try { hidden = sessionStorage.getItem("pixel-mock-switch") === "hidden"; } catch {}
    el.innerHTML = `<style>
      .mk-switch{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(10px + env(safe-area-inset-bottom,0px));z-index:900;display:flex;align-items:center;gap:2px;padding:3px;border-radius:999px;background:#1d1f24;color:#f2f2f0;font:500 12px/1 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3),0 0 0 1px rgba(255,255,255,.08)}
      .mk-switch a,.mk-switch button{color:#c9cad0;text-decoration:none;border:0;background:none;font:inherit;padding:7px 10px;border-radius:999px;cursor:pointer;white-space:nowrap}
      .mk-switch a:hover,.mk-switch button:hover{background:#2c2f36;color:#fff}
      .mk-switch a[aria-current="page"]{background:#f2f2f0;color:#15161a}
      .mk-switch .mk-sep{width:1px;height:16px;background:#3a3d45;margin:0 3px}
      .mk-switch a:focus-visible,.mk-switch button:focus-visible{outline:2px solid #f2f2f0;outline-offset:1px}
      .mk-switch.min .full{display:none}
      .mk-switch:not(.min) .open{display:none}
      @media (max-width:640px){.mk-switch .mk-lbl{display:none}}
    </style>
    <button type="button" class="open" title="Show the mockup switcher">◧ ${current.toUpperCase()}</button>
    <span class="full" style="display:contents">
    <a href="index.html" title="All directions">≡</a><span class="mk-sep"></span>
    <a href="a-workbench.html" ${current === "a" ? 'aria-current="page"' : ""}>A<span class="mk-lbl"> Workbench</span></a>
    <a href="b-console.html" ${current === "b" ? 'aria-current="page"' : ""}>B<span class="mk-lbl"> Console</span></a>
    <a href="c-wall.html" ${current === "c" ? 'aria-current="page"' : ""}>C<span class="mk-lbl"> Wall</span></a>
    <span class="mk-sep"></span><button type="button" class="theme" title="Theme: system, light, dark">◐ <span data-theme-label>${getTheme()}</span></button>
    <button type="button" class="hide" title="Hide" aria-label="Hide the mockup switcher">×</button></span>`;
    const setMin = (v) => { el.classList.toggle("min", v); try { sessionStorage.setItem("pixel-mock-switch", v ? "hidden" : "shown"); } catch {} };
    setMin(hidden);
    el.querySelector(".theme").addEventListener("click", cycleTheme);
    el.querySelector(".hide").addEventListener("click", () => setMin(true));
    el.querySelector(".open").addEventListener("click", () => setMin(false));
    document.body.appendChild(el);
  }

  let uiImpl = {};
  const ui = () => uiImpl;

  window.PX = {
    runs, find, name, repoShort, isLive, needsYou, working, fleet, feed, kindOf, MODELS, KEYS, KIND_LABEL,
    fmt, on, emit, start, act, message, answer,
    r: { md, headline, barcode, spark, stacked, lanes, legend, agents, agentNow, todos, crossReads, question, progress, transcript, files, timeline, report, terminal, machine },
    toast, confirm, menu, closeMenu, runMenu, modelMenu, keyMenu, palette, newRunForm, bindNewRun, switcher, cycleTheme,
    set ui(v) { uiImpl = v; },
    get ui() { return uiImpl; },
  };
})();
