# Decisions & requirements log

## 2026-10-11

- **What Pixel is:** a way to run several mostly-unrelated, long-running autonomous agent sessions on a server, plus a shared message board so they can pass learnings if needed. Not one orchestrator splitting a single goal. The board is an experiment; the user isn't sure it'll help.
- **Today's workflow:** user runs opencode locally with a prompt that makes the agent act as an orchestrator spawning subagents; it works autonomously ~9 h and produces data.
- **Workload:** auditing open-source repos. About 50% of the work needs heavy tools (Ghidra, fuzzers, Docker builds to test hypotheses); 50% is plain source review.
- **Harness:** stay on opencode; extend via MCP / plugins / agents / `opencode serve` API rather than forking. Keep the runner harness-agnostic so swapping later is cheap. (Benchmarks: [benchmarks/opencode-2026-10-11.md](benchmarks/opencode-2026-10-11.md).)
- **Shared Ghidra/fuzzer instances:** rejected. Discussed a fuzz farm, Ghidra slots and a sandbox API.
- **Pixel itself runs inside Docker** (user requirement).
- **No extra tooling layer for agents** (user requirement): no sandbox API, no fuzz farm, no Ghidra slots. Each agent is one session that runs as long as it can, has its tools directly, and talks to the others through the board when it needs to. Supersedes the fuzz farm / Ghidra slot / sandbox API ideas above.
- **Each agent runs in its own Incus VM** (user asked; agreed). The VM gives it a real kernel and its own Docker daemon, so the agent uses Docker/Ghidra/AFL++ directly with no special tools. Incus `limits.cpu` / `limits.memory` replace the fuzz-farm and Ghidra-slot limits.
- **Claude's notes live in `ai/`** (user request).
- **Manual mode first** (user): the user writes the prompt and starts each agent from the dashboard. No automatic goals.
- **Current agent workflow** (user): clone the target, start opencode with an audit prompt that gives the agent a "workbase" folder to keep notes, learnings, scripts and tests in. At the end the agent reports its findings and the user triages manually. **Triage stays manual.** The prompt doesn't need to stay word for word.
- **Workbases live on the host, not in the VM** (user): knowledge survives the VM, and every agent can read every other agent's workbase.
- **No instruction about sharing** (user): nothing in the prompt mentions other agents' work; it should happen naturally or not at all. This replaces the explicit message board (`board_post` etc.) and the journal/goal-file design above. Pixel lays out the folders so others' work is discoverable (`/workbases/` + `INDEX.md`) and measures cross-reads.
- **Web dashboard is the main control surface** (user wants it very detailed and full-featured).
- **Storage**: plain files for workbases; SQLite for Pixel's own state, events and search index; git snapshots for workbase history. Proposed, see design.md.
- **Correction (user):** agents *should* be told other workbases exist and may be looked at if useful, with no push to focus on them. This replaces "no instruction about sharing" above. One short paragraph in the prompt's environment section (see design.md); cross-reads are still measured.
- **Image renamed** (user): the VM image is `pixel-image` (was `pixel-auditor`).
- **Stack: TypeScript on Bun** (user confirmed). SQLite for storage.
- **Plan approved** (user, 2026-10-11): ai/plan.md is the plan of record.
- **Server** (user): Proxmox with KVM, 32 GB RAM, Pixel may use 16 GB. Chosen: one Proxmox VM (16 GB, nested virt) holding Docker (Pixel) + Incus (agent VMs).
- **Report**: free form, `REPORT.md` in the workbase.
- **Internet**: agents get full internet access; tokens are read-only, never write-capable.
- **Permissions** (user): opencode sessions have every permission and never ask for approval.
- **Recovery** (user): session stops without a report → send "continue your work", up to 3 times, then stop and notify. opencode OOM-killed → restart opencode and continue with "continue your work, the oom killer killed you that was the reason for your stop" (Claude's default: own limit of 3, then stop). VM disk full → stop the run.
- **Improvements accepted** (user): TRIAGE.md written back from dashboard triage notes; `.pixel/run.json` per workbase; re-audit and compare runs; full manual control in the dashboard, features added as needed; restic backups; pinned opencode version. VM disks 20 GB.
- **Improvements declined** (user): per-run time/cost limits (user always monitors); shared download caches (not now).

## 2026-10-11 (build session)

- **opencode version** (user): target the latest opencode, currently **1.19.0**. Its HTTP API and event types are identical to 1.18.23 (diffed `/doc`); only the `autoupdate` config description changed. The image pins it via `OPENCODE_VERSION`.
- **Dashboard styling** (user): use **Tailwind** (v4, through `bun-plugin-tailwind`) rather than hand-written CSS.
- **Code maintainability** (user): keep modules small and focused; backend split into `server/src/runs/` (lifecycle, events, watchdog, controls) and `server/src/api/` (one file per area), web split into `pages/`, `components/`, `lib/`.
- **Agent questions** (Claude's default): if an agent uses opencode's question tool, Pixel notifies you and shows it in the dashboard; on autopilot runs an unanswered question is dismissed after `questionTimeoutMin` (30) so 9-hour runs don't block.

## 2026-10-11 (Coolify)

- **Hosting constraint** (user): the user may only have a Coolify dashboard, with no access to the server itself. So no Incus, no KVM and no Sysbox there. Claude's advice was to run the VM design on the user's own machine or a rented KVM box; if it has to be Coolify, everything in one container.
- **`single` runtime added** (user: "make everything in one container, as another option"). Incus stays the plan of record; `single` is an alternative for hosts that only run plain containers. Each agent is its own Linux user; Pixel enforces memory/disk/process limits itself and firewalls agents off private networks. Details in design.md.
- **Neighbours on a shared server** (Claude, flagged to the user): untrusted code on someone else's server needs the owner's agreement. Protections for other apps there: container CPU/memory caps, per-agent limits, free-disk guard on the data disk, private-network firewall, mandatory dashboard password.
- **Workload for `single`** (user): mostly code review; agents test hypotheses on native builds with what's installed, no Docker. Fuzzing and Ghidra only for rare cases, so Ghidra and CodeQL are off by default in `Dockerfile.single` (build args turn them on). Sizing: about 3 GiB per agent; 8 GB / 4 CPUs for about 3 agents.
- **Prompt's machine line is per runtime**: new template variable `{{machine}}` (`Runtime.describeMachine`) replaces the hard-coded "root on a disposable VM" line in `templates/audit.md`.
- **Git** (user): work directly on `main`, no branches.

## 2026-10-11 (subagents)

- **Interrupted subagents** (user): stopping an agent with parallel subagents loses their work on continue; the agent respawns them. Cause (opencode 1.18.23, read from the binary): an aborted task call becomes `error: "Tool execution aborted"` with the child id only in `state.metadata.sessionId` (+ `interrupted: true`); after a crash it stays `running` and the model sees `"[Tool execution was interrupted]"`. The child session itself is intact and the task tool can resume it via `task_id`. Fix chosen (user): an **opencode plugin**, `opencode-plugins/resume-subagents.ts`, using `experimental.chat.messages.transform` to put the task_id and a resume hint into the model's copy of the history. Installed for every runtime (copied into the agent's opencode config; baked into pixel-image). Also usable in the user's own opencode.

## 2026-10-11 (dashboard redesign)

- **Look** (user): rejected the first three style mockups (mission control / glass HUD / phosphor) as "AI slop"; approved a tool-like base (sidebar, dense runs table, side panel, neutral greys, Geist + Geist Mono) with a light Watch Dogs / ctOS flavour (cyan accent, monospace micro-labels, corner brackets, profiler readout, decrypt-in run name, prompt-style ⌘K).
- **Flash goes into data, not interaction** (user): no hover glitches or scan lines. Instead: stacked tokens/s spectrum per run, memory split by run, spend line with projection, 30-minute activity barcode per run, per-agent swimlanes, context gauge, sidebar mesh of runs/subagents/workbase reads.
- **Tokens/s** (user asked for total tokens per second): sampled every second from run token totals; shown as a 10-second average because opencode reports tokens in bursts at step end.
- **Features this round** (user): live fleet view, ⌘K command palette, Activity feed, subagent tree. No spend cap shown (cost limits were declined earlier).

## 2026-10-11 (models and providers)

- **Provider benchmarking** (user picked from Claude's list): (1) Models leaderboard across runs, (2) live provider health, (4) quick speed test. Deferred: (3) benchmark suites with known bugs, (5) per-finding triage.
- **Speed test is text-only** (Claude, agreed by the user): a throwaway `opencode serve` with every permission denied and every tool switched off per request, so the model can only answer in text; no tool-call reliability check.
- **Built so far**: capture + health + leaderboard API, Models page with health and leaderboard. The speed test API exists but has no UI; the user asked to leave it for the next session.

## 2026-10-11 (speed test)

- **Speed test refuses tools by permission instead of switching them off** (Claude; the user confirmed opencode Go has the same "must look like opencode" request checks). opencode's gateways reject requests whose tool set differs from opencode's (403 FreeTierError), so "every permission denied, every tool off" broke free and Go models. Now: all tools in the request, `permission: "ask"`, Pixel rejects every request while the call runs, and a model that tries a tool is marked failed. Still text only in practice, with an empty work folder.
- **Speed test UI** on the Models page: pick models (chips from Settings models, leaderboard, health and earlier successful tests, plus free entry), live per-model progress, latest batch as bars, earlier results below. One sample per model.


## 2026-10-11 (providers in the GUI)

- **Providers are added from the Models page** (user: "easier way to add providers right in the gui"). An "Add provider" dialog searches opencode's own catalogue (models.dev, 226 providers) and takes a key, or adds a **custom endpoint** with an **API type of OpenAI-compatible or Anthropic-compatible** (user: "open ai, anthropic endpoint nothing too crazy"), a base URL, an optional key and model ids (fetchable from `{baseURL}/models`).
- **Models page reorganised** (user: "make it better"): stat row (providers, models offered, calls last hour, problems now), then tabs Providers & models / Health / Leaderboard / Speed test. Each provider expands into a model picker: tick models for the new-run form, star the default, one-click test (a one-model speed test).
- **Settings no longer edits models/default model**; it links to the Models page and its Save leaves `models`, `defaultModel` and `providerLimits` alone. Settings env vars and auth.json still work and show up as providers ("env", "auth.json").
- **Live test** (user: "an interactive like live test … must have good ui"): the model picker's Test button (and a Live test button in the page header) opens a drawer to chat with any model and watch the answer stream in, with first-token time, live tok/s plus sparkline, output tokens, elapsed and cost. Starter prompts include a C bug-spotting one that fits the auditing work. Replaces the one-shot inline check; the Speed test tab stays for side-by-side batches.
- **Prompt cache key for Coral Bricks** (user: "add the caches to coral bricks"). opencode's `setCacheKey` option for OpenAI-compatible providers sends `promptCacheKey` (camelCase), which OpenAI-style servers ignore (checked with a fake endpoint on 1.18.23). Instead, plugin `opencode-plugins/prompt-cache-key.ts` adds `prompt_cache_key` = session id for providers in `PIXEL_CACHE_KEY_PROVIDERS`, which Pixel sets from accounts with `cacheKey` (on by default for `coralbricks`). The speed and live tests' opencode now loads the same plugins as agents. Incus VMs need an image rebuild to get the plugin. Whether Coral Bricks uses the key is unverified (their docs page didn't load).
- **GitHub for agents** (user: "I will add my read only token give the opencode the mcp and stuff"). Settings → GitHub card: token stored under `_github` (never sent to the browser), "Check token" (login, rate limit, warns on classic write scopes). Agents get `GITHUB_TOKEN`/`GH_TOKEN`, the `gh` CLI (added to both images), and GitHub's remote MCP server at `/mcp/readonly` with `X-MCP-Readonly: true`, `X-MCP-Toolsets` (default repos,issues,pull_requests,security_advisories, editable) and `oauth: false` (so a bad token fails as a 401 instead of an OAuth attempt; checked on opencode 1.18.23). MCP is on by default once a token is saved; the speed/live tests strip it. Not yet tried with a real token.
- **Coolify** (user, understood): no Incus or Docker for agents there; single runtime only.
- **Thinking levels** (user: "I want to modify the thinking level … for other providers too … custom thinking"). Runs store `variant` (opencode model variant; null = model default), sent with every prompt (`prompt_async` body `variant`, checked in opencode's /doc). Picked in the new-run form, changed mid-run from the run's controls (applies from the next message), and in the live test. Levels come from opencode's `/config/providers` `variants` via the warm live-test opencode (`GET /api/models/variants`). Custom levels: Settings `thinkingLevels` {"provider/model": {name: provider options}}, merged into OPENCODE_CONFIG_CONTENT as model variants (checked: they appear next to built-in ones). Custom endpoints get a "Models can think" switch (`reasoning: true`).
- **Coral Bricks** (from their docs.md): OpenAI- and Anthropic-compatible at https://inference.coralbricks.ai/v1; 1M context on every model; caching automatic and cached input free; accepts `prompt_cache_key` and `promptCacheKey`; `reasoning_effort` none|low|high|max (medium→high). DeepSeek V4.1 Flash defaults to no reasoning, GLM 5.3 always reasons (default max). Pixel adds `none` and `max` levels to offered Coral models.
- **Model picker** (user: "make it easier for me to choose the model"): searchable, grouped by provider, with context/price/default star; replaces the text box in the new-run form, the prompt() in run controls and the select in the live test.
- **opencode version**: npm latest is 1.19.0 (what Pixel pins), no 2.x published; Coral's docs mention "OpenCode 2", presumably unreleased.
- **2026-10-12 New keys reach existing runs** (user: "The api key ran out so I changed it … I still doesn't start when I click resume"). Keys were only injected at prepare, and resume kept the used-up continue counter, so a run stopped after its last continue stopped again the moment it idled. Now every opencode restart Pixel does (resume/message of a stopped run, manual restart, recovery, reattach) pushes the current `agentCredentials()` first; runs store `creds_hash`, and resume/message restarts an idle agent's opencode when it's stale (a busy one is left alone). Resume resets `continues` to 0.
