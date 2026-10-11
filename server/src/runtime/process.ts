/**
 * Shared base for runtimes where each agent's opencode is a child process of Pixel
 * (no VM): `local` (development) and `single` (everything in one container).
 * Subclasses decide which user the agent runs as, its environment and its limits.
 */
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, copyFileSync } from "node:fs";
import type { Subprocess } from "bun";
import { config } from "../config.ts";
import type { RunRow } from "../db.ts";
import type { AgentPaths, ExecResult, Metrics, OpencodeState, PrepareOptions, Prepared, Runtime } from "./types.ts";

interface Proc {
  proc: Subprocess;
  exit?: { code: number | null; signal: string | null };
}

/** What Pixel needs to start a run's opencode again; kept where agents can't read it. */
interface LaunchInfo {
  env: Record<string, string>;
  password: string;
  port: number;
}

export const launchDir = join(config.machinesDir, ".launch");

async function freePort() {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  return p;
}

export async function sh(cmd: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<ExecResult> {
  const p = Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env ?? (process.env as Record<string, string>), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), opts.timeoutMs ?? 600_000);
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code, stdout, stderr };
}

export abstract class ProcessRuntime implements Runtime {
  abstract kind: "local" | "single";
  readonly agentsDieWithPixel = true;
  onLimit?: (runId: string, message: string) => void;
  protected procs = new Map<string, Proc>();

  constructor() {
    mkdirSync(launchDir, { recursive: true, mode: 0o700 });
  }

  // ---- hooks for subclasses ----

  /** Wrap a command so it runs as the run's agent (user, priority, limits). */
  protected abstract wrap(run: RunRow, argv: string[]): string[];
  /** Environment every agent command gets (never includes Pixel's own secrets). */
  protected abstract agentEnv(run: RunRow): Record<string, string>;
  /** opencode config written for the agent. */
  protected abstract opencodeConfig(): Record<string, unknown>;
  /** Create users, directories and permissions before anything runs as the agent. */
  protected async setupMachine(run: RunRow, _o: PrepareOptions): Promise<string> {
    return `${this.kind}-${run.id}`;
  }
  abstract describeMachine(run: RunRow): string;
  abstract shellCommand(run: RunRow): string;
  abstract metrics(run: RunRow): Promise<Metrics>;

  // ---- layout ----

  runDir(run: RunRow) {
    return join(config.machinesDir, run.id);
  }

  protected home(run: RunRow) {
    return join(this.runDir(run), "home");
  }

  paths(run: RunRow): AgentPaths {
    return {
      target: join(this.runDir(run), "target"),
      workbases: config.workbasesDir,
      workbase: join(config.workbasesDir, run.id),
      scratch: join(this.runDir(run), "scratch"),
    };
  }

  /** XDG dirs inside the run's home, so opencode state stays with the run. */
  protected xdgEnv(run: RunRow) {
    const home = this.home(run);
    return {
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      TMPDIR: join(this.paths(run).scratch, "tmp"),
    };
  }

  private launchPath = (run: RunRow) => join(launchDir, `${run.id}.json`);
  pidPath = (run: RunRow) => join(launchDir, `${run.id}.pid`);

  // ---- lifecycle ----

  async exec(run: RunRow, cmd: string[], timeoutMs?: number) {
    const cwd = existsSync(this.paths(run).target) ? this.paths(run).target : this.runDir(run);
    return sh(this.wrap(run, cmd), { cwd, env: this.agentEnv(run), timeoutMs });
  }

