/** Browse, view, edit and see the history of one workbase. Used on run pages and in Knowledge. */
import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { useAsync } from "../lib/hooks.ts";
import { useLive } from "../lib/live.ts";
import { ago, bytes } from "../lib/format.ts";
import { Markdown } from "./Markdown.tsx";
import { DiffView } from "./DiffView.tsx";
import { Button, Empty, ErrorBox, Tabs, cx } from "./ui.tsx";

function FileView({ runId, path, onSaved }: { runId: string; path: string; onSaved: () => void }) {
  const file = useAsync(() => api.file(runId, path), [runId, path]);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [raw, setRaw] = useState(false);
  useEffect(() => setEditing(false), [path]);

  if (file.error) return <ErrorBox error={file.error} />;
  const f = file.data;
  if (!f) return null;
  const isMd = path.toLowerCase().endsWith(".md");

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-mono font-medium">{path}</span>
        <span className="muted">
          {bytes(f.size)} · modified {ago(f.mtime)}
        </span>
        <span className="ml-auto flex gap-1.5">
          {isMd && !editing && (
            <Button small onClick={() => setRaw(!raw)}>
              {raw ? "Rendered" : "Raw"}
            </Button>
          )}
          <a className="btn btn-sm hover:no-underline" href={api.rawFileUrl(runId, path)}>
            Download
          </a>
          {!f.binary && !f.truncated && !editing && (
            <Button
              small
              onClick={() => {
                setText(f.content);
                setEditing(true);
              }}
            >
              Edit
            </Button>
          )}
          {editing && (
            <>
              <Button small onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button
                small
                variant="primary"
                done="Saved"
                onClick={async () => {
                  await api.saveFile(runId, path, text);
                  setEditing(false);
                  await file.reload();
                  onSaved();
                }}
              >
                Save
              </Button>
            </>
          )}
        </span>
      </div>
      {f.truncated && <div className="text-xs muted">Showing the first 2 MB.</div>}
      {editing ? (
        <textarea className="input h-[60vh] font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} />
      ) : f.binary ? (
        <Empty>Binary file.</Empty>
      ) : isMd && !raw ? (
        <div className="max-h-[70vh] overflow-auto rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
          <Markdown text={f.content} />
        </div>
      ) : (
        <pre className="max-h-[70vh] overflow-auto rounded-md border border-zinc-200 p-3 font-mono text-xs whitespace-pre dark:border-zinc-800">{f.content}</pre>
      )}
    </div>
  );
}

function FilesPane({ runId, initialPath }: { runId: string; initialPath?: string }) {
  const [dir, setDir] = useState(initialPath?.includes("/") ? initialPath.slice(0, initialPath.lastIndexOf("/")) : "");
  const [file, setFile] = useState<string | null>(initialPath ?? null);
  const list = useAsync(() => api.files(runId, dir), [runId, dir]);
  const crumbs = dir ? dir.split("/") : [];

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(220px,300px)_1fr]">
      <div className="card min-w-0 p-2">
        <div className="mb-2 flex flex-wrap items-center gap-1 px-1 font-mono text-xs">
          <button className="cursor-pointer text-accent" onClick={() => setDir("")}>
            {runId}
          </button>
          {crumbs.map((c, i) => (
            <span key={i}>
              /
              <button className="cursor-pointer text-accent" onClick={() => setDir(crumbs.slice(0, i + 1).join("/"))}>
                {c}
              </button>
            </span>
          ))}
          <button className="ml-auto cursor-pointer muted hover:text-accent" title="Refresh" onClick={() => list.reload()}>
            ↻
          </button>
        </div>
        <ErrorBox error={list.error} />
        {list.data && !list.data.length && <Empty>Empty.</Empty>}
        <div className="flex flex-col text-sm">
          {list.data?.map((e) => (
            <button
              key={e.path}
              className={cx(
                "flex cursor-pointer justify-between gap-2 rounded px-1.5 py-0.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800",
                file === e.path && "bg-zinc-100 text-accent dark:bg-zinc-800",
              )}
              onClick={() => (e.dir ? setDir(e.path) : setFile(e.path))}
            >
              <span className="truncate">
                {e.dir ? "▸ " : ""}
                {e.name}
              </span>
              <span className="shrink-0 text-xs muted">{e.dir ? "" : bytes(e.size)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="min-w-0">{file ? <FileView runId={runId} path={file} onSaved={() => list.reload()} /> : <Empty>Pick a file.</Empty>}</div>
    </div>
  );
}

function HistoryPane({ runId }: { runId: string }) {
  const log = useAsync(() => api.history(runId), [runId]);
  const [commit, setCommit] = useState<string | null>(null);
  const patch = useAsync(() => (commit ? api.historyShow(runId, commit) : Promise.resolve(null)), [runId, commit]);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(240px,320px)_1fr]">
      <div className="card min-w-0 p-2">
        <div className="mb-2 flex items-center justify-between px-1 text-xs muted">
          <span>Snapshots (outside the agent's view)</span>
          <Button small onClick={async () => (await api.snapshotHistory(runId), log.reload())}>
            Snapshot now
          </Button>
        </div>
        {log.data && !log.data.length && <Empty>No history yet.</Empty>}
        {log.data?.map((h) => (
          <button
            key={h.commit}
            onClick={() => setCommit(h.commit)}
            className={cx("block w-full cursor-pointer rounded px-1.5 py-1 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800", commit === h.commit && "bg-zinc-100 dark:bg-zinc-800")}
          >
            <div>
              {h.message} <span className="text-xs muted">{ago(h.ts)}</span>
            </div>
            <div className="text-xs muted">{h.stat}</div>
          </button>
        ))}
      </div>
      <div className="min-w-0">{patch.data ? <DiffView patch={patch.data.patch} /> : <Empty>Pick a snapshot to see what changed.</Empty>}</div>
    </div>
  );
}

/** The run's workbase: browse and edit files, and the history snapshots. `path` opens that file. */
export function WorkbaseBrowser({ runId, path }: { runId: string; path?: string }) {
  const [tab, setTab] = useState<"files" | "history">("files");
  const [key, setKey] = useState(0);
  // Remount the file pane when the run finishes or files change notably, so listings refresh.
  useLive(runId, (m) => {
    if (m.type === "run" && m.data.status === "done") setKey((k) => k + 1);
  });
  return (
    <div>
      <Tabs<"files" | "history">
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "files", label: "Files" },
          { id: "history", label: "History" },
        ]}
      />
      {tab === "files" ? <FilesPane key={`${key}:${path ?? ""}`} runId={runId} initialPath={path} /> : <HistoryPane runId={runId} />}
    </div>
  );
}
