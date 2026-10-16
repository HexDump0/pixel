/**
 * Proxies for runs' model calls: add, test (exit IP and location, which provider APIs answer through it),
 * pick the default for new runs, see how runs use them. Runs and live tests choose one on their own.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { IconAlertTriangle, IconDots, IconFileImport, IconPencil, IconPlus, IconStar, IconStarFilled, IconTrash, IconWorld } from "@tabler/icons-react";
import { api } from "../../lib/api.ts";
import { keys } from "../../lib/query.ts";
import { ago } from "../../lib/format.ts";
import { cn } from "../../lib/cn.ts";
import type { ProxyInput, ProxyTest, PublicProxy } from "../../lib/types.ts";
import { Button, ErrorBox, Segmented } from "../../components/ui.tsx";
import { IC_SM, IC_XS, Join, Nothing, SectionHead } from "../../components/ui/bits.tsx";
import { Dialog, Menu } from "../../components/ui/overlay.tsx";
import { useProxies } from "../../components/ProxySelect.tsx";
import { toast } from "../../components/Toast.tsx";
import { ms } from "./common.tsx";

type Row = PublicProxy & { runs: string[] };
type Scheme = NonNullable<ProxyInput["scheme"]>;
const SCHEME_OPTIONS: [Scheme, string][] = [
  ["auto", "Auto"],
  ["http", "HTTP"],
  ["https", "HTTPS"],
  ["socks5", "SOCKS5"],
];

/** Exit IP, place and network from a test, and which provider APIs answered. */
function TestResult({ t, compact }: { t: ProxyTest; compact?: boolean }) {
  if (!t.ok) return <span className="text-critical" title={t.error}>Failed{compact ? "" : `: ${t.error}`}</span>;
  const reached = t.reach?.filter((r) => r.status != null) ?? [];
  return (
    <span className="min-w-0">
      <span className="block truncate">
        <Join items={[<span className="font-mono">{t.ip}</span>, [t.city, t.country].filter(Boolean).join(", "), !compact && t.org]} />
      </span>
      {!!t.reach?.length && (
        <span className={cn("block truncate text-xs", reached.length < t.reach.length ? "text-warning" : "text-ink-3")} title={t.reach.map((r) => `${r.host}: ${r.status != null ? `HTTP ${r.status} in ${ms(r.ms)}` : r.error}`).join("\n")}>
          {reached.length === t.reach.length ? `Reaches ${t.reach.length === 1 ? t.reach[0].host : `all ${t.reach.length} provider APIs`}` : `Reaches ${reached.length} of ${t.reach.length} provider APIs`}
        </span>
      )}
    </span>
  );
}

