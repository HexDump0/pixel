# UI redesign: handoff

Written 2026-10-15 at the end of the mockup session (rounds 5–14). The next session's job is to **build the redesign into the real app** (`web/src`, plus the server pieces it needs) and the **findings tool** that replaces PROGRESS.md.

## Read in this order

1. **This file**: goal, status, what is decided.
2. [taste.md](taste.md): what the user likes and has rejected, in their words. Read it before touching any pixel.
3. [spec.md](spec.md): the target design: system, every screen, behaviour, text rules.
4. [findings-tool.md](findings-tool.md): findings as folders in the workbase (replace PROGRESS.md).
5. [data-map.md](data-map.md): each mockup element → where its data comes from today, what's missing, and a build order.
6. Open the reference mockup: `ai/mockups/r14/index.html` (plain HTML, fake data, works from `file://`). Hashes: `#libpng-2026-10-14` (a run), `#tinyxml2-2026-10-13` (run asking a question), `#list` (list view), `#filter-triage`.

Background if needed: `ai/decisions.md` (dated log, rounds 5–14 at the end), `ai/design.md` (technical notes).

## Status (2026-10-15, end of the build session)

Built and committed: findings (first as a plugin, then as workbase folders; server + UI), the Wall, the docked run view (Overview as Now/Story/Charts, Findings, Report), Findings page, catch-up, palette, new chrome on every page. Left: the user's reaction to the Overview and to the whole thing on real data; a proper redesign of the older pages (Activity, Models, Stats, Knowledge, Templates, Settings, System, New run), which still use parts of the old index.css; the user's own templates still ask for PROGRESS.md (move them to the `{{> environment}}`/`{{> findings}}`/`{{> report}}` sections, showing the user the diff first).

## Status at handoff

- The **look and the Wall/run-view layout are agreed**: the user said "okay okay I'm start to like it" about round 14 after "def better" on round 12. Not everything is final; expect another round of feedback once it runs on real data.
- **Two changes asked for after round 14, not in any mockup yet:**
  1. **Overview tab must not repeat** the Findings tab and the side column. It needs its own content. A proposal is in spec.md § Run view → Overview. **Mock it first and show the user** before building it.
  2. **Report tab**: a tab that shows the agent's final REPORT.md once the run is done.
- **Findings tool replaces PROGRESS.md** (user picked it, 2026-10-15). One list of findings per run with states lead → suspected → confirmed, or ruled out. Now kept as one folder per finding in the workbase (findings-tool.md).
- **Questions from the agent are rare** (user: "the agent doesn't really ask questions to me"). Keep the support (the question card, answering on the tile), but don't design around it: "Needs you" is mostly failures, stops and runs idle without a report.

## Ground rules for the build

- Work on `main` and commit there (see the user's git workflow memory). Coolify deploys from GitHub; push before saying "redeploy".
- The laptop has tight disk and RAM: no full image builds and no big memory tests locally. Use the fake opencode (`server/test/fake-opencode.ts`) and a scratch `PIXEL_DATA` with seeded runs to look at the UI. Screenshots work with headless `chromium --headless=new --screenshot` (add `--force-prefers-reduced-motion` so charts aren't caught mid-animation).
- Rebuild the UI in the **existing stack**: React 19, Tailwind 4 (via `bun-plugin-tailwind`), tokens in `web/src/index.css`, the small router in `web/src/lib/router.tsx`, live updates from `web/src/lib/live.ts` and `lib/fleet.ts`. Port the mockup's design, not its code: the mockup is vanilla JS over fake data.
- Icons: Tabler outline 3.19.0, inlined as SVG paths (the mockup's `icons.js` has every one used). The app's current `web/src/components/icons.tsx` is a different set; replace it.
- Fonts: Geist and Geist Mono (the mockup loads them from Google Fonts; in the app, self-host or keep the link, but they must not fall back to system fonts silently).
- Dark is the default. Light mode exists as a toggle; it doesn't need to be pretty yet, but it must not break.
- Keep every existing feature reachable. The mockup moves things (12 control buttons → Pause, Stop, ⋯; model and key become clickable values), it doesn't delete them. Pages the mockup doesn't cover (Activity, Models, Stats, Knowledge, Templates, Settings, System, New run) get the new chrome and tokens now and a proper redesign later.
- Update `ai/decisions.md` and `ai/design.md` as you go (dated entries; don't rewrite history).
