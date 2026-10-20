/**
 * Agent access: MCP access tokens for the user's own agents (Claude Code, opencode, any MCP client).
 * Saved right away, not with the page's draft. A token is shown once, when made, with ready-to-paste
 * setup for each client; afterwards only its name, access, last four characters and use are listed.
 */
import { useState, type ReactNode } from "react";
import { IconCopy, IconPlugConnected, IconPlus } from "@tabler/icons-react";
import { api, type McpToken } from "../../lib/api.ts";
import { ago, duration } from "../../lib/format.ts";
import { cn } from "../../lib/cn.ts";
import { Button, ErrorBox, Notice, Segmented, Tabs } from "../../components/ui.tsx";
import { Dialog, Select } from "../../components/ui/overlay.tsx";
import { IC, IC_SM, IC_XS, Join } from "../../components/ui/bits.tsx";
import { Row, Section, State } from "./parts.tsx";

type Data = { url: string; tokens: McpToken[] };

const ACCESS: [McpToken["access"], ReactNode][] = [
  ["read", "Read only"],
  ["full", "Full control"],
];
const ACCESS_HINT: Record<McpToken["access"], string> = {
  read: "Runs, findings, transcripts, workbase files, reports and token usage. Can't change anything.",
  full: "Also start, message and control runs, answer questions, triage findings, and call any Pixel API route.",
};
const EXPIRY: [string, string][] = [
  ["0", "Never expires"],
  ["30", "30 days"],
  ["90", "90 days"],
  ["365", "1 year"],
];

export function AgentAccessSection({ data, setData, error: loadError }: { data: Data | undefined; setData: (d: Data) => void; error: string | null }) {
  const [making, setMaking] = useState(false);
  const tokens = data?.tokens ?? [];
  const now = Date.now();

  const replace = (t: McpToken) => data && setData({ ...data, tokens: data.tokens.map((x) => (x.id === t.id ? t : x)) });

  return (
    <Section
      id="mcp"
      icon={<IconPlugConnected {...IC} />}
      title="Agent access"
      meta="MCP for your own agents, saved right away"
      right={
        <Button size="sm" onClick={() => setMaking(true)} disabled={!data}>
          <IconPlus {...IC_XS} />
          New token
        </Button>
      }
    >
      {!data ? (
        <div className="p-4">
          <ErrorBox error={loadError} />
        </div>
      ) : (
        <>
          <Row label="Address" hint="Agents connect here over MCP (streamable HTTP) with one of the tokens below. Tokens open only this, not the dashboard.">
            <code className="max-w-[340px] truncate rounded-md bg-s3 px-2 py-1 font-mono text-xs max-sm:flex-1">{data.url}</code>
            <Copy text={data.url} label="Copy address" />
          </Row>
          {tokens.length === 0 && <Row label={<State tone="off">No tokens yet</State>} hint="Make one to let an agent connect." />}
          {tokens.map((t) => {
            const expired = !!t.expires && t.expires < now;
            return (
              <Row
                key={t.id}
                label={
                  <>
                    <span className="truncate font-medium">{t.name}</span>
                    {expired && <State tone="warn">Expired</State>}
                  </>
                }
                hint={
                  <Join
                    items={[
                      <>
                        Ends in <span className="font-mono">{t.hint}</span>
                      </>,
                      `Made ${ago(t.created)}`,
                      t.used_at ? (
                        <>
                          Last used {ago(t.used_at)}
                          {t.used_tool && (
                            <>
                              , <span className="font-mono">{t.used_tool}</span>
                            </>
                          )}
                          , {t.uses} call{t.uses === 1 ? "" : "s"}
                        </>
                      ) : (
                        "Never used"
                      ),
                      !t.expires ? "Never expires" : expired ? `Expired ${ago(t.expires)}` : `Expires in ${duration(t.expires - now)}`,
                    ]}
                  />
                }
              >
                <Segmented
                  label={`Access of ${t.name}`}
                  value={t.access}
                  options={ACCESS}
                  onChange={(access) =>
                    void api.updateMcpToken(t.id, { access }).then(replace, () => {
                      /* the list stays as it was */
                    })
                  }
                />
                <Button
                  size="sm"
                  variant="danger"
                  confirm={`Revoke "${t.name}"? Agents using it lose access right away.`}
                  done="Token revoked"
                  onClick={async () => {
                    await api.revokeMcpToken(t.id);
                    setData({ ...data, tokens: data.tokens.filter((x) => x.id !== t.id) });
                  }}
                >
                  Revoke
                </Button>
              </Row>
            );
          })}
          <ConnectGuide url={data.url} />
        </>
      )}
      {making && data && <NewTokenDialog url={data.url} onClose={() => setMaking(false)} onMade={(t) => setData({ ...data, tokens: [t, ...data.tokens] })} />}
    </Section>
  );
}

