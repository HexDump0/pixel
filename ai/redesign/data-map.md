# Mockup → real data, and a build order

✓ = exists today (endpoint / table / live event), **new** = must be built. Paths are in `server/src` and `web/src`.

## The Wall

| Element | Source | |
|---|---|---|
| Stream: tok/s per run, last 30 min | `fleet.ts` keeps only 90 × 1 s samples (`FleetRun.tps`). | **new**: keep a 30-min series per run (e.g. 180 × 10 s buckets in the same sampler) and send it in `/api/fleet`; live via `fleet.tick` |
| Stream marks (finding, question, crash) | findings events (**new**), `questions` table ✓, timeline `recover`/`limit` ✓ | |
| Latest feed | timeline (live on `*`) ✓, questions ✓, finding events **new** | **new** `GET /api/feed?limit=` merging them |
| Spend today + projection, by run per hour | `/api/fleet` → spend (cost per hour per run, top four + other, projection) ✓ | |
| Tool calls per minute by run | `FleetRun.activity` (60 × 30 s buckets, dominant kind, alert) ✓ | aggregate to minutes client-side |
| Memory by run, 90 % line | `FleetRun.mem`, shared memory in the snapshot ✓ | |
| To triage count + severity split | **new** `findings` table | |
| Toolbar counts and filters | `lib/runs.ts` runs list ✓, `questions` count per run ✓ (`GET /runs` adds it), findings **new** | |
| Tile agent lanes (15 min ticks per agent) | `GET /runs/:id/lanes?minutes=` ✓ per run | add compact per-agent ticks to `/api/fleet` (or a batch lanes call) instead of one request per tile |
| Tile wave (tok/s) | `FleetRun.tps` ✓ | |
| Tile todos | `todos` table ✓ (via run detail) | include todo states in the runs list or fleet so tiles don't need the detail |
| Tile top finding / latest lead | **new** findings | |
| Recovering 2/3 | runs `oom_restarts` / `continues` ✓ | |
| Finished rows, verdict | runs ✓ (`triage_verdict`), finding dots **new** | |
| List view + bulk | runs + fleet ✓; bulk = loop over `POST /runs/:id/pause|resume|stop|message` ✓ | |
| Since you looked | per browser `localStorage["pixel.progressSeen"]` today | **new**: last seen finding event per run, plus timeline |

## Run view

| Element | Source | |
|---|---|---|
| Header tokens, cache rate, cost, cost/h | runs `tokens_in/out/reasoning/cache`, `cost` ✓ (totals over root + subagent sessions) | `tokens_cache` merges cache read and write (design.md § Stats page), so compute the cache rate from the stored assistant messages like `stats.ts` does: cache read ÷ (input + cache read + cache write) |
| Context ring | `FleetRun.context` ✓ | |
| Agent dots, agent tree, current command | `FleetRun.agents`, `now` ✓ | |
| Agent lanes 60 min, by kind | `GET /runs/:id/lanes?minutes=60` ✓ | |
| Todos | ✓ | |
| Run facts (repo, ref, template, model, key, machine, continues) | run detail ✓, `/runs/:id/keys` ✓ | |
| Message box, quick messages | `POST /runs/:id/message` ✓ | |
| Question card | `questions` ✓, `POST /runs/:id/question/:qid` ✓ | |
| Overview → Now (live tail) | `GET /api/activity?run=&limit=` ✓, live `activity` events ✓ | |
| Overview → Story | timeline ✓ + finding events **new** | |
| Overview → Charts over the run's life | `llm_calls` per run (tokens, cost, times) ✓, `metrics` ✓, context from assistant messages ✓ | **new** `GET /runs/:id/series` |
| Findings tab | **new** (findings-tool.md) | |
| Report tab | `GET /runs/:id/report` ✓, `report_ready` ✓, `POST /runs/:id/triage` ✓ | |
| Transcript / Files / Timeline / Terminal / Machine | existing tabs ✓ | restyle |

## Today's web structure (to replace or reuse)

- `components/Layout.tsx`: left sidebar nav + Mesh → replace with the top bar.
- `pages/Runs.tsx` (table + `RunPanel.tsx` side panel) and `pages/run/RunPage.tsx` (full page with tabs) → one Wall page and one docked run view at `/runs/:id`.
- `components/viz.tsx` (TokenFlow, SpendBars, MemorySplit, LanesChart, Barcode, MiniMeters): reuse the data plumbing, redraw to the spec (the mockup's `hero.js` has the canvas code for the stream and the small charts).
- `components/ProgressNotes.tsx`, `lib/progress.ts`: go away with PROGRESS.md (keep for old runs only if cheap).
- `pages/run/OverviewTab.tsx`: TodoList and QuestionCard are reusable; the rest is replaced.
- `pages/run/ReportTab.tsx`: becomes the Report tab (report + run triage form).
- `index.css` (2284 lines, Tailwind zinc remapped to tokens, light by default): replace the tokens with spec.md § 1, dark by default.

## Suggested order

1. **Run the app locally** with the fake opencode and a scratch `PIXEL_DATA` holding a few seeded runs (live, asking, recovering, failed, done), so every state can be screenshotted.
2. **Findings backend**: plugin (verify the import question first), `findings.ts` sync, tables, API, verdict write-back, fake-opencode support, tests. Independent of the UI; unblocks most of the new data.
3. **Foundation**: tokens, Geist, Tabler icons, top bar replacing the sidebar, status chip, buttons, segmented controls.
4. **Run view**: dock + rail, compact header, tabs (Findings, Report), side column, message box, focus and rail toggles. **Overview**: build a quick mockup of the proposal in spec.md first (in `ai/mockups/r15/`, reusing r14), show the user, then build it.
5. **Wall**: server 30-min tps series and `/api/feed`; fleet row, toolbar and filters, tiles, finished rows, list view and bulk actions.
6. Findings page, catch-up dialog, palette; new chrome on the remaining pages.
7. Retire PROGRESS.md UI; update `templates/audit.md`; tell the user what to change in their own templates.

Check each step on screen (screenshots) against the mockup before moving on, and show the user at natural milestones (after 4 and after 5).
