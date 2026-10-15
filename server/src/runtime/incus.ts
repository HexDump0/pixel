/** Production runtime: one Incus VM per run, driven through the Incus REST API on its unix socket. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import type { RunRow } from "../db.ts";
import type { AgentPaths, Credentials, ExecResult, Metrics, OpencodeState, PrepareOptions, Prepared, Runtime } from "./types.ts";

class IncusError extends Error {}

async function api<T = any>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}, rawBody?: BodyInit): Promise<{ type: string; metadata: T; operation?: string; status_code?: number }> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `http://incus${path}${path.startsWith("/1.0/operations") ? "" : `${sep}project=${encodeURIComponent(config.incus.project)}`}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      unix: config.incus.socket,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extraHeaders },
      body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    } as any);
  } catch (e: any) {
    throw new IncusError(`cannot reach Incus at ${config.incus.socket} (${e.code ?? e.message}); is the socket mounted?`);
  }
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    if (!res.ok) throw new IncusError(`incus ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    return { type: "raw", metadata: text as any };
  }
  if (json.type === "error" || !res.ok) throw new IncusError(`incus ${method} ${path}: ${json.error || res.status}`);
  return json;
}

const withProject = (path: string) => `${path}${path.includes("?") ? "&" : "?"}project=${encodeURIComponent(config.incus.project)}`;

async function raw(path: string): Promise<string> {
  const res = await fetch(`http://incus${withProject(path)}`, { unix: config.incus.socket } as any);
  return res.ok ? res.text() : "";
}

/** Wait for an async operation and return its final metadata. */
async function waitOp(op: string | undefined, timeoutSec = 600): Promise<any> {
  if (!op) return undefined;
  const r = await api("GET", `${op}/wait?timeout=${timeoutSec}`);
  const m: any = r.metadata;
  if (m?.status === "Failure") throw new IncusError(`incus operation failed: ${m.err}`);
  if (m?.status !== "Success") throw new IncusError(`incus operation did not finish in ${timeoutSec}s (status ${m?.status})`);
  return m;
}

async function call(method: string, path: string, body?: unknown, timeoutSec = 600) {
  const r = await api(method, path, body);
  if (r.type === "async") return waitOp(r.operation, timeoutSec);
  return r.metadata;
}

export const vmNameFor = (runId: string) => ("px-" + runId.toLowerCase().replace(/[^a-z0-9-]/g, "-")).slice(0, 63).replace(/-+$/, "");

export class IncusRuntime implements Runtime {
  kind = "incus" as const;
  private cpuSamples = new Map<string, { t: number; usage: number }>();

  paths(run: RunRow): AgentPaths {
    return {
      target: config.guest.target,
      workbases: config.guest.workbases,
      workbase: `${config.guest.workbases}/${run.id}`,
      scratch: config.guest.scratch,
    };
  }

  private name(run: RunRow) {
    return run.vm_name || vmNameFor(run.id);
  }

  async state(name: string) {
    return (await api("GET", `/1.0/instances/${name}/state`)).metadata as any;
  }

  private async waitForAgent(name: string, timeoutMs = 240_000) {
    const end = Date.now() + timeoutMs;
    let last = "";
    while (Date.now() < end) {
      try {
        const r = await this.execByName(name, ["true"], 15_000);
        if (r.code === 0) return;
      } catch (e: any) {
        last = e.message;
      }
      await Bun.sleep(2000);
    }
    throw new IncusError(`VM ${name} agent not ready after ${timeoutMs / 1000}s ${last}`);
  }

