/**
 * Add or edit a model provider: pick one from opencode's catalogue and paste its key, or point Pixel
 * at any endpoint that speaks the OpenAI or Anthropic API (Ollama, vLLM, LiteLLM, a gateway…) and
 * list its models.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api.ts";
import { useAsync } from "../lib/hooks.ts";
import type { CatalogList, ConnectedProvider } from "../lib/types.ts";
import { Button, ErrorBox, Field, Notice } from "./ui.tsx";
import { ProviderMark } from "./ProviderList.tsx";

type CatalogEntry = CatalogList["providers"][number];
type CustomApi = "openai" | "anthropic";

const API_TYPES: { id: CustomApi; label: string; placeholder: string; hint: string }[] = [
  { id: "openai", label: "OpenAI-compatible", placeholder: "http://192.168.1.20:11434/v1", hint: "The URL before /chat/completions, usually ending in /v1." },
  { id: "anthropic", label: "Anthropic-compatible", placeholder: "https://gateway.example.com/v1", hint: "The URL before /messages, usually ending in /v1." },
];

/** Shown first when nothing is typed: the providers people use most for coding agents. */
const POPULAR = ["anthropic", "openai", "openrouter", "google", "opencode", "opencode-go", "deepseek", "xai", "moonshotai", "zai", "mistral", "groq", "cerebras", "fireworks-ai", "togetherai"];

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

function Dialog({ title, onClose, children, footer, back }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; back?: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}>
        <header>
          {back && (
            <button className="btn btn-sm" onClick={back} aria-label="Back">
              ←
            </button>
          )}
          <h2>{title}</h2>
          <button className="btn btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

function ProviderPicker({ catalog, connected, onPick, onCustom }: { catalog: CatalogList | undefined; connected: ConnectedProvider[]; onPick: (p: CatalogEntry) => void; onCustom: () => void }) {
  const [query, setQuery] = useState("");
  const all = catalog?.providers ?? [];
  const isOn = (id: string) => connected.some((c) => c.id === id && c.via.some((v) => v !== "builtin"));
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return { popular: POPULAR.map((id) => all.find((p) => p.id === id)).filter((p): p is CatalogEntry => !!p), rest: [...all].sort((a, b) => a.name.localeCompare(b.name)) };
    const hits = all.filter((p) => p.id.includes(q) || p.name.toLowerCase().includes(q) || p.env.some((e) => e.toLowerCase().includes(q)));
    return { popular: [], rest: hits.sort((a, b) => Number(!a.id.startsWith(q)) - Number(!b.id.startsWith(q)) || a.name.localeCompare(b.name)) };
  }, [all, query]);

  const item = (p: CatalogEntry) => (
    <button key={p.id} onClick={() => onPick(p)}>
      <ProviderMark id={p.id} name={p.name} />
      <span className="pick-text">
        <div className="pick-name">{p.name}</div>
        <div className="pick-sub">
          {p.id}
          {p.env.length ? ` · ${p.env.join(", ")}` : ""}
        </div>
      </span>
      <span className="pick-side">{isOn(p.id) ? <span className="badge done">connected</span> : `${p.toolModels} models with tools`}</span>
    </button>
  );

  return (
    <>
      <input className="input" autoFocus placeholder={`Search ${all.length || ""} providers, e.g. anthropic, openrouter, groq…`} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search providers" />
      {!catalog && <div className="muted">Loading the provider catalogue…</div>}
      {catalog?.source === "none" && <Notice>Pixel could not download the provider catalogue (models.dev) and has no cached copy. You can still add a custom endpoint.</Notice>}
      <div className="pick">
        <button className="custom" onClick={onCustom}>
          <span className="pmark">+</span>
          <span className="pick-text">
            <div className="pick-name">Custom endpoint</div>
            <div className="pick-sub">OpenAI or Anthropic API · Ollama, vLLM, LiteLLM, a gateway…</div>
          </span>
          <span className="pick-side">base URL + key</span>
        </button>
        {shown.popular.length > 0 && <div className="pick-group">Popular</div>}
        {shown.popular.map(item)}
        {shown.rest.length > 0 && <div className="pick-group">{query ? `${shown.rest.length} matches` : "All providers"}</div>}
        {shown.rest.slice(0, query ? 100 : 400).map(item)}
        {query && !shown.rest.length && <div className="pick-group">No provider matches. If it speaks the OpenAI API, add it as a custom endpoint.</div>}
      </div>
    </>
  );
}