function NewTokenDialog({ url, onClose, onMade }: { url: string; onClose: () => void; onMade: (t: McpToken) => void }) {
  const [name, setName] = useState("");
  const [access, setAccess] = useState<McpToken["access"]>("read");
  const [days, setDays] = useState("0");
  const [made, setMade] = useState<{ token: string; info: McpToken } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const make = async () => {
    try {
      const r = await api.createMcpToken({ name: name.trim(), access, days: Number(days) || null });
      setMade(r);
      onMade(r.info);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (made)
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        title={`Token for ${made.info.name}`}
        description="Copy it now. Pixel keeps only a fingerprint and can't show it again."
        size="md"
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 rounded-md bg-s3 px-2.5 py-1.5 font-mono text-[12.5px] break-all">{made.token}</code>
          <Copy text={made.token} label="Copy token" />
        </div>
        <Setup url={url} token={made.token} />
      </Dialog>
    );

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New MCP token"
      description="For one agent or machine, so you can revoke it on its own."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim()} onClick={make}>
            Make token
          </Button>
        </>
      }
    >
      <ErrorBox error={error} />
      <label className="label">
        <span>Name</span>
        <input
          className="input"
          value={name}
          placeholder="Claude Code on my laptop"
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && name.trim() && void make()}
        />
      </label>
      <div className="flex flex-col gap-1.5">
        <span className="text-[12.5px] text-ink-2">Access</span>
        <div role="radiogroup" aria-label="Access" className="grid gap-2 sm:grid-cols-2">
          {ACCESS.map(([v, label]) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={access === v}
              onClick={() => setAccess(v)}
              className={cn(
                "flex cursor-pointer flex-col gap-1 rounded-xl border px-3.5 py-3 text-left",
                access === v ? "border-accent/70 bg-s2 shadow-[0_0_0_3px_var(--accent-soft)]" : "border-line-2 bg-s1 hover:border-line",
              )}
            >
              <span className="text-[13px] font-medium text-ink">{label}</span>
              <span className="text-xs leading-relaxed text-ink-3">{ACCESS_HINT[v]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[12.5px] text-ink-2">Expires</span>
        <Select field value={days} onChange={setDays} options={EXPIRY} label="Expires" className="sm:w-[220px]" />
      </div>
      {access === "full" && <Notice>A full-control token can start, stop and message runs and change settings. Give it only to agents you trust with that.</Notice>}
    </Dialog>
  );
}

const PLACEHOLDER = "pxm_YOUR_TOKEN";
const Mono = ({ children }: { children: ReactNode }) => <span className="font-mono text-[11.5px] text-ink-2">{children}</span>;

/** Always under the tokens: how to add Pixel to each client, with the token pasted in if the user gives it (kept in the page only). */
function ConnectGuide({ url }: { url: string }) {
  const [token, setToken] = useState("");
  return (
    <div className="flex flex-col gap-3 px-4 py-3.5">
      <div>
        <div className="text-[13px] text-ink">Connect an agent</div>
        <div className="mt-0.5 max-w-[70ch] text-xs leading-relaxed text-ink-3">
          Make a token above, then add Pixel to your agent below. Use Read only unless the agent should control runs. Paste the token here to fill it into the setup; it stays in this page and isn't saved.
        </div>
      </div>
      <input
        className="input max-w-[420px] font-mono text-[12.5px]"
        type="password"
        autoComplete="off"
        aria-label="Your token, to fill into the setup"
        placeholder="Paste a token (optional)"
        value={token}
        onChange={(e) => setToken(e.target.value.trim())}
      />
      <Setup url={url} token={token || PLACEHOLDER} />
      <div className="text-xs leading-relaxed text-ink-3">
        Not connecting? A 401 means the token is wrong, expired or revoked. A tool answering that the token is read only needs Full control above. Each token's last use shows in its row once the agent calls a tool.
      </div>
    </div>
  );
}

/** Ready-to-paste setup for the common MCP clients, with the steps around it. */
function Setup({ url, token }: { url: string; token: string }) {
  const [tab, setTab] = useState<"claude" | "opencode" | "json">("claude");
  const placeholder = token === PLACEHOLDER;
  const snippets: Record<typeof tab, { text: string; steps: ReactNode[] }> = {
    claude: {
      text: `claude mcp add --transport http --scope user pixel ${url} --header "Authorization: Bearer ${token}"`,
      steps: [
        <>Run this in a terminal{placeholder && <>, with your token in place of <Mono>{PLACEHOLDER}</Mono></>}. <Mono>--scope user</Mono> adds Pixel to every project; leave it out for the current folder only.</>,
        <>Start Claude Code and type <Mono>/mcp</Mono>: pixel should be connected, with its tools listed.</>,
        <>Ask for things in plain words, e.g. "list Pixel's untriaged findings" or "how many tokens did runs use this week".</>,
      ],
    },
    opencode: {
      text: JSON.stringify({ mcp: { pixel: { type: "remote", url, oauth: false, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
      steps: [
        <>Add this to <Mono>opencode.json</Mono> in the project, or to <Mono>~/.config/opencode/opencode.json</Mono> for every project. Keep any <Mono>mcp</Mono> entries already there.</>,
        <>Restart opencode. Pixel's tools come up as the pixel MCP server.</>,
        <>Ask for things in plain words, e.g. "show the latest finding from the libpng run".</>,
      ],
    },
    json: {
      text: JSON.stringify({ mcpServers: { pixel: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
      steps: [
        <>For clients that read <Mono>mcpServers</Mono>: <Mono>.mcp.json</Mono> at a project's root (Claude Code), <Mono>~/.cursor/mcp.json</Mono> (Cursor) and similar.</>,
        <>A project file can end up in git: put <Mono>{"${PIXEL_MCP_TOKEN}"}</Mono> in place of the token and set that variable in your shell (Claude Code expands it).</>,
        <>Restart the client and check that pixel shows as connected.</>,
      ],
    },
  };
  const s = snippets[tab];
  return (
    <div className="flex flex-col">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "claude", label: "Claude Code" },
          { id: "opencode", label: "opencode" },
          { id: "json", label: "JSON config" },
        ]}
      />
      <div className="relative">
        <pre className="m-0 overflow-x-auto rounded-lg border border-line-2 bg-s2 py-2.5 pr-12 pl-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all">{s.text}</pre>
        <div className="absolute top-1.5 right-1.5">
          <Copy text={s.text} label="Copy setup" />
        </div>
      </div>
      <ol className="m-0 mt-3 flex list-decimal flex-col gap-1.5 pl-5 text-xs leading-relaxed text-ink-3 marker:text-ink-4">
        {s.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
    </div>
  );
}

function Copy({ text, label }: { text: string; label: string }) {
  return (
    <Button size="sm" icon variant="ghost" aria-label={label} title={label} onClick={() => navigator.clipboard.writeText(text)} done="Copied">
      <IconCopy {...IC_SM} />
    </Button>
  );
}
