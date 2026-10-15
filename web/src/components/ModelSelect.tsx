/**
 * Model and thinking pickers shared by the new-run form, a run's controls and the live test:
 * a searchable model list grouped by provider, the model's thinking levels (opencode variants)
 * as a segmented control, and an editor for your own levels.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api, type OfferedModel } from "../lib/api.ts";
import { tokens } from "../lib/format.ts";
import { ProviderMark } from "./ProviderList.tsx";
import { Button, ErrorBox, Field } from "./ui.tsx";

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

function Meta({ m }: { m: OfferedModel }) {
  const p = price(m.costIn);
  return (
    <span className="ms-meta num">
      {m.context ? `${tokens(m.context)} ctx` : ""}
      {p ? `${m.context ? " · " : ""}${p === "free" ? "free" : `${p} / ${price(m.costOut)}`}` : ""}
    </span>
  );
}

// ---- model picker ----

export function ModelSelect({ value, onChange, compact }: { value: string; onChange: (model: string) => void; compact?: boolean }) {
  const { offered } = useModels();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = offered?.models ?? [];
  const cur = list.find((m) => m.model === value);
  const [pid] = value.split("/");

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => root.current && !root.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", down);
    return () => window.removeEventListener("mousedown", down);
  }, [open]);

  const q = query.trim().toLowerCase();
  const hits = list.filter((m) => !q || m.model.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || m.providerName.toLowerCase().includes(q));
  const typed = q.includes("/") && !list.some((m) => m.model === query.trim()) ? query.trim() : null;
  const rows: (OfferedModel | { model: string; typed: true })[] = [...hits, ...(typed ? [{ model: typed, typed: true as const }] : [])];
  const pick = (m: string) => {
    onChange(m);
    setOpen(false);
    setQuery("");
  };

  return (
    <div className={`ms ${compact ? "compact" : ""}`} ref={root}>
      <button type="button" className="ms-btn" onClick={() => (setOpen((o) => !o), setCursor(0))} aria-haspopup="listbox" aria-expanded={open}>
        <ProviderMark id={pid} name={cur?.providerName ?? pid} />
        <span className="ms-text">
          <span className="ms-name">
            {cur?.name ?? value.split("/").slice(1).join("/")}
            {offered?.defaultModel === value && <span className="ms-star"> ★</span>}
          </span>
          {!compact && <span className="ms-id">{value}</span>}
        </span>
        {!compact && cur && <Meta m={cur} />}
        <span className="ms-chev">▾</span>
      </button>
      {open && (
        <div className="ms-pop" role="listbox">
          <input
            className="input"
            autoFocus
            placeholder="Search models, or type provider/model"
            value={query}
            onChange={(e) => (setQuery(e.target.value), setCursor(0))}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") (e.preventDefault(), setCursor((c) => Math.min(rows.length - 1, c + 1)));
              else if (e.key === "ArrowUp") (e.preventDefault(), setCursor((c) => Math.max(0, c - 1)));
              else if (e.key === "Enter" && rows[cursor]) (e.preventDefault(), pick(rows[cursor].model));
              else if (e.key === "Escape") setOpen(false);
            }}
          />
          <div className="ms-list">
            {rows.map((m, i) => {
              const head = !("typed" in m) && (i === 0 || ("provider" in rows[i - 1] ? (rows[i - 1] as OfferedModel).provider : "") !== m.provider);
              return (
                <div key={m.model}>
                  {head && <div className="ms-group">{(m as OfferedModel).providerName}</div>}
                  <button type="button" role="option" aria-selected={m.model === value} className={`ms-row ${i === cursor ? "on" : ""} ${m.model === value ? "sel" : ""}`} onMouseEnter={() => setCursor(i)} onClick={() => pick(m.model)}>
                    {"typed" in m ? (
                      <span className="ms-text">
                        <span className="ms-name">Use “{m.model}”</span>
                        <span className="ms-id">not in the offered list</span>
                      </span>
                    ) : (
                      <>
                        <span className="ms-text">
                          <span className="ms-name">
                            {m.name}
                            {offered?.defaultModel === m.model && <span className="ms-star"> ★</span>}
                            {m.reasoning && <span className="badge" style={{ marginLeft: 6, fontSize: 10.5, padding: "0 5px" }}>thinks</span>}
                          </span>
                          <span className="ms-id">{m.model}</span>
                        </span>
                        <Meta m={m} />
                      </>
                    )}
                  </button>
                </div>
              );
            })}
            {!rows.length && <div className="ms-group">No offered model matches. Type provider/model to use any model.</div>}
          </div>
          <div className="ms-foot">
            <a href="/models">Choose which models show here on the Models page</a>
          </div>
        </div>
      )}
    </div>
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

  return (
    <div className="thinking">
      <div className="seg" role="radiogroup" aria-label="Thinking level">
        <button type="button" role="radio" aria-checked={!value} className={!value ? "on" : ""} onClick={() => onChange("")} title="Whatever opencode uses for this model by default">
          default
        </button>
        {levels?.map((l) => (
          <button key={l} type="button" role="radio" aria-checked={value === l} className={value === l ? "on" : ""} onClick={() => onChange(l)}>
            {l}
          </button>
        ))}
        <button type="button" className="add" onClick={() => setEditing(true)} title="Make your own thinking levels for this model">
          + custom
        </button>
      </div>
      {!levels && !variantsError && <span className="muted text-xs">checking this model's levels…</span>}
      {variantsError && <span className="text-xs" style={{ color: "var(--warn)" }}>couldn't ask opencode for levels: {variantsError}</span>}
      {levels && !levels.length && <span className="muted text-xs">no built-in levels for this model; add your own with + custom</span>}
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
  const [json, setJson] = useState("{\n  \"reasoningEffort\": \"high\"\n}");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.settings().then((s) => {
      setAll(s.thinkingLevels ?? {});
      setLevels(s.thinkingLevels?.[model] ?? {});
    });
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
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
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Custom thinking levels">
        <header>
          <h2>
            Custom thinking · <span className="mono" style={{ fontWeight: 400 }}>{model}</span>
          </h2>
          <button className="btn btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="body">
          <div className="text-sm muted">
            Each level is a set of provider options opencode sends with every model call when you pick it. They're added next to the model's own levels and reach every new agent. Test one in the live test before a long run: a provider may reject options it doesn't know.
          </div>
          <ErrorBox error={error} />
          {levels && Object.keys(levels).length > 0 && (
            <div className="flex flex-col gap-1.5">
              {Object.entries(levels).map(([n, o]) => (
                <div key={n} className="flex items-center gap-2">
                  <span className="badge mono">{n}</span>
                  <code className="mono muted min-w-0 flex-1 truncate text-xs" title={JSON.stringify(o)}>
                    {JSON.stringify(o)}
                  </code>
                  <Button
                    small
                    variant="danger"
                    onClick={async () => {
                      const { [n]: _, ...rest } = levels;
                      await persist(rest);
                    }}
                    done={`${n} removed`}
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-col gap-2">
            <span className="eyebrow">New level</span>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className="btn btn-sm"
                  title={p.hint}
                  onClick={() => {
                    setName((n) => n || p.name);
                    setJson(JSON.stringify(p.options, null, 2));
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <Field label="Name" hint="Shown in the thinking picker, e.g. deep or think32k.">
              <input className="input mono" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="deep" />
            </Field>
            <Field label="Provider options (JSON)" hint="Passed to the AI SDK provider as-is, the same as an opencode model variant.">
              <textarea className="input mono" style={{ minHeight: 110, fontSize: 12 } as CSSProperties} value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
            </Field>
          </div>
        </div>
        <footer>
          <button className="btn" onClick={onClose}>
            Done
          </button>
          <Button variant="primary" disabled={!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name.trim())} onClick={add} done="Thinking level added">
            Add level
          </Button>
        </footer>
      </div>
    </div>
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

