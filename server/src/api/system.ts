/** /api: knowledge (search, workbases, cross-reads), settings, system status, backups. */
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { config } from "../config.ts";
import { db, listRuns } from "../db.ts";
import { defaultSettings, getSettings, saveSettings, type Settings } from "../settings.ts";
import { runtime } from "../runtime/index.ts";
import { search } from "../search.ts";
import { crossReadGraph } from "../crossreads.ts";
import { fleetSnapshot, lanes, recentActivity } from "../fleet.ts";
import { notify } from "../notify.ts";
import { backupStatus, runBackup } from "../backup.ts";
import { get, post, put, readJson } from "./router.ts";

// ---- knowledge ----

get("/search", ({ query }) => search(query.get("q") ?? "", Number(query.get("limit") ?? 50)));
get("/crossreads", () => crossReadGraph());

get("/workbases", () => {
  const runs = new Map(listRuns().map((r) => [r.id, r]));
  return db
    .query<{ run_id: string; n: number; bytes: number; last: number }, []>("SELECT run_id, COUNT(*) AS n, SUM(size) AS bytes, MAX(mtime) AS last FROM files_index GROUP BY run_id")
    .all()
    .map((f) => {
      const r = runs.get(f.run_id);
      return {
        run: f.run_id,
        files: f.n,
        bytes: f.bytes,
        last: f.last,
        repo: r?.repo ?? null,
        language: r?.language ?? null,
        status: r?.status ?? null,
        verdict: r?.triage_verdict ?? null,
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
  saveSettings(Object.fromEntries(Object.entries(patch).filter(([k]) => known.includes(k))) as Partial<Settings>);
  return withDefaults(getSettings());
});
post("/settings/test-notify", async () => ({
  results: await notify("test", "Pixel test notification", "If you can read this, notifications work.", config.publicUrl || undefined),
}));

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
    dbBytes: Bun.file(config.dbPath).size,
    indexedBytes: db.query<{ b: number | null }, []>("SELECT SUM(size) AS b FROM files_index").get()?.b ?? 0,
  };
});
post("/backup", () => runBackup());