function KeyForm({ provider, existing, onSaved, onBack, onClose }: { provider: CatalogEntry; existing?: ConnectedProvider; onSaved: (id: string) => void; onBack?: () => void; onClose: () => void }) {
  const [key, setKey] = useState("");
  const [baseURL, setBaseURL] = useState(existing?.baseURL ?? "");
  const [advanced, setAdvanced] = useState(!!existing?.baseURL);
  const [error, setError] = useState<string | null>(null);
  const editing = existing?.via.includes("pixel");
  const multiVar = provider.env.length > 1;
  const save = async () => {
    try {
      await api.saveProvider(provider.id, { key: editing && !key ? undefined : key, baseURL });
      onSaved(provider.id);
    } catch (e: any) {
      setError(e.message);
      throw e;
    }
  };
  return (
    <Dialog
      title={`${editing ? "Edit" : "Connect"} ${provider.name}`}
      onClose={onClose}
      back={onBack}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <Button variant="primary" onClick={save} disabled={!editing && !key.trim() && !baseURL.trim()} done={editing ? `${provider.name} updated` : `${provider.name} connected`}>
            {editing ? "Save" : "Connect"}
          </Button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="muted" style={{ fontSize: 12.5 }}>
        <span className="mono">{provider.id}</span> · {provider.modelCount} models in the catalogue
        {provider.doc && (
          <>
            {" · "}
            <a href={provider.doc} target="_blank" rel="noreferrer">
              docs
            </a>
          </>
        )}
      </div>
      {multiVar && (
        <Notice>
          {provider.name} usually needs more than a key: <span className="mono">{provider.env.join(", ")}</span>. Paste the API key here if it has one, and set the other variables under Settings → Agent credentials.
        </Notice>
      )}
      <Field
        label="API key"
        hint={
          <>
            Stored on the Pixel server and never shown again. Every agent gets it in opencode's <span className="mono">auth.json</span>
            {provider.env[0] && (
              <>
                , the same as setting <span className="mono">{provider.env[0]}</span>
              </>
            )}
            . Prefer a key with a spending limit.
          </>
        }
      >
        <input
          className="input mono"
          type="password"
          autoFocus
          autoComplete="off"
          placeholder={editing ? `unchanged (${existing?.keyHint ?? "no key"})` : "paste the key"}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (key.trim() || editing) && void save().catch(() => {})}
        />
      </Field>
      {advanced ? (
        <Field label="Base URL (optional)" hint="Only to route this provider through a proxy or a regional endpoint.">
          <input className="input mono" placeholder={provider.api ?? "provider default"} value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
        </Field>
      ) : (
        <button className="btn btn-sm self-start" onClick={() => setAdvanced(true)}>
          Use a different base URL…
        </button>
      )}
    </Dialog>
  );
}

