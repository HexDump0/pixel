# Redesign spec (target: mockup round 14, plus the two changes asked after it)

Reference: `ai/mockups/r14/` — `index.html` (page + state + filters), `kit.css` (all styles), `kit.js` (tiles, run view, findings, list rows), `hero.js` (the fleet charts), `shared.js` (fake data, simulation, renderers for transcript/files/timeline/terminal/machine), `icons.js` (Tabler paths). When this spec and the mockup disagree, this spec wins (it includes feedback the mockup doesn't).

## 1. System

### Colour tokens (dark, default)

```
--bg #09090b   --s1 #111113   --s2 #17171a   --s3 #1f1f23   --line #2a2a2f   --line-2 #1c1c20
--ink #ededef  --ink-2 #a1a1aa --ink-3 #71717a --ink-4 #46464d
run hues: --r0 #4fcdbd teal  --r1 #79a6ff blue  --r2 #ad90ff violet  --r3 #f38bc3 pink  --r4 #a9d673 lime  --r5 #f2aa82 peach
--good #5bd08f (running)   --warning #f1b354 (needs you, recovering)   --critical #f27474 (failed)
severity: high = critical red, medium = warning amber, low #8b8b94, info #55555d
tool kinds: shell = teal, read #5c5c66, edit = blue, subagent = violet, web = peach
tints for problem tiles/notices: amber 6.5 % and red 6.5 % over --s1
```
Light-mode values are in `kit.css` under `:root[data-theme="light"]`. Each run gets a stable hue index at creation (`runs.length % 6` in the mock; in the app store it on the run or derive it from the id). **Two live runs must not share a hue** when avoidable (round 11 bug: libxml2 and zlib were both blue).

### Rules

- Colour means something: run identity (hue), state (green/amber/red), severity, tool kind. Nothing decorative. No coloured borders on cards; problem tiles get a faint **whole-tile tint**.
- Surfaces separate by `--s1` on `--bg` with 1 px `--line-2` borders; radius 16 px for panels and tiles, 8–10 px for controls.
- Type: Geist 14 px base (`ss01`), Geist Mono for numbers, paths, commands and code only. Tabular figures for all numbers. Sentence case everywhere; no uppercase labels.
- Spacing scale 4 8 12 16 24 32. Gutter 32 px desktop, 16 px phone.
- Motion only where data arrives (charts scroll, numbers update). One load-in reveal for charts is fine. No pulses, glows, flashes.
- **Text rule**: say a thing once; no labels for what is evident; words only for problems. Units sit next to numbers in `--ink-3` ("58 tok/s"). Tooltips carry the long form.
- Status chip: 6 px dot + word. Running: green dot + age in mono `--ink-3` ("● 3h 21m"). Waiting 12m / Recovering 2/3 / Preparing / Idle / Stopped: amber. Failed: red. Paused, triaged: hollow dot.
- Icons: Tabler outline, 15–16 px, stroke 1.75.

## 2. Chrome

- Top bar 60 px, sticky, translucent `--bg`: brand (four rounded squares in r0/r2/r3/ink) · nav (Runs, Findings, Activity, Models, Stats, Knowledge, Templates, Settings) · right: search box (⌘K, opens the command palette), "since you last looked" icon (history, blue dot when there's news), theme toggle, **New run** (primary, white).
- Nav counts: Runs shows an **amber pill** with the needs-you count; Findings shows the untriaged count in mono.
- No sidebar (the current app's left nav goes away).

## 3. The Wall (Runs page, `/`)

### Fleet row (220 px high)
Three areas side by side (`1.25fr | 1fr | 340px`), each a `--s1` panel:
1. **Stream**: output tokens/s per run over the last 30 minutes as a streamgraph (silhouette baseline, smooth curves, fill gradient from 22 % to 72 % of the run hue left→right, 1.25 px top line). Big number top-left ("57" + "tok/s"). **Direct labels** in a right gutter (run name + current value in its hue, leader lines, de-overlapped), only for runs generating now. Events marked on the streams: finding (dot, severity colour), question (amber diamond), crash/OOM (amber tick). Hover a stream: others dim, tooltip lists runs at that moment; hover a mark: its text; click a stream: open the run. Time labels 30m · 20m · 10m · now in `--ink-4`.
2. **Latest**: the 7 newest events across runs, one line each: icon (bug coloured by severity, message-question, alert-triangle, file-check, player-play) · text · run hue square · age. Click opens the finding or run. Header: "Latest" and a "Since you looked" link (catch-up dialog). With the findings tool, finding events (added, confirmed, ruled out) are the main content here.
3. **Four stats** (2×2): Spend today (value, "→ $X" projection, 24 hourly bars stacked by run hue, the rest of the day as dashed outlines) · Tool calls per minute (30 one-minute bars stacked by run) · Memory (used "of 15 GB", one bar split by run, amber tick at 90 %) · To triage (count, "N runs", a severity split bar; click = To triage filter).

Responsive: ≤1280 px stream + feed on one row, stats as a row of four below; ≤900 px everything stacks; phone: stats 2×2.

### Toolbar (sticky under the top bar)
`All 7 · Running 3 · Needs you 3 · To triage 4 · Finished 2` (segmented, counts in mono; Needs-you count amber) · right: Filter input (`/` focuses, Esc clears; matches name, repo, template) · Model select · Sort (Started, Activity, Cost, Name) · Tiles/List toggle. Filter, sort and layout persist (localStorage). Keys 1–5 switch filters.
- Running = live and not waiting on you. Needs you = asking, failed, stopped, recovering. To triage = has untriaged findings (also lists the open findings under the runs). Finished = done or triaged.
- Empty result: dashed box "Nothing matches. Clear filters".

### Tiles (grid, min 380 px columns, rows equal height, min 232 px)
- Header: hue chip · name (+ blue dot when findings changed since you looked) · status chip; on hover the status is replaced by Message, Pause, ⋯.
- Body (running): **agent lanes**: one row per agent (max 3): short title and the last 15 minutes of tool calls as ticks in the run hue (height = kind: shell tall, edit/subagent medium, read short; newest full opacity; waiting agents have a dashed baseline). Tooltip: title + current command.
- Body (problem): only the text and the action. Question: the question (3 lines max) + numbered answer buttons. Recovering: the cause ("OOM-killed while linking the MSan build") + a 3-step attempt meter, then the lanes. Failed: the error in mono + Retry / Edit.
- Finding line: severity dot + title of the top finding + "+N". Without findings: the latest lead/headline in `--ink-2` (from the findings tool: the most recent `lead`).
- Footer: todo segments (done grey, current white) · tok/s · cost.
- Floor: a full-width 40 px **wave** of the run's tok/s (last 2 minutes) in its hue, scaled to the run's own range; flat dashed line when not generating.
- Repo appears only as the tile's tooltip.

### Finished rows
hue chip · name · finding dots (hollow when triaged) · verdict word if triaged · age · runtime · cost · `Triage N` (primary) or `Open` (ghost).

### List view
Table in one `--s1` panel: checkbox · hue · name + repo (mono, small) · status · output wave (live only) · finding dots · model (without the "claude-" prefix) · tok/s · cost · runtime · hover actions. Problem rows tinted. Select with checkbox or `x`; a floating bar appears at the bottom: "N selected · Pause · Resume · Message · Stop · ×". Message opens one text box sent to every selected run.

## 4. Run view (opening a run docks it)

Layout: run list (264 px rail) + the run panel (`--s1`, radius 16). `[` hides the rail completely (a button next to the run name brings it back; never a strip of colour squares). `.` toggles **focus mode**: rail and side column hidden, text centred. Both persist. Esc closes the run. ↑/↓ or j/k move between runs in the rail.

### Rail
Filter box + hide button on top; "Live N" and "Finished N" groups of compact tiles: hue · name · status (or finding count) and one line under it (current command in mono, or the problem text).

### Header (two thin rows; must stay compact)
- Row 1: hue chip · name (double-click to rename) · status chip · **numbers**, right-aligned and split by thin rules: tok/s with a 56 px wave (just a grey "0 tok/s" when not generating) · total tokens · cache rate (same formula as the Stats page: cache read ÷ (input + cache read + cache write)) · cost + cost per hour · context ring + % · agent state dots + "2/4 agents" · then Pause, Stop (icon buttons), ⋯, ×. Lower-priority numbers drop out on narrower windows.
- A one-line notice under it only for recovering/failed/preparing (tinted, mono).
- Row 2: tabs as pills with icons: **Overview · Findings N · Report · Transcript · Files · Timeline · Terminal · Machine**; focus toggle at the far right.

### Body
Two columns that scroll independently: main (centred content, max 760 px) and side (300–380 px, slightly darker, left rule).

### Message box
One line pinned at the bottom (min 44 px). Quick messages ("What are you doing right now?", "Write up what you have so far", "Wrap up and write the report") appear above it only while it has focus; ⌘↵ hint likewise.

### Side column (all tabs that use it)
- **Agents**: tree (main, subagents indented on a thin rule): state dot · title · age; current command in mono; under each, its last 60 minutes of tool calls as a lane coloured by tool kind; a small 60m–now axis and the kind legend.
- **Todos**: "Todos 2/6", thin progress bar, round checks (done = filled grey with a check, current = half-filled green, no strike-through).
- **Run**: label/value list: Repo · Ref @commit · Template · Model (opens the model menu) · API key (opens the key menu, "failover") · Tokens in/out · Cost and per hour · Continues n of 3 · Machine · Started.
- Findings are **not** listed in the Overview side column any more (they have their own tab; Overview shows finding events in its story instead). See below.

### Tabs
- **Overview — NEW, to mock and confirm first.** It must not repeat the Findings tab or the side column. Proposal: "what is happening and how it went":
  1. *Now*: for each working agent, a live tail of its last few tool calls (tool · command · result status · duration), streaming in; idle/waiting agents collapse to one line.
  2. *Story*: the run's notable events in time order: started, finding added / confirmed / ruled out / removed (with the agent's note), crashes and OOM recoveries, automatic continues, key failovers, your messages and answers, report written. This replaces the PROGRESS.md "since you looked" diff: entries since your last visit are marked.
  3. *Charts*: over the run's whole life: tok/s and cost, context use with continue/restart marks, tool calls per kind.
  The question card (when the agent asks) sits at the top of Overview.
- **Findings**: the full list from the findings tool (see findings-tool.md): grouped by state (Confirmed, Suspected, Leads, Ruled out; removed ones hidden behind a toggle), each row severity · title · location · PoC · state · verdict; open a finding for its description, history of changes, links to the PoC file and the REPORT.md section; verdict buttons with keys (R real, N not a bug, D duplicate) and a note; verdicts never message the agent. New/changed since you looked are marked.
- **Report — NEW.** REPORT.md rendered, once the run is done (`report_ready`). Before that the tab is disabled with a tooltip ("Written when the run finishes"), not an empty page. Finding ids mentioned in the report link to the findings. The run-level triage verdict and notes (today's ReportTab form, saved to TRIAGE.md) move here, under the report.
- Transcript, Files, Terminal, Machine: redesigned 2026-10-15 (see design.md § dashboard for what each does). Timeline: as today, restyled with the new tokens.

## 5. Other pages

- **Findings page** (`/findings`, new): every finding across runs, grouped To triage / Triaged, sortable by severity and age, same row and detail as the run's Findings tab.
- Catch-up dialog ("Since you last looked"): per run, events since your last visit, with Answer / Triage / Retry / Open buttons, "Mark all seen".
- Command palette (⌘K): jump to run, actions.
- Activity, Models, Stats, Knowledge, Templates, Settings, System, New run: new chrome and tokens now; content as today.

## 6. Keyboard

`/` filter · 1–5 filters · arrows/j k move · Enter open · Esc close · m message · n new run · f findings page · x select (list) · `[` rail · `.` focus · R/N/D/W verdicts in a finding · ⌘K palette · ⌘↵ send.
