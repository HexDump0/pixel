/**
 * Everything in one container: Pixel runs as root, each agent's opencode runs as its own
 * unprivileged Linux user. For hosts where Pixel can only deploy a plain container (e.g. Coolify).
 *
 * Agents can read every workbase but write only their own, can't read Pixel's data or each other's
 * machine dirs, and have no root, Docker or snapshots. There are no cgroups inside an ordinary
 * container, so limits are enforced from here: memory by killing the agent's largest process,
 * disk by stopping the run (watchdog), processes by RLIMIT_NPROC, CPU only by lower priority.
 * Set CPU/memory limits on the container itself so a runaway can never reach other apps on the host.
 */
import { join } from "node:path";
import { chmodSync, chownSync, existsSync, lchownSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { config } from "../config.ts";
import type { RunRow, RunSize } from "../db.ts";
import type { Credentials, Metrics, PrepareOptions } from "./types.ts";
import { launchDir, ProcessRuntime, sh } from "./process.ts";
import { readProc, type ProcessInfo } from "./procs.ts";

const GiB = 1024 ** 3;
/** Agent uids are allocated upwards from here and never reused (workbases keep their owner). */
const FIRST_UID = 20000;
const LAST_UID = 59999;
const MEMORY_CHECK_MS = 5000;
const DISK_CHECK_MS = 5 * 60_000;
const ROOT_ENV_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const PYGHIDRA_MCP = "/usr/local/bin/pyghidra-mcp";

/** Address ranges agents may not reach: private, link-local (cloud metadata), CGNAT/Tailscale. */
const BLOCKED_V4 = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10"];
const BLOCKED_V6 = ["fc00::/7", "fe80::/10"];

interface ProcInfo {
  pid: number;
  rss: number;
  /** utime + stime + reaped children, in clock ticks. */
  ticks: number;
}

function chownTree(dir: string, uid: number) {
  lchownSync(dir, uid, uid);
  for (const f of readdirSync(dir, { recursive: true }) as string[]) lchownSync(join(dir, f), uid, uid);
}

/** Every process on the system, grouped by real uid. */
/**
 * Agent processes by uid. Most processes on the box aren't agents', so the owner of /proc/<pid> (a
 * stat, no read) rules them out first. Non-dumpable processes show root as that owner whatever
 * their real uid, so root-owned ones get their status read as before.
 */
function scanProcs() {
  const byUid = new Map<number, ProcInfo[]>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const owner = statSync(`/proc/${name}`).uid;
      if (owner !== 0 && (owner < FIRST_UID || owner > LAST_UID)) continue;
      const status = readFileSync(`/proc/${name}/status`, "utf8");
      const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
      if (uid < FIRST_UID || uid > LAST_UID) continue;
      const rss = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) * 1024;
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ticks = Number(f[11]) + Number(f[12]) + Number(f[13]) + Number(f[14]);
      const list = byUid.get(uid) ?? [];
      list.push({ pid: Number(name), rss, ticks });
      byUid.set(uid, list);
    } catch {
      // exited while we looked
    }
  }
  return byUid;
}

/** A scan at most a second old, for readings (metrics, machine list); enforcing and killing always scan afresh. */
let recentScan: { at: number; procs: Map<number, ProcInfo[]> } | null = null;
function recentProcs() {
  if (!recentScan || Date.now() - recentScan.at > 1000) recentScan = { at: Date.now(), procs: scanProcs() };
  return recentScan.procs;
}

export class SingleRuntime extends ProcessRuntime {
  kind = "single" as const;
  private firewall = "not set up";
  private cpuSamples = new Map<string, { t: number; ticks: number }>();
  private diskCache = new Map<string, { t: number; bytes: number }>();
  /** Runs whose memory is being policed: run id → uid + limit. */
  private limits = new Map<string, { uid: number; bytes: number }>();

  constructor() {
    super();
    if (process.getuid?.() !== 0) throw new Error("the single runtime must run as root (it starts each agent as its own user)");
    if (!config.password) throw new Error("the single runtime needs PIXEL_PASSWORD: agents share the network with the dashboard");
    this.lockDown();
    void this.setupFirewall();
    setInterval(() => this.enforceMemory(), MEMORY_CHECK_MS).unref();
  }

  // ---- agent users ----

  private uidPath = (run: RunRow) => join(launchDir, `${run.id}.uid`);

  /** The run's uid, allocated once from a counter so uids of deleted runs are never handed out again. */
  private uid(run: RunRow) {
    if (existsSync(this.uidPath(run))) return Number(readFileSync(this.uidPath(run), "utf8"));
    const counter = join(launchDir, "next-uid");
    const uid = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : FIRST_UID;
    if (uid > LAST_UID) throw new Error("out of agent uids");
    writeFileSync(counter, String(uid + 1));
    writeFileSync(this.uidPath(run), String(uid));
    return uid;
  }

