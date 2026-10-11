/** GitHub access for agents: a read-only token, the gh CLI, and GitHub's MCP server (read-only). */
import { useState } from "react";
import { api } from "../lib/api.ts";
import { useAsync } from "../lib/hooks.ts";
import { Button, Card, ErrorBox, Field, Notice } from "./ui.tsx";

type Check = Awaited<ReturnType<typeof api.checkGithub>>;

export function GithubCard() {
  const gh = useAsync(api.github, []);
  const [token, setToken] = useState("");
  const [toolsets, setToolsets] = useState<string | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [error, setError] = useState<string | null>(null);
  const g = gh.data;

  const save = async (body: Parameters<typeof api.saveGithub>[0]) => {
    try {
      gh.setData(await api.saveGithub(body));
      setError(null);
    } catch (e: any) {
      setError(e.message);
      throw e;
    }
  };
  const runCheck = async () => {
    setCheck(null);
    try {
      setCheck(await api.checkGithub());
      setError(null);
    } catch (e: any) {
      setError(e.message);
      throw e;
    }
  };

  return (
    <Card
      title="GitHub"
      actions={
        g?.tokenHint ? (
          <>
            <Button small onClick={runCheck}>
              Check token
            </Button>
            <Button small variant="danger" confirm="Remove the GitHub token? New agents won't get GitHub access." onClick={() => save({ token: "" })} done="GitHub token removed">
              Remove
            </Button>
          </>
        ) : null
      }
    >
      {!g ? (
        <ErrorBox error={gh.error} />
      ) : (
        <div className="flex flex-col gap-3">
          <ErrorBox error={error} />
          <div className="text-sm">
            {g.tokenHint ? (
              <>
                <span className="badge done">connected</span> <span className="font-mono">{g.tokenHint}</span>
              </>
            ) : (
              <span className="muted">No token yet. Agents can clone public repos, but have no GitHub API access.</span>
            )}
          </div>
          {check && (
            <div className="text-sm">
              Token of <b>{check.login}</b> ({check.kind}) · API rate limit {check.rateRemaining ?? "?"} / {check.rateLimit ?? "?"} per hour
              {check.kind === "fine-grained" && <div className="text-xs muted">GitHub doesn't report a fine-grained token's permissions; make sure they're all read-only.</div>}
            </div>
          )}
          {check && check.writeScopes.length > 0 && (
            <Notice>
              This classic token has write access (<span className="font-mono">{check.writeScopes.join(", ")}</span>). Agents run untrusted code; use a read-only fine-grained token instead.
            </Notice>
          )}
          <Field
            label={g.tokenHint ? "Replace token" : "Token"}
            hint={
              <>
                A{" "}
                <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">
                  fine-grained token
                </a>{" "}
                with read-only permissions (Contents, Issues, Pull requests, Metadata). Never shown again. Every new agent gets it as <span className="font-mono">GITHUB_TOKEN</span> /{" "}
                <span className="font-mono">GH_TOKEN</span>, for git and the <span className="font-mono">gh</span> CLI.
              </>
            }
          >
            <span className="flex gap-1.5">
              <input className="input flex-1 font-mono" type="password" autoComplete="off" placeholder="github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} />
              <Button
                variant="primary"
                small
                disabled={!token.trim()}
                onClick={async () => {
                  await save({ token });
                  setToken("");
                  await runCheck().catch(() => {});
                }}
                done="GitHub token saved"
              >
                Save
              </Button>
            </span>
          </Field>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={g.mcp} onChange={(e) => void save({ mcp: e.target.checked }).catch(() => {})} />
            <span>
              Give agents GitHub's MCP server, read-only
              <span className="block text-xs muted">Search code, issues, PRs and security advisories across GitHub. Its tool list is sent with every model call, so only the toolsets below are loaded.</span>
            </span>
          </label>
          {g.mcp && (
            <Field label="MCP toolsets" hint={`Comma-separated, e.g. ${g.defaultToolsets}. Fewer toolsets = fewer tokens per call.`}>
              <span className="flex gap-1.5">
                <input className="input flex-1 font-mono" value={toolsets ?? g.toolsets} onChange={(e) => setToolsets(e.target.value)} />
                <Button small disabled={toolsets == null || toolsets === g.toolsets} onClick={async () => (await save({ toolsets: toolsets ?? "" }), setToolsets(null))} done="Toolsets saved">
                  Save
                </Button>
              </span>
            </Field>
          )}
          <div className="text-xs muted">Applies to agents started after a change; running agents keep what they started with.</div>
        </div>
      )}
    </Card>
  );
}