export function Proxies({ defaultProxy, onDefault }: { defaultProxy: string; onDefault: (id: string) => Promise<void> }) {
  const q = useProxies();
  const qc = useQueryClient();
  const [edit, setEdit] = useState<Row | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const list = (q.data?.proxies ?? []) as Row[];
  const reload = () => qc.invalidateQueries({ queryKey: keys.proxies });

  const test = async (p: Row) => {
    setTesting(p.id);
    try {
      const t = await api.testProxy(p.id);
      toast(t.ok ? `${p.name} works, out from ${[t.city, t.country].filter(Boolean).join(", ") || t.ip}` : `${p.name} failed: ${t.error}`, t.ok ? undefined : "error");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setTesting(null);
      void reload();
    }
  };
  const remove = async (p: Row) => {
    const n = p.runs.length;
    if (!confirm(n ? `Remove ${p.name}? ${n} active run${n === 1 ? " uses" : "s use"} it; their model calls stop until you pick another proxy or none.` : `Remove ${p.name}?`)) return;
    try {
      await api.removeProxy(p.id);
      toast(`${p.name} removed`);
    } catch (e: any) {
      toast(e.message, "error");
    }
    void reload();
  };

  return (
    <section id="proxies" className="scroll-mt-20">
      <SectionHead
        className="mt-8"
        title="Proxies"
        meta="For model calls only; the agent's own traffic goes direct"
        right={
          list.length > 0 && (
            <span className="flex gap-1.5">
              <Button size="sm" onClick={() => setImporting(true)}>
                <IconFileImport {...IC_SM} />
                Import
              </Button>
              <Button size="sm" onClick={() => setEdit("new")}>
                <IconPlus {...IC_SM} />
                Add proxy
              </Button>
            </span>
          )
        }
      />
      <ErrorBox error={q.error?.message} />
      {q.data && q.data.unrelayable.length > 0 && list.length > 0 && (
        <p className="mt-0 mb-2.5 flex items-center gap-2 text-xs text-warning">
          <IconAlertTriangle {...IC_XS} />
          Calls to {q.data.unrelayable.join(", ")} can't go through a proxy: Pixel doesn't know their API's address.
        </p>
      )}
      {q.data && !list.length ? (
        <Nothing>
          <IconWorld {...IC_SM} />
          <span>No proxies yet</span>
          <Button size="sm" onClick={() => setEdit("new")}>
            <IconPlus {...IC_SM} />
            Add proxy
          </Button>
          <Button size="sm" onClick={() => setImporting(true)}>
            <IconFileImport {...IC_SM} />
            Import
          </Button>
        </Nothing>
      ) : (
        <div role="table" className="overflow-x-auto rounded-2xl border border-line-2 bg-s1">
          <div className="min-w-[860px]">
            <div role="row" className="grid h-[38px] grid-cols-[28px_minmax(180px,1.2fr)_minmax(220px,1.5fr)_72px_minmax(150px,1fr)_120px] items-center gap-3.5 border-b border-line-2 px-3 text-xs text-ink-3">
              <span />
              <span>Proxy</span>
              <span>Exit, from the last test</span>
              <span className="text-right">Latency</span>
              <span>Last hour</span>
              <span />
            </div>
            {list.map((p, i) => {
              const isDefault = defaultProxy === p.id;
              const u = p.use;
              return (
                <div key={p.id} role="row" className={cn("group grid min-h-14 grid-cols-[28px_minmax(180px,1.2fr)_minmax(220px,1.5fr)_72px_minmax(150px,1fr)_120px] items-center gap-3.5 px-3 py-2 text-[13px] hover:bg-s2", i > 0 && "border-t border-line-2")}>
                  <button
                    type="button"
                    onClick={() => void onDefault(isDefault ? "" : p.id)}
                    aria-pressed={isDefault}
                    title={isDefault ? "Default for new runs (click to make new runs go direct)" : "Make default for new runs"}
                    className={cn("inline-flex size-6 cursor-pointer items-center justify-center rounded-md hover:bg-s3", isDefault ? "text-accent" : "text-ink-4 hover:text-ink-2")}
                  >
                    {isDefault ? <IconStarFilled size={14} /> : <IconStar size={14} stroke={1.75} />}
                  </button>
                  <span className="min-w-0">
                    <b className="block truncate font-medium">{p.name}</b>
                    <span className="block truncate font-mono text-[11.5px] text-ink-3" title={p.note || undefined}>
                      {p.scheme}://{p.user ? `${p.user}@` : ""}
                      {p.host}:{p.port}
                    </span>
                  </span>
                  <span className="min-w-0 text-ink-2">
                    {p.test ? (
                      <span className="flex items-baseline gap-2">
                        <TestResult t={p.test} compact />
                        <span className="shrink-0 font-mono text-[11px] text-ink-4">{ago(p.test.at).replace(" ago", "")}</span>
                      </span>
                    ) : (
                      <span className="text-ink-4">Not tested</span>
                    )}
                  </span>
                  <span className="text-right font-mono text-xs text-ink-2 tabular-nums">{p.test?.ok ? ms(p.test.ms) : ""}</span>
                  <span className="min-w-0 text-xs text-ink-3">
                    <span className="block truncate">
                      <Join items={[p.runs.length > 0 && `${p.runs.length} run${p.runs.length === 1 ? "" : "s"}`, `${u.callsLastHour} calls`, u.failuresLastHour > 0 && <span className="text-critical">{u.failuresLastHour} failed</span>]} />
                    </span>
                    {u.lastError && u.failuresLastHour > 0 && (
                      <span className="block truncate text-critical" title={u.lastError.message}>
                        {u.lastError.message}
                      </span>
                    )}
                  </span>
                  <span className="flex justify-end gap-1">
                    <Button size="xs" onClick={() => test(p)} disabled={testing === p.id}>
                      {testing === p.id ? "Testing" : "Test"}
                    </Button>
                    <Menu
                      trigger={
                        <button type="button" aria-label={`More for ${p.name}`} className="inline-flex size-[26px] cursor-pointer items-center justify-center rounded-md text-ink-3 hover:bg-s3 hover:text-ink">
                          <IconDots {...IC_SM} />
                        </button>
                      }
                      items={[
                        { label: "Edit", icon: <IconPencil {...IC_SM} />, onSelect: () => setEdit(p) },
                        { label: "Remove", icon: <IconTrash {...IC_SM} />, danger: true, onSelect: () => void remove(p) },
                      ]}
                    />
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onImported={async (added) => {
            void reload();
            // Test each one, so the list shows where it comes out.
            for (const p of added) {
              setTesting(p.id);
              await api.testProxy(p.id).catch(() => {});
              void reload();
            }
            setTesting(null);
          }}
        />
      )}
      {edit && (
        <ProxyDialog
          proxy={edit === "new" ? null : edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            void reload();
          }}
        />
      )}
    </section>
  );
}

function ProxyDialog({ proxy, onClose, onSaved }: { proxy: Row | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<Required<Omit<ProxyInput, "url">> & { url: string }>({
    name: proxy?.name ?? "",
    url: proxy ? `${proxy.host}:${proxy.port}` : "",
    scheme: (proxy?.scheme as Scheme) ?? "auto",
    username: proxy?.user ?? "",
    password: "",
    note: proxy?.note ?? "",
  });
  const [result, setResult] = useState<ProxyTest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const setAddress = (e: React.ChangeEvent<HTMLInputElement>) => {
    const split = splitCredentials(e.target.value);
    const url = split?.url ?? e.target.value;
    const typed = /^(https?|socks5h?):\/\//i.exec(url.trim())?.[1].toLowerCase().replace("socks5h", "socks5") as Scheme | undefined;
    setF({ ...f, ...split, url: url.replace(/^\w+:\/\//, ""), scheme: typed ?? f.scheme });
  };
  const body = (): ProxyInput => ({ name: f.name, url: f.url, scheme: f.scheme, username: f.username, ...(f.password && { password: f.password }), note: f.note });

  const test = async () => {
    setError(null);
    setResult(null);
    try {
      setResult(await api.testProxyAddress({ ...body(), ...(proxy && { id: proxy.id }) }));
    } catch (e: any) {
      setError(e.message);
    }
  };
  const save = async () => {
    try {
      const saved = proxy ? await api.editProxy(proxy.id, body()) : await api.addProxy(body());
      // Keep the test just run, so the list shows where it comes out.
      if (result && !proxy) await api.testProxy(saved.id).catch(() => {});
      onSaved();
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <Dialog
      onOpenChange={(o) => !o && onClose()}
      size="md"
      title={proxy ? `Edit ${proxy.name}` : "Add proxy"}
      description="HTTP, HTTPS or SOCKS5 proxy. Its password stays in Pixel; agents only reach it through Pixel's relay."
      footer={
        <>
          <Button variant="ghost" className="mr-auto" onClick={test} disabled={!f.url.trim()}>
            Test
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={!f.url.trim()} done={proxy ? "Proxy saved" : "Proxy added"}>
            {proxy ? "Save" : "Add"}
          </Button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
        <label className="label col-span-full">
          <span>Address</span>
          <input className="input font-mono" value={f.url} onChange={setAddress} placeholder="host:8080" spellCheck={false} autoComplete="off" />
          <span>Host and port. Pasting host:port:user:password or user:password@host:port fills in the username and password.</span>
        </label>
        <div className="label col-span-full">
          <span>Protocol</span>
          <Segmented label="Protocol" value={f.scheme} onChange={(scheme) => setF({ ...f, scheme })} options={SCHEME_OPTIONS} className="self-start" />
          <span>{f.scheme === "auto" ? "Pixel asks the proxy what it speaks when you test or add it." : f.scheme === "socks5" ? "Pixel bridges model calls to it on its own side." : null}</span>
        </div>
        <label className="label">
          <span>Username</span>
          <input className="input font-mono" value={f.username} onChange={set("username")} placeholder="none" autoComplete="off" />
        </label>
        <label className="label">
          <span>Password</span>
          <input className="input font-mono" type="password" value={f.password} onChange={set("password")} placeholder={proxy?.hasPassword ? "unchanged" : "none"} autoComplete="new-password" />
        </label>
        <label className="label">
          <span>Name</span>
          <input className="input" value={f.name} onChange={set("name")} placeholder={f.url.replace(/^\w+:\/\//, "").split(/[:/@]/).pop() || "Office proxy"} />
        </label>
        <label className="label">
          <span>Note</span>
          <input className="input" value={f.note} onChange={set("note")} placeholder="optional" />
        </label>
      </div>
      {result && (
        <div className={cn("rounded-xl border px-3.5 py-3 text-[13px]", result.ok ? "border-line-2 bg-s2" : "border-critical/45 bg-critical/10")}>
          <TestResult t={result} />
          {result.ok && <span className="mt-1 block text-xs text-ink-3">First answer in {ms(result.ms)}</span>}
        </div>
      )}
    </Dialog>
  );
}

/** host:port:user:password, user:password:host:port or [scheme://]user:password@host:port: the address and its credentials apart. */
function splitCredentials(v: string): { url: string; username: string; password: string } | null {
  const t = v.trim();
  const at = /^(https?:\/\/)?([^:/@]+):(.*)@([^@/]+)$/.exec(t);
  if (at) {
    const d = (x: string) => {
      try {
        return decodeURIComponent(x);
      } catch {
        return x;
      }
    };
    return { url: `${at[1] ?? "http://"}${at[4]}`, username: d(at[2]), password: d(at[3]) };
  }
  if (t.includes("://") || t.includes("@")) return null;
  const p = t.split(":");
  if (p.length >= 4 && /^\d+$/.test(p[1])) return { url: `http://${p[0]}:${p[1]}`, username: p[2], password: p.slice(3).join(":") };
  if (p.length === 4 && /^\d+$/.test(p[3])) return { url: `http://${p[2]}:${p[3]}`, username: p[0], password: p[1] };
  return null;
}

/** Many proxies pasted at once, one per line; each is tested after it's added. */
function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: (added: PublicProxy[]) => void }) {
  const [text, setText] = useState("");
  const [scheme, setScheme] = useState<Scheme>("auto");
  const [skipped, setSkipped] = useState<{ line: number; reason: string }[]>([]);
  const lines = text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).length;
  const save = async () => {
    const r = await api.importProxies(text, scheme);
    if (r.added.length) toast(`Added ${r.added.length} prox${r.added.length === 1 ? "y" : "ies"}; testing ${r.added.length === 1 ? "it" : "them"}`);
    onImported(r.added);
    if (r.skipped.length) setSkipped(r.skipped);
    else onClose();
  };
  return (
    <Dialog
      onOpenChange={(o) => !o && onClose()}
      size="md"
      title="Import proxies"
      description="One per line: host:port:user:password as proxy sellers list them, user:password@host:port, or with a scheme like socks5://user:password@host:port."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {skipped.length ? "Close" : "Cancel"}
          </Button>
          {!skipped.length && (
            <Button variant="primary" onClick={save} disabled={!lines}>
              Import{lines > 1 ? ` ${lines}` : ""}
            </Button>
          )}
        </>
      }
    >
      {skipped.length > 0 ? (
        <div className="text-[13px]">
          <p className="mt-0 mb-2">Not imported:</p>
          <ul className="m-0 list-none p-0 text-ink-2">
            {skipped.map((x) => (
              <li key={x.line}>
                Line {x.line}: {x.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          <textarea className="input min-h-40 w-full resize-y py-2 font-mono text-[12.5px]" value={text} onChange={(e) => setText(e.target.value)} placeholder="45.41.128.10:8001:user:password" spellCheck={false} autoComplete="off" autoFocus />
          <div className="label">
            <span>Protocol</span>
            <Segmented label="Protocol" value={scheme} onChange={setScheme} options={SCHEME_OPTIONS} className="self-start" />
            <span>{scheme === "auto" ? "Pixel asks each proxy what it speaks; a scheme written in a line wins." : "For every line, whatever is written in it."}</span>
          </div>
        </>
      )}
    </Dialog>
  );
}