  private async mustExec(run: RunRow, cmd: string[], what: string, timeoutMs?: number) {
    const r = await this.exec(run, cmd, timeoutMs);
    if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-800)}`);
    return r;
  }

  protected writeAgentFiles(run: RunRow, authJson: string) {
    const env = this.xdgEnv(run);
    mkdirSync(join(env.XDG_CONFIG_HOME, "opencode"), { recursive: true });
    writeFileSync(join(env.XDG_CONFIG_HOME, "opencode", "opencode.json"), JSON.stringify(this.opencodeConfig(), null, 2));
    const plugins = join(env.XDG_CONFIG_HOME, "opencode", "plugin");
    mkdirSync(plugins, { recursive: true });
    for (const f of readdirSync(config.opencodePluginsDir).filter((f) => f.endsWith(".ts"))) copyFileSync(join(config.opencodePluginsDir, f), join(plugins, f));
    if (authJson.trim()) {
      mkdirSync(join(env.XDG_DATA_HOME, "opencode"), { recursive: true });
      writeFileSync(join(env.XDG_DATA_HOME, "opencode", "auth.json"), authJson, { mode: 0o600 });
    }
    mkdirSync(env.TMPDIR, { recursive: true });
  }

  async prepare(o: PrepareOptions): Promise<Prepared> {
    const run = o.run;
    const p = this.paths(run);
    mkdirSync(p.scratch, { recursive: true });
    mkdirSync(this.home(run), { recursive: true });
    this.writeAgentFiles(run, o.authJson);
    const vmName = await this.setupMachine(run, o);
    if (!existsSync(join(p.target, ".git"))) {
      o.log(`Cloning ${run.repo}`);
      rmSync(p.target, { recursive: true, force: true });
      await this.mustExec(run, ["git", "clone", "--quiet", run.repo, p.target], "git clone", 1_800_000);
      if (run.ref) await this.mustExec(run, ["git", "-C", p.target, "checkout", "--quiet", run.ref], `git checkout ${run.ref}`);
    }
    const port = await freePort();
    writeFileSync(this.launchPath(run), JSON.stringify({ env: o.env, password: o.opencodePassword, port } satisfies LaunchInfo), { mode: 0o600 });
    o.log(`Starting opencode on port ${port}`);
    this.spawnOpencode(run);
    return { vmName, endpoint: `http://127.0.0.1:${port}` };
  }

  private spawnOpencode(run: RunRow) {
    const launch: LaunchInfo = JSON.parse(readFileSync(this.launchPath(run), "utf8"));
    const log = Bun.file(join(this.runDir(run), "opencode.log"));
    const proc = Bun.spawn(this.wrap(run, [config.opencodeBin, "serve", "--hostname", "127.0.0.1", "--port", String(launch.port)]), {
      cwd: this.paths(run).target,
      env: { ...this.agentEnv(run), ...launch.env, OPENCODE_SERVER_PASSWORD: launch.password },
      stdout: log,
      stderr: log,
    });
    const entry: Proc = { proc };
    this.procs.set(run.id, entry);
    writeFileSync(this.pidPath(run), String(proc.pid));
    proc.exited.then(() => {
      entry.exit = { code: proc.exitCode, signal: proc.signalCode };
    });
  }

  pid(run: RunRow) {
    const p = this.procs.get(run.id);
    return p && !p.exit ? (p.proc.pid ?? null) : null;
  }

  async opencodeState(run: RunRow): Promise<OpencodeState> {
    const p = this.procs.get(run.id);
    if (!p) return "exited";
    if (!p.exit) return "running";
    // No VM here: a SIGKILL is what the OOM killer does (or `kill -9` when testing recovery).
    return p.exit.signal === "SIGKILL" ? "oom" : "exited";
  }

  /** Stop the run's opencode, including one left over from before a Pixel restart. */
  protected async stopOpencode(run: RunRow) {
    const p = this.procs.get(run.id);
    if (p && !p.exit) {
      p.proc.kill();
      await p.proc.exited;
    } else if (!p) {
      try {
        const pid = Number(readFileSync(this.pidPath(run), "utf8"));
        if (pid > 0) process.kill(pid, "SIGTERM");
        await Bun.sleep(500);
      } catch {}
    }
  }

  async restartOpencode(run: RunRow) {
    await this.stopOpencode(run);
    this.spawnOpencode(run);
  }

  async vmState(run: RunRow) {
    const p = this.procs.get(run.id);
    return p && !p.exit ? "Running" : "Stopped";
  }

  async startVm(run: RunRow) {
    if ((await this.vmState(run)) !== "Running") await this.restartOpencode(run);
  }

  async stopVm(run: RunRow) {
    await this.stopOpencode(run);
  }

  async snapshot(): Promise<void> {
    throw new Error("snapshots need the incus runtime");
  }

  async listSnapshots() {
    return [];
  }

  async restore(): Promise<void> {
    throw new Error("snapshots need the incus runtime");
  }

  async destroy(run: RunRow) {
    await this.stopVm(run);
    this.procs.delete(run.id);
    rmSync(this.runDir(run), { recursive: true, force: true });
    rmSync(this.launchPath(run), { force: true });
    rmSync(this.pidPath(run), { force: true });
  }

  async listMachines() {
    return [...this.procs.entries()].map(([id, p]) => ({ name: id, status: p.exit ? "Stopped" : "Running" }));
  }

  async info(): Promise<Record<string, unknown>> {
    return { runtime: this.kind };
  }
}