function CustomForm({ existing, onSaved, onBack, onClose }: { existing?: ConnectedProvider; onSaved: (id: string, models: string[]) => void; onBack?: () => void; onClose: () => void }) {
  const [name, setName] = useState(existing?.name ?? "");
  const [id, setId] = useState(existing?.id ?? "");
  const [idEdited, setIdEdited] = useState(!!existing);
  const [apiType, setApiType] = useState<CustomApi>(existing?.custom?.api ?? "openai");
  const [baseURL, setBaseURL] = useState(existing?.baseURL ?? "");
  const [key, setKey] = useState("");
  const [context, setContext] = useState(String(existing?.custom?.context ?? 128000));
  const [models, setModels] = useState<string[]>(existing?.custom?.models ?? []);
  const [found, setFound] = useState<string[] | null>(null);
  const [extra, setExtra] = useState("");
  const [error, setError] = useState<string | null>(null);
  const finalId = idEdited ? id : slug(name);

  const discover = async () => {
    try {
      const r = await api.discoverModels({ baseURL, key: key || undefined, id: existing?.id, api: apiType });
      setFound(r.models);
      setError(r.models.length ? null : "The endpoint answered but listed no models; type the model ids below.");
    } catch (e: any) {
      setFound(null);
      setError(e.message);
    }
  };
  const toggle = (m: string) => setModels((ms) => (ms.includes(m) ? ms.filter((x) => x !== m) : [...ms, m]));
  const addExtra = () => {
    const ids = extra.split(/[\s,]+/).filter(Boolean);
    setModels((ms) => [...new Set([...ms, ...ids])]);
    setExtra("");
  };
  const save = async () => {
    try {
      await api.saveProvider(finalId, { name, baseURL, key: existing && !key ? undefined : key, custom: { api: apiType, models, context: Number(context) } });
      onSaved(finalId, models);
    } catch (e: any) {
      setError(e.message);
      throw e;
    }
  };

  return (
    <Dialog
      title={existing ? `Edit ${existing.name}` : "Custom endpoint"}
      onClose={onClose}
      back={onBack}
      footer={
        <>
          <span className="muted mr-auto" style={{ fontSize: 12 }}>
            {models.length} model{models.length === 1 ? "" : "s"}
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <Button variant="primary" onClick={save} disabled={!finalId || !baseURL.trim() || !models.length} done={`${name || finalId} saved`}>
            {existing ? "Save" : "Add provider"}
          </Button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="label sm:col-span-2">
          <span>API</span>
          <div className="tabs" role="radiogroup" aria-label="API type">
            {API_TYPES.map((t) => (
              <button key={t.id} type="button" role="radio" aria-checked={apiType === t.id} className={`tab ${apiType === t.id ? "on" : ""}`} onClick={() => setApiType(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <Field label="Name">
          <input className="input" autoFocus={!existing} placeholder="e.g. Home Ollama" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Provider id" hint="Models are named id/model in Pixel and opencode.">
          <input
            className="input mono"
            disabled={!!existing}
            placeholder="home-ollama"
            value={finalId}
            onChange={(e) => {
              setIdEdited(true);
              setId(slug(e.target.value));
            }}
          />
        </Field>
        <Field label="Base URL" className="sm:col-span-2" hint={`${API_TYPES.find((t) => t.id === apiType)!.hint} Agents must be able to reach it from their machine.`}>
          <input className="input mono" placeholder={API_TYPES.find((t) => t.id === apiType)!.placeholder} value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
        </Field>
        <Field label="API key (optional)">
          <input className="input mono" type="password" autoComplete="off" placeholder={existing ? `unchanged (${existing.keyHint ?? "no key"})` : "none"} value={key} onChange={(e) => setKey(e.target.value)} />
        </Field>
        <Field label="Context window (tokens)" hint="Used for every model here; opencode compacts the session before it fills up.">
          <input className="input num" type="number" min={1024} value={context} onChange={(e) => setContext(e.target.value)} />
        </Field>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="eyebrow mr-auto">Models</span>
          <Button small onClick={discover} disabled={!baseURL.trim()}>
            Fetch from endpoint
          </Button>
        </div>
        {found && found.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {found.map((m) => (
              <label key={m} className="badge mono" style={{ cursor: "pointer", borderColor: models.includes(m) ? "var(--accent)" : undefined, color: models.includes(m) ? "var(--fg)" : undefined }}>
                <input type="checkbox" checked={models.includes(m)} onChange={() => toggle(m)} />
                {m}
              </label>
            ))}
          </div>
        )}
        {models.filter((m) => !found?.includes(m)).length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {models
              .filter((m) => !found?.includes(m))
              .map((m) => (
                <span key={m} className="badge mono" style={{ borderColor: "var(--accent)", color: "var(--fg)" }}>
                  {m}
                  <button style={{ all: "unset", cursor: "pointer" }} className="muted" aria-label={`Remove ${m}`} onClick={() => toggle(m)}>
                    ×
                  </button>
                </span>
              ))}
          </div>
        )}
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            addExtra();
          }}
        >
          <input className="input mono flex-1" placeholder="model id, e.g. qwen3-coder:30b" value={extra} onChange={(e) => setExtra(e.target.value)} aria-label="Add a model id" />
          <button className="btn btn-sm" type="submit" disabled={!extra.trim()}>
            Add
          </button>
        </form>
        <div className="muted" style={{ fontSize: 12 }}>
          Agents need models that can call tools. Small local models often can't, or loop.
        </div>
      </div>
    </Dialog>
  );
}

/** `edit` opens straight on a connected provider's form; otherwise the catalogue picker comes first. */
export function AddProviderDialog({ connected, edit, onClose, onSaved }: { connected: ConnectedProvider[]; edit?: ConnectedProvider; onClose: () => void; onSaved: (id: string, offer?: string[]) => void }) {
  const catalog = useAsync(() => api.catalog(), []);
  const [picked, setPicked] = useState<CatalogEntry | null>(null);
  const [custom, setCustom] = useState(!!edit?.custom);
  const started = useRef(!!edit);

  // Editing a catalogue provider: wait for its catalogue entry, then show the key form.
  useEffect(() => {
    if (edit && !edit.custom && catalog.data) setPicked(catalog.data.providers.find((p) => p.id === edit.id) ?? null);
  }, [edit, catalog.data]);

  if (custom) return <CustomForm existing={edit} onClose={onClose} onBack={started.current ? undefined : () => setCustom(false)} onSaved={(id, models) => onSaved(id, models)} />;
  if (picked)
    return (
      <KeyForm
        provider={picked}
        existing={edit ?? connected.find((c) => c.id === picked.id)}
        onClose={onClose}
        onBack={started.current ? undefined : () => setPicked(null)}
        onSaved={(id) => onSaved(id)}
      />
    );
  if (edit) return <Dialog title={`Edit ${edit.name}`} onClose={onClose}>{catalog.error ? <ErrorBox error={catalog.error} /> : <div className="muted">Loading…</div>}</Dialog>;
  return (
    <Dialog title="Add a model provider" onClose={onClose}>
      <ErrorBox error={catalog.error} />
      <ProviderPicker catalog={catalog.data} connected={connected} onPick={setPicked} onCustom={() => setCustom(true)} />
    </Dialog>
  );
}
