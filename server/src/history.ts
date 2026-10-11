/**
 * Workbase history: periodic git commits into a git dir kept outside the workbase,
 * so agents never see it and can still use git inside their workbase themselves.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { workbasePath } from "./knowledge.ts";

const MAX_TRACKED = 1024 * 1024;

const gitDir = (runId: string) => join(config.historyDir, `${runId}.git`);

async function git(runId: string, args: string[], stdin?: string) {
  const p = Bun.spawn(["git", `--git-dir=${gitDir(runId)}`, `--work-tree=${workbasePath(runId)}`, ...args], {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "pixel", GIT_AUTHOR_EMAIL: "pixel@localhost", GIT_COMMITTER_NAME: "pixel", GIT_COMMITTER_EMAIL: "pixel@localhost" },
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { code, out, err };
}

function smallFiles(runId: string) {
  const base = workbasePath(runId);
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== ".git") walk(full);
      } else if (e.isFile()) {
        try {
          if (statSync(full).size <= MAX_TRACKED) out.push(full.slice(base.length + 1));
        } catch {}
      }
    }
  };
  walk(base);
  return out;
}

/** Commit the workbase's current state if anything changed. Returns the new commit or null. */
export async function snapshotWorkbase(runId: string, message = "snapshot") {
  if (!existsSync(workbasePath(runId))) return null;
  if (!existsSync(gitDir(runId))) {
    await git(runId, ["init", "--quiet"]);
  }
  const files = smallFiles(runId);
  await git(runId, ["add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"], files.join("\0"));
  await git(runId, ["add", "--update"]); // record deletions and files that grew past the limit
  const diff = await git(runId, ["diff", "--cached", "--quiet"]);
  if (diff.code === 0) return null;
  const c = await git(runId, ["commit", "--quiet", "--no-verify", "-m", message]);
  if (c.code !== 0) return null;
  return (await git(runId, ["rev-parse", "HEAD"])).out.trim();
}

export async function historyLog(runId: string, limit = 200) {
  if (!existsSync(gitDir(runId))) return [];
  const r = await git(runId, ["log", `-n${limit}`, "--format=%H%x09%ct%x09%s", "--shortstat"]);
  const entries: { commit: string; ts: number; message: string; stat: string }[] = [];
  for (const line of r.out.split("\n")) {
    const parts = line.split("\t");
    if (parts.length === 3) entries.push({ commit: parts[0], ts: Number(parts[1]) * 1000, message: parts[2], stat: "" });
    else if (line.trim() && entries.length) entries[entries.length - 1].stat = line.trim();
  }
  return entries;
}

export async function historyShow(runId: string, commit: string) {
  if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error("bad commit id");
  const r = await git(runId, ["show", "--format=%H%n%ct%n%s", "--stat", "--patch", "--no-color", commit]);
  return r.out.slice(0, 2_000_000);
}
