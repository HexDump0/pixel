/**
 * GitHub access for agents: a token (meant to be read-only) given to every agent as GITHUB_TOKEN and
 * GH_TOKEN (git, the gh CLI), and optionally GitHub's remote MCP server in read-only mode with a
 * few toolsets, so tool definitions don't bloat every request.
 *
 * Stored in the settings table under `_github`, so the token never travels back to the browser.
 */
import { db } from "./db.ts";

export interface GithubConfig {
  token: string;
  mcp: boolean;
  /** Comma-separated MCP toolsets (X-MCP-Toolsets). */
  toolsets: string;
}

const KEY = "_github";
export const MCP_URL = "https://api.githubcopilot.com/mcp/readonly";
export const DEFAULT_TOOLSETS = "repos,issues,pull_requests,security_advisories";

function load(): GithubConfig {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(KEY);
  let v: Partial<GithubConfig> = {};
  try {
    v = row ? JSON.parse(row.value) : {};
  } catch {}
  return { token: v.token ?? "", mcp: v.mcp ?? true, toolsets: v.toolsets || DEFAULT_TOOLSETS };
}

const hint = (t: string) => (!t ? null : t.length < 12 ? "••••" : `${t.slice(0, 4)}…${t.slice(-4)}`);

export function githubPublic() {
  const g = load();
  return { tokenHint: hint(g.token), mcp: g.mcp, toolsets: g.toolsets, defaultToolsets: DEFAULT_TOOLSETS, mcpUrl: MCP_URL };
}

export function saveGithub(input: { token?: string; mcp?: boolean; toolsets?: string }) {
  const g = load();
  if (input.token !== undefined) {
    const t = input.token.trim();
    if (t && !/^[A-Za-z0-9_]{20,255}$/.test(t)) throw new Error("that doesn't look like a GitHub token (ghp_…, github_pat_…)");
    g.token = t;
  }
  if (input.mcp !== undefined) g.mcp = !!input.mcp;
  if (input.toolsets !== undefined) {
    const ts = input.toolsets.split(",").map((s) => s.trim()).filter(Boolean);
    if (ts.some((t) => !/^[a-z_]+$/.test(t))) throw new Error("toolsets: comma-separated names like repos,issues");
    g.toolsets = ts.join(",") || DEFAULT_TOOLSETS;
  }
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(g));
  return githubPublic();
}

/** Ask GitHub who the token belongs to and what it may do. */
export async function checkGithub() {
  const { token } = load();
  if (!token) throw new Error("no token saved");
  const res = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "pixel" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const user: any = await res.json();
  // Classic tokens list their scopes; fine-grained tokens don't, and their permissions can't be read back.
  const scopes = res.headers.get("x-oauth-scopes");
  const list = scopes ? scopes.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const risky = list?.filter((s) => ["repo", "public_repo", "write:packages", "delete_repo", "admin:org", "workflow", "write:org", "gist"].includes(s)) ?? [];
  return {
    login: user.login as string,
    kind: token.startsWith("github_pat_") ? "fine-grained" : token.startsWith("ghp_") ? "classic" : "other",
    scopes: list,
    writeScopes: risky,
    rateLimit: Number(res.headers.get("x-ratelimit-limit") ?? 0) || null,
    rateRemaining: Number(res.headers.get("x-ratelimit-remaining") ?? 0) || null,
  };
}

/** What every agent gets: env vars, and the MCP server entry for its opencode config. */
export function githubForAgents(): { env: Record<string, string>; mcp: Record<string, unknown> | null } {
  const g = load();
  if (!g.token) return { env: {}, mcp: null };
  return {
    env: { GITHUB_TOKEN: g.token, GH_TOKEN: g.token },
    mcp: g.mcp
      ? {
          github: {
            type: "remote",
            url: MCP_URL,
            // A bad token should fail as a 401, not start an OAuth login nobody can finish.
            oauth: false,
            headers: { Authorization: `Bearer ${g.token}`, "X-MCP-Readonly": "true", "X-MCP-Toolsets": g.toolsets },
            enabled: true,
          },
        }
      : null,
  };
}
