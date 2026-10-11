/**
 * Development runtime: runs opencode as a local process instead of in a VM.
 * No isolation and no read-only enforcement of other workbases. Only for trying
 * Pixel out on a laptop with harmless prompts.
 */
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statfsSync } from "node:fs";
import type { Subprocess } from "bun";
import { config } from "../config.ts";
import type { RunRow } from "../db.ts";
import type { AgentPaths, ExecResult, Metrics, OpencodeState, PrepareOptions, Prepared, Runtime } from "./types.ts";

interface Proc {
  proc: Subprocess;
  exit?: { code: number | null; signal: string | null };
}

const procs = new Map<string, Proc>();

const runDir = (run: RunRow) => join(config.localDir, run.id);

async function freePort() {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  return p;
}

async function sh(cmd: string[], cwd?: string, env?: Record<string, string>, timeoutMs = 600_000): Promise<ExecResult> {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code, stdout, stderr };
}

export class LocalRuntime implements Runtime {
  kind = "local" as const;

  paths(run: RunRow): AgentPaths {
    return {
      target: join(runDir(run), "target"),
      workbases: config.workbasesDir,
      workbase: join(config.workbasesDir, run.id),
      scratch: join(runDir(run), "scratch"),
    };
  }

  private writeOpencodeConfig(run: RunRow, authJson: string) {
    const dir = runDir(run);
    const cfgDir = join(dir, "xdg-config", "opencode");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, "opencode.json"),
      JSON.stringify({ $schema: "https://opencode.ai/config.json", permission: "allow", autoupdate: false, share: "disabled" }, null, 2),
    );
    if (authJson.trim()) {
      const dataDir = join(dir, "xdg-data", "opencode");
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, "auth.json"), authJson, { mode: 0o600 });
    }
  }

  private async spawnOpencode(run: RunRow, port: number) {
    const dir = runDir(run);
    const saved = JSON.parse(readFileSync(join(dir, "launch.json"), "utf8"));
    const proc = Bun.spawn([config.local.opencodeBin, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: this.paths(run).target,
      env: {
        ...process.env,
        ...saved.env,
        XDG_CONFIG_HOME: join(dir, "xdg-config"),
        XDG_DATA_HOME: join(dir, "xdg-data"),
        XDG_STATE_HOME: join(dir, "xdg-state"),
        XDG_CACHE_HOME: join(dir, "xdg-cache"),
        OPENCODE_SERVER_PASSWORD: saved.password,
      },
      stdout: Bun.file(join(dir, "opencode.log")),
      stderr: Bun.file(join(dir, "opencode.log")),
    });
    const entry: Proc = { proc };
    procs.set(run.id, entry);
    writeFileSync(join(dir, "pid"), String(proc.pid));
    proc.exited.then(() => {
      entry.exit = { code: proc.exitCode, signal: proc.signalCode };
    });
  }

  async prepare(o: PrepareOptions): Promise<Prepared> {
    const dir = runDir(o.run);
    const p = this.paths(o.run);
    mkdirSync(p.scratch, { recursive: true });
    if (!existsSync(join(p.target, ".git"))) {
      o.log(`Cloning ${o.run.repo}`);
      rmSync(p.target, { recursive: true, force: true });
      const r = await sh(["git", "clone", "--quiet", o.run.repo, p.target]);
      if (r.code !== 0) throw new Error(`git clone failed: ${r.stderr.trim()}`);
      if (o.run.ref) {
        const c = await sh(["git", "checkout", "--quiet", o.run.ref], p.target);
        if (c.code !== 0) throw new Error(`git checkout ${o.run.ref} failed: ${c.stderr.trim()}`);
      }
    }
    this.writeOpencodeConfig(o.run, o.authJson);
    writeFileSync(join(dir, "launch.json"), JSON.stringify({ env: o.env, password: o.opencodePassword }), { mode: 0o600 });
    const port = await freePort();
    o.log(`Starting opencode on port ${port}`);
    await this.spawnOpencode(o.run, port);
    return { vmName: `local-${o.run.id}`, endpoint: `http://127.0.0.1:${port}` };
  }

  async exec(run: RunRow, cmd: string[], timeoutMs?: number) {
    return sh(cmd, this.paths(run).target, undefined, timeoutMs);
  }

  async opencodeState(run: RunRow): Promise<OpencodeState> {
    const p = procs.get(run.id);
    if (!p) return "exited";
    if (!p.exit) return "running";
    // A SIGKILL locally is the closest thing to an OOM kill (or someone ran kill -9 to test it).
    return p.exit.signal === "SIGKILL" ? "oom" : "exited";
  }

  async restartOpencode(run: RunRow) {
    const p = procs.get(run.id);
    if (p && !p.exit) {
      p.proc.kill();
      await p.proc.exited;
    } else if (!p) {
      // Left over from before a Pixel restart: it is not our child any more, so stop it by pid.
      try {
        const pid = Number(readFileSync(join(runDir(run), "pid"), "utf8"));
        if (pid > 0) process.kill(pid, "SIGTERM");
        await Bun.sleep(500);
      } catch {}
    }
    const port = Number(new URL(run.endpoint!).port);
    await this.spawnOpencode(run, port);
  }

  async metrics(run: RunRow): Promise<Metrics> {
    const p = procs.get(run.id);
    const out: Metrics = {};
    try {
      const fs = statfsSync(this.paths(run).target);
      out.diskTotal = fs.blocks * fs.bsize;
      out.diskUsed = (fs.blocks - fs.bfree) * fs.bsize;
    } catch {}
    if (p && !p.exit) {
      try {
        const status = readFileSync(`/proc/${p.proc.pid}/status`, "utf8");
        const rss = /VmRSS:\s+(\d+)/.exec(status);
        if (rss) out.memUsed = Number(rss[1]) * 1024;
      } catch {}
    }
    return out;
  }

  async vmState(run: RunRow) {
    const p = procs.get(run.id);
    return p && !p.exit ? "Running" : "Stopped";
  }

  async startVm(run: RunRow) {
    if ((await this.vmState(run)) !== "Running") await this.restartOpencode(run);
  }

  async stopVm(run: RunRow) {
    const p = procs.get(run.id);
    if (p && !p.exit) {
      p.proc.kill("SIGTERM");
      await p.proc.exited;
    }
  }

  async snapshot() {
    throw new Error("snapshots need the incus runtime");
  }

  async listSnapshots() {
    return [];
  }

  async restore() {
    throw new Error("snapshots need the incus runtime");
  }

  async destroy(run: RunRow) {
    await this.stopVm(run);
    procs.delete(run.id);
    rmSync(runDir(run), { recursive: true, force: true });
  }

  shellCommand(run: RunRow) {
    return `cd ${this.paths(run).target}`;
  }

  async listMachines() {
    return [...procs.entries()].map(([id, p]) => ({ name: `local-${id}`, status: p.exit ? "Stopped" : "Running" }));
  }

  async info() {
    return { runtime: "local", note: "Development runtime: no VM isolation." };
  }
}
