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
