# Findings tool (replaces PROGRESS.md)

Decided 2026-10-15. The user picked option 1 of three ("a report finding tool for the agent"), asked that the agent can also **check, remove and modify** findings, and that this **replaces PROGRESS.md** entirely. The states cover what PROGRESS.md's "Promising / Found / Ruled out" sections held. "Trying now" comes from the live agent activity Pixel already shows.

## Why a tool

Findings show up the moment the agent has them, as structured items (severity, location, PoC), so the UI can count, filter, mark and triage them one by one. Nothing is parsed from prose, so nothing is guessed. REPORT.md stays the long write-up at the end and refers to findings by id.

## Constraint that shapes the design

Agents **cannot reach Pixel's HTTP API**: in the single runtime the agent uids are firewalled from private ranges and from the dashboard port on loopback; on Incus they run in VMs. So the tool doesn't call Pixel. It writes to the run's **workbase** (which Pixel can read in every runtime), and Pixel picks up changes from the file and from the opencode event stream it already consumes (tool parts are stored in the `parts` table by `runs/events.ts`).

## Model

One list per run, stored by the plugin in `{{workbase}}/FINDINGS.json` (source of truth), with `{{workbase}}/FINDINGS.md` regenerated after every change (for peer agents browsing `/workbases`, and for humans in the Files tab).

```jsonc
{
  "version": 1,
  "next": 4,                       // next id number
  "findings": [{
    "id": "F3",                    // stable, never reused
    "title": "Heap overflow in iCCP decompression",       // ≤ 120 chars
    "state": "confirmed",          // lead | suspected | confirmed | ruled_out
    "severity": "high",            // critical | high | medium | low | info; optional for leads
    "class": "heap-buffer-overflow",                       // optional, free text
    "location": "pngrutil.c:1184", // optional, file:line or function
    "poc": "poc/iccp-0041.png",    // optional, path relative to the workbase
    "summary": "ASan heap-buffer-overflow, 1-byte read past the profile buffer when …", // ≤ 1500 chars
    "created": "2026-10-15T06:01:12Z", "updated": "…",
    "by": "ses_…", "agent": "Fuzz the iCCP chunk handler",  // session id and agent title of the last writer
    "removed": null,               // or { "at": "…", "reason": "duplicate", "duplicate_of": "F2" }
    "history": [{ "at": "…", "by": "ses_…", "action": "add|update|remove", "changes": { "state": ["suspected", "confirmed"] }, "note": "reproduced with ASan build" }]
  }]
}
```