  private user = (run: RunRow) => `px${this.uid(run)}`;

  /** /etc/passwd lives in the image, so users are created again after the container is recreated. */
  private async ensureUser(run: RunRow) {
    const uid = this.uid(run);
    if ((await sh(["getent", "passwd", String(uid)])).code === 0) return;
    const r = await sh(["useradd", "--uid", String(uid), "--user-group", "--no-create-home", "--home-dir", this.home(run), "--shell", "/bin/bash", this.user(run)]);
    if (r.code !== 0) throw new Error(`useradd failed: ${r.stderr.trim()}`);
  }

  /** Pixel's own files are root-only; agents may only pass through to workbases and their own machine dir. */
  private lockDown() {
    const modes: [string, number][] = [
      [config.dataDir, 0o711],
      [config.machinesDir, 0o711],
      [config.workbasesDir, 0o755],
      [config.historyDir, 0o700],
      [config.transcriptsDir, 0o700],
      [launchDir, 0o700],
    ];
    for (const [p, mode] of modes) chmodSync(p, mode);
    for (const f of ["pixel.db", "pixel.db-wal", "pixel.db-shm"]) {
      const p = join(config.dataDir, f);
      if (existsSync(p)) chmodSync(p, 0o600);
    }
  }

  // ---- ProcessRuntime hooks ----

  protected wrap(run: RunRow, argv: string[]) {
    const uid = String(this.uid(run));
    return [
      // Agents die before Pixel when memory runs out, and yield CPU and disk I/O to it.
      "choom", "-n", "500", "--",
      "nice", "-n", "10",
      "ionice", "-c", "2", "-n", "7",
      "prlimit", `--nproc=${config.single.maxProcs}`, "--core=0", "--",
      "setpriv", "--reuid", uid, "--regid", uid, "--clear-groups", "--no-new-privs", "--",
      ...argv,
    ];
  }

  protected agentEnv(run: RunRow) {
    const home = this.home(run);
    return {
      PATH: `${home}/.local/bin:${ROOT_ENV_PATH}:/opt/ghidra/support`,
      HOME: home,
      USER: this.user(run),
      LOGNAME: this.user(run),
      SHELL: "/bin/bash",
      LANG: "C.UTF-8",
      GHIDRA_INSTALL_DIR: "/opt/ghidra",
      ...this.xdgEnv(run),
    };
  }

  protected opencodeConfig() {
    return {
      $schema: "https://opencode.ai/config.json",
      permission: "allow",
      autoupdate: false,
      share: "disabled",
      // Todos are off by default in opencode 2; agents had them in opencode 1 and the dashboard shows them.
      experimental: { todo: true },
      ...(existsSync(PYGHIDRA_MCP) && {
        mcp: {
          ghidra: { type: "local", command: [PYGHIDRA_MCP, "--transport", "stdio"], environment: { GHIDRA_INSTALL_DIR: "/opt/ghidra" }, timeout: 120000, enabled: true },
        },
      }),
    };
  }

  protected async setupMachine(run: RunRow, o: PrepareOptions) {
    this.lockDown();
    await this.ensureUser(run);
    const uid = this.uid(run);
    const p = this.paths(run);
    // The machine dir is private to the agent; its workbase is readable by every agent.
    for (const [dir, mode] of [[this.runDir(run), 0o700], [p.scratch, 0o755], [p.workbase, 0o755]] as const) {
      chownSync(dir, uid, uid);
      chmodSync(dir, mode);
    }
    await sh(["chown", "-R", `${uid}:${uid}`, this.home(run), join(p.scratch, "tmp"), p.workbase]);
    this.track(run, JSON.parse(run.size) as RunSize);
    o.log(`Agent runs as ${this.user(run)} (uid ${uid})`);
    return this.user(run);
  }

  private track(run: RunRow, size: RunSize) {
    this.limits.set(run.id, { uid: this.uid(run), bytes: size.memoryGiB * GiB });
  }

  // ---- lifecycle ----

  /** Files written after preparing (new keys) must still belong to the agent's user. */
  protected writeAgentFiles(run: RunRow, authJson: string) {
    super.writeAgentFiles(run, authJson);
    if (!existsSync(this.uidPath(run))) return;
    const uid = this.uid(run);
    const env = this.xdgEnv(run);
    for (const dir of [join(env.XDG_CONFIG_HOME, "opencode"), join(env.XDG_DATA_HOME, "opencode")]) if (existsSync(dir)) chownTree(dir, uid);
  }

