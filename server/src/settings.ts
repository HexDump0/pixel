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
  /** A run whose machine disk fills up gets this many GiB extra for a while and is asked to clean up (0 = just stop it). */
  diskRescueGiB: number;
  /** Automatic cleanups per run; after that a full disk stops the run. */
  diskRescueMax: number;
  /** Minutes the agent has to get back under its normal disk before the run stops. */
  diskRescueMin: number;
  /** Sent to the agent with the extra disk. {used} {limit} {extra} {goal} {dirs} are filled in. */
  diskRescueMessage: string;
  continueMessage: string;
  /** This many tool calls after an automatic continue count as progress and reset the count (0 = never reset). */
  continueResetCalls: number;
  /** The agent ended its turn with only background shell commands running: wait this long, then nudge it (0 = wait for them however long). */
  backgroundWaitMin: number;
  /** Sent after that wait; not counted as a continue. {commands} and {minutes} are filled in. */
  backgroundWaitMessage: string;
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
    on: { done: boolean; stopped: boolean; question: boolean; failed: boolean; deadline: boolean };
  };
  /** Days from sending a finding upstream to its disclosure deadline. */
  disclosureDays: number;
  /** A sent finding counts as due soon (amber, one notification) this many days before its deadline. */
  disclosureWarnDays: number;
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
  /** Stop the opencode of a run paused or stopped this long, to free its memory; it starts again on resume or a message (0 = never). */
  releaseIdleMin: number;
  /** Proxy id new runs use for their model calls; "" = none. */
  defaultProxy: string;
  /** Per "provider/model": values put over the catalogue in opencode's config (modelOverrides.ts). */
  modelOverrides: Record<string, ModelOverride>;
  /** Per provider id: request timeouts and extra options for all its models. */
  providerOverrides: Record<string, ProviderOverride>;
}

/** What you can change about a model by hand; anything left out comes from the catalogue. */
export interface ModelOverride {
  /** Tokens. */
  context?: number;
  output?: number;
  input?: number;
  /** USD per million tokens. */
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  reasoning?: boolean;
  tool_call?: boolean;
  attachment?: boolean;
  /** Whether the model accepts a temperature at all. */
  temperature?: boolean;
  /** opencode model options, passed to the AI SDK with every request. */
  options?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface ProviderOverride {
  /** Milliseconds; 0 turns the timeout off. */
  timeout?: number;
  headerTimeout?: number;
  chunkTimeout?: number;
  /** Extra opencode provider options (merged over baseURL and the rest). */
  options?: Record<string, unknown>;
  headers?: Record<string, string>;
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
  diskRescueGiB: 5,
  diskRescueMax: 3,
  diskRescueMin: 30,
  diskRescueMessage:
    "Your machine's disk filled up ({used} of {limit}), so Pixel stopped your last step. You have {extra} extra for a short while to clean up. Delete what you no longer need on the machine ({dirs}): build trees and object files, fuzzing corpora and crashes you have already triaged, core dumps, downloaded archives, caches such as ~/.cache and pip, npm or cargo caches. Keep your workbase and anything you still need. Get usage under {goal} (check with du -sh and df -h), then carry on with your work and keep an eye on disk use from now on. The extra space goes away once you are under {goal}.",
  continueMessage: "continue your work",
  continueResetCalls: 10,
  backgroundWaitMin: 60,
  backgroundWaitMessage:
    "Your background commands are still running after {minutes} minutes: {commands}. If you need their result, check their output; otherwise carry on with other work. Keep working until you have written REPORT.md.",
  oomMessage: "continue your work, the oom killer killed you that was the reason for your stop",
  questionTimeoutMin: 30,
  agentEnv: {},
  agentAuthJson: "",
  notify: {
    ntfyUrl: "",
    telegramToken: "",
    telegramChat: "",
    on: { done: true, stopped: true, question: true, failed: true, deadline: true },
  },
  disclosureDays: 90,
  disclosureWarnDays: 14,
  backup: { repository: "", password: "", env: {}, dailyHour: -1 },
  historyIntervalMin: 5,
  providerLimits: {},
  thinkingLevels: {},
  keyFailover: true,
  releaseIdleMin: 15,
  defaultProxy: "",
  modelOverrides: {},
  providerOverrides: {},
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
  // Notification switches added later default to on for settings saved before them.
  s.notify = { ...defaultSettings.notify, ...s.notify, on: { ...defaultSettings.notify.on, ...s.notify?.on } };
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

