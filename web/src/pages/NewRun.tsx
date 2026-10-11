import { useEffect, useState } from "react";
import { api, type CreateRunInput } from "../lib/api.ts";
import { useAsync } from "../lib/hooks.ts";
import { navigate, useLocation } from "../lib/router.tsx";
import { Button, Card, ErrorBox, Field, Notice, PageHeader } from "../components/ui.tsx";
import { ModelAndThinking } from "../components/ModelSelect.tsx";

/** Prefill from the URL, e.g. /new?repo=…&parent=… (used by "re-audit" on a run page). */
function initialFromQuery(search: string) {
  const q = new URLSearchParams(search);
  return { repo: q.get("repo") ?? "", ref: q.get("ref") ?? "", parentRun: q.get("parent") ?? "", model: q.get("model") ?? "" };
}

export function NewRunPage() {
  const { search } = useLocation();
  const init = initialFromQuery(search);
  const settings = useAsync(api.settings, []);
  const templates = useAsync(api.templates, []);
  const runs = useAsync(api.runs, []);

  const [repo, setRepo] = useState(init.repo);
  const [ref, setRef] = useState(init.ref);
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [version, setVersion] = useState<number | "">("");
  const [model, setModel] = useState(init.model);
  const [variant, setVariant] = useState("");
  const [size, setSize] = useState("");
  const [parentRun, setParentRun] = useState(init.parentRun);
  const [autopilot, setAutopilot] = useState(true);
  const [compare, setCompare] = useState(false);
  const [compareModels, setCompareModels] = useState<string[]>([]);
  const [compareVersions, setCompareVersions] = useState<number[]>([]);
  const [body, setBody] = useState("");
  const [edited, setEdited] = useState(false);
  const [preview, setPreview] = useState("");
  const [error, setError] = useState<string | null>(null);

  const s = settings.data;
  const versions = useAsync(() => (templateId ? api.template(templateId) : Promise.resolve(null)), [templateId]);

  useEffect(() => {
    if (!s) return;
    setModel((m) => m || s.defaultModel);
    setSize((x) => x || s.defaultSize);
  }, [s]);
  useEffect(() => {
    if (!templateId && templates.data?.length) setTemplateId(templates.data[0].id);
  }, [templates.data]);

  // Load the chosen template version's body unless the user has edited it.
  const chosen = versions.data?.versions.find((v) => v.version === version) ?? versions.data?.versions[0];
  useEffect(() => {
    if (chosen && !edited) setBody(chosen.body);
  }, [chosen?.template_id, chosen?.version, edited]);

  // Live preview of the rendered prompt.
  useEffect(() => {
    const t = setTimeout(() => {
      api.preview({ body, repo, ref, model, size, parentRun: parentRun || undefined, name: name || undefined }).then((r) => setPreview(r.prompt), () => {});
    }, 250);
    return () => clearTimeout(t);
  }, [body, repo, ref, model, size, parentRun, name]);

  const submit = async () => {
    setError(null);
    const input: CreateRunInput = {
      repo,
      ref: ref || undefined,
      templateId,
      templateVersion: version || undefined,
      model,
      variant: compare ? undefined : variant || undefined,
      size,
      parentRun: parentRun || undefined,
      autopilot,
      name: name || undefined,
      promptOverride: edited ? body : undefined,
    };
    if (compare) {
      input.models = compareModels.length ? compareModels : [model];
      input.templateVersions = compareVersions.length ? compareVersions : undefined;
    }
    try {
      const created = await api.createRun(input);
      navigate(created.length === 1 ? `/runs/${encodeURIComponent(created[0].id)}` : "/");
    } catch (e: any) {
      setError(e.message);
    }
  };

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const sameRepoRuns = (runs.data ?? []).filter((r) => !repo || r.repo === repo.trim());
  const preset = s?.sizePresets[size];

  return (
    <div>
      <PageHeader title="New run" subtitle="Start an audit agent on a repository." />
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="flex flex-col gap-4">
          <Card title="Target">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Repository URL" className="sm:col-span-2">
                <input className="input" placeholder="https://github.com/owner/project" value={repo} onChange={(e) => setRepo(e.target.value)} />
              </Field>
              <Field label="Branch, tag or commit" hint="Empty = default branch">
                <input className="input" value={ref} onChange={(e) => setRef(e.target.value)} />
              </Field>
              <Field label="Run name" hint="Empty = <repo>-<date>; also the workbase folder">
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={compare} />
              </Field>
              <Field label="Follow-up of (re-audit)" hint="Offers that run's workbase as a starting point" className="sm:col-span-2">
                <select className="input" value={parentRun} onChange={(e) => setParentRun(e.target.value)}>
                  <option value="">— none —</option>
                  {sameRepoRuns.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.id} ({r.status})
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </Card>

          <Card title="Agent">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="label sm:col-span-2">
                <span>Model and thinking</span>
                {model ? <ModelAndThinking model={model} variant={variant} onModel={setModel} onVariant={setVariant} /> : <div className="input muted">loading…</div>}
                {compare && <span className="text-[11px]">Compare mode runs every model below at its default thinking.</span>}
              </div>
              <Field label="Machine size" hint={preset ? `${preset.cpu} CPU · ${preset.memoryGiB} GiB RAM · ${preset.diskGiB} GiB disk` : undefined}>
                <select className="input" value={size} onChange={(e) => setSize(e.target.value)}>
                  {s && Object.keys(s.sizePresets).map((k) => <option key={k}>{k}</option>)}
                </select>
              </Field>
              <Field label="Template">
                <select
                  className="input"
                  value={templateId}
                  onChange={(e) => {
                    setTemplateId(e.target.value);
                    setVersion("");
                    setEdited(false);
                  }}
                >
                  {templates.data?.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Template version">
                <select
                  className="input"
                  value={version}
                  onChange={(e) => {
                    setVersion(e.target.value ? Number(e.target.value) : "");
                    setEdited(false);
                  }}
                >
                  <option value="">latest</option>
                  {versions.data?.versions.map((v) => (
                    <option key={v.version} value={v.version}>
                      v{v.version} {v.note ? `– ${v.note}` : ""}
                    </option>
                  ))}
                </select>
              </Field>
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input type="checkbox" checked={autopilot} onChange={(e) => setAutopilot(e.target.checked)} />
                Autopilot: continue automatically when the agent stops without a report (up to {s?.maxAutoContinues ?? 3} times) and recover from crashes
              </label>
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
                Compare: start one run per selected model × template version
              </label>
            </div>
            {compare && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <div className="mb-1 text-xs muted">Models</div>
                  {s?.models.map((m) => (
                    <label key={m} className="flex items-center gap-2 font-mono text-sm">
                      <input type="checkbox" checked={compareModels.includes(m)} onChange={() => setCompareModels(toggle(compareModels, m))} />
                      {m}
                    </label>
                  ))}
                  <div className="mt-1 text-xs muted">Add models on the Models page.</div>
                </div>
                <div>
                  <div className="mb-1 text-xs muted">Template versions (none = selected above)</div>
                  {versions.data?.versions.map((v) => (
                    <label key={v.version} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={compareVersions.includes(v.version)} onChange={() => setCompareVersions(toggle(compareVersions, v.version))} />v{v.version}
                    </label>
                  ))}
                </div>
                {edited && <Notice>Compare runs use the saved template versions; your edits below are ignored. Save them as a new version first.</Notice>}
              </div>
            )}
          </Card>
          <ErrorBox error={error} />
          <div>
            <Button variant="primary" onClick={submit} disabled={!repo || !templateId || !model}>
              {compare ? "Start compare runs" : "Start run"}
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <Card
            title={`Prompt template${edited ? " (edited for this run)" : ""}`}
            actions={
              edited && (
                <Button small onClick={() => setEdited(false)}>
                  Revert
                </Button>
              )
            }
          >
            <textarea
              className="input h-72 w-full font-mono text-xs"
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                setEdited(true);
              }}
            />
            <div className="mt-1 text-xs muted">Variables: {versions.data?.variables.map((v) => `{{${v}}}`).join(" ")}</div>
          </Card>
          <Card title="Preview (what the agent receives)">
            <pre className="max-h-96 overflow-auto font-mono text-xs whitespace-pre-wrap">{preview}</pre>
          </Card>
        </div>
      </div>
    </div>
  );
}
