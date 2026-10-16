/**
 * Add or edit a model provider: pick one from opencode's catalogue and connect it with a key or
 * without one, or point Pixel at any endpoint that speaks the OpenAI or Anthropic API (Ollama, vLLM,
 * LiteLLM, a gateway…) and list its models.
 */
import { useEffect, useMemo, useState } from "react";
import { Command } from "cmdk";
import { IconCheck, IconExternalLink, IconPlus, IconRefresh, IconSearch } from "@tabler/icons-react";
import { api } from "../lib/api.ts";
import { useAsync } from "../lib/hooks.ts";
import { cn } from "../lib/cn.ts";
import type { CatalogList, ConnectedProvider } from "../lib/types.ts";
import { Button, ErrorBox, Field, Notice, Segmented } from "./ui.tsx";
import { IC_SM, IC_XS, Sep } from "./ui/bits.tsx";
import { Dialog } from "./ui/overlay.tsx";
import { ProviderMark } from "./ProviderMark.tsx";

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

// ---- the key, with "no key" as a real choice ----

type KeyMode = "keep" | "key" | "none";
interface KeyState {
  mode: KeyMode;
  key: string;
}

/** What to send for the key: nothing keeps the stored one, noKey drops every key. */
const keyPatch = (k: KeyState) => (k.mode === "none" ? { noKey: true } : k.mode === "key" ? { key: k.key.trim() } : {});
const initialKey = (existing?: ConnectedProvider): KeyState => ({ mode: existing?.via.includes("pixel") ? (existing.keys.length ? "keep" : "none") : "key", key: "" });

function KeyChoice({ value, onChange, existing, providerName, envVar }: { value: KeyState; onChange: (k: KeyState) => void; existing?: ConnectedProvider; providerName: string; envVar?: string }) {
  const stored = existing?.via.includes("pixel") ? existing.keys : [];
  const options: [KeyMode, string][] = stored.length
    ? [
        ["keep", stored.length > 1 ? `Keep ${stored.length} keys` : `Keep ${stored[0].hint ?? "key"}`],
        ["key", stored.length > 1 ? "Replace the default" : "Replace"],
        ["none", "No key"],
      ]
    : [
        ["key", "API key"],
        ["none", "No key"],
      ];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[12.5px] font-[450] text-ink-2">Key</span>
        <Segmented label="Key" value={value.mode} onChange={(mode) => onChange({ ...value, mode })} options={options} />
      </div>
      {value.mode === "key" && (
        <input
          className="input font-mono"
          type="password"
          autoComplete="off"
          data-autofocus
          placeholder={stored.length > 1 ? `new key for ${stored[0].name}` : "paste the key"}
          value={value.key}
          onChange={(e) => onChange({ ...value, key: e.target.value })}
          aria-label="API key"
        />
      )}
      <p className="m-0 text-xs text-ink-3">
        {value.mode === "none" ? (
          <>
            Agents call {providerName} without a key: OpenCode Zen's free models, or a server that doesn't check keys.
            {stored.length > 0 && <span className="text-warning"> Removes {stored.length === 1 ? "the stored key" : `all ${stored.length} keys`}.</span>}
          </>
        ) : value.mode === "key" ? (
          <>Stored on the Pixel server and never shown again. Agents get it in opencode's auth.json{envVar ? `, the same as setting ${envVar}` : ""}. Prefer a key with a spending limit.</>
        ) : (
          <>More keys, notes and failover order are on the provider's panel.</>
        )}
      </p>
    </div>
  );
}

// ---- step 1: pick a provider ----

