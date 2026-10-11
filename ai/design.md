# Pixel technical notes

Last updated 2026-10-11 (after the first build session). The plan of record is [plan.md](plan.md); this file holds implementation details and gotchas that don't belong in the plan.

## Mount layout inside an agent VM

- Share 1: host `/srv/pixel/workbases` → guest `/workbases`, **readonly** (virtiofs).
- Share 2: host `/srv/pixel/workbases/<run>` → guest `/workbases/<run>`, read-write, mounted on top of share 1.
- Read-only must be enforced on the host side; the agent is root in the guest.
- Nested mount (share 2 on top of share 1) is expected to work; verify in phase 0.

## opencode inside the VM

- Pinned version, installed in `pixel-image`.
- Global config allows every permission so it never blocks on approval (bash, edit, webfetch, external_directory and any others the pinned version has). Check the exact keys against the pinned version's config schema.
- `opencode serve` as a systemd unit, password-protected (`OPENCODE_SERVER_PASSWORD`), listening on the VM's bridge address. `Restart=` is **off**: Pixel decides restarts so it can send the right continue message.
- Pixel also auto-approves any `permission` request event as a safety net.
- OOM detection: `systemctl show opencode -p Result` = `oom-kill`, or a kernel OOM log line naming the opencode process. If the OOM killer hits a build/fuzzer instead, opencode just sees a failed tool call; nothing to do.
- Resume after restart: sessions persist on the VM disk, so Pixel continues the same session ID.

## Pixel container

- Host networking, to reach VMs on `incusbr0` directly.
- Mounts the Incus unix socket (root-equivalent on the pixel host; fine, Pixel is trusted) and `/srv/pixel`.

## Single runtime (one container)

`PIXEL_RUNTIME=single`, built from `Dockerfile.single` / `compose.single.yaml`. `runtime/process.ts` holds what it shares with `local` (opencode as a child process, launch info, restart).

- **Users**: each run gets uid 20000+ from a counter in `machines/.launch/next-uid`; uids are never reused because workbases keep their owner. `/etc/passwd` lives in the image, so `ensureUser` recreates the user (same uid) before every opencode start. On delete, the workbase is chowned to root (still readable, frozen) and the user removed.
- **Command wrapper**: `choom -n 500` (killed before Pixel under memory pressure) → `nice 10` → `ionice -c2 -n7` → `prlimit --nproc --core=0` → `setpriv --reuid/--regid --clear-groups --no-new-privs`. The agent environment is built from scratch, so Pixel's env (`PIXEL_PASSWORD`) never leaks.
- **Permissions**: data dir 0711, `machines/` 0711, `workbases/` 0755, history/transcripts/`.launch` 0700, `pixel.db*` 0600, each run dir 0700 (agent), each workbase 0755 (agent). The backup copy of the database is created 0600 before `VACUUM INTO`.
- **Limits without cgroups** (an ordinary container can't create them): memory is checked every 5 s by summing RSS over the uid's processes; over the run's size the largest process gets SIGKILL and the timeline gets a `limit` entry. Disk is `du -sxb` of the run dir (cached 5 min) against the run's disk size, reusing the watchdog's disk-full rule. CPU is only priority; the container's `cpus` is the real cap.
- **Firewall**: iptables `OUTPUT -m owner --uid-owner 20000-59999 -j PIXEL_AGENTS`, which rejects 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10 (and fc00::/7, fe80::/10) and the dashboard port on loopback, but allows the resolv.conf nameservers on port 53. Needs NET_ADMIN; failure is reported in `info()` on the System page, not fatal.
- **Stopping** kills every process of the uid (fuzzers, servers), not just opencode. tini is PID 1 so orphans get reaped.
- **Free-disk guard** (all runtimes): the watchdog stops runs when the data disk has less than `PIXEL_MIN_FREE_GIB` free. Tests set it to 0.
- Verified 2026-10-11 in a slim test container (fake opencode): users and permissions as above, agent→dashboard blocked, private-range rules in place, internet allowed, memory kill + OOM recovery, container restart → reattach and continue. Not verified: the full image build, real opencode as an agent user, gdb/ptrace under Docker's default seccomp, Coolify honouring `cap_add`/`cpus`/`mem_limit`/`tmpfs`.

## Known gotchas

- **Nested virtualization**: the pixel host VM on Proxmox needs CPU type `host` and nesting enabled on the node (`kvm_intel nested=1` / `kvm_amd nested=1`).
- **Docker and Incus on the same host**: Docker sets the iptables FORWARD policy to DROP, which breaks Incus bridge networking. Fix: `"ip-forward-no-drop": true` in Docker's `daemon.json` (or `DOCKER-USER` accept rules for `incusbr0`).
- **VM memory** is mostly held once the guest touches it; keep total `limits.memory` within the 16 GB. Each VM costs ~0.5–0.7 GB fixed ([benchmarks/incus-research-2026-10-11.md](benchmarks/incus-research-2026-10-11.md)).
- **ZFS storage pool**: cap the ARC (`zfs_arc_max`), or it eats RAM inside the 16 GB.
- **VM disks** only grow; Incus default is 10 GiB, Pixel sets 20 GiB.
- **opencode updates** are frequent; bump the pinned version deliberately and rebuild the image.

## Code layout

See the root README for the tree. Rules of thumb: one concern per module; `runs/state.ts` is the only place that writes a run and fans out updates (dashboard, run.json/INDEX.md); API handlers stay thin and call `runs/controls.ts`; dashboard types reuse server types via `import type`.

## opencode API notes (1.19.0, same as 1.18.23)

- Event stream `GET /event?directory=…` sends `data: {id, type, properties}` lines. Pixel uses `session.*`, `message.updated`, `message.part.updated`, `message.part.delta`, `todo.updated`, `permission.asked`, `question.*`.
- `GET /session/status` only lists sessions that are busy/retrying; an idle session is simply absent.
- Session info carries cumulative `cost` and `tokens`; run totals = sum over the root and subagent sessions.
- PTY: `POST /pty/{id}/connect-token` returns 403 for server-side callers (tickets are for browsers). Pixel connects to `/pty/{id}/connect` directly with the basic-auth header and proxies to the dashboard.
- `permission: "allow"` as a single value allows everything (question tool included).

## Recovery details

- `onIdle` and `recover` run serialised per run, so an idle event and a watchdog check can't both act.
- Missed events (stream drop, Pixel restart) are caught by the watchdog: busy per our DB but absent from `/session/status` for 60 s → treated as idle; pending permissions are polled and approved.
- opencode unit uses `OOMPolicy=continue` so a fuzzer hitting the OOM killer doesn't stop opencode. When opencode itself is OOM-killed the unit sees SIGKILL (`ExecMainStatus=9`); Pixel confirms with the kernel log (`Killed process … (opencode)`).
- Process runtimes (local, single): SIGKILL of the opencode process counts as OOM (that's how the tests simulate it, and what the kernel or the single runtime's memory limit does). opencode dies with Pixel (`agentsDieWithPixel`); on restart Pixel restarts it and sends a continue that doesn't count toward the limit. On Incus, opencode keeps running in the VM across Pixel restarts.
- Until a run starts, `runs.prompt` holds an optional per-run edited template body; afterwards the rendered prompt that was sent.

## Testing

- `bun test`: unit tests plus lifecycle tests using `server/test/fake-opencode.ts` (scripted by prompt text: `REPORT <path>`, `HANG`).
- Manual e2e: `PIXEL_RUNTIME=local OPENCODE_BIN=<opencode> bun server/src/index.ts` with a tiny local git repo and the free `opencode/big-pickle` model.
