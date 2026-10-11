# Pixel

Runs several long-lived [opencode](https://opencode.ai) audit agents at once, each in its own throwaway Incus VM, each auditing one open-source repository. You start runs from a web dashboard; Pixel keeps them going (continues, OOM and crash recovery), records everything, and keeps every agent's notes in a shared, read-only **workbase** folder that the other agents can learn from.

The design and the reasoning behind it live in [ai/plan.md](ai/plan.md).

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
  runtime/         machines: incus.ts (production), local.ts (development)
  opencode.ts      client for `opencode serve`
  knowledge.ts     workbase files, run.json, INDEX.md, TRIAGE.md
  search.ts history.ts crossreads.ts notify.ts backup.ts settings.ts db.ts
web/src/           React dashboard (Tailwind): pages/, pages/run/, components/, lib/
image/             pixel-image build (provision.sh, opencode config + systemd unit)
templates/         seed prompt templates
server/test/       bun tests, with a fake opencode server
ai/                design notes and decisions
```
