/** A run's processes for the Machine tab: what uses its memory and CPU, sorted biggest first. */
import { readdirSync, readFileSync } from "node:fs";

export type ProcessKind = "opencode" | "lsp" | "mcp" | "agent";

export interface ProcessInfo {
  pid: number;
  /** Executable name, e.g. `clangd`. */
  name: string;
  /** Command line, shortened. */
  cmd: string;
  kind: ProcessKind;
  rss: number;
  /** Percent of one core since the last reading; null on the first one. */
  cpu: number | null;
}

const LSP = /(^|[/-])(clangd|ccls|gopls|rust-analyzer|typescript-language-server|tsserver|pyright|pylsp|basedpyright|jdtls|lua-language-server|bash-language-server|intelephense|zls|elixir-ls|ruby-lsp|solargraph|sourcekit-lsp|csharp-ls|omnisharp|kotlin-language-server|vscode-[a-z-]+-language-server|[a-z-]+-language-server)\b/;

/** opencode itself, a language server it started, an MCP server, or something the agent started. */
export function kindOf(name: string, cmd: string): ProcessKind {
  if (/opencode/.test(name) || /(^|\/)\.?opencode(\s|$)|opencode serve/.test(cmd)) return "opencode";
  if (LSP.test(name) || LSP.test(cmd)) return "lsp";
  if (/mcp/i.test(name) || /\bmcp\b|[-_]mcp\b|mcp[-_]server/i.test(cmd)) return "mcp";
  return "agent";
}

/** One reading of a process from /proc: memory, CPU ticks, name, command line and parent. */
export function readProc(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const name = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
    return {
      pid,
      ppid: Number(f[1]),
      uid: Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]),
      rss: Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) * 1024,
      ticks: Number(f[11]) + Number(f[12]),
      name,
      cmd: cmd || `[${name}]`,
    };
  } catch {
    return null; // exited while we looked
  }
}
export type ProcReading = NonNullable<ReturnType<typeof readProc>>;

/** Every process under `root` (included), from one pass over /proc. */
export function processTree(root: number): ProcReading[] {
  const all: ProcReading[] = [];
  for (const name of readdirSync("/proc")) if (/^\d+$/.test(name)) {
    const p = readProc(Number(name));
    if (p) all.push(p);
  }
  const children = new Map<number, ProcReading[]>();
  for (const p of all) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const out: ProcReading[] = [];
  const stack = all.filter((p) => p.pid === root);
  while (stack.length) {
    const p = stack.pop()!;
    out.push(p);
    stack.push(...(children.get(p.pid) ?? []));
  }
  return out;
}

/** Turns readings into ProcessInfo, with CPU from the previous reading of the same process. */
export class CpuSampler {
  private last = new Map<number, { t: number; ticks: number }>();

  /** `opencodePid`, when known, is labelled opencode whatever its command line says. */
  info(readings: ProcReading[], opencodePid?: number | null): ProcessInfo[] {
    const now = Date.now();
    const seen = new Set<number>();
    const out = readings.map((p) => {
      seen.add(p.pid);
      const prev = this.last.get(p.pid);
      this.last.set(p.pid, { t: now, ticks: p.ticks });
      // Clock ticks are 1/100 s on Linux.
      const cpu = prev && now > prev.t ? Math.max(0, ((p.ticks - prev.ticks) * 10 * 100) / (now - prev.t)) : null;
      return { pid: p.pid, name: p.name, cmd: p.cmd.slice(0, 300), kind: p.pid === opencodePid ? "opencode" : kindOf(p.name, p.cmd), rss: p.rss, cpu } as ProcessInfo;
    });
    for (const pid of this.last.keys()) if (!seen.has(pid)) this.last.delete(pid);
    return out.sort((a, b) => b.rss - a.rss);
  }
}

/** `ps` output from inside a VM (pid rss-KiB %cpu comm args), for runtimes that can't read the agent's /proc. */
export function parsePs(out: string): ProcessInfo[] {
  return out
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s*(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), name: m[4], cmd: (m[5] || m[4]).slice(0, 300), kind: kindOf(m[4], m[5]), rss: Number(m[2]) * 1024, cpu: Number(m[3]) }))
    .sort((a, b) => b.rss - a.rss);
}
