/**
 * New run: what to audit, which agent (model, thinking, key), the machine and template, then the prompt
 * beside it (template or the rendered preview). A bar at the bottom sums it up and starts the run.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { IconArrowBackUp, IconBrandGithub, IconCheck, IconCpu, IconGitBranch, IconPlayerPlay, IconTag, IconUsersGroup } from "@tabler/icons-react";
import { api, type CreateRunInput } from "../lib/api.ts";
import { useAsync } from "../lib/hooks.ts";
import { navigate, useLocation } from "../lib/router.tsx";
import { cn } from "../lib/cn.ts";
import { Button, ErrorBox, Field, Notice, PageHeader, Segmented, Switch } from "../components/ui.tsx";
import { IC_SM, IC_XS, Join } from "../components/ui/bits.tsx";
import { Select } from "../components/ui/overlay.tsx";
import { ModelSelect, ThinkingSelect } from "../components/ModelSelect.tsx";
import { KeySelect, NO_KEY, useProviders } from "../components/KeySelect.tsx";

/** Prefill from the URL, e.g. /new?repo=…&parent=… (used by "re-audit" on a run page). */
function initialFromQuery(search: string) {
  const q = new URLSearchParams(search);
  return { repo: q.get("repo") ?? "", ref: q.get("ref") ?? "", parentRun: q.get("parent") ?? "", model: q.get("model") ?? "" };
}

/** "https://github.com/owner/project(.git)" → host, "owner/project" and the name; null when it doesn't look like a repo URL. */
function repoSlug(url: string) {
  const m = url.trim().match(/^(?:https?:\/\/|git@)([^/:]+)[/:]([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/);
  return m ? { host: m[1], path: `${m[2]}/${m[3]}`, name: m[3].toLowerCase() } : null;
}
const sameRepo = (a: string, b: string) => a.trim().replace(/\.git$/, "").replace(/\/+$/, "") === b.trim().replace(/\.git$/, "").replace(/\/+$/, "");
const today = () => new Date().toISOString().slice(0, 10);

function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line-2 bg-s1 p-5">
      <div className="mb-4 flex items-center gap-2">
        <h2 className="m-0 text-[13.5px] font-medium">{title}</h2>
        {right && <div className="ml-auto">{right}</div>}
      </div>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn("inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 font-mono text-xs", on ? "border-line bg-s3 text-ink" : "border-line-2 bg-transparent text-ink-3 hover:text-ink")}
    >
      {on && <IconCheck {...IC_XS} className="text-accent" />}
      {children}
    </button>
  );
}