const itemClass = "grid h-[50px] cursor-pointer grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-3 data-[selected=true]:bg-s3";
const groupClass = "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-ink-3";

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

  const item = (p: CatalogEntry, group: string) => (
    <Command.Item key={`${group}:${p.id}`} value={`${group}:${p.id}`} onSelect={() => onPick(p)} className={itemClass}>
      <ProviderMark id={p.id} name={p.name} />
      <span className="min-w-0">
        <span className="block truncate text-[13.5px] text-ink">{p.name}</span>
        <span className="block truncate font-mono text-[11.5px] text-ink-3">
          {p.id}
          {p.env.length ? `, ${p.env.join(", ")}` : ""}
        </span>
      </span>
      {isOn(p.id) ? (
        <span className="inline-flex items-center gap-1 text-xs text-good">
          <IconCheck {...IC_XS} />
          Connected
        </span>
      ) : (
        <span className="font-mono text-xs text-ink-3">{p.toolModels} models</span>
      )}
    </Command.Item>
  );

  return (
    <Command shouldFilter={false} className="flex min-h-0 flex-1 flex-col" loop>
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-y border-line-2 px-5 text-ink-3">
        <IconSearch {...IC_SM} />
        <Command.Input
          value={query}
          onValueChange={setQuery}
          placeholder={`Search ${all.length || ""} providers`}
          className="h-full min-w-0 flex-1 border-0 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-4"
        />
      </div>
      <Command.List className="min-h-0 flex-1 overflow-y-auto p-2">
        {!catalog && <div className="px-3 py-4 text-sm text-ink-3">Loading the provider catalogue</div>}
        {catalog?.source === "none" && (
          <div className="p-2">
            <Notice>Pixel couldn't download the provider catalogue (models.dev) and has no cached copy. You can still add a custom endpoint.</Notice>
          </div>
        )}
        <Command.Item value="__custom" onSelect={onCustom} className={itemClass}>
          <span className="inline-flex size-[30px] items-center justify-center rounded-lg border border-dashed border-line text-ink-2">
            <IconPlus {...IC_SM} />
          </span>
          <span className="min-w-0">
            <span className="block text-[13.5px] text-ink">Custom endpoint</span>
            <span className="block truncate text-xs text-ink-3">OpenAI or Anthropic API: Ollama, vLLM, LiteLLM, a gateway</span>
          </span>
          <span />
        </Command.Item>
        {shown.popular.length > 0 && (
          <Command.Group heading="Popular" className={groupClass}>
            {shown.popular.map((p) => item(p, "pop"))}
          </Command.Group>
        )}
        {shown.rest.length > 0 && (
          <Command.Group heading={query ? `${shown.rest.length} matches` : "All providers"} className={groupClass}>
            {shown.rest.slice(0, query ? 100 : 400).map((p) => item(p, "all"))}
          </Command.Group>
        )}
        {query && !shown.rest.length && <div className="px-3 py-4 text-sm text-ink-3">No provider matches. If it speaks the OpenAI API, add it as a custom endpoint.</div>}
      </Command.List>
    </Command>
  );
}

// ---- step 2a: a catalogue provider ----

function ConnectForm({ provider, existing, onSaved, onBack, onClose }: { provider: CatalogEntry; existing?: ConnectedProvider; onSaved: (id: string) => void; onBack?: () => void; onClose: () => void }) {
  const editing = !!existing?.via.includes("pixel");
  const [k, setK] = useState<KeyState>(() => initialKey(existing));
  const [baseURL, setBaseURL] = useState(existing?.baseURL ?? "");
  const [advanced, setAdvanced] = useState(!!existing?.baseURL);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await api.saveProvider(provider.id, { ...keyPatch(k), baseURL });
      onSaved(provider.id);
    } catch (e: any) {
      setError(e.message);
      throw e;
    }
  };
  return (
    <Dialog
      onOpenChange={(o) => !o && onClose()}
      size="md"
      back={onBack}
      title={`${editing ? "Edit" : "Connect"} ${provider.name}`}
      description={
        <span className="inline-flex flex-wrap items-center gap-x-1.5">
          <span className="font-mono text-xs">{provider.id}</span>
          <Sep className="mx-0" /> {provider.modelCount} models
          {provider.doc && (
            <a href={provider.doc} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-ink-3 hover:text-ink">
              <Sep className="mx-0" /> docs <IconExternalLink {...IC_XS} />
            </a>
          )}
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={k.mode === "key" && !k.key.trim()} done={editing ? `${provider.name} saved` : `${provider.name} connected${k.mode === "none" ? " without a key" : ""}`}>
            {editing ? "Save" : "Connect"}
          </Button>
        </>
      }
    >
      <ErrorBox error={error} />
      {provider.env.length > 1 && (
        <Notice>
          {provider.name} usually needs more than a key: <span className="font-mono text-xs">{provider.env.join(", ")}</span>. Set the other variables under Settings, Agent credentials.
        </Notice>
      )}
      <KeyChoice value={k} onChange={setK} existing={existing} providerName={provider.name} envVar={provider.env[0]} />
      {advanced ? (
        <Field label="Base URL" hint="Only to route this provider through a proxy or a regional endpoint.">
          <input className="input font-mono" placeholder={provider.api ?? "provider default"} value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
        </Field>
      ) : (
        <button type="button" className="cursor-pointer self-start border-0 bg-transparent p-0 text-[13px] text-ink-3 hover:text-ink" onClick={() => setAdvanced(true)}>
          Use a different base URL
        </button>
      )}
    </Dialog>
  );
}

