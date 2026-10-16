/**
 * Model and thinking pickers shared by the new-run form, a run's controls and the live test:
 * a searchable model list grouped by provider, the model's thinking levels (opencode variants)
 * as a segmented control, and an editor for your own levels.
 */
import { useEffect, useState } from "react";
import { Command } from "cmdk";
import { IconBrain, IconCheck, IconChevronDown, IconPlus, IconSearch, IconStarFilled, IconTrash } from "@tabler/icons-react";
import { api, type OfferedModel } from "../lib/api.ts";
import { tokens } from "../lib/format.ts";
import { cn } from "../lib/cn.ts";
import { navigate } from "../lib/router.tsx";
import { ProviderMark } from "./ProviderMark.tsx";
import { Button, ErrorBox, Field } from "./ui.tsx";
import { IC_SM, IC_XS } from "./ui/bits.tsx";
import { Dialog, Popover } from "./ui/overlay.tsx";

// ---- shared data: offered models (fast) and thinking levels (asked from opencode, slower) ----

type Offered = { defaultModel: string; models: OfferedModel[] };
let offeredCache: Promise<Offered> | null = null;
let variantsCache: Promise<Record<string, string[]>> | null = null;
const listeners = new Set<() => void>();

/** Forget cached models and levels (after adding levels or providers) and refresh every picker. */
export function refreshModels() {
  offeredCache = null;
  variantsCache = null;
  for (const l of listeners) l();
}

export function useModels() {
  const [offered, setOffered] = useState<Offered | null>(null);
  const [variants, setVariants] = useState<Record<string, string[]> | null>(null);
  const [variantsError, setVariantsError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    const bump = () => setN((x) => x + 1);
    listeners.add(bump);
    return () => void listeners.delete(bump);
  }, []);
  useEffect(() => {
    let live = true;
    (offeredCache ??= api.models()).then((o) => live && setOffered(o)).catch(() => (offeredCache = null));
    (variantsCache ??= api.modelVariants())
      .then((v) => live && (setVariants(v), setVariantsError(null)))
      .catch((e) => {
        variantsCache = null;
        if (live) setVariantsError(e.message ?? String(e));
      });
    return () => void (live = false);
  }, [n]);
  return { offered, variants, variantsError };
}

const price = (n: number | null) => (n == null ? null : n === 0 ? "free" : `$${n < 1 ? n.toFixed(2) : Math.round(n * 10) / 10}`);

/** Context and price per million tokens, in one quiet line. */
function meta(m: OfferedModel) {
  const p = price(m.costIn);
  return [m.context ? `${tokens(m.context)} ctx` : "", p ? (p === "free" ? "free" : `${p} / ${price(m.costOut)}`) : ""].filter(Boolean).join(", ");
}

// ---- model picker ----

