#!/usr/bin/env bash
# Install opencode's prebuilt binary from npm's registry into /usr/local/bin.
# Usage: install-opencode.sh <version>   (e.g. 2.2.0)
# Straight from the tarball: `npm install -g @opencode/cli` needs its postinstall script, which newer npm skips.
set -euo pipefail
VERSION="${1:?usage: install-opencode.sh <version>}"
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
target="linux-$arch"
# Same choice as opencode's installer: CPUs without AVX2 need the baseline build, musl systems the musl one.
if [ "$arch" = x64 ] && ! grep -qwi avx2 /proc/cpuinfo 2>/dev/null; then target="$target-baseline"; fi
if ldd --version 2>&1 | grep -qi musl; then target="$target-musl"; fi
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "https://registry.npmjs.org/@opencode/cli-$target/-/cli-$target-$VERSION.tgz" | tar -xz -C "$tmp"
install -m 0755 "$tmp/package/bin/opencode" /usr/local/bin/opencode
/usr/local/bin/opencode --version
