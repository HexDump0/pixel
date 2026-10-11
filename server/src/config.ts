import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";

const env = (k: string, d = "") => process.env[k] ?? d;

const dataDir = resolve(env("PIXEL_DATA", join(import.meta.dir, "../../.data")));

export const config = {
  dataDir,
  workbasesDir: join(dataDir, "workbases"),
  historyDir: join(dataDir, "history"),
  /** Per-run directories (target, scratch, home) for the process runtimes (local, single). */
  machinesDir: join(dataDir, "machines"),
  transcriptsDir: join(dataDir, "transcripts"),
  dbPath: join(dataDir, "pixel.db"),
  templatesDir: resolve(import.meta.dir, "../../templates"),
  /** opencode plugins every agent gets (copied into its opencode config; baked into pixel-image for Incus). */
  opencodePluginsDir: resolve(import.meta.dir, "../../opencode-plugins"),

  host: env("PIXEL_HOST", "127.0.0.1"),
  port: Number(env("PIXEL_PORT", "7700")),
  password: env("PIXEL_PASSWORD"),
  /** Hostname or IP that `opencode attach` commands should point at, as seen from the user's machine. */
  publicHost: env("PIXEL_PUBLIC_HOST"),
  /** Base URL of the dashboard, used for links in notifications. */
  publicUrl: env("PIXEL_PUBLIC_URL"),

  runtime: env("PIXEL_RUNTIME", "incus") as "incus" | "single" | "local",

  incus: {
    socket: env("INCUS_SOCKET", "/var/lib/incus/unix.socket"),
    project: env("INCUS_PROJECT", "default"),
    image: env("PIXEL_IMAGE", "pixel-image"),
    pool: env("INCUS_POOL", "default"),
    network: env("INCUS_NETWORK", "incusbr0"),
  },

  /** opencode binary for the process runtimes (local, single). */
  opencodeBin: env("OPENCODE_BIN", "opencode"),

  /** `single` runtime: Pixel and every agent in one container (e.g. a Coolify deployment). */
  single: {
    /** Max processes + threads per agent (fork-bomb guard). */
    maxProcs: Number(env("PIXEL_AGENT_MAX_PROCS", "4096")),
    /** Block agents from private/link-local networks with iptables (needs the NET_ADMIN capability). */
    firewall: env("PIXEL_AGENT_FIREWALL", "on") !== "off",
  },

  /** Stop runs when the data disk has less free space than this (protects whatever else lives on that disk). */
  minFreeGiB: Number(env("PIXEL_MIN_FREE_GIB", "10")),

  /** Paths as the agent sees them inside its VM. The process runtimes use real paths instead. */
  guest: {
    target: "/work/target",
    workbases: "/workbases",
    scratch: "/scratch",
  },

  opencodePort: 4096,
  /** How often the watchdog checks each active run. */
  watchdogMs: Number(env("PIXEL_WATCHDOG_MS", "15000")),
  dev: env("NODE_ENV") !== "production",
};

for (const d of [config.dataDir, config.workbasesDir, config.historyDir, config.machinesDir, config.transcriptsDir]) {
  mkdirSync(d, { recursive: true });
}