export function NewRunPage() {
  const { search } = useLocation();
  const init = initialFromQuery(search);
  const settings = useAsync(api.settings, []);
  const templates = useAsync(api.templates, []);
  const runs = useAsync(api.runs, []);
  const providers = useProviders();

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
  // "" = the provider's default key, a key id, or NO_KEY.
  const [keyId, setKeyId] = useState("");
  const [failover, setFailover] = useState<boolean | null>(null);
  const [compare, setCompare] = useState(false);
  const [compareModels, setCompareModels] = useState<string[]>([]);
  const [compareVersions, setCompareVersions] = useState<number[]>([]);
  const [body, setBody] = useState("");
  const [edited, setEdited] = useState(false);
  const [preview, setPreview] = useState("");
  const [promptView, setPromptView] = useState<"template" | "preview">("template");
  const [error, setError] = useState<string | null>(null);

  const s = settings.data;
  const keys = providers.data?.find((p) => p.id === model.split("/")[0])?.keys ?? [];
  const chosenKey = keyId === NO_KEY ? null : (keys.find((k) => k.id === keyId) ?? keys[0] ?? null);
  const failoverOn = failover ?? s?.keyFailover ?? true;
  const failoverOrder = chosenKey ? [...keys.slice(keys.indexOf(chosenKey) + 1), ...keys.slice(0, keys.indexOf(chosenKey))].map((k) => (k.status ? `${k.name} (failing, skipped)` : k.name)) : [];
  const versions = useAsync(() => (templateId ? api.template(templateId) : Promise.resolve(null)), [templateId]);
  const slug = repoSlug(repo);

  useEffect(() => {
    if (!s) return;
    setModel((m) => m || s.defaultModel);
    setSize((x) => x || s.defaultSize);
  }, [s]);
  useEffect(() => {
    if (!templateId && templates.data?.length) setTemplateId(templates.data[0].id);
  }, [templates.data]);
  // A key belongs to one provider: switching to another provider's model goes back to its default.
  useEffect(() => {
    if (keyId && keyId !== NO_KEY && !keys.some((k) => k.id === keyId)) setKeyId("");
  }, [model, keys.length]);

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
      keyId: compare ? undefined : keyId === NO_KEY ? NO_KEY : keys.length > 1 ? chosenKey?.id : undefined,
      keyFailover: keyId === NO_KEY ? false : failoverOn,
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
      throw e;
    }
  };

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const sameRepoRuns = useMemo(() => (slug ? (runs.data ?? []).filter((r) => sameRepo(r.repo, repo)) : []), [runs.data, repo]);
  const template = templates.data?.find((t) => t.id === templateId);
  const nRuns = compare ? Math.max(1, compareModels.length) * Math.max(1, compareVersions.length) : 1;
  const ready = !!repo.trim() && !!templateId && !!model;

  return (
    <div className="pb-28">
      <PageHeader title="New run" />
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Section title="Target">
            <div className="flex flex-col gap-1.5">
              <label className="flex h-11 items-center gap-2.5 rounded-[10px] border border-line bg-[color-mix(in_srgb,var(--bg)_70%,var(--s1))] px-3.5 text-ink-3 focus-within:border-[color-mix(in_srgb,var(--accent-c)_65%,var(--line))] focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
                <IconBrandGithub {...IC_SM} />
                <input
                  autoFocus
                  aria-label="Repository URL"
                  placeholder="https://github.com/owner/project"
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  className="h-full min-w-0 flex-1 border-0 bg-transparent font-mono text-[13.5px] text-ink outline-none placeholder:font-sans placeholder:text-ink-4"
                />
                {slug && <IconCheck {...IC_SM} className="text-good" aria-label="Looks like a repository" />}
              </label>
              {slug && (
                <span className="pl-1 font-mono text-xs text-ink-3">
                  <Join items={[slug.host, slug.path, sameRepoRuns.length > 0 && `audited ${sameRepoRuns.length} time${sameRepoRuns.length === 1 ? "" : "s"} before`]} />
                </span>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Branch, tag or commit">
                <span className="relative flex items-center">
                  <IconGitBranch {...IC_XS} className="pointer-events-none absolute left-3 text-ink-4" />
                  <input className="input w-full pl-8 font-mono" placeholder="default branch" value={ref} onChange={(e) => setRef(e.target.value)} />
                </span>
              </Field>
              <Field label="Run name" hint="Also the workbase folder">
                <span className="relative flex items-center">
                  <IconTag {...IC_XS} className="pointer-events-none absolute left-3 text-ink-4" />
                  <input className="input w-full pl-8 font-mono" placeholder={`${slug?.name ?? "repo"}-${today()}`} value={name} onChange={(e) => setName(e.target.value)} disabled={compare} />
                </span>
              </Field>
            </div>
            {(sameRepoRuns.length > 0 || parentRun) && (
              <Field label="Follow-up of" hint="Gives the agent that run's workbase as a starting point">
                <Select field value={parentRun} onChange={setParentRun} options={[["", "None, start fresh"], ...sameRepoRuns.map((r) => ({ value: r.id, label: r.label || r.id, hint: r.status }))]} />
              </Field>
            )}
          </Section>

          <Section
            title="Agent"
            right={
              <Switch
                checked={compare}
                onChange={setCompare}
                label={
                  <span className="inline-flex items-center gap-1.5 text-ink-2">
                    <IconUsersGroup {...IC_XS} />
                    Compare models
                  </span>
                }
              />
            }
          >
            {compare ? (
              <div className="flex flex-col gap-3">
                <p className="m-0 text-xs text-ink-3">One run for each model and template version, each at its default thinking and on its provider's default key.</p>
                <div className="flex flex-wrap gap-1.5">
                  {s?.models.map((m) => (
                    <Chip key={m} on={compareModels.includes(m)} onClick={() => setCompareModels(toggle(compareModels, m))}>
                      {m}
                    </Chip>
                  ))}
                </div>
                {(versions.data?.versions.length ?? 0) > 1 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="mr-1 text-xs text-ink-3">Template versions</span>
                    {versions.data!.versions.map((v) => (
                      <Chip key={v.version} on={compareVersions.includes(v.version)} onClick={() => setCompareVersions(toggle(compareVersions, v.version))}>
                        v{v.version}
                      </Chip>
                    ))}
                  </div>
                )}
                {edited && <Notice>Compare runs use the saved template versions; your edits to the prompt are ignored. Save them as a new version first.</Notice>}
              </div>
            ) : (
              <>
                {model ? <ModelSelect value={model} onChange={setModel} /> : <div className="input flex items-center text-ink-4">Loading</div>}
                <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                  <span className="inline-flex min-w-0 items-center gap-2.5">
                    <span className="text-xs text-ink-3">Thinking</span>
                    {model && <ThinkingSelect model={model} value={variant} onChange={setVariant} />}
                  </span>
                  <span className="inline-flex items-center gap-2.5">
                    <span className="text-xs text-ink-3">Key</span>
                    {model && <KeySelect model={model} value={keyId} onChange={setKeyId} />}
                  </span>
                </div>
                {keyId === NO_KEY ? (
                  <p className="m-0 text-xs text-ink-3">The agent calls {model.split("/")[0]} without a key: OpenCode Zen's free models, or a server that doesn't check keys.</p>
                ) : chosenKey?.note ? (
                  <p className="m-0 text-xs text-ink-3">{chosenKey.note}</p>
                ) : null}
                {keys.length > 1 && keyId !== NO_KEY && (
                  <Switch
                    checked={failoverOn}
                    onChange={setFailover}
                    label="Key failover"
                    hint={failoverOn ? `If ${chosenKey?.name ?? "the key"} runs out or is rejected, switch to ${failoverOrder.join(", then ") || "the next key"}.` : "If the key runs out or is rejected, the run pauses and tells you."}
                  />
                )}
              </>
            )}
          </Section>

          <Section title="Machine and template">
            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Machine size">
              {s &&
                Object.entries(s.sizePresets).map(([k, p]) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={size === k}
                    onClick={() => setSize(k)}
                    className="flex cursor-pointer flex-col gap-1 rounded-xl border border-line-2 bg-transparent px-3.5 py-3 text-left hover:border-line aria-checked:border-[color-mix(in_srgb,var(--accent-c)_60%,var(--line))] aria-checked:bg-[var(--accent-soft)]"
                  >
                    <span className="flex items-center gap-2 text-[13px] font-medium text-ink">
                      <IconCpu {...IC_XS} className="text-ink-3" />
                      {k}
                      {k === s.defaultSize && <span className="ml-auto text-[11px] font-normal text-ink-4">default</span>}
                    </span>
                    <span className="font-mono text-[11.5px] text-ink-3">
                      <Join items={[`${p.cpu} CPU`, `${p.memoryGiB} GiB`, `${p.diskGiB} GiB disk`]} />
                    </span>
                  </button>
                ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
              <Field label="Template">
                <Select
                  field
                  value={templateId}
                  onChange={(v) => {
                    setTemplateId(v);
                    setVersion("");
                    setEdited(false);
                  }}
                  options={(templates.data ?? []).map((t): [string, string] => [t.id, t.name])}
                />
              </Field>
              <Field label="Version">
                <Select
                  field
                  value={String(version)}
                  onChange={(v) => {
                    setVersion(v ? Number(v) : "");
                    setEdited(false);
                  }}
                  options={[["", "Latest"], ...(versions.data?.versions ?? []).map((v) => ({ value: String(v.version), label: `v${v.version}`, hint: v.note || undefined }))]}
                />
              </Field>
            </div>
            <Switch checked={autopilot} onChange={setAutopilot} label="Autopilot" hint={`Continue automatically when the agent stops without a report (up to ${s?.maxAutoContinues ?? 3} times) and recover from crashes.`} />
          </Section>
          <ErrorBox error={error} />
        </div>

        <section className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-line-2 bg-s1 xl:sticky xl:top-[72px] xl:h-[calc(100vh-180px)]">
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line-2 px-5 py-3">
            <h2 className="m-0 mr-2 text-[13.5px] font-medium">Prompt</h2>
            <Segmented
              label="Prompt view"
              value={promptView}
              onChange={setPromptView}
              options={[
                ["template", edited ? "Template (edited)" : "Template"],
                ["preview", "What the agent gets"],
              ]}
            />
            {edited && (
              <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setEdited(false)}>
                <IconArrowBackUp {...IC_XS} />
                Revert
              </Button>
            )}
          </div>
          {promptView === "template" ? (
            <>
              <textarea
                aria-label="Prompt template"
                spellCheck={false}
                className="min-h-80 flex-1 resize-none border-0 bg-transparent px-5 py-4 font-mono text-[12.5px] leading-relaxed text-ink outline-none"
                value={body}
                onChange={(e) => {
                  setBody(e.target.value);
                  setEdited(true);
                }}
              />
              <div className="flex shrink-0 flex-wrap gap-1 border-t border-line-2 px-5 py-2.5">
                {versions.data?.variables.map((v) => (
                  <code key={v} className="rounded bg-s3 px-1.5 py-0.5 font-mono text-[11px] text-ink-3">{`{{${v}}}`}</code>
                ))}
              </div>
            </>
          ) : (
            <pre className="m-0 min-h-80 flex-1 overflow-auto px-5 py-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-2">{preview}</pre>
          )}
        </section>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line-2 bg-bg/85 backdrop-blur-md">
        <div className="gut flex items-center gap-4 py-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-ink-3">
            <span className="truncate text-[13px] text-ink">{name || (slug ? `${slug.name}-${today()}` : "New run")}</span>
            {!compare && model && <span>{model.split("/").slice(1).join("/")}</span>}
            {!compare && variant && <span>{variant}</span>}
            {!compare && keyId === NO_KEY && <span>no key</span>}
            {compare && <span>{nRuns} runs</span>}
            {size && <span>{size}</span>}
            {template && (
              <span>
                {template.name}
                {version ? ` v${version}` : ""}
                {edited ? " (edited)" : ""}
              </span>
            )}
          </div>
          <Button variant="primary" onClick={submit} disabled={!ready}>
            <IconPlayerPlay {...IC_SM} />
            {compare ? `Start ${nRuns} runs` : "Start run"}
          </Button>
        </div>
      </div>
    </div>
  );
}
