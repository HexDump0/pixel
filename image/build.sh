#!/usr/bin/env bash
# Build the pixel-image Incus VM image on the pixel host.
# Usage: image/build.sh [alias]   (env: OPENCODE_VERSION, BASE_IMAGE, GHIDRA_URL, CODEQL_VERSION)
set -euo pipefail
cd "$(dirname "$0")"

ALIAS="${1:-pixel-image}"
BASE_IMAGE="${BASE_IMAGE:-images:ubuntu/24.04/cloud}"
OPENCODE_VERSION="${OPENCODE_VERSION:-1.19.0}"
BUILD="pixel-build-$(date +%s)"

cleanup() { incus delete -f "$BUILD" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> Launching $BUILD from $BASE_IMAGE"
incus launch "$BASE_IMAGE" "$BUILD" --vm -c limits.cpu=4 -c limits.memory=8GiB -d root,size=30GiB

echo "==> Waiting for the VM agent"
for _ in $(seq 1 120); do incus exec "$BUILD" -- true 2>/dev/null && break; sleep 2; done
incus exec "$BUILD" -- cloud-init status --wait >/dev/null 2>&1 || true

incus exec "$BUILD" -- mkdir -p /root/pixel-provision
for f in provision.sh opencode.json opencode.service; do incus file push "$f" "$BUILD/root/pixel-provision/$f"; done
for f in ../opencode-plugins/*.ts; do incus file push "$f" "$BUILD/root/pixel-provision/$(basename "$f")"; done
incus exec "$BUILD" -- env OPENCODE_VERSION="$OPENCODE_VERSION" ${GHIDRA_URL:+GHIDRA_URL="$GHIDRA_URL"} ${CODEQL_VERSION:+CODEQL_VERSION="$CODEQL_VERSION"} bash /root/pixel-provision/provision.sh

echo "==> Publishing as $ALIAS"
incus stop "$BUILD"
incus image delete "$ALIAS" 2>/dev/null || true
incus publish "$BUILD" --alias "$ALIAS" description="pixel-image, opencode $OPENCODE_VERSION, built $(date -u +%F)"
incus image info "$ALIAS" | head -20
