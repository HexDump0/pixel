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
- **Run page**: live transcript (with subagent sessions), todos, questions from the agent, timeline of every automatic and manual action, workbase browser with editing and history diffs, report + triage, web terminal into the VM, CPU/RAM/disk/token charts, snapshots. Controls: message, continue, pause/resume, abort, restart opencode, change model, autopilot on/off, reset counters, stop, mark done, re-run, delete.
- **Knowledge**: full-text search over all workbases, `INDEX.md`, and a graph of which agents read which other workbases.
- **CLI**: `bun run cli -- run <repo> --wait`, `ls`, `show`, `log`, `msg`, `continue`, `triage`, … (`PIXEL_URL`, `PIXEL_PASSWORD`).

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
  api/             JSON API (router + one file per area)
  runs/            run manager: create/prepare, event capture, lifecycle, watchdog, manual controls
  runtime/         machines: incus.ts (VMs), single.ts (one container), local.ts (development); process.ts is shared by the last two
  opencode.ts      client for `opencode serve`
  knowledge.ts     workbase files, run.json, INDEX.md, TRIAGE.md
  search.ts history.ts crossreads.ts notify.ts backup.ts settings.ts db.ts
web/src/           React dashboard (Tailwind): pages/, pages/run/, components/, lib/
image/             pixel-image build (provision.sh, opencode config + systemd unit)
Dockerfile.single, compose.single.yaml   single-container mode (Coolify)
templates/         seed prompt templates
server/test/       bun tests, with a fake opencode server
ai/                design notes and decisions
```
