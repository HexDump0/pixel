# Pixel

Runs several long-lived [opencode](https://opencode.ai) audit agents at once, each in its own throwaway Incus VM, each auditing one open-source repository. You start runs from a web dashboard; Pixel keeps them going (continues, OOM and crash recovery), records everything, and keeps every agent's notes in a shared, read-only **workbase** folder that the other agents can learn from.

The design and the reasoning behind it live in [ai/plan.md](ai/plan.md).

Three runtimes decide what an agent's "machine" is (`PIXEL_RUNTIME`):

| Runtime | Machine | Isolation | For |
|---|---|---|---|
| `incus` | One VM per agent: root, own Docker, snapshots | Strong | A host you control with KVM (the plan of record) |
| `single` | One Linux user per agent, all in Pixel's container | Medium | Hosts that only run plain containers, e.g. Coolify |
| `local` | A process running as you | None | Trying Pixel out on a laptop |

```
Proxmox VM "pixel host" (16 GB, nested virt)
├── docker: pixel            dashboard + API + run manager (this repo)
├── /srv/pixel/              SQLite, workbases, history, transcripts
└── Incus VMs, one per run   from pixel-image; opencode serve on :4096
```

## Quick start (laptop, no VMs)

The `local` runtime runs opencode as a plain process: no isolation, for trying Pixel out with harmless prompts.

```sh
bun install
bun run dev                 # http://127.0.0.1:7700, data in ./.data
bun test                    # unit + lifecycle tests against a fake opencode
```

## Production setup (pixel host)

1. **Proxmox VM**: Ubuntu 24.04, 16 GB RAM, CPU type `host`, nested virtualization on the node (`kvm_intel nested=1` / `kvm_amd nested=1`), enough disk for ~20 GB per agent VM.
2. **Docker** and **Incus** on that VM. Docker breaks Incus bridge networking unless you add `"ip-forward-no-drop": true` to `/etc/docker/daemon.json`. Run `incus admin init` (a ZFS or btrfs pool is best; cap the ZFS ARC with `zfs_arc_max`).
3. **Data dir**: `sudo mkdir -p /srv/pixel`.
4. **Agent image**: `image/build.sh` (builds `pixel-image` with opencode `1.19.0`, Docker, clang/gcc + sanitizers, AFL++, gdb/rr, valgrind, semgrep, CodeQL, Ghidra headless + pyghidra-mcp). Override versions with `OPENCODE_VERSION=… image/build.sh`.
5. **Pixel**: `cp .env.example .env`, set `PIXEL_PASSWORD` and `PIXEL_HOST` (a private address such as the Tailscale IP; never `0.0.0.0`, the agent VMs share the host network), then `docker compose up -d --build`.
6. In the dashboard: **Settings** → models, provider keys (agent environment) or an opencode `auth.json`, notifications (ntfy / Telegram), restic backups.

To use `opencode attach` from your own machine, the agent VMs' addresses (on `incusbr0`) must be reachable, e.g. advertise the bridge subnet as a Tailscale subnet route, or use an SSH tunnel; set `PIXEL_PUBLIC_HOST` if a different hostname should appear in the copied command.

## Single-container mode (Coolify)

Pixel and every agent run in one ordinary container. Each agent is its own unprivileged Linux user.

**Only deploy this on a server whose owner has agreed to it.** Agents run untrusted code (target builds, PoCs, fuzzers) with internet access from that server's IP, and a container shares the host's kernel with everything else on it.

What agents get and don't get:
- No root, no Docker, no `apt`, no snapshots. They test hypotheses on native builds with the image's toolchain (clang/gcc + sanitizers, gdb, valgrind, AFL++, semgrep) and install extra tools under their home. The prompt's `{{machine}}` line tells them this.
- Each agent can read every workbase, write only its own, and can't read Pixel's database, the history, other agents' machine dirs or their processes' environment (where opencode's password lives).

What protects the rest of the server:
- **Container limits** (`PIXEL_CPUS`, `PIXEL_MEMORY`, `pids_limit`): the hard ceiling for Pixel plus all agents together. This is the main protection, so size it to what the server's owner allows.
- **Per agent**: over its memory size, its largest process is killed; over its disk size (target + scratch), the run stops; process count capped (`PIXEL_AGENT_MAX_PROCS`); lower CPU and I/O priority; agents are killed before Pixel when memory runs out.
- **Data disk**: every run stops when less than `PIXEL_MIN_FREE_GIB` (default 20) is free.
- **Network**: with the `NET_ADMIN` capability, an iptables rule keyed on the agent uids blocks private, link-local (cloud metadata) and CGNAT ranges and the dashboard port. Agents keep internet access. **System** shows `Agent firewall: on` or why it failed.
- **Temp dirs**: `/tmp` and `/var/tmp` are capped tmpfs, so they can't fill the host's Docker storage.
- **Dashboard**: Pixel refuses to start without `PIXEL_PASSWORD`.

Deploy:
1. In Coolify, create a resource from this repo with the **Docker Compose** build pack and `compose.single.yaml`.
2. Set `PIXEL_PASSWORD`, plus `PIXEL_MEMORY` / `PIXEL_CPUS` (default 8g / 4) and optionally `PIXEL_PUBLIC_URL`. `INSTALL_GHIDRA=1` / `INSTALL_CODEQL=1` add those tools for the rare reverse-engineering run (about 2 GB more and a much longer build).
3. Point a domain at port 7700 and deploy. Data lives in the `pixel-data` volume.
4. In **Settings → size presets**, use sizes that fit inside the container, e.g. standard = 3 GiB memory, 10 GB disk. With mostly code review, 8 GB / 4 CPUs fits about 3 agents at once.
5. Check **System**: `Agent firewall: on`. If it says FAILED, that Coolify install didn't apply `cap_add`.

Differences from the VM setup: a redeploy or container restart kills every agent's processes. Pixel restarts each opencode and continues the same session, but anything in memory (a running fuzzer) is lost. `opencode attach` from your machine doesn't work (agents listen inside the container); use the dashboard's terminal and transcript.

## Using it

- **New run**: repository, optional ref, template (versioned, editable per run with live preview), model, machine size. *Follow-up* offers an earlier run's workbase; *Compare* starts one run per model × template version.
- **Runs (the Wall)**: output tokens/s per run over the last 30 minutes with findings, questions and crashes marked on the streams, the latest events across runs, spend today with a projection, tool calls per minute, memory by run and findings to triage. Below, a filter bar (<kbd>1</kbd>–<kbd>5</kbd>: all, running, needs you, to triage, finished; <kbd>/</kbd> text filter; model; sort) and every run as a tile (agents' recent tool calls, the top finding, todos, tok/s, cost) or as a list with bulk pause/resume/message/stop (<kbd>X</kbd> selects). Arrows or <kbd>J</kbd>/<kbd>K</kbd> move, <kbd>Enter</kbd> opens, <kbd>M</kbd> messages, <kbd>N</kbd> new run, <kbd>F</kbd> findings.
- **A run** opens beside the run list (<kbd>[</kbd> hides it, <kbd>.</kbd> focus mode, <kbd>Esc</kbd> closes): live tokens/s, tokens, cache rate, cost, context and agents in the header; **Overview** (each agent's latest tool calls, the run's story with what changed since you looked, charts over its life), **Findings**, **Report** (REPORT.md and the run's triage), transcript, workbase files with history, timeline, web terminal, machine (resources, snapshots, how to connect, sessions, the prompt). The side column has the agents with their last hour of tool calls, todos and the run's facts (model and API key are clickable). Controls: message (one line at the bottom, <kbd>⌘</kbd><kbd>↵</kbd> sends), pause, stop, and the ⋯ menu (continue, abort, autopilot, model, rename, restart opencode, reset counters, mark done, re-run, follow-up, delete).
- **Findings**: every finding across runs in four lists: **To triage** (by project), **Report** (not sent yet, then sent and waiting on upstream), **Resolved** (fixed upstream, or dropped with a reason) and **Reviewed** (by disposition), plus what the agents set aside. Triage keys <kbd>R</kbd> report, <kbd>K</kbd> known, <kbd>D</kbd> duplicate (of a finding you pick), <kbd>W</kbd> weak, <kbd>I</kbd> invalid, a final severity next to the agent's, and a note; the next finding opens after each. Report findings get a disclosure you set by hand (sent with its link, fixed with its version, dropped). Search with <kbd>/</kbd>. **Copy for LLM** on a finding (to check it, write the disclosure, or find variants) and on every list. Triage goes to the workbase's `TRIAGE.md` and to `TRIAGED.md` across runs; nothing is sent to the agent.
- **Since you last looked** (the clock icon): per run, what happened since you last cleared it, with Answer / Triage / Retry / Open.
- **⌘K / Ctrl+K** anywhere: jump to runs and pages, pause/resume/continue/message the run you're looking at, search all workbases.
- **Activity**: every tool call and every action Pixel took across the fleet, live and filterable.
- **Models**: live provider health (time to first token, output tok/s, errors, rate limits and retries, tokens and requests per minute against limits you enter) and a leaderboard of every model across all runs (finish rate, median time, tokens and cost per run, real-findings rate from triage, cost per real finding), plus a speed test that sends the same prose prompt to the models you pick and compares first token and output speed.
- **Knowledge**: search over all workbases (ripgrep, run when you search), `INDEX.md`, and a graph of which agents read which other workbases.
- **Looking at the UI without agents**: `PIXEL_DATA=/tmp/pixel-demo bun server/test/seed-demo.ts`, then start Pixel with the same `PIXEL_DATA`, `PIXEL_RUNTIME=local` and `PIXEL_DETACHED=1` (no reattaching or recovering runs).
- **CLI**: `bun run cli -- run <repo> --wait`, `ls`, `show`, `log`, `msg`, `continue`, `triage`, … (`PIXEL_URL`, `PIXEL_PASSWORD`).
- **MCP for your own agents**: Pixel is an MCP server at `<pixel address>/api/mcp`, so Claude Code, opencode or any MCP client on your machine can read runs, findings, transcripts, workbase files and token usage, and start, message and control runs. See [Connecting your agents](#connecting-your-agents-mcp).

### Connecting your agents (MCP)

Settings, **Agent access**: make a token per agent or machine (a name, **Read only** or **Full control**, and an expiry). It's shown once, with the setup ready to paste for Claude Code, opencode and `.mcp.json`; the same steps stay under the token list (Connect an agent), where you can paste a token to fill it in. The list shows each token's last use; change its access or revoke it there. Tokens open only the MCP endpoint, not the dashboard; the dashboard password doesn't open MCP.

Claude Code:

```sh
claude mcp add --transport http pixel https://pixel.example.com/api/mcp --header "Authorization: Bearer pxm_..."
```

Tools: `list_runs`, `get_run`, `get_timeline`, `get_transcript`, `list_findings`, `search_findings`, `get_finding` (the full "Copy for LLM" brief with download commands; purpose verify, disclose or variants), `finding_history`, `token_usage` (Pixel-wide or per run), `get_report`, `list_files`, `read_file`, `search_workbases`, `new_run_options`. Full control adds `triage_finding` and `triage_findings` (disposition, final severity, duplicate of, note; disclosure stays in the dashboard), `create_run`, `send_message`, `control_run`, `answer_question`, and `pixel_api`, which calls any API route (its description lists them all).

### Findings

Agents keep their findings as plain files in the run's workbase, one folder per finding: `findings/F3-short-name/README.md` with a short header (`state`: lead → suspected → confirmed, or ruled out; `severity`, `location`, `poc`), then the details in markdown, with PoCs and logs next to it. No tools or API calls, so other agents can read them like any other file. Pixel picks changes up within a few seconds, keeps a history of each finding, writes `FINDINGS.md` (an index), puts your triage in `TRIAGE.md` and lists every triaged finding across runs in `/workbases/TRIAGED.md`, which agents check before writing a bug up as new (they can mark one `duplicate_of: <run>/<id>`). A run's result ("2 to report (1 high, 1 low)") comes from your triage.

### Template sections

The conventions every template should share live in `templates/parts/` and ship with Pixel: `{{> environment}}` (target, workbase, scratch, other runs' workbases), `{{> findings}}` (the format above) and `{{> report}}`. Put them in your template and keep only your own task text around them; when a convention changes, every template that uses the section gets it. The seeded `audit` template is built this way.

### Interrupted subagents

When a run is paused, aborted, OOM-killed or restarted while task-tool subagents are running, their sessions survive in opencode but the agent normally can't see their ids, so it starts new ones and their work is lost. Every agent gets the opencode plugin [`opencode-plugins/resume-subagents.ts`](opencode-plugins/resume-subagents.ts), which adds each interrupted subagent's `task_id` and a "resume it with task_id" hint to the history the model sees. It also works in a normal opencode: copy it to `~/.config/opencode/plugin/`.

### What Pixel does on its own

| Situation | Action |
|---|---|
| Agent idle and `REPORT.md` exists | Run **done**: transcript exported, workbase snapshot, VM stopped (kept) |
| Agent idle without a report | Send "continue your work", up to 3× (Settings), then **stop** and notify |
| opencode OOM-killed | Restart it, resume the same session with the OOM message, up to 3×, then stop |
| opencode/VM crashed | Start VM/opencode, continue the same session (counts as a continue) |
| VM disk ≥ 98% / workbase > 5 GiB | Abort, **stop**, notify |
| Data disk below `PIXEL_MIN_FREE_GIB` free | Abort, **stop**, notify (every run) |
| Agent over its memory size (`single`) | Kill its largest process; if that was opencode, OOM recovery |
| Permission prompt | Auto-approved (opencode is configured with every permission anyway) |
| Agent asks a question | Notify you; on autopilot runs dismissed after 30 min |
| Pixel restarted | Reattach to every active run from SQLite |

Marking a run **triaged** writes `TRIAGE.md` into its workbase and deletes its VM; the workbase is kept.

## Layout

```
server/src/
  index.ts         server entry: dashboard, API, websockets, background loops
  mcp.ts           MCP server for your own agents (/api/mcp); mcpTokens.ts its access tokens
  api/             JSON API (router + one file per area)
  runs/            run manager: create/prepare, event capture, lifecycle, watchdog, manual controls
  runtime/         machines: incus.ts (VMs), single.ts (one container), local.ts (development); process.ts is shared by the last two
  opencode.ts      client for `opencode serve`
  knowledge.ts     workbase files, run.json, INDEX.md, TRIAGE.md
  fleet.ts         live telemetry for the dashboard (tokens/s, current tool, subagents, activity, lanes)
  providers.ts     model calls, provider events, health, leaderboard, text-only speed test
  search.ts history.ts crossreads.ts notify.ts backup.ts settings.ts db.ts
web/src/           React dashboard: pages/, pages/run/, components/ (viz.tsx charts, RunPanel, Mesh, CommandPalette), lib/ (fleet + runs stores)
image/             pixel-image build (provision.sh, opencode config + systemd unit)
Dockerfile.single, compose.single.yaml   single-container mode (Coolify)
templates/         seed prompt templates; parts/ = Pixel's sections ({{> name}})
opencode-plugins/  opencode plugins every agent gets (resume interrupted subagents)
server/test/       bun tests, with a fake opencode server
ai/                design notes and decisions
```
