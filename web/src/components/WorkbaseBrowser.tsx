/**
 * One workbase: a folder tree (REPORT.md, FINDINGS.md and TRIAGE.md pinned on top, finding folders named by
 * their finding) and a viewer (markdown rendered, code highlighted with line numbers, images shown, binaries
 * as a hex peek), with the file's own history from the snapshots and editing. Used on run pages and in Knowledge.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { IconChevronDown, IconChevronRight, IconDownload, IconFile, IconFileCode, IconFileText, IconFolder, IconHistory, IconPencil, IconPhoto, IconRefresh } from "@tabler/icons-react";
import { api } from "../lib/api.ts";
import { useLive } from "../lib/live.ts";
import { ago, bytes } from "../lib/format.ts";
import { highlight, htmlLines, langForPath } from "../lib/highlight.ts";
import { sevOf, useRunFindings } from "../lib/findings.ts";
import { cn } from "../lib/cn.ts";
import type { FileEntry, Finding } from "../lib/types.ts";
import { Markdown } from "./Markdown.tsx";
import { Button, ErrorBox } from "./ui.tsx";
import { IC_SM, IC_XS, Join, Nothing, Sev } from "./ui/bits.tsx";

const PINNED = ["REPORT.md", "FINDINGS.md", "TRIAGE.md"];
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
const isMd = (p: string) => /\.(md|markdown)$/i.test(p);

function iconFor(e: FileEntry) {
  if (e.dir) return IconFolder;
  if (IMAGE.test(e.name)) return IconPhoto;
  if (isMd(e.name) || /\.(txt|log)$/i.test(e.name)) return IconFileText;
  if (langForPath(e.name)) return IconFileCode;
  return IconFile;
}

// ---- tree ----

function useDir(runId: string, dir: string, enabled = true) {
  return useQuery({ queryKey: ["workbase", runId, "dir", dir], queryFn: () => api.files(runId, dir), enabled, staleTime: 5_000 });
}

interface TreeProps {
  runId: string;
  selected: string | null;
  open: Set<string>;
  toggle: (dir: string) => void;
  select: (path: string) => void;
  findings: Map<string, Finding>;
}

function Row({ e, depth, t }: { e: FileEntry; depth: number; t: TreeProps }) {
  const Icon = iconFor(e);
  const expanded = e.dir && t.open.has(e.path);
  const f = e.dir ? t.findings.get(e.path) : undefined;
  return (
    <>
      <button
        type="button"
        aria-current={t.selected === e.path ? "true" : undefined}
        aria-expanded={e.dir ? expanded : undefined}
        title={e.path}
        onClick={() => (e.dir ? t.toggle(e.path) : t.select(e.path))}
        style={{ paddingLeft: 8 + depth * 14 }}
        className="grid h-7 w-full cursor-pointer grid-cols-[12px_15px_minmax(0,1fr)_auto] items-center gap-1.5 rounded-md pr-2 text-left text-[13px] text-ink-2 hover:bg-s2 hover:text-ink aria-[current=true]:bg-s3 aria-[current=true]:text-ink"
      >
        {e.dir ? expanded ? <IconChevronDown {...IC_XS} className="text-ink-4" /> : <IconChevronRight {...IC_XS} className="text-ink-4" /> : <span />}
        {f ? <Sev sev={sevOf(f)} done={!!f.disposition && f.disposition !== "report"} className="justify-self-center" /> : <Icon {...IC_SM} className="text-ink-4" />}
        <span className="truncate">{f ? <><span className="font-mono text-[12px] text-ink-3">{f.id}</span> {f.title}</> : e.name}</span>
        <span className="font-mono text-[11px] text-ink-4 tabular-nums">{e.dir ? "" : bytes(e.size)}</span>
      </button>
      {expanded && <Children dir={e.path} depth={depth + 1} t={t} />}
    </>
  );
}

function Children({ dir, depth, t, skip }: { dir: string; depth: number; t: TreeProps; skip?: Set<string> }) {
  const q = useDir(t.runId, dir);
  if (q.error) return <div className="px-3 py-1 text-xs text-critical">{(q.error as Error).message}</div>;
  const list = (q.data ?? []).filter((e) => !skip?.has(e.path));
  if (q.data && !list.length && depth > 0) return <div style={{ paddingLeft: 8 + depth * 14 + 33 }} className="py-1 text-xs text-ink-4">empty</div>;
  return (
    <>
      {list.map((e) => (
        <Row key={e.path} e={e} depth={depth} t={t} />
      ))}
    </>
  );
}

// ---- viewer ----

/** A `---` header at the top of a markdown file (finding READMEs have one): its key/value lines and the rest. */
function splitHeader(text: string) {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { fields: [] as [string, string][], body: text };
  const fields = m[1].split(/\r?\n/).flatMap((l) => {
    const kv = /^\s*([\w-]+)\s*:\s*(.*)$/.exec(l);
    return kv ? [[kv[1], kv[2].replace(/(^|\s)#.*$/, "").trim()] as [string, string]] : [];
  });
  return { fields, body: text.slice(m[0].length) };
}

function RenderedMd({ text }: { text: string }) {
  const { fields, body } = useMemo(() => splitHeader(text), [text]);
  return (
    <div className="mx-auto max-w-[760px]">
      {fields.length > 0 && (
        <dl className="m-0 mb-5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-1 rounded-xl border border-line-2 px-4 py-3 font-mono text-[12.5px]">
          {fields.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-ink-3">{k}</dt>
              <dd className="m-0 break-words text-ink">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <Markdown text={body} className="text-[14.5px] leading-[1.65]" />
    </div>
  );
}

/** An image, or the hex view when it doesn't decode (crash inputs often don't). */
function ImageOrHex({ url, path, size }: { url: string; path: string; size: number }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <HexPeek url={url} size={size} />;
  return (
    <div className="p-5">
      <img src={url} alt={path} onError={() => setBroken(true)} className="max-h-[70vh] max-w-full rounded-lg border border-line-2 [image-rendering:pixelated]" />
    </div>
  );
}

function CodeView({ text, lang }: { text: string; lang: string | null }) {
  const lines = useMemo(() => htmlLines(highlight(text, lang)), [text, lang]);
  return (
    <div className="overflow-auto font-mono text-[12.5px] leading-[1.6] [scrollbar-width:thin]">
      <table className="border-collapse">
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td className="sticky left-0 bg-s1 pr-4 pl-5 text-right align-top text-ink-4 tabular-nums select-none">{i + 1}</td>
              <td className="pr-6 whitespace-pre text-ink">
                <code className="hljs" dangerouslySetInnerHTML={{ __html: l || " " }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The first bytes of a binary file, as a hexdump: PoC inputs are usually binary. */
function HexPeek({ url, size }: { url: string; size: number }) {
  const q = useQuery({ queryKey: ["raw-peek", url], queryFn: async () => new Uint8Array(await (await fetch(url)).arrayBuffer()).subarray(0, 1024), enabled: size <= 8 * 1024 * 1024 });
  if (size > 8 * 1024 * 1024) return <Nothing>Binary, {bytes(size)}. Download it to look inside.</Nothing>;
  if (!q.data) return null;
  const rows: string[] = [];
  for (let o = 0; o < q.data.length; o += 16) {
    const chunk = [...q.data.subarray(o, o + 16)];
    const hex = chunk.map((b) => b.toString(16).padStart(2, "0")).join(" ").padEnd(47, " ");
    const asc = chunk.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
    rows.push(`${o.toString(16).padStart(8, "0")}  ${hex}  ${asc}`);
  }
  return (
    <div className="px-5 py-4">
      <pre className="m-0 font-mono text-[12px] leading-[1.6] text-ink-2">{rows.join("\n")}</pre>
      {size > 1024 && <div className="mt-2 text-xs text-ink-3">First 1 KB of {bytes(size)}.</div>}
    </div>
  );
}

function FileHistory({ runId, path }: { runId: string; path: string }) {
  const log = useQuery({ queryKey: ["workbase", runId, "history", path], queryFn: () => api.history(runId, path) });
  const [commit, setCommit] = useState<string | null>(null);
  const pick = commit ?? log.data?.[0]?.commit ?? null;
  const patch = useQuery({ queryKey: ["workbase", runId, "patch", pick, path], queryFn: () => api.historyShow(runId, pick!, path), enabled: !!pick });
  const diff = useMemo(() => {
    const p = patch.data?.patch ?? "";
    const i = p.indexOf("\ndiff --git");
    return i >= 0 ? p.slice(i + 1) : "";
  }, [patch.data]);
  if (log.data && !log.data.length) return <Nothing>No snapshots of this file yet. Pixel snapshots the workbase every few minutes while the run is live.</Nothing>;
  return (
    <div className="grid min-h-0 grid-cols-[220px_minmax(0,1fr)] max-md:grid-cols-1">
      <ul className="m-0 list-none overflow-y-auto border-r border-line-2 p-1.5 [scrollbar-width:thin]">
        {log.data?.map((h) => (
          <li key={h.commit}>
            <button
              type="button"
              aria-current={pick === h.commit ? "true" : undefined}
              onClick={() => setCommit(h.commit)}
              className="flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left hover:bg-s2 aria-[current=true]:bg-s3"
            >
              <span className="text-[13px] text-ink">{ago(h.ts)}</span>
              <span className="truncate text-xs text-ink-3">{h.message}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="min-w-0 overflow-auto">{diff ? <CodeView text={diff} lang="diff" /> : patch.data && <Nothing>No change to this file in that snapshot.</Nothing>}</div>
    </div>
  );
}

type Mode = "view" | "source" | "history" | "edit";

function Viewer({ runId, path, onSaved }: { runId: string; path: string; onSaved: () => void }) {
  const file = useQuery({ queryKey: ["workbase", runId, "file", path], queryFn: () => api.file(runId, path) });
  const [mode, setMode] = useState<Mode>("view");
  const [text, setText] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => setMode("view"), [path]);
  const f = file.data;
  const md = isMd(path);
  const image = IMAGE.test(path);
  const url = api.rawFileUrl(runId, path);

  const tabs: [Mode, string][] = [...(md ? ([["view", "Rendered"], ["source", "Source"]] as [Mode, string][]) : []), ["history", "History"]];
  let body;
  if (file.error) body = <div className="p-5"><ErrorBox error={(file.error as Error).message} /></div>;
  else if (!f) body = null;
  else if (mode === "history") body = <FileHistory runId={runId} path={path} />;
  else if (mode === "edit")
    body = (
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        aria-label={`Edit ${path}`}
        className="h-full w-full resize-none bg-s1 px-5 py-4 font-mono text-[12.5px] leading-[1.6] text-ink outline-none"
      />
    );
  else if (image) body = <ImageOrHex url={url} path={path} size={f.size} />;
  else if (f.binary) body = <HexPeek url={url} size={f.size} />;
  else if (md && mode === "view") body = <div className="px-8 py-6 max-md:px-4"><RenderedMd text={f.content} /></div>;
  else body = <div className="py-3"><CodeView text={f.content} lang={md ? "markdown" : langForPath(path)} /></div>;

  return (
    <div className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-line-2 px-4 py-2">
        <span className="min-w-0 truncate font-mono text-[12.5px] text-ink">{path}</span>
        {f && <span className="font-mono text-[11.5px] whitespace-nowrap text-ink-4"><Join items={[bytes(f.size), ago(f.mtime), f.truncated && "cut at 2 MB"]} /></span>}
        <span className="flex-1" />
        {mode === "edit" ? (
          <>
            {saveError && <span className="text-xs text-critical">{saveError}</span>}
            <Button size="sm" variant="ghost" onClick={() => setMode("view")}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={async () => {
                try {
                  await api.saveFile(runId, path, text);
                  setSaveError(null);
                  setMode("view");
                  await file.refetch();
                  onSaved();
                } catch (e) {
                  setSaveError((e as Error).message);
                }
              }}
            >
              Save
            </Button>
          </>
        ) : (
          <>
            <div role="radiogroup" aria-label="Show" className="flex items-center gap-0.5 rounded-lg bg-s2 p-0.5">
              {tabs.map(([m, label]) => {
                const on = mode === m;
                return (
                  <button key={m} type="button" role="radio" aria-checked={on} onClick={() => setMode(on && m === "history" ? "view" : m)} className="inline-flex h-[26px] cursor-pointer items-center gap-1 rounded-md px-2.5 text-[12.5px] text-ink-3 hover:text-ink aria-checked:bg-s3 aria-checked:text-ink">
                    {m === "history" && <IconHistory {...IC_XS} />}
                    {label}
                  </button>
                );
              })}
            </div>
            {f && !f.binary && !f.truncated && !image && (
              <Button size="sm" icon variant="ghost" title="Edit" aria-label="Edit" onClick={() => (setText(f.content), setMode("edit"))}>
                <IconPencil {...IC_SM} />
              </Button>
            )}
            <a href={url} download className="inline-flex size-8 items-center justify-center rounded-lg text-ink-3 hover:bg-s2 hover:text-ink" title="Download" aria-label="Download">
              <IconDownload {...IC_SM} />
            </a>
          </>
        )}
      </div>
      <div className={cn("min-h-0", mode === "history" ? "grid" : "overflow-auto [scrollbar-width:thin]")}>{body}</div>
    </div>
  );
}

// ---- the browser ----

const ancestors = (p: string) => p.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"));

/** The run's workbase. `path` opens that file (and the folders above it). */
export function WorkbaseBrowser({ runId, path, className }: { runId: string; path?: string; className?: string }) {
  const root = useDir(runId, "");
  const findingsQ = useRunFindings(runId);
  const [selected, setSelected] = useState<string | null>(path ?? null);
  const [open, setOpen] = useState<Set<string>>(() => new Set(["findings", ...(path ? ancestors(path) : [])]));
  useEffect(() => {
    if (!path) return;
    setSelected(path);
    setOpen((o) => new Set([...o, ...ancestors(path)]));
  }, [path]);
  const refresh = () => void root.refetch();
  // Pick up new files when the run writes its report or finishes (not on every token update).
  const runState = useRef<string | null>(null);
  useLive(runId, (m) => {
    if (m.type === "findings") return void root.refetch();
    if (m.type !== "run") return;
    const state = `${m.data.status}|${m.data.report_ready}`;
    if (runState.current !== null && runState.current !== state) void root.refetch();
    runState.current = state;
  });

  const findings = useMemo(() => new Map((findingsQ.data ?? []).filter((f) => f.path?.endsWith("/README.md")).map((f) => [f.path!.slice(0, -"/README.md".length), f])), [findingsQ.data]);
  const pinned = (root.data ?? []).filter((e) => !e.dir && PINNED.includes(e.name)).sort((a, b) => PINNED.indexOf(a.name) - PINNED.indexOf(b.name));
  const first = pinned[0]?.path ?? root.data?.find((e) => !e.dir)?.path ?? null;
  const shownFile = selected ?? first;
  const t: TreeProps = {
    runId,
    selected: shownFile,
    open,
    findings,
    select: setSelected,
    toggle: (d) => setOpen((o) => {
      const n = new Set(o);
      if (n.has(d)) n.delete(d);
      else n.add(d);
      return n;
    }),
  };

  return (
    <div className={cn("grid h-full min-h-0 grid-cols-[minmax(220px,300px)_minmax(0,1fr)] max-md:h-auto max-md:grid-cols-1", className)}>
      <nav aria-label="Files" className="flex min-h-0 flex-col border-r border-line-2 max-md:max-h-[40vh] max-md:border-r-0 max-md:border-b">
        <div className="flex items-center gap-1 px-3 pt-2.5 pb-1.5">
          <span className="truncate font-mono text-[12px] text-ink-3">workbase</span>
          <span className="flex-1" />
          <Button size="xs" icon variant="ghost" title="Refresh" aria-label="Refresh" onClick={refresh}>
            <IconRefresh {...IC_XS} />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3 [scrollbar-width:thin]">
          {root.error && <div className="px-2"><ErrorBox error={(root.error as Error).message} /></div>}
          {root.data && !root.data.length && <div className="px-2 py-1 text-[13px] text-ink-3">The workbase is empty.</div>}
          {pinned.length > 0 && (
            <div className="mb-1.5 border-b border-line-2 pb-1.5">
              {pinned.map((e) => (
                <Row key={e.path} e={e} depth={0} t={t} />
              ))}
            </div>
          )}
          {root.data && <Children dir="" depth={0} t={t} skip={new Set(pinned.map((e) => e.path))} />}
        </div>
      </nav>
      <div className="grid min-h-0 min-w-0">{shownFile ? <Viewer key={shownFile} runId={runId} path={shownFile} onSaved={refresh} /> : root.data && <Nothing>Pick a file.</Nothing>}</div>
    </div>
  );
}
