# Open questions

- [ ] User's current audit prompt (to turn into the first template). User: later.
- [ ] Model providers / keys / rate limits with several runs at once. User: later.
- [ ] Proxmox node details: CPU vendor (nested setting), disk space for the pixel host VM, storage backend for Incus (ZFS/btrfs/dir).
- [ ] Off-server backup target for restic.
- [ ] Notification channel: ntfy or Telegram.
- [ ] OOM restart limit: defaulted to 3 then stop; confirm.
- [ ] Incus runtime and `image/build.sh` are untested on a real host (no Incus on the laptop). Check on first run: nested share mount (own workbase over read-only `/workbases`), `incus publish` size, VM boot time.
- [ ] Ghidra MCP: the image configures `pyghidra-mcp` (headless) as an opencode MCP server. Untested; the user's local setup uses a different Ghidra bridge, so confirm which one they want.
- [ ] Dashboard exposure: agents share the host network, so `PIXEL_HOST` must be a private address (Tailscale IP). Consider a firewall rule dropping incusbr0 → host:7700 as a second layer.
- [ ] Coolify (single runtime): does the server's owner agree to untrusted agent code running there? How much RAM/CPU/disk can Pixel have?
- [ ] Coolify: does that install honour `cap_add: NET_ADMIN`, `cpus`, `mem_limit` and `tmpfs` from the compose file? Check the System page (`Agent firewall: on`) after the first deploy.
- [ ] `Dockerfile.single` has not been built in full yet (only a slim test image). First build on the server may need package fixes (radare2 already dropped: not in Debian 13).
- [ ] resume-subagents plugin: confirm live (user's opencode or first Pixel run) that after a stop the agent resumes the same child sessions via task_id. Re-check the experimental hook when bumping opencode.
- [ ] Models page: optional cost-vs-findings scatter on the leaderboard (not built; needs triaged runs to be useful). Speed test UI, real-run check of health/leaderboard, and tests for providers.ts/fleet.ts were done 2026-10-11.
- [ ] Speed test with paid providers (keys in Settings) untested; only the opencode free tier was run. Health's tokens/min counts uncached input + output + reasoning; check how your provider counts its TPM limit before relying on the meter.
