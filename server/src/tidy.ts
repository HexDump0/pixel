/**
 * Clean-up from the System page, for after an upgrade or a long stretch of runs. It measures first and
 * changes nothing until asked, then:
 * - moves the transcripts of every finished run out of the database now (archive.ts), not after a week;
 * - removes the uncompressed transcript copies Pixel wrote at finish before 2026-10-16 (nothing reads them);
 * - slims or deletes finished runs' folders (process runtimes: machines/<run>). Slim keeps what a resume
 *   needs (opencode's data, the checkout's tracked files, scratch outside tmp) and drops caches, untracked
 *   files in the checkout (build outputs) and temp files. Delete is the run menu's Delete machine;
 * - compacts the database.
 * Workbases are never touched.
 */
import { existsSync, readdirSync, rmSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { ACTIVE_STATUSES, db, getRun, type RunStatus } from "./db.ts";
import { archiveOldRuns, runsToArchive } from "./archive.ts";
import { runtime } from "./runtime/index.ts";
import { deleteMachine } from "./runs/controls.ts";
import { unwatch } from "./runs/events.ts";
import { setRun, timeline } from "./runs/state.ts";

export interface TidyFolder {
  id: string;
  label: string | null;
  /** null: the run no longer exists. */
  status: RunStatus | null;
  bytes: number;
  /** What slimming would free. */
  slimBytes: number;
}

export interface TidyPlan {
  measuredAt: number;
  /** Finished runs whose transcripts are still in the database. */
  transcripts: { runs: number; bytes: number };
  /** transcripts/<run>.json from before 2026-10-16. */
  copies: { files: number; bytes: number };
  folders: TidyFolder[];
  db: { bytes: number; inUse: number; canCompact: boolean };
  disk: { free: number; total: number };
}

export interface TidyChoices {
  transcripts?: boolean;
  copies?: boolean;
  folders?: Record<string, "slim" | "delete">;
  compact?: boolean;
}

export interface TidyState {
  phase: "idle" | "measuring" | "ready" | "working" | "done";
  step?: string;
  plan?: TidyPlan;
  log: string[];
  error?: string;
  /** Disk space freed by the last clean-up. */
  freed?: number;
}

let state: TidyState = { phase: "idle", log: [] };
export const tidyState = () => state;

const HOME_CACHES = [".npm", ".cargo/registry", ".cargo/git", "go/pkg/mod", ".gradle/caches", ".m2/repository", ".bun/install/cache"];
const FINISHED = (s: RunStatus) => !ACTIVE_STATUSES.includes(s);

function disk() {
  const fs = statfsSync(config.dataDir);
  return { free: fs.bavail * fs.bsize, total: fs.blocks * fs.bsize };
}

export const dbBytes = () => Bun.file(config.dbPath).size + Bun.file(`${config.dbPath}-wal`).size;

/** Bytes the database's live pages take (what VACUUM would leave). */
function dbInUse() {
  const n = (p: string) => (db.query(`PRAGMA ${p}`).get() as Record<string, number>)[p];
  return (n("page_count") - n("freelist_count")) * n("page_size");
}

/** VACUUM writes a temporary copy of the live pages and as much again to the WAL. */
const roomToCompact = () => disk().free > 2 * dbInUse() + 512 * 1024 ** 2;

export function compactDb() {
  if (!roomToCompact()) throw new Error("not enough free disk to compact the database (it needs about twice its live size)");
  const before = dbBytes();
  const t = Date.now();
  db.exec("VACUUM");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return { before, after: dbBytes(), ms: Date.now() - t };
}

async function run(cmd: string[]) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

const chunks = <T>(xs: T[], n = 200) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Disk usage of the paths together. */
async function du(paths: string[]) {
  let total = 0;
  for (const c of chunks(paths.filter((p) => existsSync(p)))) {
    const r = await run(["du", "-scB1", "--", ...c]);
    total += Number(r.out.trim().split("\n").pop()?.split("\t")[0]) || 0;
  }
  return total;
}

const children = (dir: string, except: string[] = []) => (existsSync(dir) ? readdirSync(dir).filter((n) => !except.includes(n)).map((n) => join(dir, n)) : []);

/** What slimming a run folder removes. */
async function slimPaths(dir: string) {
  const home = join(dir, "home");
  const target = join(dir, "target");
  const paths = [...children(join(home, ".cache"), ["opencode"]), ...HOME_CACHES.map((c) => join(home, c)), ...children(join(dir, "scratch", "tmp"))];
  if (existsSync(join(target, ".git"))) {
    // Untracked and ignored files, nested clones included; tracked files stay so the run can carry on.
    const r = await run(["git", "-c", "safe.directory=*", "-c", "core.quotePath=false", "-C", target, "clean", "-ndxff"]);
    for (const line of r.out.split("\n")) {
      const m = /^Would remove (.+?)\/?$/.exec(line);
      if (m && !m[1].startsWith('"')) paths.push(join(target, m[1]));
    }
  }
  return paths.filter((p) => existsSync(p));
}

function folderIds() {
  if (config.runtime === "incus") return [];
  return readdirSync(config.machinesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name);
}

const busy = () => state.phase === "measuring" || state.phase === "working";

async function measure(): Promise<TidyPlan> {
  const finished = runsToArchive(Date.now(), 0);
  let partBytes = 0;
  const size = db.query<{ n: number }, [string]>("SELECT COALESCE(SUM(length(CAST(data AS BLOB))), 0) AS n FROM parts WHERE session_id IN (SELECT id FROM sessions WHERE run_id = ?)");
  for (const [i, id] of finished.entries()) {
    state.step = `Measuring transcripts (${i + 1} of ${finished.length})`;
    partBytes += size.get(id)!.n;
    await Bun.sleep(0);
  }

  const copies = readdirSync(config.transcriptsDir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".json"));
  const copyBytes = copies.reduce((n, e) => n + Bun.file(join(config.transcriptsDir, e.name)).size, 0);

  const folders: TidyFolder[] = [];
  const ids = folderIds();
  for (const [i, id] of ids.entries()) {
    const r = getRun(id);
    if (r && !FINISHED(r.status)) continue;
    state.step = `Measuring run folders (${i + 1} of ${ids.length})`;
    const dir = join(config.machinesDir, id);
    const bytes = await du([dir]);
    folders.push({ id, label: r?.label ?? null, status: r?.status ?? null, bytes, slimBytes: r ? await du(await slimPaths(dir)) : bytes });
  }
  folders.sort((a, b) => b.bytes - a.bytes);

  return {
    measuredAt: Date.now(),
    transcripts: { runs: finished.length, bytes: partBytes },
    copies: { files: copies.length, bytes: copyBytes },
    folders,
    db: { bytes: dbBytes(), inUse: dbInUse(), canCompact: roomToCompact() },
    disk: disk(),
  };
}