/** The chosen model as a button; opens a searchable list of offered models grouped by provider (or any typed provider/model). */
export function ModelSelect({ value, onChange, compact }: { value: string; onChange: (model: string) => void; compact?: boolean }) {
  const { offered } = useModels();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const list = offered?.models ?? [];
  const cur = list.find((m) => m.model === value);
  const [pid] = value.split("/");

  const q = query.trim().toLowerCase();
  const hits = list.filter((m) => !q || m.model.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || m.providerName.toLowerCase().includes(q));
  const groups = [...new Set(hits.map((m) => m.providerName))].map((name) => ({ name, models: hits.filter((m) => m.providerName === name) }));
  const typed = q.includes("/") && !list.some((m) => m.model === query.trim()) ? query.trim() : null;
  const pick = (m: string) => {
    onChange(m);
    setOpen(false);
    setQuery("");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => (setOpen(o), o || setQuery(""))}
      className="flex w-[min(460px,calc(100vw-24px))] flex-col"
      trigger={
        <button
          type="button"
          className={cn(
            "group grid w-full min-w-0 cursor-pointer items-center gap-x-2.5 rounded-[10px] border border-line text-left hover:border-ink-4 data-[state=open]:border-[color-mix(in_srgb,var(--accent-c)_65%,var(--line))]",
            compact ? "h-9 grid-cols-[24px_minmax(0,1fr)_auto] border-transparent bg-transparent px-1.5 hover:bg-s2" : "h-12 grid-cols-[30px_minmax(0,1fr)_auto_auto] bg-[color-mix(in_srgb,var(--bg)_70%,var(--s1))] px-2.5",
          )}
        >
          <ProviderMark id={pid} name={cur?.providerName ?? pid} size={compact ? 24 : 30} />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 truncate text-[13.5px] text-ink">
              {cur?.name ?? value.split("/").slice(1).join("/")}
              {offered?.defaultModel === value && <IconStarFilled size={11} className="shrink-0 text-accent" aria-label="default" />}
            </span>
            {!compact && <span className="block truncate font-mono text-[11.5px] text-ink-3">{value}</span>}
          </span>
          {!compact && cur && <span className="font-mono text-[11.5px] text-ink-3 max-sm:hidden">{meta(cur)}</span>}
          <IconChevronDown {...IC_XS} className="text-ink-3 transition-transform group-data-[state=open]:rotate-180" />
        </button>
      }
    >
      <Command shouldFilter={false} loop className="flex min-h-0 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-line-2 px-3.5 text-ink-3">
          <IconSearch {...IC_SM} />
          <Command.Input autoFocus value={query} onValueChange={setQuery} placeholder="Search models, or type provider/model" className="h-full min-w-0 flex-1 border-0 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-ink-4" />
        </div>
        <Command.List className="max-h-[min(380px,60vh)] overflow-y-auto p-1.5">
          {groups.map((g) => (
            <Command.Group key={g.name} heading={g.name} className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-ink-3">
              {g.models.map((m) => (
                <Command.Item key={m.model} value={m.model} onSelect={() => pick(m.model)} className="grid min-h-11 cursor-pointer grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-lg px-2.5 py-1 data-[selected=true]:bg-s3">
                  {m.model === value ? <IconCheck {...IC_SM} className="text-accent" /> : <span />}
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 truncate text-[13px] text-ink">
                      {m.name}
                      {offered?.defaultModel === m.model && <IconStarFilled size={11} className="shrink-0 text-accent" aria-label="default" />}
                      {m.reasoning && <IconBrain size={13} stroke={1.75} className="shrink-0 text-ink-3" aria-label="thinks" />}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-ink-3">{m.model}</span>
                  </span>
                  <span className="font-mono text-[11px] text-ink-3">{meta(m)}</span>
                </Command.Item>
              ))}
            </Command.Group>
          ))}
          {typed && (
            <Command.Item value={`__typed:${typed}`} onSelect={() => pick(typed)} className="grid min-h-11 cursor-pointer grid-cols-[16px_minmax(0,1fr)] items-center gap-x-2.5 rounded-lg px-2.5 data-[selected=true]:bg-s3">
              <IconPlus {...IC_SM} className="text-ink-3" />
              <span className="min-w-0">
                <span className="block truncate text-[13px]">Use {typed}</span>
                <span className="block text-[11px] text-ink-3">Not in the offered list</span>
              </span>
            </Command.Item>
          )}
          {!groups.length && !typed && <div className="px-2.5 py-3 text-[13px] text-ink-3">No offered model matches. Type provider/model to use any model.</div>}
        </Command.List>
        <button type="button" onClick={() => (setOpen(false), navigate("/models"))} className="shrink-0 cursor-pointer border-0 border-t border-line-2 bg-transparent px-3.5 py-2.5 text-left text-xs text-ink-3 hover:text-ink">
          Choose which models show here on the Models page
        </button>
      </Command>
    </Popover>
  );
}

// ---- thinking levels ----

const ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const sortLevels = (vs: string[]) => [...vs].sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));

