/** /api: knowledge (search, workbases, cross-reads), settings, system status, backups. */
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { config } from "../config.ts";
import { db, listRuns } from "../db.ts";
import { defaultSettings, getSettings, saveSettings, type Settings } from "../settings.ts";
import { runtime } from "../runtime/index.ts";
import { search, workbaseSizes } from "../search.ts";
import { crossReadGraph } from "../crossreads.ts";
import { outcomeText, verdictCounts } from "../knowledge.ts";
import { feed, fleetSnapshot, lanes, recentActivity, runSeries } from "../fleet.ts";
import { notify, notifyStatus } from "../notify.ts";
import { validateModelOverrides, validateProviderOverrides } from "../modelOverrides.ts";
import { getProxy } from "../proxies.ts";
import { backupStatus, runBackup } from "../backup.ts";
import { checkGithub, githubPublic, saveGithub } from "../github.ts";
import { stats } from "../stats.ts";
import { healthSamples } from "../health.ts";
import { get, post, put, readJson } from "./router.ts";

// ---- knowledge ----

get("/search", ({ query }) => search(query.get("q") ?? "", Number(query.get("limit") ?? 50)));
get("/crossreads", () => crossReadGraph());

get("/workbases", async () => {
  const runs = new Map(listRuns().map((r) => [r.id, r]));
  const verdicts = verdictCounts();
  return [...(await workbaseSizes())].map(([id, f]) => {
    const r = runs.get(id);
    return {
      run: id,
      files: f.files,
      bytes: f.bytes,
      last: f.last,
      repo: r?.repo ?? null,
      language: r?.language ?? null,
      status: r?.status ?? null,
      verdict: outcomeText(verdicts[id]) ?? r?.triage_verdict ?? null,
      started_at: r?.started_at ?? null,
      model: r?.model ?? null,
      orphan: !r,
    };
  });
});

get("/workbases/index", () => {
  const p = join(config.workbasesDir, "INDEX.md");
  return { content: existsSync(p) ? readFileSync(p, "utf8") : "" };
});

// ---- fleet telemetry (Runs page, run panel, Activity page) ----

get("/fleet", () => fleetSnapshot());
get("/activity", ({ query }) => recentActivity(Math.min(500, Number(query.get("limit") ?? 200)), query.get("run") ?? undefined));
get("/feed", ({ query }) => feed(Number(query.get("limit") ?? 50), Number(query.get("since") ?? 0)));
get("/runs/:id/series", ({ params: { id } }) => runSeries(id) ?? { from: 0, to: 0, step: 1, tps: [], cost: [], context: [], kinds: {}, marks: [] });
get("/runs/:id/lanes", ({ params: { id }, query }) => lanes(id, Math.min(240, Number(query.get("minutes") ?? 20))) ?? { from: 0, to: 0, lanes: [] });

// ---- settings ----

const withDefaults = (s: Settings) => ({ ...s, defaults: defaultSettings });

get("/settings", () => withDefaults(getSettings()));
put("/settings", async ({ req }) => {
  const patch = await readJson<Record<string, unknown>>(req);
  const known = Object.keys(defaultSettings);
  if (typeof patch.agentAuthJson === "string" && patch.agentAuthJson.trim()) {
    let v: unknown;
    try {
      v = JSON.parse(patch.agentAuthJson);
    } catch {}
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("opencode auth.json must be a JSON object");
  }
  if (patch.thinkingLevels !== undefined) validateThinking(patch.thinkingLevels);
  if (typeof patch.defaultProxy === "string" && patch.defaultProxy && !getProxy(patch.defaultProxy)) throw new Error(`no proxy ${patch.defaultProxy}`);
  if (patch.modelOverrides !== undefined) validateModelOverrides(patch.modelOverrides);
  if (patch.providerOverrides !== undefined) validateProviderOverrides(patch.providerOverrides);
  saveSettings(Object.fromEntries(Object.entries(patch).filter(([k]) => known.includes(k))) as Partial<Settings>);
  return withDefaults(getSettings());
});
get("/github", () => githubPublic());
put("/github", async ({ req }) => saveGithub(await readJson(req)));
post("/github/check", () => checkGithub());
post("/settings/test-notify", async () => ({
  results: await notify("test", "Pixel test notification", "If you can read this, notifications work.", config.publicUrl || undefined),
}));
get("/settings/notify-status", () => notifyStatus());

function validateThinking(v: unknown) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("thinkingLevels must be an object");
  for (const [model, levels] of Object.entries(v)) {
    if (!model.includes("/")) throw new Error(`thinking levels: ${model} is not provider/model`);
    if (!levels || typeof levels !== "object" || Array.isArray(levels)) throw new Error(`thinking levels for ${model} must be an object`);
    for (const [name, opts] of Object.entries(levels)) {
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) throw new Error(`thinking level name "${name}": lowercase letters, digits, - or _`);
      if (!opts || typeof opts !== "object" || Array.isArray(opts)) throw new Error(`thinking level ${name}: options must be a JSON object`);
      if (JSON.stringify(opts).length > 2000) throw new Error(`thinking level ${name}: options too long`);
    }
  }
}

// ---- system ----

function diskOf(path: string) {
  try {
    const fs = statfsSync(path);
    return { total: fs.blocks * fs.bsize, free: fs.bavail * fs.bsize };
  } catch {
    return null;
  }
}

const RESERVING: string[] = ["preparing", "running", "recovering", "paused", "stopped", "done"];

get("/system", async () => {
  const runs = listRuns();
  const [info, machines] = await Promise.all([runtime.info().catch((e) => ({ error: e.message })), runtime.listMachines().catch(() => [])]);
  return {
    host: { memTotal: totalmem(), memFree: freemem(), load: loadavg(), cpus: cpus().length, disk: diskOf(config.dataDir), dataDir: config.dataDir },
    runtime: info,
    machines,
    /** Memory promised to machines that still exist (VMs of done runs are stopped but kept). */
    committedMemoryGiB: runs.filter((r) => RESERVING.includes(r.status)).reduce((n, r) => n + JSON.parse(r.size).memoryGiB, 0),
    activeRuns: runs.filter((r) => ["preparing", "running", "recovering"].includes(r.status)).length,
    backup: backupStatus(),
    // With the WAL, which holds recent writes until a checkpoint folds them into the file.
    dbBytes: Bun.file(config.dbPath).size + Bun.file(`${config.dbPath}-wal`).size,
  };
});
post("/backup", () => runBackup());

/**
 * SQLite never gives freed space back to the disk (archived transcripts, the old search index).
 * VACUUM rewrites the file; it blocks Pixel while it runs (seconds for a few hundred MB), so it's
 * a button, not a schedule. Live events wait in their sockets meanwhile.
 */
get("/system/health", () => healthSamples());

post("/system/compact", () => {
  const before = Bun.file(config.dbPath).size;
  const t = Date.now();
  db.exec("VACUUM");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return { before, after: Bun.file(config.dbPath).size, ms: Date.now() - t };
});
get("/stats", ({ query }) => stats(Number(query.get("days") ?? 7), Number(query.get("tz") ?? 0)));
