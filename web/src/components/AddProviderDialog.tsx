/**
 * Add or edit a model provider: pick one from opencode's catalogue and connect it with a key or
 * without one, or point Pixel at any endpoint that speaks the OpenAI or Anthropic API (Ollama, vLLM,
 * LiteLLM, a gateway…) and list its models. Whatever else a provider needs (an account id, a region,
 * a resource name) is set here too, as variables agents get and the base URL can use.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Command } from "cmdk";
import { IconCheck, IconExternalLink, IconPlus, IconRefresh, IconSearch, IconX } from "@tabler/icons-react";
import { api } from "../lib/api.ts";
import { useAsync } from "../lib/hooks.ts";
import { cn } from "../lib/cn.ts";
import type { CatalogList, ConnectedProvider } from "../lib/types.ts";
import { Button, ErrorBox, Field, Notice, Segmented, Switch } from "./ui.tsx";
import { IC_SM, IC_XS, Sep } from "./ui/bits.tsx";
import { Dialog } from "./ui/overlay.tsx";
import { ProviderMark } from "./ProviderMark.tsx";

type CatalogEntry = CatalogList["providers"][number];
type CustomApi = "openai" | "anthropic";

const API_TYPES: { id: CustomApi; label: string; placeholder: string; hint: string }[] = [
  { id: "openai", label: "OpenAI-compatible", placeholder: "http://192.168.1.20:11434/v1", hint: "The URL before /chat/completions, usually ending in /v1." },
  { id: "anthropic", label: "Anthropic-compatible", placeholder: "https://gateway.example.com/v1", hint: "The URL before /messages, usually ending in /v1." },
];

/**
 * Catalogue providers Pixel sets up as a custom endpoint instead, with everything filled in.
 * Snowflake Cortex: opencode's own Cortex support renames max_tokens on every call, which Cortex's
 * Anthropic API refuses, and Claude 5.5 answers only there (checked 2026-10-20, opencode 1.19).
 */
interface Preset {
  id: string;
  name: string;
  api: CustomApi;
  baseURL: string;
  vars: string[];
  bearer?: boolean;
  maxCompletionTokens?: boolean;
  context: number;
  /** The API a newly added model speaks, when the endpoint mixes them. */
  apiFor?: (model: string) => CustomApi;
  keyName: string;
  about: ReactNode;
}
const PRESETS: Record<string, Preset> = {
  "snowflake-cortex": {
    id: "cortex",
    name: "Snowflake Cortex",
    api: "openai",
    baseURL: "https://${SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/api/v2/cortex/v1",
    vars: ["SNOWFLAKE_ACCOUNT"],
    bearer: true,
    maxCompletionTokens: true,
    context: 200_000,
    apiFor: (m) => (m.startsWith("claude-") ? "anthropic" : "openai"),
    keyName: "PAT",
    about: <>Claude models use Cortex's Anthropic API (the only one that serves Claude 5.5), the others its OpenAI API. The key is a programmatic access token (PAT). Fetch lists the models your account has.</>,
  },
};
const presetForURL = (url: string | null | undefined) => (url && /\.snowflakecomputing\.com/.test(url) ? PRESETS["snowflake-cortex"] : null);

// ---- variables a provider needs besides the key ----

/** Mirrors the server: names that look like secrets are never sent back, only a hint. */
const SECRET_VAR = /KEY|TOKEN|SECRET|PASSWORD|PAT$|CREDENTIAL/i;
const VAR_HINTS: Record<string, string> = {
  SNOWFLAKE_ACCOUNT: "Account identifier, the part before .snowflakecomputing.com (like abcdefg-xy12345). Pasting the account URL works too.",
};
const urlVars = (url: string | null | undefined) => [...(url ?? "").matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]);

/** A row: a value typed now, or a stored secret kept as it is (only its hint is known). */
interface VarRow {
  name: string;
  value: string;
  stored: string | null;
}
const initialVars = (existing: ConnectedProvider | undefined, names: string[]): VarRow[] => {
  const rows: VarRow[] = (existing?.vars ?? []).map((v) => ({ name: v.name, value: v.value ?? "", stored: v.hint }));
  for (const n of names) if (!rows.some((r) => r.name === n)) rows.push({ name: n, value: "", stored: null });
  return rows;
};
/** The whole set for the server: typed values, null keeps a stored secret, "" drops it. */
const varsPatch = (rows: VarRow[]) => Object.fromEntries(rows.filter((r) => r.name.trim()).map((r) => [r.name.trim(), r.value.trim() || (r.stored ? null : "")]));
const unset = (rows: VarRow[], names: string[]) => names.filter((n) => !rows.some((r) => r.name === n && (r.value.trim() || r.stored)));