export function startMeasure() {
  if (busy()) throw new Error("already busy");
  state = { phase: "measuring", log: [], step: "Measuring" };
  measure().then(
    (plan) => (state = { phase: "ready", plan, log: [] }),
    (e) => (state = { phase: "idle", log: [], error: e.message }),
  );
}

const mb = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);

/** Stop the run's opencode before files go (a resume or a message starts it again, as after Free memory). */
async function quiet(id: string) {
  const r = getRun(id)!;
  unwatch(id);
  if (r.endpoint && !r.asleep) {
    await runtime.release(r);
    setRun(id, { asleep: 1 });
  }
}

async function remove(paths: string[]) {
  for (const c of chunks(paths)) await run(["rm", "-rf", "--", ...c]);
}

async function slimFolder(id: string) {
  const dir = join(config.machinesDir, id);
  await quiet(id);
  const paths = await slimPaths(dir);
  const before = await du([dir]);
  await remove(paths);
  const freed = before - (await du([dir]));
  timeline(id, "user", "vm", `Folder slimmed: caches, untracked files in the checkout and temp files removed (${mb(freed)}); the run can still be resumed`);
  return freed;
}

async function deleteFolder(id: string) {
  const dir = join(config.machinesDir, id);
  const before = await du([dir]);
  if (getRun(id)) {
    await quiet(id);
    // The bulk goes in a separate process; destroy's own rmSync would hold up Pixel on large trees.
    await remove(children(dir));
    await deleteMachine(id);
  } else await remove([dir]);
  return before;
}

async function apply(c: TidyChoices) {
  const startFree = disk().free;
  const log = (line: string) => state.log.push(line);

  const folders = Object.entries(c.folders ?? {});
  for (const [i, [id, how]] of folders.entries()) {
    const r = getRun(id);
    if (r && !FINISHED(r.status)) {
      log(`Skipped ${r.label ?? id}: it is ${r.status} again`);
      continue;
    }
    state.step = `${how === "slim" ? "Slimming" : "Deleting"} run folders (${i + 1} of ${folders.length})`;
    try {
      const freed = how === "slim" && r ? await slimFolder(id) : await deleteFolder(id);
      log(`${how === "slim" && r ? "Slimmed" : "Deleted"} the folder of ${r?.label ?? id}: ${mb(freed)}`);
    } catch (e: any) {
      log(`Folder of ${r?.label ?? id} failed: ${e.message}`);
    }
  }

  if (c.transcripts) {
    const parts = await archiveOldRuns(0, (_, i, n) => (state.step = `Moving transcripts out of the database (${i + 1} of ${n})`));
    log(`Moved ${parts.toLocaleString()} transcript parts to compressed files`);
  }

  if (c.copies) {
    state.step = "Removing old transcript copies";
    const files = readdirSync(config.transcriptsDir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".json"));
    for (const f of files) rmSync(join(config.transcriptsDir, f.name), { force: true });
    log(`Removed ${files.length} old transcript copies`);
  }

  if (c.compact) {
    state.step = "Compacting the database (Pixel pauses meanwhile)";
    // Let the step reach the page before VACUUM holds the thread.
    await Bun.sleep(1500);
    try {
      const r = compactDb();
      log(`Database went from ${mb(r.before)} to ${mb(r.after)} in ${(r.ms / 1000).toFixed(1)} s`);
    } catch (e: any) {
      log(`Compacting failed: ${e.message}`);
    }
  }

  return disk().free - startFree;
}

export function startTidy(c: TidyChoices) {
  if (busy()) throw new Error("already busy");
  state = { phase: "working", log: [], step: "Starting", plan: state.plan };
  apply(c).then(
    (freed) => (state = { ...state, phase: "done", step: undefined, freed }),
    (e) => (state = { ...state, phase: "done", step: undefined, error: e.message }),
  );
}
