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

## Subagents

- Subagents are task-tool child sessions (`parentID` = caller). Pixel records them (transcript, costs) and pulls them in `syncTranscript` via `/session/:id/children`.
- Interrupted subagents: see decisions.md (2026-10-11, subagents). The `resume-subagents` plugin rewrites, in the history copy sent to the model only, the latest task call per child session that is aborted (`error` + `interrupted`/"abort") or left `pending`/`running` by a crash: status `error`, error text + `task_id` hint, `interrupted` dropped (with `interrupted` and a string `metadata.output`, opencode would show that output instead of the error). Background tasks are skipped. opencode calls every exported function of a plugin file as a plugin, so the file exports only the plugin.
- Tested: `server/test/plugin.test.ts` drives the hook with opencode-shaped messages. opencode 1.18.23 starts with the plugin in its plugin dir, but a full live check (stop with running subagents → continue → same child session resumed) hasn't been done yet.

## Dashboard telemetry (fleet.ts)

- `/api/fleet`: one snapshot for every non-archived run: output tokens/s samples (90 × 1 s; live from streamed deltas, corrected to exact counts when each call finishes), latest tool call per session (with status, so "thinking…" shows between calls), subagents with state from their task calls, 60 × 30 s activity buckets (dominant kind; "alert" where Pixel recovered or a limit fired), CPU/mem/disk from the last metrics row, context used (latest assistant message with token counts) and the model's context limit (asked once from opencode `/config/providers`), machine name/PID/endpoint. Plus shared memory (cgroup v2 `memory.max`/`memory.current` when limited, else the machine), today's spend and tokens from assistant messages (cost per hour per run, top four plus other; tokens by kind and cache hit rate, both against yesterday up to the same time; projection at the last hour's rate; cached 10 s) and the cross-read graph.
- Live: `fleet.tick` (`*`, every second, tokens per run), `activity` (`*`, on each tool-call status change only), `timeline` now also goes to `*`. The web `lib/fleet.ts` store applies these and refetches every 15 s; `lib/runs.ts` is the shared runs list.
- `/api/runs/:id/lanes?minutes=N`: per-session tool-call segments + marks (subagent done/interrupted dots, Pixel recover/limit/continue ticks on the main lane). `/api/activity?run=&limit=`: recent tool calls + timeline entries (24 h).
- Tool kinds: shell (bash), read (read/grep/glob/list), edit (edit/write/patch/todowrite), task, web, other. Commands are shown with the run's own target/workbase/scratch paths shortened.
- Styling: tokens in `web/src/index.css`; Tailwind's zinc scale is remapped onto the same greys so older pages match. Light by default, dark with the OS.

## Models and providers (providers.ts)
- Live test (`liveTest.ts`, `POST /api/live {model, text, session?, turn}`, `POST /api/live/:session/abort`, `GET /api/live`): one warm throwaway opencode from `scratchOpencode.ts` (shared with the speed test: empty work dir, `permission: "ask"`, agents' credentials). Started on first prompt, restarted when `agentCredentials()` changes, stopped after 10 idle minutes and on SIGINT/SIGTERM. Pixel reads its `/event` stream and publishes `live` bus messages tagged `{turn, session, kind}`: starting, sent, first (server-measured TTFT), part, delta, message (tokens, cost, error), retry, tool (refused at `permission.asked`/`question.asked`), done/error/stopped. The client sends its own turn id so it can match `starting` before the POST returns. A follow-up continues the same opencode session (the model can be switched mid-chat). Live tok/s is chars/4 over time since the first token until the exact count arrives.
- Provider setup (`catalog.ts`, `providerAccounts.ts`): the catalogue is models.dev (`PIXEL_MODELS_URL`), fetched at most daily and cached in `data/models.json`, falling back to opencode's `~/.cache/opencode/models.json`. Accounts live in the settings table under `_providers` (underscore = never sent by `/api/settings`); the API only returns a key hint. `agentCredentials()` builds what runs and the speed test get: Settings `agentAuthJson` merged with `{id: {type: "api", key}}` per account, and `OPENCODE_CONFIG_CONTENT` (merged over any value in Settings env) with a `provider` block for custom endpoints (`@ai-sdk/openai-compatible` or `@ai-sdk/anthropic`, one context size for all their models) and base-URL overrides. Checked against opencode 1.18.23: env config is merged over opencode.json, and auth.json keys apply to custom providers too. Works for every runtime because it travels as env + auth.json. Existing runs get new keys on their next opencode restart (`runs/state.ts` `restartOpencode`, which records `creds_hash`); resume or a message to an idle run with a stale hash restarts it on purpose. Routes: `GET /api/catalog`, `GET /api/catalog/:id`, `GET /api/providers`, `PUT|DELETE /api/providers/:id`, `POST /api/providers/discover`.

- Tables (created by providers.ts on import): `llm_calls` (one row per assistant message: provider, model, created, first_token, completed, tokens, cost, error), `provider_events` (ratelimit / error / retry, with message), `speedtests`.
- Capture in events.ts: `message.updated` → `onMessage` (upsert call; errors become provider events, 429 / "rate limit" text → ratelimit); first `message.part.updated` or `message.part.delta` of an assistant message → `first_token`; `session.status` retry → `onRetry` (deduped per session + attempt). Live `provider` events go to `*`.
- Health (`/api/providers/health?minutes=`): per provider/model: calls, time to first token p50/p90, output tok/s p50 (calls with ≥ 30 output tokens), errors, rate limits, retries, tokens and requests per minute (last 5 min), 12-bucket series, state ok/degraded/limited/idle. Limits per "provider/model" live in settings `providerLimits` (edited on the Models page).
- Leaderboard (`/api/providers/leaderboard`): per `runs.model`: finish rate (report written vs stopped/failed), median duration, tokens/cost per run, continues/OOM per run, real-findings rate from triage verdicts ("real findings", "partly real"), cost per real finding, plus call medians.
- Speed test (`POST /api/speedtests {models}`, `GET /api/speedtests` → results plus the running batch's models and current model): spawns `config.opencodeBin serve` in `data/speedtest/run-*` with only PATH/HOME/LANG/XDG + Settings agentEnv/auth.json and an empty work folder. Config `permission: "ask"`; while a call runs Pixel rejects every permission request and question, and a call that tried a tool is recorded as failed. Models are checked against `/config/providers` first (an unknown model otherwise gets a bare 500). Fixed ~250-word prose prompt; records TTFT (first part `time.start` − message created), total, output+reasoning tokens, tok/s. Needs opencode in Pixel's container (true for local/single, not for the incus Dockerfile).
- **opencode's gateways (Zen free models, Go) only accept requests that look like opencode's own**: denying permissions in config, or switching off even one tool per request, gets `403 FreeTierError: "OpenCode's free tier can only be used from within OpenCode"`. That's why the speed test keeps every tool and refuses them by permission instead. Anonymous free-tier use from a fresh HOME works. (Tested 2026-10-11, opencode 1.18.23.)
- `opencode serve` 1.18.23 can ignore SIGTERM after a call; the speed test waits 5 s then SIGKILLs.
- First token is Pixel's clock (first part event) minus the message's `time.created` (opencode's clock). Same machine for local/single; on Incus it depends on the VM clock being in sync with the host, plus event-stream latency.
- Checked with a real big-pickle run (15 calls): health first token p50 1.8 s / p90 2.8 s, 149 tok/s; per-call tokens add up to the run totals; leaderboard shows the run as finished. Speed test on big-pickle: 114–124 tok/s, first token 2.5–3.5 s.

## Recovery details

- `onIdle` and `recover` run serialised per run, so an idle event and a watchdog check can't both act.
- Missed events (stream drop, Pixel restart) are caught by the watchdog: busy per our DB but absent from `/session/status` for 60 s → treated as idle; pending permissions are polled and approved.
- opencode unit uses `OOMPolicy=continue` so a fuzzer hitting the OOM killer doesn't stop opencode. When opencode itself is OOM-killed the unit sees SIGKILL (`ExecMainStatus=9`); Pixel confirms with the kernel log (`Killed process … (opencode)`).
- Process runtimes (local, single): SIGKILL of the opencode process counts as OOM (that's how the tests simulate it, and what the kernel or the single runtime's memory limit does). opencode dies with Pixel (`agentsDieWithPixel`); on restart Pixel restarts it and sends a continue that doesn't count toward the limit. On Incus, opencode keeps running in the VM across Pixel restarts.
- Until a run starts, `runs.prompt` holds an optional per-run edited template body; afterwards the rendered prompt that was sent.

## Testing

- `bun test`: unit tests plus lifecycle tests using `server/test/fake-opencode.ts` (scripted by prompt text: `REPORT <path>`, `HANG`; the synchronous message endpoint used by the speed test is scripted by model id: `fake/fast`, `fake/broken`, `fake/tool`). `providers.test.ts` covers capture, health, leaderboard and the speed test; `fleet.test.ts` covers the snapshot, swimlanes, activity and the stream-based tokens/s sampler and its correction on a seeded run.
- Manual e2e: `PIXEL_RUNTIME=local OPENCODE_BIN=<opencode> bun server/src/index.ts` with a tiny local git repo and the free `opencode/big-pickle` model.

## Stats page (stats.ts)

- `GET /api/stats?days=1|7|30|90&tz=<minutes east of UTC>` → `/stats`. Buckets: hourly ≤ 2 days, 6-hourly ≤ 14, daily beyond, aligned to the viewer's clock via `tz`.
- Tokens come from the stored assistant messages (`json_extract` over `messages.data`), not `llm_calls`/`runs`, because those merge cache read and write into one `tokens_cache` column. That means history from before the page counts too; deleted runs drop out. Index `messages_created` is created by stats.ts.
- Cache hit rate = cache read / (input + cache read + cache write); opencode's `input` already excludes cached tokens. Savings ≈ cache read × (input price − cache-read price) for models in the models.dev catalogue (`costCacheRead`); custom endpoints aren't priced.
- Aborted calls (`MessageAbortedError`) aren't counted as errors. Tool stats come from `parts` (type tool) updated in the window.
- Health checks (runtime, data disk vs `PIXEL_MIN_FREE_GIB`, host memory, memory promised, event streams, provider errors in the last hour, backups) are computed on the server; the System page still holds machines and backups.

## API keys and failover

- Provider accounts hold `keys[]` in order; the first is the default. The API returns `PublicKey` (hint only, status only while it counts as failing).
- Each run's opencode gets its own key for its model's provider (`runs.key_id`, null = default); other providers get their default key. `credsStale` compares per run, so changing a run's key restarts its opencode when it is idle (directly, or in `onIdle` before the automatic continue).
- `runs/keys.ts`: classifies errors from `message.updated` errors, `session.error` and `session.status` retries. A failing key is marked on the account; the switch runs in the run's serial queue, so the idle event from the failed call can't send a second continue (`onIdle` also ignores idle events when opencode says the session is busy). Errors in the 30 s after a switch are ignored.
- Routes: `/providers/:id/keys` (POST add), `/providers/:id/keys/:key` (PUT edit, DELETE remove; runs on it fall back to the default), `/providers/:id/keys-order`, `/providers/:id/keys/:key/test`, `/providers/:id/keys/usage`; `/runs/:id/keys` (GET current key, next failover key, cost per key), `/runs/:id/key`, `/runs/:id/failover`.