  async restartOpencode(run: RunRow, creds?: Credentials) {
    await this.ensureUser(run);
    this.track(run, JSON.parse(run.size));
    await super.restartOpencode(run, creds);
  }

  /** Stop opencode and everything the agent left running (fuzzers, builds, servers). */
  async stopVm(run: RunRow) {
    await this.stopOpencode(run);
    if (existsSync(this.uidPath(run))) this.killAll(this.uid(run));
  }

  private killAll(uid: number) {
    // A few rounds: processes may fork while we kill.
    for (let i = 0; i < 3; i++) {
      for (const p of scanProcs().get(uid) ?? []) {
        try {
          process.kill(p.pid, "SIGKILL");
        } catch {}
      }
    }
  }

  async destroy(run: RunRow) {
    const hadUid = existsSync(this.uidPath(run));
    await super.destroy(run);
    this.limits.delete(run.id);
    if (!hadUid) return;
    const user = this.user(run);
    // The workbase outlives the run: hand it to root so it stays readable but nobody can change it.
    const workbase = this.paths(run).workbase;
    if (existsSync(workbase)) await sh(["chown", "-R", "0:0", workbase]);
    await sh(["userdel", user]);
    rmSync(this.uidPath(run), { force: true });
  }

  // ---- limits and metrics ----

  /** Like an OOM killer scoped to one agent: over its memory size, its largest process goes. */
  private enforceMemory() {
    if (this.limits.size === 0) return;
    const procs = scanProcs();
    for (const [runId, { uid, bytes }] of this.limits) {
      const list = procs.get(uid) ?? [];
      const used = list.reduce((a, p) => a + p.rss, 0);
      if (used <= bytes || list.length === 0) continue;
      const biggest = list.reduce((a, b) => (b.rss > a.rss ? b : a));
      try {
        process.kill(biggest.pid, "SIGKILL");
      } catch {
        continue;
      }
      const comm = (() => {
        try {
          return readFileSync(`/proc/${biggest.pid}/comm`, "utf8").trim();
        } catch {
          return "?";
        }
      })();
      this.onLimit?.(runId, `Memory ${(used / GiB).toFixed(1)} GiB over the ${bytes / GiB} GiB limit: killed pid ${biggest.pid} (${comm}, ${(biggest.rss / GiB).toFixed(1)} GiB)`);
    }
  }

  /** Limits apply from the next check: memory within 5 s, disk at the next metrics (du is measured again). */
  async resize(run: RunRow, next: RunSize, prev: RunSize) {
    if (this.limits.has(run.id)) this.track(run, next);
    this.diskCache.delete(run.id);
    return next.cpu !== prev.cpu ? ["CPU here is only a priority, the container's CPU cap is shared by every agent"] : [];
  }

  /**
   * Bytes the run's machine dir uses. `du` over build trees is slow, so it is cached for a few minutes;
   * for one minute while the run has extra disk to clean up, so its progress shows.
   */
  private async diskUsed(run: RunRow) {
    const cached = this.diskCache.get(run.id);
    if (cached && Date.now() - cached.t < (run.disk_boost ? 60_000 : DISK_CHECK_MS)) return cached.bytes;
    const r = await sh(["du", "-sxb", this.runDir(run)], { timeoutMs: 120_000 });
    const bytes = Number(r.stdout.split(/\s/)[0]);
    if (!Number.isFinite(bytes)) return cached?.bytes;
    this.diskCache.set(run.id, { t: Date.now(), bytes });
    return bytes;
  }

  async metrics(run: RunRow): Promise<Metrics> {
    const size: RunSize = JSON.parse(run.size);
    const out: Metrics = { memTotal: size.memoryGiB * GiB, diskTotal: size.diskGiB * GiB };
    out.diskUsed = await this.diskUsed(run);
    if (!existsSync(this.uidPath(run))) return out;
    const list = recentProcs().get(this.uid(run)) ?? [];
    out.memUsed = list.reduce((a, p) => a + p.rss, 0);
    const ticks = list.reduce((a, p) => a + p.ticks, 0);
    const now = Date.now();
    const prev = this.cpuSamples.get(run.id);
    // Clock ticks are 1/100 s on Linux; a dip means processes exited without being reaped into a parent.
    if (prev && now > prev.t) out.cpu = Math.max(0, ((ticks - prev.ticks) * 10) / (now - prev.t)) * 100;
    this.cpuSamples.set(run.id, { t: now, ticks });
    return out;
  }

  // ---- network ----

