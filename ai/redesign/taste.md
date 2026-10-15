# The user's taste, from fourteen rounds of mockups

Quotes are the user's words (typos kept out). Dates 2026-10-13 to 2026-10-15.

## What they want

- **The Wall**: a tile per live run is home. Finished runs below as plain rows.
- **Dark by default.** The round-5 "C Wall" dark palette is the reference: near-black neutral surfaces, **soft per-run colours** (teal, blue, violet, pink, lime, peach), green for running, amber for needs-you or recovering, red for failed or high severity.
- **Real, "cool" charts** on top ("I want the cool graphs"), but **not big for the sake of it**: round 11's full-width stream was "too big … could also have other stuff here". The compact row in round 12+ (stream + Latest feed + four stats) is what they liked.
- **No text stating the obvious.** "it still looks slightly sloppy with all the unwanted text (text stating the obvious)". Say each thing once. Running shows only a green dot and its age; words only for problems ("Waiting 12m", "Recovering 2/3", "Failed"). No labels like "Asked 12 min ago" next to "Waiting 12m", no "Recovering automatically", no "No PROGRESS.md yet", no "Report ready", no "to triage".
- **Control**: filter running / needs you / to triage / finished, text filter, sort, tiles or list, bulk actions. "I feel like we are missing control like filtering the running stuff, triage stuff and other such stuff."
- **Room to read.** The run view must give the main text the space: "there is very little space in the middle where the text I want to read exists". On wide screens the reading column is centred, never pinned left with a hole beside it.
- **Numbers that matter stay visible**: token count and cache rate in the run header ("I still do want the token count and cache rate at the top too").
- "A tiny bit of ctOS / Watch Dogs" feel, **through restraint**: mono for numbers and code, crisp 1 px lines, tabular figures. Not through effects.
- Tabler icons (tabler.io/icons), outline.
- They like being shown a mockup in the browser and reacting to it. Open the page for them (`xdg-open file://…`).

## What they rejected (don't bring these back)

- Neon/cyan glow, scanlines, corner brackets, clipped buttons, KPI tiles in a row: "flashy slop", "ctOS is not just all blue stuff" (round 1).
- Prose-heavy layouts that explain things; a reinvented "Needs you" inbox as the main screen (round 2).
- **Coloured top borders or accent bars on rounded cards**: "a tell tale sign of slop" (round 6).
- Unicode glyph art (├─ trees, █░ meters, braille spinners): use real icons (round 7).
- Too many colours and too much animation; pulses, glows, decrypt effects (round 7). But also **not monochrome** (rounds 8–9): "I want the cool graphs".
- "just orange and blue stuff everywhere" (round 8).
- A greyscale "fleet tape" without real charts (round 9).
- **Meaningless visual shorthand**: the collapsed run list as bare colour squares, "the heck is this?" (round 13). If something is compressed, it must still say something.
- A narrow text column pinned to the left on a wide window: "does not look good at all" (round 13).
- Overview that shows the same information as the Findings tab and the side column (after round 14).
- A top-bar redesign of the real app that wasn't asked for was reverted (2026-10-14, `git stash list`: "rejected UI redesign (2026-10-14)"). Don't restyle on your own initiative beyond this spec.

## How to present work

- One mockup or change at a time; open it in their browser; ask what's off. They answer briefly and visually (screenshots).
- Keep the reply short: what changed, in their terms.
