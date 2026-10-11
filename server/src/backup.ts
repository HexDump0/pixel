/** Off-server backups of the data dir (workbases, SQLite, history, transcripts) with restic. */
import { config } from "./config.ts";
import { db } from "./db.ts";
import { getSettings } from "./settings.ts";
import { publish } from "./bus.ts";

export interface BackupStatus {
  running: boolean;
  last?: { ts: number; ok: boolean; output: string };
}

let running = false;

function lastBackup(): BackupStatus["last"] {
  const row = db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = '_lastBackup'").get();
  return row ? JSON.parse(row.value) : undefined;
}

export const backupStatus = (): BackupStatus => ({ running, last: lastBackup() });

async function restic(args: string[]) {
  const b = getSettings().backup;
  const p = Bun.spawn(["restic", ...args], {
    env: { ...process.env, ...b.env, RESTIC_REPOSITORY: b.repository, RESTIC_PASSWORD: b.password },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: (out + err).slice(-4000) };
}

export async function runBackup() {
  const b = getSettings().backup;
  if (!b.repository || !b.password) throw new Error("backup repository and password are not set (Settings → Backups)");
  if (running) throw new Error("a backup is already running");
  running = true;
  publish("*", "backup", { running: true });
  let result: { ts: number; ok: boolean; output: string };
  try {
    // Consistent copy of the database first; the WAL file alone isn't safe to copy mid-write.
    const dbCopy = `${config.dataDir}/pixel-backup.db`;
    await Bun.file(dbCopy).delete().catch(() => {});
    db.exec(`VACUUM INTO '${dbCopy.replace(/'/g, "''")}'`);
    let r = await restic(["cat", "config"]);
    if (r.code !== 0) {
      r = await restic(["init"]);
      if (r.code !== 0) throw new Error(`restic init failed: ${r.out}`);
    }
    r = await restic(["backup", "--tag", "pixel", "--exclude", "pixel.db", "--exclude", "pixel.db-wal", "--exclude", "pixel.db-shm", "--exclude", "local", config.dataDir]);
    result = { ts: Date.now(), ok: r.code === 0, output: r.out };
    if (r.code === 0) await restic(["forget", "--tag", "pixel", "--keep-daily", "14", "--keep-weekly", "8", "--keep-monthly", "12", "--prune"]);
  } catch (e: any) {
    result = { ts: Date.now(), ok: false, output: e.message };
  } finally {
    running = false;
  }
  db.query("INSERT INTO settings (key, value) VALUES ('_lastBackup', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(result));
  publish("*", "backup", { running: false, last: result });
  return result;
}

/** Hourly tick: back up once a day at the configured hour. */
export function startBackupSchedule() {
  setInterval(() => {
    const b = getSettings().backup;
    if (b.dailyHour < 0 || !b.repository || running) return;
    const now = new Date();
    if (now.getHours() !== b.dailyHour) return;
    const last = lastBackup();
    if (last && now.getTime() - last.ts < 20 * 3600_000) return;
    runBackup().catch((e) => console.error("backup failed", e));
  }, 10 * 60_000);
}
