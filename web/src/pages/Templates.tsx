/** Prompt templates: versions, editing (each save is a new version), diffs between versions. */
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { useAsync } from "../lib/hooks.ts";
import { navigate } from "../lib/router.tsx";
import { dateTime } from "../lib/format.ts";
import type { TemplateVersion } from "../lib/types.ts";
import { Button, Card, Empty, ErrorBox, Field, PageHeader, cx } from "../components/ui.tsx";
import { Sep } from "../components/ui/bits.tsx";

/** Line diff (LCS) between two template bodies. */
function lineDiff(a: string, b: string) {
  const x = a.split("\n");
  const y = b.split("\n");
  const dp = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { op: " " | "+" | "-"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) out.push({ op: " ", line: x[i++] }), j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: "-", line: x[i++] });
    else out.push({ op: "+", line: y[j++] });
  }
  while (i < x.length) out.push({ op: "-", line: x[i++] });
  while (j < y.length) out.push({ op: "+", line: y[j++] });
  return out;
}

function VersionDiff({ from, to }: { from: TemplateVersion; to: TemplateVersion }) {
  const diff = useMemo(() => lineDiff(from.body, to.body), [from, to]);
  return (
    <pre className="max-h-[60vh] overflow-auto font-mono text-xs whitespace-pre-wrap">
      {diff.map((d, i) => (
        <div key={i} className={d.op === "+" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : d.op === "-" ? "bg-red-500/10 text-red-700 dark:text-red-300" : ""}>
          {d.op} {d.line}
        </div>
      ))}
    </pre>
  );
}

/** Pixel's own sections (templates/parts/), the same in every template that uses them. */
function Sections({ parts }: { parts: { name: string; body: string }[] }) {
  if (!parts.length) return null;
  return (
    <div className="mt-3 text-xs">
      <div className="muted">Pixel's sections, kept up to date with Pixel; put one in with its tag:</div>
      <div className="mt-1 flex flex-col gap-1">
        {parts.map((p) => (
          <details key={p.name}>
            <summary className="cursor-pointer font-mono">{`{{> ${p.name}}}`}</summary>
            <pre className="mt-1 max-h-[40vh] overflow-auto rounded border border-zinc-200 p-2 font-mono whitespace-pre-wrap dark:border-zinc-800">{p.body}</pre>
          </details>
        ))}
      </div>
    </div>
  );
}

/** The prompt as an agent would get it, for an example run. */
function PromptPreview({ body }: { body: string }) {
  const [shown, setShown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    api.preview({ body }).then(
      (r) => (setShown(r.prompt), setError(null)),
      (e) => (setShown(null), setError((e as Error).message)),
    );
  return (
    <div className="mt-3 text-xs">
      <button className="text-accent hover:underline" onClick={() => (shown === null ? load() : setShown(null))}>
        {shown === null ? "Show the full prompt" : "Hide the full prompt"}
      </button>
      <ErrorBox error={error} />
      {shown !== null && <pre className="mt-1 max-h-[60vh] overflow-auto rounded border border-zinc-200 p-2 font-mono whitespace-pre-wrap dark:border-zinc-800">{shown}</pre>}
    </div>
  );
}

function TemplateEditor({ id }: { id: string }) {
  const t = useAsync(() => api.template(id), [id]);
  const versions = t.data?.versions ?? [];
  const [selected, setSelected] = useState<number | null>(null);
  const [compareTo, setCompareTo] = useState<number | null>(null);
  const [body, setBody] = useState("");
  const [note, setNote] = useState("");
  const current = versions.find((v) => v.version === selected) ?? versions[0];

  useEffect(() => {
    if (current) setBody(current.body);
  }, [current?.version, id]);

  const dirty = current && body !== current.body;
  const other = versions.find((v) => v.version === compareTo);

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_300px]">
      <Card
        title={current ? `${id} v${current.version}${dirty ? " (edited)" : ""}` : id}
        actions={
          <Button
            small
            variant="primary"
            disabled={!dirty}
            done="Saved as a new version"
            onClick={async () => {
              const v = await api.addTemplateVersion(id, body, note || undefined);
              setNote("");
              await t.reload();
              setSelected(v.version);
            }}
          >
            Save as new version
          </Button>
        }
      >
        <ErrorBox error={t.error} />
        {other && current ? (
          <>
            <div className="mb-2 text-xs muted">
              Changes from v{other.version} to v{current.version}{" "}
              <button className="text-accent hover:underline" onClick={() => setCompareTo(null)}>
                close diff
              </button>
            </div>
            <VersionDiff from={other} to={current} />
          </>
        ) : (
          <>
            <textarea className="input h-[55vh] w-full font-mono text-xs" value={body} onChange={(e) => setBody(e.target.value)} />
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <Field label="Version note" className="flex-1">
                <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed and why" />
              </Field>
            </div>
            <div className="mt-2 text-xs muted">
              Variables: {t.data?.variables.map((v) => `{{${v}}}`).join(" ")} <Sep /> Conditionals: <code>{"{{#if var}} ... {{/if}}"}</code>
            </div>
            <Sections parts={t.data?.parts ?? []} />
            <PromptPreview body={body} />
          </>
        )}
      </Card>
      <Card title="Versions">
        <div className="flex flex-col gap-1">
          {versions.map((v) => (
            <div key={v.version} className={cx("rounded px-2 py-1.5 text-sm", v.version === current?.version && "bg-zinc-100 dark:bg-zinc-800")}>
              <div className="flex items-center justify-between gap-2">
                <button className="cursor-pointer font-medium text-accent hover:underline" onClick={() => (setSelected(v.version), setCompareTo(null))}>
                  v{v.version}
                </button>
                <span className="text-xs muted">{v.runs ?? 0} runs</span>
              </div>
              <div className="text-xs muted">{dateTime(v.created_at)}</div>
              {v.note && <div className="text-xs">{v.note}</div>}
              {current && v.version !== current.version && (
                <button className="text-xs text-accent hover:underline" onClick={() => setCompareTo(v.version)}>
                  diff against v{current.version}
                </button>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

export function TemplatesPage({ selected }: { selected?: string }) {
  const list = useAsync(api.templates, []);
  const [newId, setNewId] = useState("");
  const id = selected ?? list.data?.[0]?.id;

  return (
    <div>
      <PageHeader
        title="Templates"
        subtitle="Prompt templates are versioned; every run records the version it used."
        actions={
          <form
            className="flex gap-1.5"
            onSubmit={async (e) => {
              e.preventDefault();
              const base = list.data?.find((t) => t.id === id);
              const body = base ? (await api.template(base.id)).versions[0].body : "";
              const t = await api.createTemplate({ id: newId, body, note: base ? `Copied from ${base.id}` : undefined });
              setNewId("");
              await list.reload();
              navigate(`/templates/${encodeURIComponent(t.template_id)}`);
            }}
          >
            <input className="input w-40" placeholder="new-template-id" value={newId} onChange={(e) => setNewId(e.target.value)} />
            <button className="btn" disabled={!newId}>
              Create (copy of current)
            </button>
          </form>
        }
      />
      <div className="mb-4 flex flex-wrap gap-1.5">
        {list.data?.map((t) => (
          <button key={t.id} className={`btn btn-sm ${t.id === id ? "btn-primary" : ""}`} onClick={() => navigate(`/templates/${encodeURIComponent(t.id)}`)}>
            {t.name} <span className="opacity-70">v{t.version}</span>
          </button>
        ))}
      </div>
      {id ? <TemplateEditor key={id} id={id} /> : list.data && <Empty>No templates.</Empty>}
    </div>
  );
}
