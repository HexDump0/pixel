/**
 * Machine size on the fly and the disk rescue: a full disk gets extra room and a cleanup request,
 * goes back to normal once cleaned, stops when out of automatic cleanups, and can be given room by hand.
 * Disk readings are faked: the local runtime measures the host's disk.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { db, getRun } from "../src/db.ts";
import { saveSettings } from "../src/settings.ts";
import { config } from "../src/config.ts";
import { runtime } from "../src/runtime/index.ts";
import { boostDisk, controls, createRun, resizeRun, startWatchdog, stopWatchdog } from "../src/runs/index.ts";
import { getWatcher } from "../src/runs/events.ts";
import { seedTemplates } from "../src/templates.ts";

const GiB = 1024 ** 3;
let used = 0;
const realMetrics = runtime.metrics.bind(runtime);

async function until(what: string, fn: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Make the watchdog take a metrics sample on its next pass. */
const sample = (id: string) => void (getWatcher(id) && (getWatcher(id)!.lastMetrics = 0));
const size = (id: string) => JSON.parse(getRun(id)!.size);
const prompts = (id: string) =>
  db
    .query<{ data: string }, [string]>("SELECT p.data FROM parts p JOIN messages m ON m.id = p.message_id WHERE m.run_id = ? AND m.role = 'user'")
    .all(id)
    .map((r) => JSON.parse(r.data).text as string);

beforeAll(async () => {
  const repo = join(config.dataDir, "repo-resize");
  const sh = (cmd: string[]) => Bun.spawnSync(cmd, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  Bun.spawnSync(["mkdir", "-p", repo]);
  sh(["git", "init", "-q"]);
  await Bun.write(join(repo, "main.c"), "int main(){}\n");
  sh(["git", "add", "."]);
  sh(["git", "commit", "-qm", "init"]);
  process.env.RESIZE_REPO = repo;
  seedTemplates();
  // HANG keeps the fake agent busy after each message, like a real one working.
  saveSettings({ diskFullPercent: 98, diskRescueGiB: 5, diskRescueMax: 1, diskRescueMin: 30, diskRescueMessage: "HANG clean up to {goal}, you have {extra}" });
  runtime.metrics = async (run) => ({ diskUsed: used, diskTotal: JSON.parse(run.size).diskGiB * GiB });
  startWatchdog();
});

afterAll(async () => {
  stopWatchdog();
  runtime.metrics = realMetrics;
  for (const r of db.query<{ id: string }, []>("SELECT id FROM runs").all()) await controls.deleteRun(r.id, true).catch(() => {});
});

describe("machine size", () => {
  test("full disk: extra room and a cleanup request, back to normal once cleaned, stopped when out of cleanups, room by hand", async () => {
    used = 1 * GiB;
    const run = createRun({ repo: process.env.RESIZE_REPO!, templateId: "audit", name: "disky", promptOverride: "HANG", size: { cpu: 2, memoryGiB: 3, diskGiB: 20 } });
    await until("running", () => getRun(run.id)!.status === "running" && !!getRun(run.id)!.session_id && !!getWatcher(run.id));

    used = 19.8 * GiB;
    sample(run.id);
    await until("boost", () => !!getRun(run.id)!.disk_boost);
    let r = getRun(run.id)!;
    expect(size(run.id).diskGiB).toBe(25);
    expect(JSON.parse(r.disk_boost!)).toMatchObject({ baseGiB: 20, extraGiB: 5, by: "pixel" });
    expect(r.disk_rescues).toBe(1);
    expect(r.status).toBe("running");
    await until("cleanup prompt", () => prompts(run.id).some((t) => t.includes("clean up to 17.6 GiB, you have 5 GiB")));

    // Still over the goal: nothing changes.
    used = 18 * GiB;
    sample(run.id);
    await Bun.sleep(700);
    expect(size(run.id).diskGiB).toBe(25);

    used = 12 * GiB;
    sample(run.id);
    await until("back to normal", () => !getRun(run.id)!.disk_boost);
    expect(size(run.id).diskGiB).toBe(20);
    expect(getRun(run.id)!.status).toBe("running");

    // Full again with no automatic cleanups left: stopped.
    used = 19.8 * GiB;
    sample(run.id);
    await until("stopped", () => getRun(run.id)!.status === "stopped");
    r = getRun(run.id)!;
    expect(r.status_detail).toBe("machine disk full");
    expect(r.disk_boost).toBeNull();

    // By hand: room again and the run goes back to work with the cleanup request.
    await boostDisk(run.id, "user");
    r = getRun(run.id)!;
    expect(r.status).toBe("running");
    expect(size(run.id).diskGiB).toBe(25);
    expect(JSON.parse(r.disk_boost!).by).toBe("user");
    expect(r.disk_rescues).toBe(1);

    // Changing memory keeps the boost; setting the disk by hand ends it.
    await resizeRun(run.id, { memoryGiB: 6 });
    expect(size(run.id)).toEqual({ cpu: 2, memoryGiB: 6, diskGiB: 25 });
    expect(getRun(run.id)!.disk_boost).not.toBeNull();
    await resizeRun(run.id, { diskGiB: 40 });
    expect(size(run.id).diskGiB).toBe(40);
    expect(getRun(run.id)!.disk_boost).toBeNull();
    await expect(resizeRun(run.id, { cpu: 0 })).rejects.toThrow("cpu must be between");
    await controls.stopRun(run.id);
  });
});