  private async ipv4(name: string, timeoutMs = 120_000): Promise<string> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const st = await this.state(name);
      for (const [iface, n] of Object.entries<any>(st.network ?? {})) {
        if (iface === "lo" || iface.startsWith("docker") || iface.startsWith("br-") || iface.startsWith("veth")) continue;
        const a = (n.addresses ?? []).find((x: any) => x.family === "inet" && x.scope === "global");
        if (a) return a.address;
      }
      await Bun.sleep(2000);
    }
    throw new IncusError(`VM ${name} got no IPv4 address`);
  }

  private async pushFile(name: string, path: string, content: string, mode = "0600") {
    await api(
      "POST",
      `/1.0/instances/${name}/files?path=${encodeURIComponent(path)}`,
      undefined,
      { "X-Incus-type": "file", "X-Incus-mode": mode, "X-Incus-uid": "0", "X-Incus-gid": "0", "X-Incus-write": "overwrite", "content-type": "application/octet-stream" },
      content,
    );
  }

  async execByName(name: string, cmd: string[], timeoutMs = 600_000): Promise<ExecResult> {
    const r = await api("POST", `/1.0/instances/${name}/exec`, {
      command: cmd,
      environment: { HOME: "/root", PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/root/.local/bin:/root/.opencode/bin" },
      "wait-for-websocket": false,
      "record-output": true,
      interactive: false,
    });
    const op = await waitOp(r.operation, Math.ceil(timeoutMs / 1000));
    const md = op?.metadata ?? {};
    const out = md.output ?? {};
    const [stdout, stderr] = await Promise.all([out["1"] ? raw(out["1"]) : "", out["2"] ? raw(out["2"]) : ""]);
    for (const p of [out["1"], out["2"]]) if (p) fetch(`http://incus${withProject(p)}`, { method: "DELETE", unix: config.incus.socket } as any).catch(() => {});
    return { code: Number(md.return ?? -1), stdout, stderr };
  }

  exec(run: RunRow, cmd: string[], timeoutMs?: number) {
    return this.execByName(this.name(run), cmd, timeoutMs);
  }

  private async mustExec(name: string, cmd: string[], what: string, timeoutMs?: number) {
    const r = await this.execByName(name, cmd, timeoutMs);
    if (r.code !== 0) throw new IncusError(`${what} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-800)}`);
    return r;
  }

  async prepare(o: PrepareOptions): Promise<Prepared> {
    const name = vmNameFor(o.run.id);
    const p = this.paths(o.run);
    const exists = await api("GET", `/1.0/instances/${name}`).then(() => true, () => false);
    if (!exists) {
      o.log(`Creating VM ${name} (${o.size.cpu} CPU, ${o.size.memoryGiB} GiB RAM, ${o.size.diskGiB} GiB disk)`);
      await call("POST", "/1.0/instances", {
        name,
        type: "virtual-machine",
        source: { type: "image", alias: config.incus.image },
        config: {
          "limits.cpu": String(o.size.cpu),
          "limits.memory": `${o.size.memoryGiB}GiB`,
          "user.pixel.run": o.run.id,
        },
        devices: {
          root: { type: "disk", path: "/", pool: config.incus.pool, size: `${o.size.diskGiB}GiB` },
          eth0: { type: "nic", network: config.incus.network, name: "eth0" },
          workbases: { type: "disk", source: config.workbasesDir, path: p.workbases, readonly: "true" },
          workbase: { type: "disk", source: o.workbaseHostPath, path: p.workbase },
        },
      });
    }
    const st = await this.state(name);
    if (st.status !== "Running") {
      o.log("Starting VM");
      await call("PUT", `/1.0/instances/${name}/state`, { action: "start" });
    }
    o.log("Waiting for the VM agent");
    await this.waitForAgent(name);

    // The own workbase must be writable and land on the host; other workbases must not be writable.
    const probe = `.pixel/write-probe-${Date.now()}`;
    await this.mustExec(name, ["sh", "-c", `mkdir -p ${p.workbase}/.pixel && echo ok > ${p.workbase}/${probe}`], "Writing to own workbase");
    const hostProbe = Bun.file(`${o.workbaseHostPath}/${probe}`);
    if (!(await hostProbe.exists())) throw new IncusError("Own workbase is not shared with the host: the read-write share did not mount on top of /workbases");
    await hostProbe.unlink().catch(() => {});
    const ro = await this.execByName(name, ["sh", "-c", `touch ${p.workbases}/.pixel-ro-probe`]);
    if (ro.code === 0) throw new IncusError("Other workbases are writable from the VM: the /workbases share is not read-only");

    o.log("Injecting credentials");
    await this.pushCredentials(name, o, o.opencodePassword, p.workbase);

    const cloned = await this.execByName(name, ["test", "-d", `${p.target}/.git`]);
    if (cloned.code !== 0) {
      o.log(`Cloning ${o.run.repo}`);
      await this.mustExec(name, ["mkdir", "-p", "/work", p.scratch], "mkdir");
      await this.mustExec(name, ["git", "clone", "--quiet", o.run.repo, p.target], "git clone", 1_800_000);
      if (o.run.ref) await this.mustExec(name, ["git", "-C", p.target, "checkout", "--quiet", o.run.ref], `git checkout ${o.run.ref}`);
      o.log("Taking a clean snapshot (pixel-start)");
      await call("POST", `/1.0/instances/${name}/snapshots`, { name: "pixel-start" }).catch((e) => o.log(`Snapshot failed: ${e.message}`));
    }

    o.log("Starting opencode");
    await this.mustExec(name, ["sh", "-c", "systemctl reset-failed opencode 2>/dev/null; systemctl restart opencode"], "Starting opencode");
    const ip = await this.ipv4(name);
    return { vmName: name, endpoint: `http://${ip}:${config.opencodePort}` };
  }

  async opencodeState(run: RunRow): Promise<OpencodeState> {
    const name = this.name(run);
    try {
      const st = await this.state(name);
      if (st.status !== "Running") return "vm-down";
      const r = await this.execByName(name, ["systemctl", "show", "opencode", "-p", "ActiveState", "-p", "Result", "-p", "ExecMainStatus"], 20_000);
      if (/ActiveState=(active|activating|reloading)/.test(r.stdout)) return "running";
      if (/Result=oom-kill/.test(r.stdout)) return "oom";
      // The unit uses OOMPolicy=continue (so a fuzzer's OOM doesn't stop it), so when opencode itself
      // is OOM-killed the unit just sees SIGKILL: confirm with the kernel log.
      if (/ExecMainStatus=9\b/.test(r.stdout)) {
        const k = await this.execByName(name, ["sh", "-c", "journalctl -k -b --no-pager -o cat | grep -i 'killed process' | grep -c '(opencode)'"], 20_000);
        if (Number(k.stdout.trim()) > 0) return "oom";
      }
      return "exited";
    } catch {
      return "unknown";
    }
  }

  private async pushCredentials(name: string, creds: Credentials, opencodePassword: string, workbase: string) {
    // PIXEL_WORKBASE: where the finding tools keep FINDINGS.json.
    const envFile = Object.entries({ ...creds.env, PIXEL_WORKBASE: workbase, OPENCODE_SERVER_PASSWORD: opencodePassword })
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join("\n");
    await this.pushFile(name, "/etc/pixel/opencode.env", envFile + "\n");
    // Plugins are baked into the image too; pushing them here keeps older images current.
    for (const f of readdirSync(config.opencodePluginsDir).filter((f) => f.endsWith(".ts")))
      await this.pushFile(name, `/root/.config/opencode/plugin/${f}`, readFileSync(join(config.opencodePluginsDir, f), "utf8"), "0644");
    if (creds.authJson.trim()) {
      await this.mustExec(name, ["mkdir", "-p", "/root/.local/share/opencode"], "mkdir");
      await this.pushFile(name, "/root/.local/share/opencode/auth.json", creds.authJson);
    } else await this.mustExec(name, ["rm", "-f", "/root/.local/share/opencode/auth.json"], "Removing auth.json");
  }

  async restartOpencode(run: RunRow, creds?: Credentials) {
    const name = this.name(run);
    const st = await this.state(name);
    if (st.status !== "Running") {
      await call("PUT", `/1.0/instances/${name}/state`, { action: "start" });
      await this.waitForAgent(name);
    }
    if (creds) await this.pushCredentials(name, creds, run.opencode_password!, this.paths(run).workbase);
    await this.mustExec(name, ["sh", "-c", "systemctl reset-failed opencode 2>/dev/null; systemctl restart opencode"], "Restarting opencode");
  }

  async metrics(run: RunRow): Promise<Metrics> {
    const name = this.name(run);
    const st = await this.state(name);
    const out: Metrics = {};
    if (st.memory) {
      out.memUsed = st.memory.usage;
      out.memTotal = st.memory.total || undefined;
    }
    if (st.cpu?.usage !== undefined) {
      const now = Date.now();
      const prev = this.cpuSamples.get(name);
      if (prev && now > prev.t) out.cpu = ((st.cpu.usage - prev.usage) / 1e6 / (now - prev.t)) * 100;
      this.cpuSamples.set(name, { t: now, usage: st.cpu.usage });
    }
    if (st.status === "Running") {
      try {
        const r = await this.execByName(name, ["df", "-B1", "--output=used,size", "/"], 20_000);
        const nums = r.stdout.trim().split("\n").pop()!.trim().split(/\s+/).map(Number);
        if (nums.length === 2 && nums.every(Number.isFinite)) [out.diskUsed, out.diskTotal] = nums;
      } catch {}
    }
    return out;
  }

  async vmState(run: RunRow) {
    try {
      return (await this.state(this.name(run))).status as string;
    } catch {
      return "Missing";
    }
  }

  async startVm(run: RunRow) {
    await call("PUT", `/1.0/instances/${this.name(run)}/state`, { action: "start" });
    await this.waitForAgent(this.name(run));
  }

  async stopVm(run: RunRow) {
    await call("PUT", `/1.0/instances/${this.name(run)}/state`, { action: "stop", timeout: 30, force: true });
  }

  async snapshot(run: RunRow, snap: string) {
    await call("POST", `/1.0/instances/${this.name(run)}/snapshots`, { name: snap });
  }

  async listSnapshots(run: RunRow) {
    const r = await api("GET", `/1.0/instances/${this.name(run)}/snapshots?recursion=1`);
    return ((r.metadata as any[]) ?? []).map((s) => ({ name: s.name, created: s.created_at }));
  }

  async restore(run: RunRow, snap: string) {
    await call("PUT", `/1.0/instances/${this.name(run)}`, { restore: snap });
  }

  async destroy(run: RunRow) {
    const name = this.name(run);
    try {
      const st = await this.state(name);
      if (st.status === "Running") await this.stopVm(run);
    } catch {
      return; // already gone
    }
    await call("DELETE", `/1.0/instances/${name}`);
  }

  describeMachine() {
    return "You are root on a disposable VM with full internet access. Docker, compilers with sanitizers, AFL++/libFuzzer, gdb/rr, semgrep/CodeQL and Ghidra (headless) are installed; install anything else you need.";
  }

  shellCommand(run: RunRow) {
    return `incus exec ${this.name(run)} -- bash -l`;
  }

  async listMachines() {
    const r = await api("GET", "/1.0/instances?recursion=2");
    return ((r.metadata as any[]) ?? [])
      .filter((i) => i.config?.["user.pixel.run"])
      .map((i) => ({ name: i.name, status: i.status, memory: i.state?.memory?.usage, cpu: i.config?.["limits.cpu"] }));
  }

  async info() {
    const r = await api("GET", "/1.0");
    const m: any = r.metadata;
    let image: any = null;
    try {
      image = (await api("GET", `/1.0/images/aliases/${config.incus.image}`)).metadata;
      const full: any = (await api("GET", `/1.0/images/${image.target}`)).metadata;
      image = { alias: config.incus.image, fingerprint: full.fingerprint?.slice(0, 12), created: full.created_at, size: full.size, description: full.properties?.description };
    } catch {
      image = { alias: config.incus.image, missing: true };
    }
    return { runtime: "incus", server: m.environment?.server_version, kernel: m.environment?.kernel_version, storage: m.environment?.storage, image };
  }
}