  /**
   * Keep agents off the container's internal networks (other apps on the host, the host itself,
   * cloud metadata) and off the dashboard port. Needs NET_ADMIN; without it agents keep full access
   * and the System page says so.
   */
  private async setupFirewall() {
    if (!config.single.firewall) {
      this.firewall = "off (PIXEL_AGENT_FIREWALL=off)";
      return;
    }
    const owner = ["-m", "owner", "--uid-owner", `${FIRST_UID}-${LAST_UID}`];
    const nameservers = [...readFileSync("/etc/resolv.conf", "utf8").matchAll(/^nameserver\s+(\S+)/gm)].map((m) => m[1]);
    const apply = async (bin: string, blocked: string[], loopback: string) => {
      const run = (...args: string[]) => sh([bin, "-w", ...args]);
      await run("-N", "PIXEL_AGENTS");
      let r = await run("-F", "PIXEL_AGENTS");
      if (r.code !== 0) throw new Error(r.stderr.trim());
      const rules: string[][] = [
        ["-d", loopback, "-p", "tcp", "--dport", String(config.port), "-j", "REJECT"],
        ["-d", loopback, "-j", "RETURN"],
        // DNS may be a resolver on a private address (cloud VPCs).
        ...nameservers.filter((ns) => ns.includes(":") === (bin === "ip6tables")).flatMap((ns) => [
          ["-d", ns, "-p", "udp", "--dport", "53", "-j", "RETURN"],
          ["-d", ns, "-p", "tcp", "--dport", "53", "-j", "RETURN"],
        ]),
        ...blocked.map((net) => ["-d", net, "-j", "REJECT"]),
      ];
      for (const rule of rules) {
        r = await run("-A", "PIXEL_AGENTS", ...rule);
        if (r.code !== 0) throw new Error(r.stderr.trim());
      }
      if ((await run("-C", "OUTPUT", ...owner, "-j", "PIXEL_AGENTS")).code !== 0) {
        r = await run("-I", "OUTPUT", "1", ...owner, "-j", "PIXEL_AGENTS");
        if (r.code !== 0) throw new Error(r.stderr.trim());
      }
    };
    try {
      await apply("iptables", BLOCKED_V4, "127.0.0.0/8");
      this.firewall = "on";
    } catch (e: any) {
      this.firewall = `FAILED, agents can reach internal networks (${e.message}); give the container the NET_ADMIN capability`;
      console.warn(`Agent firewall: ${this.firewall}`);
      return;
    }
    try {
      await apply("ip6tables", BLOCKED_V6, "::1");
    } catch (e: any) {
      this.firewall = `on for IPv4; IPv6 not set up (${e.message})`;
    }
  }

  // ---- info ----

  describeMachine(run: RunRow) {
    const size: RunSize = JSON.parse(run.size);
    const extras = [existsSync("/opt/ghidra") && "Ghidra (headless)", existsSync("/opt/codeql") && "CodeQL"].filter(Boolean);
    return [
      `You run as an unprivileged user (no root, no sudo) in a container shared with other agents, with internet access but no access to private networks.`,
      `There is no Docker: test your hypotheses on native builds with the tools here (compilers with sanitizers, gdb, valgrind, AFL++/libFuzzer, semgrep${extras.length ? `, ${extras.join(", ")}` : ""}). apt isn't available, so install anything else under your home or scratch (pip/pipx --user, npm --prefix, building from source).`,
      `You have about ${size.memoryGiB} GiB of memory (your largest process is killed above that) and ${size.diskGiB} GB of disk for the target and scratch (the run stops above that). CPU is shared with other agents: keep builds and fuzzers proportionate and stop them when you're done.`,
    ].join(" ");
  }

  shellCommand(run: RunRow) {
    return `su -s /bin/bash ${this.user(run)} -c 'cd ${this.paths(run).target} && exec bash'`;
  }

  /** Every process of the agent's user, so things it started and left running (fuzzers, servers) count too. */
  async processes(run: RunRow): Promise<ProcessInfo[]> {
    if (!existsSync(this.uidPath(run))) return [];
    const pids = (recentProcs().get(this.uid(run)) ?? []).map((p) => p.pid);
    return this.sampler(run).info(
      pids.flatMap((pid) => readProc(pid) ?? []),
      this.pid(run),
    );
  }

  async listMachines() {
    const procs = recentProcs();
    return [...this.limits.entries()].map(([id, { uid }]) => {
      const list = procs.get(uid) ?? [];
      return { name: `${id} (px${uid})`, status: list.length ? "Running" : "Stopped", memory: list.reduce((a, p) => a + p.rss, 0) };
    });
  }

  async info() {
    return {
      runtime: "single",
      note: `Everything in one container: each agent is its own Linux user. No Docker for agents, no snapshots. Agent firewall: ${this.firewall}.`,
    };
  }
}
