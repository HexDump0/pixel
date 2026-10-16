/** Shared knowledge: search all workbases, browse them, and see who reads whose work. */
import { useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { useAsync } from "../lib/hooks.ts";
import { Link } from "../lib/router.tsx";
import { ago, bytes } from "../lib/format.ts";
import type { CrossReadEdge, SearchHit } from "../lib/types.ts";
import { WorkbaseBrowser } from "../components/WorkbaseBrowser.tsx";
import { CrossReadGraph } from "../components/CrossReadGraph.tsx";
import { Badge, Card, Empty, ErrorBox, PageHeader, Tabs } from "../components/ui.tsx";

/** Search snippets come back with [[match]] markers. */
function Snippet({ text }: { text: string }) {
  return (
    <span className="font-mono text-xs whitespace-pre-wrap">
      {text.split(/(\[\[.*?\]\])/g).map((s, i) =>
        s.startsWith("[[") ? (
          <mark key={i} className="rounded bg-amber-300/40 text-inherit">
            {s.slice(2, -2)}
          </mark>
        ) : (
          s
        ),
      )}
    </span>
  );
}

function SearchPane({ onOpen }: { onOpen: (run: string) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setHits(await api.search(q));
      setError(null);
    } catch (err: any) {
      setError(err.message);
    }
  };
  return (
    <div>
      <form onSubmit={run} className="mb-3 flex gap-2">
        <input className="input flex-1" placeholder="Search notes, reports and scripts in every workbase…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <button className="btn btn-primary" type="submit">
          Search
        </button>
      </form>
      <ErrorBox error={error} />
      {hits && !hits.length && <Empty>No matches.</Empty>}
      <div className="flex flex-col gap-2">
        {hits?.map((h, i) => (
          <div key={i} className="card p-3">
            <div className="mb-1 text-sm">
              <button className="cursor-pointer font-medium text-accent hover:underline" onClick={() => onOpen(h.run_id)}>
                {h.run_id}
              </button>
              <span className="font-mono text-xs muted"> / {h.path}</span>
            </div>
            <Snippet text={h.snippet} />
          </div>
        ))}
      </div>
    </div>
  );
}

function WorkbasesPane({ onOpen }: { onOpen: (run: string) => void }) {
  const wbs = useAsync(api.workbases, []);
  const [lang, setLang] = useState("");
  const [verdict, setVerdict] = useState("");
  const langs = [...new Set((wbs.data ?? []).map((w) => w.language).filter(Boolean))] as string[];
  // verdict is the run's result ("2 real (1 high)", "nothing real") or an older typed overall verdict.
  const result = (v: string | null) => (!v ? "untriaged" : /^\d+ real\b/.test(v) ? "real" : "other");
  const shown = (wbs.data ?? []).filter((w) => (!lang || w.language === lang) && (!verdict || result(w.verdict) === verdict)).sort((a, b) => b.last - a.last);
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2">
        <select className="input" value={lang} onChange={(e) => setLang(e.target.value)}>
          <option value="">All languages</option>
          {langs.map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
        <select className="input" value={verdict} onChange={(e) => setVerdict(e.target.value)}>
          <option value="">Any triage result</option>
          <option value="real">With real findings</option>
          <option value="other">Nothing real</option>
          <option value="untriaged">Not triaged</option>
        </select>
      </div>
      <ErrorBox error={wbs.error} />
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr>
              {["Workbase", "Repository", "Language", "Status", "Verdict", "Files", "Size", "Last change"].map((h) => (
                <th key={h} className="th">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((w) => (
              <tr key={w.run} className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50" onClick={() => onOpen(w.run)}>
                <td className="td font-medium">{w.run}</td>
                <td className="td max-w-xs truncate text-xs muted">{w.repo ?? "(run deleted)"}</td>
                <td className="td">{w.language ?? "–"}</td>
                <td className="td">
                  <Badge value={w.status} />
                </td>
                <td className="td">{w.verdict ?? "–"}</td>
                <td className="td tabular-nums">{w.files}</td>
                <td className="td tabular-nums">{bytes(w.bytes)}</td>
                <td className="td whitespace-nowrap">{ago(w.last)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {wbs.data && !shown.length && <Empty>No workbases indexed yet (indexing runs every minute).</Empty>}
      </div>
    </div>
  );
}

function CrossReadsPane() {
  const edges = useAsync(api.crossReads, []);
  const data: CrossReadEdge[] = edges.data ?? [];
  const byReader = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of data) m.set(e.run_id, (m.get(e.run_id) ?? 0) + e.n);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [data]);
  if (edges.data && !data.length) return <Empty>No agent has looked at another workbase yet.</Empty>;
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <Card title="Who read whose workbase">
        <CrossReadGraph edges={data} />
      </Card>
      <Card title="Reads">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="th">Reader</th>
              <th className="th">Read</th>
              <th className="th text-right">Times</th>
            </tr>
          </thead>
          <tbody>
            {data.map((e, i) => (
              <tr key={i}>
                <td className="td">
                  <Link to={`/runs/${encodeURIComponent(e.run_id)}`}>{e.run_id}</Link>
                </td>
                <td className="td">{e.other_run === "*" ? <span className="muted">index</span> : e.other_run}</td>
                <td className="td text-right tabular-nums">{e.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 text-xs muted">Most curious: {byReader.slice(0, 3).map(([r, n]) => `${r} (${n})`).join(", ")}</div>
      </Card>
    </div>
  );
}

type TabId = "search" | "workbases" | "graph" | "browse";

export function KnowledgePage() {
  const [tab, setTab] = useState<TabId>("search");
  const [open, setOpen] = useState<string | null>(null);
  const index = useAsync(api.workbaseIndex, []);
  const openRun = (r: string) => {
    setOpen(r);
    setTab("browse");
  };
  return (
    <div>
      <PageHeader title="Knowledge" subtitle="Every workbase, searchable. Agents see these read-only under /workbases." />
      <Tabs<TabId>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "search", label: "Search" },
          { id: "workbases", label: "Workbases" },
          { id: "graph", label: "Cross-reads" },
          { id: "browse", label: open ? `Browse: ${open}` : "INDEX.md" },
        ]}
      />
      {tab === "search" && <SearchPane onOpen={openRun} />}
      {tab === "workbases" && <WorkbasesPane onOpen={openRun} />}
      {tab === "graph" && <CrossReadsPane />}
      {tab === "browse" &&
        (open ? (
          <div>
            <div className="mb-2 text-sm">
              <button className="cursor-pointer text-accent hover:underline" onClick={() => setOpen(null)}>
                ← INDEX.md
              </button>{" "}
              · <Link to={`/runs/${encodeURIComponent(open)}`}>open run</Link>
            </div>
            <WorkbaseBrowser runId={open} className="h-[75vh] rounded-xl border border-line-2" />
          </div>
        ) : (
          <Card title="INDEX.md (what agents see at /workbases/INDEX.md)">
            <pre className="overflow-auto font-mono text-xs whitespace-pre">{index.data?.content}</pre>
          </Card>
        ))}
    </div>
  );
}
