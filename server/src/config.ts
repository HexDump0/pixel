import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";

const env = (k: string, d = "") => process.env[k] ?? d;

const dataDir = resolve(env("PIXEL_DATA", join(import.meta.dir, "../../.data")));

export const config = {
  dataDir,
  workbasesDir: join(dataDir, "workbases"),
  historyDir: join(dataDir, "history"),
  localDir: join(dataDir, "local"),
  transcriptsDir: join(dataDir, "transcripts"),
  dbPath: join(dataDir, "pixel.db"),
  templatesDir: resolve(import.meta.dir, "../../templates"),

  host: env("PIXEL_HOST", "127.0.0.1"),
  port: Number(env("PIXEL_PORT", "7700")),
  password: env("PIXEL_PASSWORD"),
  /** Hostname or IP that `opencode attach` commands should point at, as seen from the user's machine. */
  publicHost: env("PIXEL_PUBLIC_HOST"),
  /** Base URL of the dashboard, used for links in notifications. */
  publicUrl: env("PIXEL_PUBLIC_URL"),

  runtime: env("PIXEL_RUNTIME", "incus") as "incus" | "local",

  incus: {
    socket: env("INCUS_SOCKET", "/var/lib/incus/unix.socket"),
    project: env("INCUS_PROJECT", "default"),
    image: env("PIXEL_IMAGE", "pixel-image"),
    pool: env("INCUS_POOL", "default"),
    network: env("INCUS_NETWORK", "incusbr0"),
  },

  local: {
    opencodeBin: env("OPENCODE_BIN", "opencode"),
  },

  /** Paths as the agent sees them inside its VM. The local runtime overrides these with host paths. */
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

for (const d of [config.dataDir, config.workbasesDir, config.historyDir, config.localDir, config.transcriptsDir]) {
  mkdirSync(d, { recursive: true });
}
