/**
 * Run lifecycle against the fake opencode (local runtime): done on report, automatic continues,
 * stop after the limit, recovery from a SIGKILL ("OOM") of opencode.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getRun, db } from "../src/db.ts";
import { saveSettings } from "../src/settings.ts";
import { config } from "../src/config.ts";
import { createRun, startWatchdog, stopWatchdog, controls } from "../src/runs/index.ts";
import { seedTemplates } from "../src/templates.ts";
import { addKey, providerKeys, saveAccount } from "../src/providerAccounts.ts";

let repo: string;

async function until(what: string, fn: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const timelineKinds = (id: string) => db.query<{ kind: string }, [string]>("SELECT kind FROM timeline WHERE run_id = ? ORDER BY id").all(id).map((r) => r.kind);

beforeAll(async () => {
  repo = join(config.dataDir, "repo");
  const sh = (cmd: string[]) => Bun.spawnSync(cmd, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  Bun.spawnSync(["mkdir", "-p", repo]);
  sh(["git", "init", "-q"]);
  await Bun.write(join(repo, "main.c"), "int main(){}\n");
  sh(["git", "add", "."]);
  sh(["git", "commit", "-qm", "init"]);
  seedTemplates();
  saveSettings({ maxAutoContinues: 2, continueMessage: "continue your work" });
  startWatchdog();
});

afterAll(async () => {
  stopWatchdog();
  for (const r of db.query<{ id: string }, []>("SELECT id FROM runs").all()) await controls.deleteRun(r.id, true).catch(() => {});
});

describe("run lifecycle", () => {
  test("report written → done, commit and language recorded", async () => {
    const run = createRun({ repo, templateId: "audit", name: "ok", promptOverride: "REPORT {{workbase}}/REPORT.md" });
    await until("done", () => getRun(run.id)!.status === "done");
    const r = getRun(run.id)!;
    expect(r.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.language).toBe("C");
    expect(r.report_ready).toBe(1);
    expect(r.tokens_in).toBeGreaterThan(0);
    const runJson = JSON.parse(readFileSync(join(config.workbasesDir, run.id, ".pixel/run.json"), "utf8"));
    expect(runJson.status).toBe("done");
    expect(readFileSync(join(config.workbasesDir, "INDEX.md"), "utf8")).toContain("| ok |");
  });

  test("no report → continues up to the limit, then stopped", async () => {
    const run = createRun({ repo, templateId: "audit", name: "giveup", promptOverride: "just stop" });
    await until("stopped", () => getRun(run.id)!.status === "stopped");
    expect(getRun(run.id)!.continues).toBe(2);
    expect(timelineKinds(run.id).filter((k) => k === "continue").length).toBe(2);
    const prompts = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM messages WHERE run_id = ? AND role = 'user'").get(run.id)!.n;
    expect(prompts).toBe(3);
  });

  test("stopped after its continues, key replaced → resume restarts opencode with the new key and starts over", async () => {
    const run = createRun({ repo, templateId: "audit", name: "newkey", promptOverride: "just stop" });
    await until("stopped", () => getRun(run.id)!.status === "stopped");
    saveSettings({ agentEnv: { FAKE_API_KEY: "new" } });
    await controls.resumeRun(run.id, `REPORT ${join(config.workbasesDir, run.id, "REPORT.md")}`);
    expect(getRun(run.id)!.continues).toBe(0);
    expect(timelineKinds(run.id)).toContain("restart");
    const launch = JSON.parse(readFileSync(join(config.machinesDir, ".launch", `${run.id}.json`), "utf8"));
    expect(launch.env.FAKE_API_KEY).toBe("new");
    await until("done", () => getRun(run.id)!.status === "done");
    saveSettings({ agentEnv: {} });
  });

  test("opencode SIGKILLed → restarted, OOM message sent to the same session", async () => {
    saveSettings({ oomMessage: "the oom killer killed you" });
    const run = createRun({ repo, templateId: "audit", name: "oom", promptOverride: "HANG" });
    await until("running", () => getRun(run.id)!.status === "running" && !!getRun(run.id)!.session_id);
    const session = getRun(run.id)!.session_id;
    const pid = Number(readFileSync(join(config.machinesDir, ".launch", `${run.id}.pid`), "utf8"));
    process.kill(pid, "SIGKILL");
    await until("oom restart", () => getRun(run.id)!.oom_restarts === 1);
    await until("running again", () => getRun(run.id)!.status === "running");
    expect(getRun(run.id)!.session_id).toBe(session);
    expect(timelineKinds(run.id)).toContain("recover");
    await until("oom message stored", () => !!db.query("SELECT 1 FROM parts WHERE run_id = ? AND data LIKE '%the oom killer killed you%'").get(run.id));
    await controls.stopRun(run.id);
  });

  test("rename: display name is trimmed, cleared by an empty name, and the id never changes", () => {
    const run = createRun({ repo, templateId: "audit", name: "named", promptOverride: "HANG" });
    controls.setLabel(run.id, "  Folia   chunk  regression ");
    expect(getRun(run.id)!.label).toBe("Folia chunk regression");
    expect(timelineKinds(run.id)).toContain("rename");
    controls.setLabel(run.id, "");
    expect(getRun(run.id)!.label).toBeNull();
    expect(() => controls.setLabel("no-such-run", "x")).toThrow();
    void controls.stopRun(run.id);
  });

  test("key failover: a key out of credit moves the run to the next key; with failover off it pauses", async () => {
    await saveAccount({ id: "kp", baseURL: "http://127.0.0.1:9/v1", key: "dead-key-1", custom: { models: ["m"] } });
    const live = addKey("kp", { name: "Live", key: "live-key-2", note: "spare" });
    const [dead] = providerKeys("kp");
    const auth = (id: string) => [...new Bun.Glob(`**/${id}/home/.local/share/opencode/auth.json`).scanSync({ cwd: config.dataDir, dot: true })].map((f) => readFileSync(join(config.dataDir, f), "utf8")).join("");

    const run = createRun({ repo, templateId: "audit", name: "keys-on", model: "kp/m", promptOverride: "KEYCHECK" });
    expect(getRun(run.id)!.key_failover).toBe(1);
    await until("switched key", () => getRun(run.id)!.key_id === live.id && getRun(run.id)!.status === "running", 30_000);
    const tl = db.query<{ message: string }, [string]>("SELECT message FROM timeline WHERE run_id = ? AND kind = 'key'").all(run.id).map((r) => r.message);
    expect(tl[0]).toContain("Key Default is out of credit (HTTP 402: insufficient balance). Switched to key Live");
    expect(providerKeys("kp").find((k) => k.id === dead.id)!.status).toMatchObject({ state: "credit" });
    await until("new key pushed", () => auth(run.id).includes("live-key-2"));
    await controls.stopRun(run.id);

    // Both keys failing now (the dead one is marked), failover off: the run pauses and says why.
    const off = createRun({ repo, templateId: "audit", name: "keys-off", model: "kp/m", keyId: dead.id, keyFailover: false, promptOverride: "KEYCHECK" });
    await until("paused", () => getRun(off.id)!.status === "paused", 30_000);
    expect(getRun(off.id)!.status_detail).toContain("failover is off for this run");
    expect(getRun(off.id)!.key_id).toBe(dead.id);
    await controls.stopRun(off.id);
  }, 60_000);

  test("manual controls: pause stops autopilot, message reopens", async () => {
    const run = createRun({ repo, templateId: "audit", name: "manual", promptOverride: "HANG" });
    await until("running", () => getRun(run.id)!.status === "running" && !!getRun(run.id)!.session_id);
    await controls.abortRun(run.id);
    expect(getRun(run.id)!.status).toBe("paused");
    await Bun.sleep(1000);
    expect(getRun(run.id)!.continues).toBe(0);
    await controls.sendMessage(run.id, `REPORT ${join(config.workbasesDir, run.id, "REPORT.md")}`);
    await until("done", () => getRun(run.id)!.status === "done");
  });
});
