# Pixel control plane. Agents never run here; they run in Incus VMs on the same host.
FROM oven/bun:1.4-debian

RUN apt-get update \
 && apt-get install -y --no-install-recommends git restic ca-certificates openssh-client \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
RUN bun install --frozen-lockfile
COPY server ./server
COPY web ./web
COPY templates ./templates

ENV NODE_ENV=production \
    PIXEL_DATA=/srv/pixel \
    PIXEL_RUNTIME=incus

# Git identity for workbase history snapshots happens per command; mark the data dir safe for git.
RUN git config --system safe.directory '*'

CMD ["bun", "server/src/index.ts"]
