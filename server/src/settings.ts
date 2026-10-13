/** Pixel's own settings, stored as JSON values in the settings table and edited from the dashboard. */
import { db, type RunSize } from "./db.ts";

export interface Settings {
  defaultModel: string;
  models: string[];
  sizePresets: Record<string, RunSize>;
  defaultSize: string;
  maxAutoContinues: number;
  maxOomRestarts: number;
  workbaseLimitGiB: number;
  diskFullPercent: number;
  continueMessage: string;
  oomMessage: string;
  /** Reject an agent's question after this many minutes without an answer, so autopilot runs don't block (0 = wait forever). */
  questionTimeoutMin: number;
  /** Environment variables injected into every agent VM (provider keys, read-only GitHub token...). */
  agentEnv: Record<string, string>;
  /** opencode auth.json contents injected into every agent VM (optional). */
  agentAuthJson: string;
  notify: {
    ntfyUrl: string;
    telegramToken: string;
    telegramChat: string;
    on: { done: boolean; stopped: boolean; question: boolean; failed: boolean };
  };
  backup: {
    repository: string;
    password: string;
    env: Record<string, string>;
    dailyHour: number; // -1 = off
  };
  historyIntervalMin: number;
  /** Per-minute limits per "provider/model" (tokens, requests), shown against live usage on the Models page. */
  providerLimits: Record<string, { tpm?: number; rpm?: number }>;
  /** Custom thinking levels per "provider/model": level name → provider options (opencode model variants). */
  thinkingLevels: Record<string, Record<string, Record<string, unknown>>>;
  /** New runs switch to the provider's next key when theirs runs out or is rejected. */
  keyFailover: boolean;
}

export const defaultSettings: Settings = {
  defaultModel: "opencode/big-pickle",
  models: ["opencode/big-pickle"],
  sizePresets: {
    light: { cpu: 2, memoryGiB: 3, diskGiB: 20 },
    standard: { cpu: 3, memoryGiB: 4, diskGiB: 20 },
    heavy: { cpu: 4, memoryGiB: 6, diskGiB: 20 },
  },
  defaultSize: "standard",
  maxAutoContinues: 3,
  maxOomRestarts: 3,
  workbaseLimitGiB: 5,
  diskFullPercent: 98,
  continueMessage: "continue your work",
  oomMessage: "continue your work, the oom killer killed you that was the reason for your stop",
  questionTimeoutMin: 30,
  agentEnv: {},
  agentAuthJson: "",
  notify: {
    ntfyUrl: "",
    telegramToken: "",
    telegramChat: "",
    on: { done: true, stopped: true, question: true, failed: true },
  },
  backup: { repository: "", password: "", env: {}, dailyHour: -1 },
  historyIntervalMin: 5,
  providerLimits: {},
  thinkingLevels: {},
  keyFailover: true,
};

export function getSettings(): Settings {
  const rows = db.query<{ key: string; value: string }, []>("SELECT key, value FROM settings").all();
  const s: any = structuredClone(defaultSettings);
  for (const r of rows) {
    if (r.key.startsWith("_")) continue;
    try {
      s[r.key] = JSON.parse(r.value);
    } catch {}
  }
  return s;
}

export function saveSettings(patch: Partial<Settings>) {
  const stmt = db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (const [k, v] of Object.entries(patch)) stmt.run(k, JSON.stringify(v));
}

export function getSecret(): string {
  const row = db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = '_secret'").get();
  if (row) return JSON.parse(row.value);
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  db.query("INSERT INTO settings (key, value) VALUES ('_secret', ?)").run(JSON.stringify(secret));
  return secret;
}