// ---- step 2b: a custom endpoint ----

function CustomForm({ existing, onSaved, onBack, onClose }: { existing?: ConnectedProvider; onSaved: (id: string, models: string[]) => void; onBack?: () => void; onClose: () => void }) {
  const [name, setName] = useState(existing?.name ?? "");
  const [id, setId] = useState(existing?.id ?? "");
  const [idEdited, setIdEdited] = useState(!!existing);
  const [apiType, setApiType] = useState<CustomApi>(existing?.custom?.api ?? "openai");
  const [baseURL, setBaseURL] = useState(existing?.baseURL ?? "");
  const [k, setK] = useState<KeyState>(() => (existing ? initialKey(existing) : { mode: "none", key: "" }));
  const [context, setContext] = useState(String(existing?.custom?.context ?? 128000));
  const [reasoning, setReasoning] = useState(!!existing?.custom?.reasoning);
  const [models, setModels] = useState<string[]>(existing?.custom?.models ?? []);
  const [found, setFound] = useState<string[] | null>(null);
  const [extra, setExtra] = useState("");
  const [error, setError] = useState<string | null>(null);
  const finalId = idEdited ? id : slug(name);
  const type = API_TYPES.find((t) => t.id === apiType)!;

  const discover = async () => {
    try {
      const r = await api.discoverModels({ baseURL, key: k.mode === "key" ? k.key || undefined : undefined, id: existing?.id, api: apiType });
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
      await api.saveProvider(finalId, { name, baseURL, ...keyPatch(k), custom: { api: apiType, models, context: Number(context), reasoning } });
      onSaved(finalId, models);
    } catch (e: any) {
      setError(e.message);
      throw e;
    }
  };
  const listed = [...new Set([...(found ?? []), ...models])];

  return (
    <Dialog
      onOpenChange={(o) => !o && onClose()}
      size="md"
      back={onBack}
      title={existing ? `Edit ${existing.name}` : "Custom endpoint"}
      description="Any server that speaks the OpenAI or Anthropic API."
      footer={
        <>
          <span className="mr-auto font-mono text-xs text-ink-3">
            {models.length} model{models.length === 1 ? "" : "s"}
          </span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={!finalId || !baseURL.trim() || !models.length || (k.mode === "key" && !k.key.trim())} done={`${name || finalId} saved`}>
            {existing ? "Save" : "Add provider"}
          </Button>
        </>
      }
    >
      <ErrorBox error={error} />
      <Segmented label="API type" value={apiType} onChange={setApiType} options={API_TYPES.map((t) => [t.id, t.label])} className="self-start" />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <input className="input" data-autofocus={!existing || undefined} placeholder="Home Ollama" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Provider id" hint="Models are named id/model.">
          <input
            className="input font-mono"
            disabled={!!existing}
            placeholder="home-ollama"
            value={finalId}
            onChange={(e) => {
              setIdEdited(true);
              setId(slug(e.target.value));
            }}
          />
        </Field>
        <Field label="Base URL" className="sm:col-span-2" hint={`${type.hint} Agents must be able to reach it from their machine.`}>
          <input className="input font-mono" placeholder={type.placeholder} value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
        </Field>
      </div>
      <KeyChoice value={k} onChange={setK} existing={existing} providerName={name || "this endpoint"} />
      <div className="grid items-center gap-3 sm:grid-cols-2">
        <Field label="Context window (tokens)" hint="For every model here; opencode compacts before it fills up.">
          <input className="input font-mono" type="number" min={1024} value={context} onChange={(e) => setContext(e.target.value)} />
        </Field>
        <label className="flex cursor-pointer items-start gap-2.5 text-[13px]">
          <input type="checkbox" className="mt-0.5 size-4" checked={reasoning} onChange={(e) => setReasoning(e.target.checked)} />
          <span>
            Models can think
            <span className="block text-xs text-ink-3">{apiType === "anthropic" ? "Offers thinking budgets" : "Offers reasoning effort low / medium / high"}</span>
          </span>
        </label>
      </div>

      <section className="flex flex-col gap-2.5 rounded-xl border border-line-2 p-3.5">
        <div className="flex items-center gap-2">
          <h3 className="m-0 mr-auto text-[13px] font-medium">Models</h3>
          <Button size="xs" onClick={discover} disabled={!baseURL.trim()}>
            <IconRefresh {...IC_XS} />
            Fetch from endpoint
          </Button>
        </div>
        {listed.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {listed.map((m) => {
              const on = models.includes(m);
              return (
                <button
                  key={m}
                  type="button"
                  aria-pressed={on}
                  title={on ? "Click to leave it out" : "Click to include it"}
                  onClick={() => toggle(m)}
                  className={cn("inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded-md border px-2 font-mono text-xs", on ? "border-line bg-s3 text-ink" : "border-line-2 bg-transparent text-ink-3 hover:text-ink")}
                >
                  {on ? <IconCheck {...IC_XS} className="text-accent" /> : <IconPlus {...IC_XS} />}
                  {m}
                </button>
              );
            })}
          </div>
        )}
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            addExtra();
          }}
        >
          <input className="input flex-1 font-mono" placeholder="model id, e.g. qwen3-coder:30b" value={extra} onChange={(e) => setExtra(e.target.value)} aria-label="Add a model id" />
          <Button type="submit" disabled={!extra.trim()}>
            Add
          </Button>
        </form>
        <p className="m-0 text-xs text-ink-3">Agents need models that can call tools. Small local models often can't, or loop.</p>
      </section>
    </Dialog>
  );
}

