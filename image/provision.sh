#!/usr/bin/env bash
# Provision a fresh Ubuntu 24.04 VM into pixel-image. Run as root inside the VM (build.sh does this).
set -euo pipefail

OPENCODE_VERSION="${OPENCODE_VERSION:-1.19.0}"
GHIDRA_URL="${GHIDRA_URL:-https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip}"
CODEQL_VERSION="${CODEQL_VERSION:-v2.27.2}"
NODE_MAJOR="${NODE_MAJOR:-22}"

export DEBIAN_FRONTEND=noninteractive
log() { echo "==> $*"; }

log "Base packages and toolchains"
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl wget gnupg git git-lfs jq unzip zip xz-utils file less vim nano tmux htop strace ltrace lsof \
  build-essential clang lld llvm libclang-rt-dev gcc g++ gdb valgrind rr cmake ninja-build meson autoconf automake libtool pkg-config bison flex \
  python3 python3-pip python3-venv python3-dev pipx \
  openjdk-21-jdk-headless \
  afl++ \
  ripgrep fd-find universal-ctags binutils patchelf radare2 gh \
  docker.io docker-buildx docker-compose-v2 \
  qemu-user-static binfmt-support \
  golang-go rustc cargo \
  sudo net-tools iproute2 dnsutils netcat-openbsd

systemctl enable docker

log "Node.js ${NODE_MAJOR}"
curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
apt-get install -y nodejs

log "opencode ${OPENCODE_VERSION}"
npm install -g "opencode-ai@${OPENCODE_VERSION}"
ln -sf "$(command -v opencode)" /usr/local/bin/opencode
opencode --version

log "Python security tools"
export PIPX_HOME=/root/.local/pipx PIPX_BIN_DIR=/root/.local/bin
pipx install semgrep
pipx install pyghidra-mcp

log "Ghidra (headless)"
tmp=$(mktemp -d)
curl -fsSL -o "$tmp/ghidra.zip" "$GHIDRA_URL"
unzip -q "$tmp/ghidra.zip" -d /opt
mv /opt/ghidra_* /opt/ghidra
ln -sf /opt/ghidra/support/analyzeHeadless /usr/local/bin/analyzeHeadless
rm -rf "$tmp"

log "CodeQL ${CODEQL_VERSION}"
curl -fsSL "https://github.com/github/codeql-action/releases/download/codeql-bundle-${CODEQL_VERSION}/codeql-bundle-linux64.tar.gz" | tar -xz -C /opt
ln -sf /opt/codeql/codeql /usr/local/bin/codeql

log "opencode config and service"
install -d /root/.config/opencode /etc/pixel /work /scratch /workbases
install -m 0644 /root/pixel-provision/opencode.json /root/.config/opencode/opencode.json
# opencode plugins from the repo's opencode-plugins/ (e.g. resume interrupted subagents)
install -d /root/.config/opencode/plugin
install -m 0644 /root/pixel-provision/*.ts /root/.config/opencode/plugin/
install -m 0644 /root/pixel-provision/opencode.service /etc/systemd/system/opencode.service
touch /etc/pixel/opencode.env && chmod 0600 /etc/pixel/opencode.env
systemctl daemon-reload
# Not enabled at boot: Pixel starts it once the target is cloned, and after crashes.

cat > /etc/profile.d/pixel.sh <<'PROFILE'
export PATH="$PATH:/root/.local/bin:/opt/ghidra/support"
export GHIDRA_INSTALL_DIR=/opt/ghidra
PROFILE

cat > /etc/motd <<'MOTD'
pixel-image: agent VM. Target in /work/target, workbase under /workbases, scratch in /scratch.
MOTD

log "Cleanup"
apt-get clean
rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache /root/pixel-provision
journalctl --vacuum-time=1s || true
cloud-init clean --logs 2>/dev/null || true
truncate -s 0 /etc/machine-id
log "Done"
