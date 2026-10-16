/** GitHub access for agents: a read-only token, the gh CLI, and GitHub's MCP server (read-only). Saved on its own, not with the page's draft. */
import { useState } from "react";
import { IconBrandGithub } from "@tabler/icons-react";
import { api, type GithubInfo } from "../../lib/api.ts";
import { Button, ErrorBox, Notice } from "../../components/ui.tsx";
import { IC, Join } from "../../components/ui/bits.tsx";
import { Row, Section, State, Toggle } from "./parts.tsx";

type Check = Awaited<ReturnType<typeof api.checkGithub>>;

export function GithubSection({ g, setG, error: loadError }: { g: GithubInfo | undefined; setG: (g: GithubInfo) => void; error: string | null }) {
  const [token, setToken] = useState("");
  const [toolsets, setToolsets] = useState<string | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (body: Parameters<typeof api.saveGithub>[0]) => {
    try {
      setG(await api.saveGithub(body));
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
    <Section
      id="github"
      icon={<IconBrandGithub {...IC} />}
      title="GitHub"
      meta="Saved right away, for agents started after a change"
      right={
        g?.tokenHint && (
          <>
            <Button size="sm" onClick={runCheck}>
              Check token
            </Button>
            <Button size="sm" variant="danger" confirm="Remove the GitHub token? New agents won't get GitHub access." onClick={() => save({ token: "" })} done="GitHub token removed">
              Remove
            </Button>
          </>
        )
      }
    >
      {!g ? (
        <div className="p-4">
          <ErrorBox error={loadError} />
        </div>
      ) : (
        <>
          {error && (
            <div className="p-3">
              <ErrorBox error={error} />
            </div>
          )}
          <Row
            label={
              <>
                Token
                {g.tokenHint ? (
                  <State tone="good">
                    <span className="font-mono">{g.tokenHint}</span>
                  </State>
                ) : (
                  <State tone="off">Public repos only</State>
                )}
              </>
            }
            hint={
              <>
                A{" "}
                <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">
                  fine-grained token
                </a>{" "}
                with read-only Contents, Issues, Pull requests and Metadata. Agents get it as <span className="font-mono">GITHUB_TOKEN</span> and <span className="font-mono">GH_TOKEN</span> for git and the{" "}
                <span className="font-mono">gh</span> CLI. Never shown again.
              </>
            }
          >
            <input
              className="input w-[260px] font-mono max-sm:flex-1"
              type="password"
              autoComplete="off"
              aria-label="GitHub token"
              placeholder={g.tokenHint ? "Paste to replace" : "github_pat_"}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <Button
              variant="primary"
              size="sm"
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
          </Row>
          {check && (
            <div className="flex flex-col gap-2 px-4 py-3 text-[12.5px] text-ink-2">
              <Join
                items={[
                  <>
                    Token of <b className="font-medium text-ink">{check.login}</b>, {check.kind}
                  </>,
                  <>
                    <span className="font-mono tabular-nums">
                      {check.rateRemaining ?? "?"} of {check.rateLimit ?? "?"}
                    </span>{" "}
                    API calls left this hour
                  </>,
                  check.kind === "fine-grained" && <span className="text-ink-3">GitHub doesn't report a fine-grained token's permissions; make sure they're all read-only</span>,
                ]}
              />
              {check.writeScopes.length > 0 && (
                <Notice>
                  This classic token can write (<span className="font-mono">{check.writeScopes.join(", ")}</span>). Agents run untrusted code; use a read-only fine-grained token instead.
                </Notice>
              )}
            </div>
          )}
          <Row label="GitHub MCP server, read-only" hint="Search code, issues, PRs and security advisories across GitHub. Its tool list goes with every model call, so only the toolsets below load.">
            <Toggle label="GitHub MCP server" checked={g.mcp} onChange={(on) => void save({ mcp: on }).catch(() => {})} />
          </Row>
          {g.mcp && (
            <Row label="MCP toolsets" hint={<>Comma separated. Fewer toolsets, fewer tokens per call.</>}>
              <input className="input w-[320px] font-mono text-[12.5px] max-sm:flex-1" aria-label="MCP toolsets" placeholder={g.defaultToolsets} value={toolsets ?? g.toolsets} onChange={(e) => setToolsets(e.target.value)} />
              <Button size="sm" disabled={toolsets == null || toolsets === g.toolsets} onClick={async () => (await save({ toolsets: toolsets ?? "" }), setToolsets(null))} done="Toolsets saved">
                Save
              </Button>
            </Row>
          )}
        </>
      )}
    </Section>
  );
}