function VarsEditor({ rows, onChange, fixed = [], needed }: { rows: VarRow[]; onChange: (rows: VarRow[]) => void; fixed?: string[]; needed: string[] }) {
  const set = (i: number, patch: Partial<VarRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  // Rows already say so in their placeholder; this is for a ${NAME} in the URL with no row yet.
  const missing = unset(rows, needed).filter((n) => !rows.some((r) => r.name === n));
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h3 className="m-0 text-[12.5px] font-[450] text-ink-2">Variables</h3>
        <p className="m-0 mt-0.5 text-xs text-ink-3">Agents get them as environment variables, and the base URL fills in each {"${NAME}"} from them.</p>
      </div>
      {rows.map((r, i) => {
        const secret = SECRET_VAR.test(r.name);
        const isFixed = fixed.includes(r.name);
        return (
          <div key={i} className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <input
                className="input w-[42%] min-w-[150px] font-mono text-[12.5px]"
                value={r.name}
                readOnly={isFixed}
                placeholder="NAME"
                spellCheck={false}
                aria-label="Variable name"
                onChange={(e) => set(i, { name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"), stored: null })}
              />
              <input
                className="input flex-1 font-mono text-[12.5px]"
                type={secret ? "password" : "text"}
                autoComplete="off"
                value={r.value}
                placeholder={r.stored ? `keep ${r.stored}` : needed.includes(r.name) ? "needed for the base URL" : "value"}
                aria-label={`${r.name || "Variable"} value`}
                onChange={(e) => set(i, { value: e.target.value })}
              />
              {!isFixed && (
                <Button size="sm" icon variant="ghost" aria-label={`Remove ${r.name || "this variable"}`} className="hover:enabled:text-critical" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                  <IconX {...IC_SM} />
                </Button>
              )}
            </div>
            {VAR_HINTS[r.name] && <p className="m-0 text-xs text-ink-3">{VAR_HINTS[r.name]}</p>}
          </div>
        );
      })}
      <Button size="xs" variant="ghost" className="self-start text-ink-3" onClick={() => onChange([...rows, { name: "", value: "", stored: null }])} disabled={rows.some((r) => !r.name.trim())}>
        <IconPlus {...IC_XS} />
        Add variable
      </Button>
      {missing.length > 0 && <p className="m-0 text-xs text-warning">The base URL needs {missing.join(", ")}.</p>}
    </section>
  );
}

/** How requests go out, for gateways that differ from the APIs they copy. */
function RequestSwitches({ bearer, onBearer, mct, onMct, anthropic, openai }: { bearer: boolean; onBearer: (on: boolean) => void; mct: boolean; onMct: (on: boolean) => void; anthropic: boolean; openai: boolean }) {
  if (!anthropic && !openai) return null;
  return (
    <div className="flex flex-col gap-3">
      {anthropic && <Switch checked={bearer} onChange={onBearer} label="Send the key as Authorization: Bearer" hint="On Anthropic-style calls too, for gateways that refuse x-api-key (Snowflake Cortex)." />}
      {openai && <Switch checked={mct} onChange={onMct} label="Send max_completion_tokens" hint="Instead of max_tokens on OpenAI-style calls; newer OpenAI models behind a gateway refuse max_tokens." />}
    </div>
  );
}

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

function KeyChoice({ value, onChange, existing, providerName, envVar, keyName = "key" }: { value: KeyState; onChange: (k: KeyState) => void; existing?: ConnectedProvider; providerName: string; envVar?: string; keyName?: string }) {
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
          placeholder={stored.length > 1 ? `new key for ${stored[0].name}` : `paste the ${keyName}`}
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
          <>Stored on the Pixel server and never shown again. Agents get it in their opencode config{envVar ? `, the same as setting ${envVar}` : ""}. Prefer a key with a spending limit.</>
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
  const isOn = (id: string) => connected.some((c) => (c.id === id || c.id === PRESETS[id]?.id) && c.via.some((v) => v !== "builtin"));
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
  // The key is the first secret-looking variable; the others (account, region, resource) are asked for here.
  // Several *_API_KEY names are aliases of one key (Google), not more to fill in.
  const keyVar = provider.env.find((v) => SECRET_VAR.test(v)) ?? provider.env[0];
  const extraVars = provider.env.filter((v) => v !== keyVar && !(/API_KEY$/.test(v) && /API_KEY$/.test(keyVar ?? "")));
  const [k, setK] = useState<KeyState>(() => initialKey(existing));
  const [baseURL, setBaseURL] = useState(existing?.baseURL ?? "");
  const [vars, setVars] = useState<VarRow[]>(() => initialVars(existing, extraVars));
  const [bearer, setBearer] = useState(!!existing?.bearer);
  const [mct, setMct] = useState(!!existing?.maxCompletionTokens);
  const [advanced, setAdvanced] = useState(!!existing?.baseURL || !!existing?.bearer || !!existing?.maxCompletionTokens);
  const [error, setError] = useState<string | null>(null);
  const anthropic = !!provider.npm?.includes("anthropic");
  const save = async () => {
    try {
      await api.saveProvider(provider.id, { ...keyPatch(k), baseURL, vars: varsPatch(vars), bearer, maxCompletionTokens: mct });
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
      <KeyChoice value={k} onChange={setK} existing={existing} providerName={provider.name} envVar={keyVar} />
      {(extraVars.length > 0 || vars.length > 0 || advanced) && <VarsEditor rows={vars} onChange={setVars} fixed={extraVars} needed={urlVars(baseURL.trim() || provider.api)} />}
      {advanced ? (
        <>
          <Field label="Base URL" hint={"Only to route this provider through a proxy or a regional endpoint. ${NAME} takes a variable."}>
            <input className="input font-mono" placeholder={provider.api ?? "provider default"} value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
          </Field>
          <RequestSwitches bearer={bearer} onBearer={setBearer} mct={mct} onMct={setMct} anthropic={anthropic} openai={!anthropic} />
        </>
      ) : (
        <button type="button" className="cursor-pointer self-start border-0 bg-transparent p-0 text-[13px] text-ink-3 hover:text-ink" onClick={() => setAdvanced(true)}>
          Base URL and how requests are sent
        </button>
      )}
    </Dialog>
  );
}

// ---- step 2b: a custom endpoint ----

function CustomForm({ existing, preset, onSaved, onBack, onClose }: { existing?: ConnectedProvider; preset?: Preset | null; onSaved: (id: string, models: string[]) => void; onBack?: () => void; onClose: () => void }) {
  const [name, setName] = useState(existing?.name ?? preset?.name ?? "");
  const [id, setId] = useState(existing?.id ?? preset?.id ?? "");
  const [idEdited, setIdEdited] = useState(!!existing || !!preset);
  const [apiType, setApiType] = useState<CustomApi>(existing?.custom?.api ?? preset?.api ?? "openai");
  const [baseURL, setBaseURL] = useState(existing?.baseURL ?? preset?.baseURL ?? "");
  const [k, setK] = useState<KeyState>(() => (existing ? initialKey(existing) : { mode: preset ? "key" : "none", key: "" }));
  const [vars, setVars] = useState<VarRow[]>(() => initialVars(existing, preset?.vars ?? []));
  const [context, setContext] = useState(String(existing?.custom?.context ?? preset?.context ?? 128000));
  const [reasoning, setReasoning] = useState(!!existing?.custom?.reasoning);
  const [models, setModels] = useState<string[]>(existing?.custom?.models ?? []);
  const [modelApi, setModelApi] = useState<Record<string, CustomApi>>(existing?.custom?.modelApi ?? {});
  const [bearer, setBearer] = useState(existing ? existing.bearer : !!preset?.bearer);
  const [mct, setMct] = useState(existing ? existing.maxCompletionTokens : !!preset?.maxCompletionTokens);
  const [found, setFound] = useState<string[] | null>(null);
  const [extra, setExtra] = useState("");
  const [error, setError] = useState<string | null>(null);
  const finalId = idEdited ? id : slug(name);
  const type = API_TYPES.find((t) => t.id === apiType)!;
  // Models saved before keep their API; new ones follow the preset's rule (Cortex: Claude on the Anthropic API).
  const apiFor = (m: string): CustomApi => modelApi[m] ?? (existing?.custom?.models.includes(m) ? apiType : (preset?.apiFor?.(m) ?? apiType));
  const [mixed, setMixed] = useState(() => !!preset?.apiFor || Object.keys(existing?.custom?.modelApi ?? {}).length > 0);
  const speaks = (x: CustomApi) => apiType === x || mixed;
  const keyVal = k.mode === "key" ? k.key || undefined : undefined;

  const discover = async () => {
    try {
      const r = await api.discoverModels({ baseURL, key: keyVal, id: existing?.id, api: apiType, vars: varsPatch(vars), bearer });
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
      const perModel = mixed ? Object.fromEntries(models.map((m) => [m, apiFor(m)])) : {};
      await api.saveProvider(finalId, { name, baseURL, ...keyPatch(k), vars: varsPatch(vars), bearer, maxCompletionTokens: mct, custom: { api: apiType, models, context: Number(context), reasoning, modelApi: perModel } });
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
      title={existing ? `Edit ${existing.name}` : (preset?.name ?? "Custom endpoint")}
      description={preset && !existing ? preset.about : "Any server that speaks the OpenAI or Anthropic API."}
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
        <Field label="Base URL" className="sm:col-span-2" hint={`${type.hint} Agents must be able to reach it from their machine. \${NAME} takes a variable.`}>
          <input className="input font-mono" placeholder={type.placeholder} value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
        </Field>
      </div>
      <VarsEditor rows={vars} onChange={setVars} fixed={preset?.vars} needed={urlVars(baseURL)} />
      <KeyChoice value={k} onChange={setK} existing={existing} providerName={name || "this endpoint"} keyName={preset?.keyName} />
      <Switch checked={mixed} onChange={setMixed} label="Models speak different APIs" hint="Each model picks OpenAI or Anthropic below; they share the base URL." />
      <RequestSwitches bearer={bearer} onBearer={setBearer} mct={mct} onMct={setMct} anthropic={speaks("anthropic")} openai={speaks("openai")} />
      <div className="grid items-center gap-3 sm:grid-cols-2">
        <Field label="Context window (tokens)" hint="For models the catalogue doesn't know; known ones (claude-opus-5-5, gpt-5.4) use its numbers. opencode compacts before it fills up.">
          <input className="input font-mono" type="number" min={1024} value={context} onChange={(e) => setContext(e.target.value)} />
        </Field>
        <label className="flex cursor-pointer items-start gap-2.5 text-[13px]">
          <input type="checkbox" className="mt-0.5 size-4" checked={reasoning} onChange={(e) => setReasoning(e.target.checked)} />
          <span>
            Models can think
            <span className="block text-xs text-ink-3">For models the catalogue doesn't know; it offers thinking levels.</span>
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
        {mixed && models.length > 0 && (
          <div className="flex flex-col gap-1.5 border-t border-line-2 pt-2.5">
            {models.map((m) => (
              <div key={m} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{m}</span>
                <Segmented label={`API for ${m}`} value={apiFor(m)} onChange={(x) => setModelApi((o) => ({ ...o, [m]: x }))} options={[["openai", "OpenAI"], ["anthropic", "Anthropic"]]} />
              </div>
            ))}
          </div>
        )}
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
  const [preset, setPreset] = useState<Preset | null>(null);

  // Editing a catalogue provider: wait for its catalogue entry, then show the form.
  useEffect(() => {
    if (edit && !edit.custom && catalog.data) setPicked(catalog.data.providers.find((p) => p.id === edit.id) ?? null);
  }, [edit, catalog.data]);

  if (custom)
    return (
      <CustomForm
        existing={edit ?? (preset ? connected.find((c) => c.id === preset.id && c.custom) : undefined)}
        preset={preset ?? presetForURL(edit?.baseURL)}
        onClose={onClose}
        onBack={
          edit
            ? undefined
            : () => {
                setCustom(false);
                setPreset(null);
              }
        }
        onSaved={(id, models) => onSaved(id, models)}
      />
    );
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
      <ProviderPicker
        catalog={catalog.data}
        connected={connected}
        onPick={(p) => {
          if (!PRESETS[p.id]) return setPicked(p);
          setPreset(PRESETS[p.id]);
          setCustom(true);
        }}
        onCustom={() => setCustom(true)}
      />
    </Dialog>
  );
}
