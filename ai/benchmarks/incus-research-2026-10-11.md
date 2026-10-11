# Incus overhead: research notes (2026-10-11)

Not measured locally (Incus not installed on the laptop; user chose research only). Published numbers for Incus are thin; items marked *estimate* are Claude's general knowledge, not sourced.

| Item | Figure | Source |
|---|---|---|
| Package size (Arch, incus 7.5.1) | 327 MiB installed | `pacman -Si incus` |
| incusd idle memory | no published figure; *estimate* tens of MB to ~100 MB | – |
| VM defaults | 1 vCPU, 1 GiB RAM, 10 GiB root disk | Incus instance options docs; forum |
| Idle Ubuntu 24.04 VM, usage inside guest | ~127 MiB | discuss.linuxcontainers.org KSM thread |
| Host cost per extra idle VM (4 GiB limit) | ~590 MiB (5441 MiB with 1 VM → 8966 MiB with 7) | same thread, derived |
| KSM saving across 7 idle VMs | ~139 MiB total (small) | same thread |
| QEMU RSS vs `limits.memory` | can slightly exceed the limit (QEMU's own overhead) | lxc/incus PR #2058 |
| Shrinking VM memory | balloon, guest must cooperate, may not succeed | lxc/incus issue #1904 |
| Boot time | no Incus benchmark found; *estimate* ~10–20 s VM to agent-ready, ~1–2 s container | – |
| Idle CPU | *estimate* near zero per idle VM | – |
| Disk per VM | 10 GiB default root, grow-only; on ZFS/btrfs only the delta from the image is stored; official images fit ~4 GiB | forum |

Gotchas:
- ZFS storage: the ARC cache uses lots of RAM and doesn't show as cache in `free`; cap with `zfs_arc_max` (maintainer uses ~2 GB on laptops).
- Docker on the same host blocks Incus forwarding. Fixes (Incus docs, firewalld/bridge page): `"ip-forward-no-drop": true` in Docker's `daemon.json`, or `DOCKER-USER` accept rules for `incusbr0`, or run Docker inside an Incus instance.

Takeaway for Pixel: an agent VM adds roughly 0.5–0.7 GB fixed cost on top of opencode (~0.7–1 GB) and the workload. Six agents ≈ 3–4 GB extra versus Docker containers.

Sources:
- https://linuxcontainers.org/incus/docs/main/reference/instance_options/
- https://discuss.linuxcontainers.org/t/memory-deduplication-implement-new-technology-to-incus/21022
- https://github.com/lxc/incus/pull/2058
- https://github.com/lxc/incus/issues/1904
- https://discuss.linuxcontainers.org/t/incus-memory-utilization/19329
- https://forums.truenas.com/t/why-does-incus-add-a-default-10gb-drive-every-time/39531
- https://linuxcontainers.org/incus/docs/main/howto/network_bridge_firewalld/
