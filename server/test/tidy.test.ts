import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { config } from "../src/config.ts";
import { db } from "../src/db.ts";
import { startMeasure, startTidy, tidyState } from "../src/tidy.ts";

const old = Date.now() - 86_400_000;

async function until(phase: string) {
  for (let i = 0; i < 200 && tidyState().phase !== phase; i++) await Bun.sleep(25);
  expect(tidyState().phase).toBe(phase);
  return tidyState();
}

function file(path: string, content = "x") {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

async function sh(cwd: string, ...cmd: string[]) {
  expect(await Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "ignore" }).exited).toBe(0);
}

describe("upgrading an older database", () => {
  test("saves a copy first and moves PROGRESS.md history to the workbase", async () => {
    const data = mkdtempSync(join(tmpdir(), "pixel-upgrade-"));
    const env = { ...process.env, PIXEL_DATA: data };
    const boot = (code: string) => Bun.spawn(["bun", "-e", `await import(${JSON.stringify(join(import.meta.dir, "../src/db.ts"))}); ${code}`], { env, stdout: "pipe", stderr: "pipe" }).exited;
    expect(await boot("")).toBe(0);
    // Make it look like the pre-redesign schema: version 0 with the progress table.
    const d = new Database(join(data, "pixel.db"));
    d.exec("PRAGMA user_version = 0; CREATE TABLE progress (run_id TEXT NOT NULL, ts INTEGER NOT NULL, content TEXT NOT NULL, added INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (run_id, ts))");
    d.query("INSERT INTO runs (id, repo, model, size, status, runtime, created_at) VALUES ('up-1', 'x', 'p/m', '{}', 'done', 'local', 1)").run();
    d.query("INSERT INTO progress (run_id, ts, content) VALUES ('up-1', 1000, 'first'), ('up-1', 2000, 'second')").run();
    d.close();

    expect(await boot("")).toBe(0);
    expect(existsSync(join(data, "pre-upgrade.db"))).toBe(true);
    const copy = new Database(join(data, "pre-upgrade.db"), { readonly: true });
    expect(copy.query("SELECT COUNT(*) AS n FROM progress").get()).toEqual({ n: 2 });
    copy.close();
    const history = readFileSync(join(data, "workbases/up-1/.pixel/progress-history.md"), "utf8");
    expect(history.indexOf("first")).toBeLessThan(history.indexOf("second"));
    const after = new Database(join(data, "pixel.db"), { readonly: true });
    expect(after.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(after.query("SELECT 1 FROM sqlite_master WHERE name = 'progress'").get()).toBeNull();
    expect(JSON.parse((after.query("SELECT value FROM settings WHERE key = '_preUpgrade'").get() as any).value).from).toBe(0);
    after.close();

    // Later starts leave it alone.
    const mtime = Bun.file(join(data, "pre-upgrade.db")).lastModified;
    expect(await boot("")).toBe(0);
    expect(Bun.file(join(data, "pre-upgrade.db")).lastModified).toBe(mtime);
  });
});

describe("clean-up", () => {
  test("measures, then slims a finished run's folder, deletes orphans, archives and removes old copies", async () => {
    const id = "td-1";
    db.query("INSERT INTO runs (id, repo, model, size, status, runtime, created_at, finished_at) VALUES (?, 'x', 'p/m', '{}', 'done', 'local', ?, ?)").run(id, old, old);
    db.query("INSERT INTO sessions (id, run_id, title, created_at) VALUES ('td-1-s', ?, 'audit', ?)").run(id, old);
    db.query("INSERT INTO messages (id, run_id, session_id, role, data, created_at) VALUES ('td-1-m', ?, 'td-1-s', 'user', '{}', ?)").run(id, old);
    db.query("INSERT INTO parts (id, run_id, session_id, message_id, type, data, updated_at) VALUES ('td-1-p', ?, 'td-1-s', 'td-1-m', 'text', ?, ?)").run(id, JSON.stringify({ id: "td-1-p", type: "text", text: "y".repeat(5000) }), old);

    const dir = join(config.machinesDir, id);
    file(join(dir, "home/.cache/pip/wheel"), "x".repeat(10_000));
    file(join(dir, "home/.cache/opencode/keep"));
    file(join(dir, "home/.local/share/opencode/storage/session"));
    file(join(dir, "scratch/tmp/junk"), "x".repeat(10_000));
    file(join(dir, "scratch/corpus/crash-1"));
    file(join(dir, "target/src/main.c"));
    await sh(join(dir, "target"), "git", "init", "-q");
    await sh(join(dir, "target"), "git", "add", ".");
    await sh(join(dir, "target"), "git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    file(join(dir, "target/build/main.o"), "x".repeat(10_000));
    file(join(config.machinesDir, "gone-run/home/x"));
    file(join(config.transcriptsDir, `${id}.json`), "{}");

    startMeasure();
    const plan = (await until("ready")).plan!;
    expect(plan.transcripts.runs).toBeGreaterThanOrEqual(1);
    expect(plan.copies.files).toBe(1);
    const f = plan.folders.find((x) => x.id === id)!;
    expect(f.slimBytes).toBeGreaterThanOrEqual(30_000);
    expect(f.slimBytes).toBeLessThan(f.bytes);
    expect(plan.folders.find((x) => x.id === "gone-run")!.status).toBeNull();

    startTidy({ transcripts: true, copies: true, compact: true, folders: { [id]: "slim", "gone-run": "delete" } });
    const done = await until("done");
    expect(done.error).toBeUndefined();
    for (const gone of ["home/.cache/pip", "scratch/tmp/junk", "target/build"]) expect(existsSync(join(dir, gone))).toBe(false);
    for (const kept of ["home/.cache/opencode/keep", "home/.local/share/opencode/storage/session", "scratch/corpus/crash-1", "target/src/main.c", "scratch/tmp"]) expect(existsSync(join(dir, kept))).toBe(true);
    expect(existsSync(join(config.machinesDir, "gone-run"))).toBe(false);
    expect(existsSync(join(config.transcriptsDir, `${id}.json`))).toBe(false);
    expect(db.query("SELECT COUNT(*) AS n FROM parts WHERE run_id = ?").get(id)).toEqual({ n: 0 });
    expect(done.log.some((l) => l.startsWith("Database went from"))).toBe(true);
  });
});