States:
- **lead**: an idea worth checking ("png_inflate trusts the declared profile length"). Severity optional.
- **suspected**: looks like a real bug, not reproduced yet.
- **confirmed**: reproduced. The tool warns (doesn't refuse) when confirming without a `poc`.
- **ruled_out**: checked and not a bug. A note saying why is required.
- **removed** (`removed` set): a mistake or a duplicate. Soft delete with a reason; hidden by default, kept for history.

## Tools (opencode plugin `opencode-plugins/findings.ts`)

Four tools, short text results (not JSON dumps):

| Tool | Args | Does |
|---|---|---|
| `finding_add` | `title`, `summary`, `state` (default `lead`), `severity?`, `class?`, `location?`, `poc?` | Adds, returns the id and a one-line confirmation |
| `finding_update` | `id`, any of the fields above, `note` (required when `state` changes) | Updates, records the change in `history` |
| `finding_remove` | `id`, `reason`, `duplicate_of?` | Soft-deletes |
| `finding_list` | `state?`, `include_removed?` | One line per finding (`F3 confirmed high  Heap overflow in iCCP · pngrutil.c:1184 · poc/iccp-0041.png`), plus the **human's verdicts and notes** from triage |

Implementation notes:
- Plugin shape (opencode docs, plugins page): `export const Findings: Plugin = async (ctx) => ({ tool: { finding_add: tool({ description, args: { title: tool.schema.string().describe("…"), … }, async execute(args, context) { … } }), … } })`. `context` has `sessionID`, `agent`, `directory`, `worktree`. Export only the plugin (opencode calls every exported function in a plugin file, see design.md § Subagents).
- **Verify first** against the pinned opencode (1.19.0; the laptop has opencode 1.18.32 at `~/.opencode/bin/opencode` for a quick local check, e.g. `OPENCODE_BIN=~/.opencode/bin/opencode PIXEL_RUNTIME=local bun server/src/index.ts` with the free `opencode/big-pickle` model): (a) whether a plugin in `~/.config/opencode/plugin/` can `import { tool } from "@opencode-ai/plugin"` without installing it (the docs suggest a `package.json` in the config dir that opencode `bun install`s at startup, which is slow and needs network for every run). If not, vendor `@opencode-ai/plugin` (and zod) into the image once, next to the plugin dir, and point the runtimes at it (`runtime/process.ts` copies plugins at line ~120; `image/provision.sh` for Incus). (b) That tool names from the plugin's `tool` map are used as-is. (c) That subagents (task child sessions) can call the tools too (same opencode process, so the same plugin instance).
- **Workbase path**: the tool needs it, and opencode's working directory is the target, not the workbase. Pass `PIXEL_WORKBASE` in the opencode environment (process runtimes build the env in `runtime/process.ts`; Incus needs it in the unit environment or a small file the plugin reads).
- **Concurrency**: main agent and subagents share one opencode process, so serialise writes with an in-process promise queue, and write atomically (temp file + rename). Re-read the file before each write (a human may have edited it in the Files tab; Pixel itself never writes FINDINGS.json).
- Validate: enums, lengths, `id` exists, `poc` exists under the workbase (warn if not), `duplicate_of` exists.
- Unit test like `server/test/plugin.test.ts`: call `execute` with a temp workbase.

## Pixel server (`server/src/findings.ts`)

- **Sync**: like `progress.ts` (poll every 5 s for active runs and runs finished in the last 10 min, one `stat`, read only on mtime/size change), plus an **immediate re-read** when `runs/events.ts` sees a completed tool part whose tool name starts with `finding_`. Validate and upsert into:
  - `findings` (run_id, id, state, severity, title, class, location, poc, summary, created, updated, removed_at, removed_reason, duplicate_of, data JSON, **verdict, verdict_note, verdict_at**). Verdict columns are Pixel's; file syncs never touch them.
  - `finding_events` (run_id, finding_id, at, action, changes JSON, note, by), deduped on (run, id, at, action). Each new event adds a **timeline** entry (`agent`/`finding`) and publishes `finding` on the run's live feed and on `*` (for the Latest feed and the stream marks).
- **API**: `GET /runs/:id/findings`, `GET /findings?untriaged=1&severity=&run=` (Findings page, To triage counts), `GET /runs/:id/findings/events`, `POST /runs/:id/findings/:fid/verdict {verdict, note}` with verdict ∈ real | not a bug | duplicate | needs work.
- **Verdicts back to the agent**: on every verdict Pixel writes `{{workbase}}/.pixel/triage.json` (id → verdict, note, at; `finding_list` merges it) and regenerates the findings section of `TRIAGE.md` (which peer agents already read). **Needs work** also sends a message to the run if it's live ("Triage on F3 “…”: needs more work. <note>") through the existing message path.
- **Done** still means REPORT.md written + idle (`runs/lifecycle.ts`); findings don't change the lifecycle.
- **Leaderboard/stats**: the real-findings rate can move from the run verdict to per-finding verdicts (real ÷ triaged). Keep the run verdict for old runs.
- Fake opencode (`server/test/fake-opencode.ts`): add a scripted command (e.g. `FINDING add …`) that writes FINDINGS.json and emits a matching tool part, so lifecycle tests and the local UI have findings.

## Template text (seeded `templates/audit.md`; the user's own templates need the same edit)

Replace any PROGRESS.md instructions with something like:

> Record findings with the finding tools as you go, not at the end. `finding_add` as soon as you have a lead worth checking (state `lead`) or a suspected bug (`suspected`). `finding_update` when you confirm one (give the PoC path) or rule it out (say why). `finding_remove` only for mistakes or duplicates. `finding_list` shows the current list with the human's triage verdicts and notes: check it when you start, after a restart, and before you write the report. The list is what the human watches while you work; REPORT.md at the end is the full write-up and refers to findings by id (F3).

The user's templates live in the DB (`templates`, `template_versions`) and on the Templates page; tell the user which text to change rather than editing their templates silently.

## What happens to PROGRESS.md

- New runs don't ask for it (template change). The run view's PROGRESS.md section, the "lines changed since you looked" diff, the unseen-progress dots and the "not updated in an hour" hint go away; their jobs move to findings (new/changed since you looked, per browser, keyed by the last seen finding event).
- `progress.ts`, the `progress` table and `/runs/:id/progress*` stay read-only for older runs until nothing uses them; the file is still visible in the Files tab.
- Update `ai/design.md` § PROGRESS.md when this lands.

## UI (see spec.md)

- Findings tab: grouped by state, verdict buttons with keys, detail with history and links (PoC file in the Files tab, the REPORT.md section).
- Tile finding line, finished-row dots, nav count, To triage filter and stat, Latest feed, stream marks, Findings page: all read the `findings` table / live `finding` events.