export function ThinkingSelect({ model, value, onChange }: { model: string; value: string; onChange: (v: string) => void }) {
  const { variants, variantsError } = useModels();
  const [editing, setEditing] = useState(false);
  const levels = variants ? sortLevels(variants[model] ?? []) : null;
  // A level that isn't offered for this model (e.g. after switching models) falls back to the default.
  useEffect(() => {
    if (levels && value && !levels.includes(value)) onChange("");
  }, [model, levels?.join(",")]);

  const seg = "inline-flex h-[26px] cursor-pointer items-center rounded-[7px] px-2.5 font-mono text-xs text-ink-3 hover:text-ink aria-checked:bg-s3 aria-checked:text-ink";
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <div role="radiogroup" aria-label="Thinking level" className="inline-flex flex-wrap items-center rounded-[9px] border border-line-2 bg-s1 p-0.5">
        <button type="button" role="radio" aria-checked={!value} className={seg} onClick={() => onChange("")} title="Whatever opencode uses for this model by default">
          default
        </button>
        {levels?.map((l) => (
          <button key={l} type="button" role="radio" aria-checked={value === l} className={seg} onClick={() => onChange(l)}>
            {l}
          </button>
        ))}
        <button type="button" className={cn(seg, "gap-1 font-sans")} onClick={() => setEditing(true)} title="Make your own thinking levels for this model">
          <IconPlus {...IC_XS} />
          Custom
        </button>
      </div>
      {!levels && !variantsError && <span className="text-xs text-ink-4">checking this model's levels</span>}
      {variantsError && <span className="text-xs text-warning">couldn't ask opencode for levels: {variantsError}</span>}
      {levels && !levels.length && <span className="text-xs text-ink-3">No built-in levels; add your own with Custom</span>}
      {editing && <ThinkingEditor model={model} onClose={() => setEditing(false)} />}
    </div>
  );
}

const PRESETS: { label: string; hint: string; name: string; options: Record<string, unknown> }[] = [
  { label: "Effort: high", hint: "OpenAI and most OpenAI-compatible reasoning models", name: "high-effort", options: { reasoningEffort: "high" } },
  { label: "Effort: max", hint: "Coral Bricks and other servers that accept reasoning_effort max", name: "max-effort", options: { reasoningEffort: "max" } },
  { label: "Effort: low", hint: "faster, cheaper", name: "low-effort", options: { reasoningEffort: "low" } },
  { label: "Budget 32k", hint: "Claude / Anthropic API", name: "think32k", options: { thinking: { type: "enabled", budgetTokens: 32000 } } },
  { label: "Budget 8k", hint: "Claude / Anthropic API", name: "think8k", options: { thinking: { type: "enabled", budgetTokens: 8000 } } },
  { label: "Gemini budget 16k", hint: "Google models", name: "gem16k", options: { thinkingConfig: { thinkingBudget: 16000, includeThoughts: true } } },
  { label: "Thinking off", hint: "OpenAI-compatible servers that read enable_thinking (Qwen, GLM on vLLM/SGLang)", name: "no-think", options: { chat_template_kwargs: { enable_thinking: false } } },
];

/** Your own thinking levels for one model, stored in Settings and sent to every agent as opencode variants. */
function ThinkingEditor({ model, onClose }: { model: string; onClose: () => void }) {
  const [levels, setLevels] = useState<Record<string, Record<string, unknown>> | null>(null);
  const [all, setAll] = useState<Record<string, Record<string, Record<string, unknown>>>>({});
  const [name, setName] = useState("");
  const [json, setJson] = useState('{\n  "reasoningEffort": "high"\n}');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.settings().then((s) => {
      setAll(s.thinkingLevels ?? {});
      setLevels(s.thinkingLevels?.[model] ?? {});
    });
  }, [model]);

  const persist = async (next: Record<string, Record<string, unknown>>) => {
    const merged = { ...all, [model]: next };
    if (!Object.keys(next).length) delete merged[model];
    await api.saveSettings({ thinkingLevels: merged });
    setAll(merged);
    setLevels(next);
    refreshModels();
  };
  const add = async () => {
    let opts: unknown;
    try {
      opts = JSON.parse(json);
    } catch {
      setError("Options must be valid JSON");
      throw new Error("Options must be valid JSON");
    }
    if (!opts || typeof opts !== "object" || Array.isArray(opts)) {
      setError("Options must be a JSON object");
      throw new Error("Options must be a JSON object");
    }
    try {
      await persist({ ...(levels ?? {}), [name.trim()]: opts as Record<string, unknown> });
      setName("");
      setError(null);
    } catch (e: any) {
      setError(e.message);
      throw e;
    }
  };

  return (
    <Dialog
      onOpenChange={(o) => !o && onClose()}
      size="md"
      title="Custom thinking levels"
      description={<span className="font-mono text-xs">{model}</span>}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
          <Button variant="primary" disabled={!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name.trim())} onClick={add} done="Thinking level added">
            Add level
          </Button>
        </>
      }
    >
      <p className="m-0 text-[13px] text-ink-3">
        A level is a set of provider options opencode sends with every call when you pick it, next to the model's own levels. Try one in the live test before a long run: a provider may reject options it doesn't know.
      </p>
      <ErrorBox error={error} />
      {levels && Object.keys(levels).length > 0 && (
        <div className="overflow-hidden rounded-xl border border-line-2">
          {Object.entries(levels).map(([n, o]) => (
            <div key={n} className="flex items-center gap-3 border-t border-line-2 px-3 py-2 first:border-t-0">
              <span className="font-mono text-[12.5px] text-ink">{n}</span>
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink-3" title={JSON.stringify(o)}>
                {JSON.stringify(o)}
              </code>
              <Button
                size="xs"
                icon
                variant="ghost"
                aria-label={`Remove ${n}`}
                className="hover:enabled:text-critical"
                onClick={async () => {
                  const { [n]: _, ...rest } = levels;
                  await persist(rest);
                }}
                done={`${n} removed`}
              >
                <IconTrash {...IC_SM} />
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <Button
            key={p.label}
            size="xs"
            title={p.hint}
            onClick={() => {
              setName((n) => n || p.name);
              setJson(JSON.stringify(p.options, null, 2));
            }}
          >
            {p.label}
          </Button>
        ))}
      </div>
      <Field label="Name" hint="Shown in the thinking picker, e.g. deep or think32k.">
        <input className="input font-mono" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="deep" />
      </Field>
      <Field label="Provider options (JSON)" hint="Passed to the AI SDK provider as-is, the same as an opencode model variant.">
        <textarea className="input min-h-28 font-mono text-xs" value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
      </Field>
    </Dialog>
  );
}

/** Model + thinking together, for forms. */
export function ModelAndThinking({ model, variant, onModel, onVariant }: { model: string; variant: string; onModel: (m: string) => void; onVariant: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <ModelSelect value={model} onChange={onModel} />
      <ThinkingSelect model={model} value={variant} onChange={onVariant} />
    </div>
  );
}
