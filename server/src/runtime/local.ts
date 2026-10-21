/**
 * Development runtime: opencode runs as your own user on your machine. No isolation and no
 * read-only enforcement of other workbases. Only for trying Pixel out with harmless prompts.
 */
import { readFileSync, statfsSync } from "node:fs";
import type { RunRow } from "../db.ts";
import type { Metrics } from "./types.ts";
import { ProcessRuntime } from "./process.ts";

export class LocalRuntime extends ProcessRuntime {
  kind = "local" as const;

  protected wrap(_run: RunRow, argv: string[]) {
    return argv;
  }

  protected agentEnv(run: RunRow) {
    const { PIXEL_PASSWORD: _, ...env } = process.env as Record<string, string>;
    return { ...env, ...this.xdgEnv(run) };
  }

  protected opencodeConfig() {
    // Todos are off by default in opencode 2; agents had them in opencode 1 and the dashboard shows them.
    // websearch: without a default provider opencode asks which one to use on the first search (a question form).
    return { $schema: "https://opencode.ai/config.json", permission: "allow", autoupdate: false, share: "disabled", websearch: { provider: "random" }, experimental: { todo: true } };
  }

  describeMachine() {
    return "You run as a normal process on the operator's own computer (Pixel's local test mode, no sandbox). Only run harmless commands and stay inside the directories above.";
  }

  shellCommand(run: RunRow) {
    return `cd ${this.paths(run).target}`;
  }

  async metrics(run: RunRow): Promise<Metrics> {
    const out: Metrics = {};
    try {
      const fs = statfsSync(this.paths(run).target);
      out.diskTotal = fs.blocks * fs.bsize;
      out.diskUsed = (fs.blocks - fs.bfree) * fs.bsize;
    } catch {}
    const p = this.procs.get(run.id);
    if (p && !p.exit) {
      try {
        const rss = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${p.proc.pid}/status`, "utf8"));
        if (rss) out.memUsed = Number(rss[1]) * 1024;
      } catch {}
    }
    return out;
  }

  async info() {
    return { runtime: "local", note: "Development runtime: no isolation between agents or from this machine." };
  }
}