/** `edit` opens straight on a connected provider's form; otherwise the catalogue picker comes first. */
export function AddProviderDialog({ connected, edit, onClose, onSaved }: { connected: ConnectedProvider[]; edit?: ConnectedProvider; onClose: () => void; onSaved: (id: string, offer?: string[]) => void }) {
  const catalog = useAsync(() => api.catalog(), []);
  const [picked, setPicked] = useState<CatalogEntry | null>(null);
  const [custom, setCustom] = useState(!!edit?.custom);

  // Editing a catalogue provider: wait for its catalogue entry, then show the form.
  useEffect(() => {
    if (edit && !edit.custom && catalog.data) setPicked(catalog.data.providers.find((p) => p.id === edit.id) ?? null);
  }, [edit, catalog.data]);

  if (custom) return <CustomForm existing={edit} onClose={onClose} onBack={edit ? undefined : () => setCustom(false)} onSaved={(id, models) => onSaved(id, models)} />;
  if (picked) return <ConnectForm provider={picked} existing={edit ?? connected.find((c) => c.id === picked.id)} onClose={onClose} onBack={edit ? undefined : () => setPicked(null)} onSaved={(id) => onSaved(id)} />;
  if (edit)
    return (
      <Dialog onOpenChange={(o) => !o && onClose()} size="md" title={`Edit ${edit.name}`}>
        {catalog.error ? <ErrorBox error={catalog.error} /> : <div className="text-sm text-ink-3">Loading</div>}
      </Dialog>
    );
  return (
    <Dialog onOpenChange={(o) => !o && onClose()} size="md" title="Add a provider" className="h-[min(640px,84vh)]" bodyClassName="p-0 gap-0">
      <ErrorBox error={catalog.error} />
      <ProviderPicker catalog={catalog.data} connected={connected} onPick={setPicked} onCustom={() => setCustom(true)} />
    </Dialog>
  );
}
