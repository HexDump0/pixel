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
  full: "Also start, message and control runs, answer questions, set verdicts, and call any Pixel API route.",
};
const EXPIRY: [string, string][] = [
  ["0", "Never expires"],
  ["30", "30 days"],
  ["90", "90 days"],
  ["365", "1 year"],
];

export function AgentAccessSection({ data, setData, error: loadError }: { data: Data | undefined; setData: (d: Data) => void; error: string | null }) {
  const [making, setMaking] = useState(false);
  const [howTo, setHowTo] = useState(false);
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
            <Button size="sm" variant="ghost" onClick={() => setHowTo(true)}>
              How to connect
            </Button>
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
        </>
      )}
      {making && data && <NewTokenDialog url={data.url} onClose={() => setMaking(false)} onMade={(t) => setData({ ...data, tokens: [t, ...data.tokens] })} />}
      {howTo && data && (
        <Dialog open onOpenChange={setHowTo} title="Connect an agent" description="Put one of your tokens where it says pxm_YOUR_TOKEN." size="md">
          <Setup url={data.url} token="pxm_YOUR_TOKEN" />
        </Dialog>
      )}
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

/** Ready-to-paste setup for the common MCP clients. */
function Setup({ url, token }: { url: string; token: string }) {
  const [tab, setTab] = useState<"claude" | "opencode" | "json">("claude");
  const snippets = {
    claude: { text: `claude mcp add --transport http pixel ${url} --header "Authorization: Bearer ${token}"`, hint: "Run in a terminal. Add --scope user to have it in every project." },
    opencode: {
      text: JSON.stringify({ mcp: { pixel: { type: "remote", url, oauth: false, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
      hint: "Merge into opencode.json (the project's, or ~/.config/opencode/opencode.json for all).",
    },
    json: {
      text: JSON.stringify({ mcpServers: { pixel: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
      hint: "For .mcp.json in a project, Cursor, and other clients that take mcpServers.",
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
      <div className="mt-2 text-xs text-ink-3">{s.hint}</div>
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
