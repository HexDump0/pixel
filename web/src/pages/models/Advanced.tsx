/**
 * Settings changed by hand for one model (context, prices, capabilities, request options, headers) or one
 * provider (timeouts, options, headers). Empty fields keep what the catalogue says; Pixel writes the rest
 * into opencode's config for new runs, live tests, and running runs when their opencode next restarts.
 */
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api.ts";
import { keys } from "../../lib/query.ts";
import { cn } from "../../lib/cn.ts";
import type { CatalogModel, ConnectedProvider, Settings } from "../../lib/types.ts";
import { Button, ErrorBox, Segmented } from "../../components/ui.tsx";
import { Dialog } from "../../components/ui/overlay.tsx";
import { EnvEditor } from "../settings/parts.tsx";
import { splitModel } from "./common.tsx";

type ModelOverride = Settings["modelOverrides"][string];
type ProviderOverride = Settings["providerOverrides"][string];
type Flag = "reasoning" | "tool_call" | "attachment" | "temperature";

/** 200000 as "200k", 1048576 as "1.05M": short enough for a placeholder or a summary. */
export const shortTokens = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n));

/** "128k", "1m", "200000" to a number; "" to undefined; anything else to NaN. */
function parseTokens(s: string) {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*([km])?$/i);
  if (!s.trim()) return undefined;
  if (!m) return NaN;
  return Math.round(Number(m[1]) * (m[2]?.toLowerCase() === "k" ? 1e3 : m[2]?.toLowerCase() === "m" ? 1e6 : 1));
}
function parseNumber(s: string) {
  if (!s.trim()) return undefined;
  const n = Number(s.trim());
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}
function parseJson(s: string, what: string) {
  if (!s.trim()) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    throw new Error(`${what} is not valid JSON`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} must be a JSON object, like {"temperature": 0.6}`);
  return Object.keys(v).length ? (v as Record<string, unknown>) : undefined;
}
const cleanHeaders = (h: Record<string, string>) => {
  const out = Object.fromEntries(Object.entries(h).filter(([k]) => k.trim()));
  return Object.keys(out).length ? out : undefined;
};
const json = (v: unknown) => (v ? JSON.stringify(v, null, 2) : "");

/** What a model override changes, in a few words (for the marks on the Models page). */
export function describeOverride(o: ModelOverride | undefined): string[] {
  if (!o) return [];
  const out: string[] = [];
  if (o.context) out.push(`context ${shortTokens(o.context)}`);
  if (o.output) out.push(`output ${shortTokens(o.output)}`);
  if (o.input) out.push(`input ${shortTokens(o.input)}`);
  if (o.cost && Object.values(o.cost).some((x) => x !== undefined)) out.push("prices");
  const flags: [Flag, string][] = [
    ["reasoning", "reasoning"],
    ["tool_call", "tool calling"],
    ["attachment", "files"],
    ["temperature", "temperature"],
  ];
  for (const [f, word] of flags) if (o[f] !== undefined) out.push(`${word} ${o[f] ? "on" : "off"}`);
  if (o.options) out.push(`options ${Object.keys(o.options).join(", ")}`);
  if (o.headers) out.push(`${Object.keys(o.headers).length === 1 ? "1 header" : `${Object.keys(o.headers).length} headers`}`);
  return out;
}

const APPLIES = "For new runs and live tests. Running runs pick it up when their opencode next restarts (resume, continue, or a message while idle).";

function Group({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2.5 border-0 border-t border-line-2 p-0 pt-4 first-of-type:border-t-0 first-of-type:pt-0">
      <legend className="float-left mb-0.5 w-full p-0">
        <span className="block text-[13px] font-medium text-ink">{title}</span>
        {hint && <span className="mt-0.5 block text-xs leading-relaxed text-ink-3">{hint}</span>}
      </legend>
      {children}
    </fieldset>
  );
}

/** A text field for a number, with the catalogue's value as the placeholder and a unit after it. */
function Num({ label, value, onChange, placeholder, unit, bad }: { label: string; value: string; onChange: (v: string) => void; placeholder: string; unit?: string; bad?: boolean }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-[12.5px] text-ink-2">
      {label}
      <span className={cn("input flex items-center gap-2 focus-within:border-accent/65 focus-within:shadow-[0_0_0_3px_var(--accent-soft)]", bad && "border-critical/60")}>
        <input inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label} className="w-full min-w-0 bg-transparent font-mono tabular-nums outline-none placeholder:text-ink-4" />
        {unit && <span className="shrink-0 text-xs text-ink-3">{unit}</span>}
      </span>
    </label>
  );
}

function FlagRow({ label, hint, value, onChange, base }: { label: string; hint: string; value: boolean | undefined; onChange: (v: boolean | undefined) => void; base: boolean | null }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-[13px]">{label}</div>
        <div className="text-xs text-ink-3">{hint}</div>
      </div>
      <Segmented
        label={label}
        value={value === undefined ? "default" : value ? "on" : "off"}
        onChange={(v) => onChange(v === "default" ? undefined : v === "on")}
        options={[
          ["default", base == null ? "Default" : `Default, ${base ? "on" : "off"}`],
          ["on", "On"],
          ["off", "Off"],
        ]}
      />
    </div>
  );
}

export function ModelAdvancedDialog({ model, settings, provider, onSave, onClose }: { model: string; settings: Settings; provider?: ConnectedProvider; onSave: (o: ModelOverride | null) => Promise<void>; onClose: () => void }) {
  const [pid, mid] = splitModel(model);
  const cat = useQuery({ queryKey: keys.catalogProvider(pid), queryFn: () => api.catalogProvider(pid).catch(() => null), staleTime: 10 * 60_000 });
  const own = provider?.customModels?.find((m) => m.id === mid);
  const c: Partial<CatalogModel> = cat.data?.models.find((m) => m.id === mid) ?? (own ? { context: own.context, output: own.output, reasoning: own.reasoning, tools: true } : {});
  const o = settings.modelOverrides?.[model];
  const [f, setF] = useState({
    context: o?.context ? String(o.context) : "",
    output: o?.output ? String(o.output) : "",
    input: o?.input ? String(o.input) : "",
    costIn: o?.cost?.input?.toString() ?? "",
    costOut: o?.cost?.output?.toString() ?? "",
    cacheRead: o?.cost?.cache_read?.toString() ?? "",
    cacheWrite: o?.cost?.cache_write?.toString() ?? "",
    options: json(o?.options),
  });
  const [flags, setFlags] = useState<Partial<Record<Flag, boolean>>>({ reasoning: o?.reasoning, tool_call: o?.tool_call, attachment: o?.attachment, temperature: o?.temperature });
  const [headers, setHeaders] = useState<Record<string, string>>(o?.headers ?? {});
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });

  const nums = { context: parseTokens(f.context), output: parseTokens(f.output), input: parseTokens(f.input), costIn: parseNumber(f.costIn), costOut: parseNumber(f.costOut), cacheRead: parseNumber(f.cacheRead), cacheWrite: parseNumber(f.cacheWrite) };
  const bad = (k: keyof typeof nums) => Number.isNaN(nums[k]);
  const context = nums.context ?? c.context ?? null;
  const output = nums.output ?? c.output ?? null;

  const build = (): ModelOverride | null => {
    if (Object.values(nums).some((n) => Number.isNaN(n))) throw new Error("Some numbers aren't valid: tokens like 128000 or 128k, prices like 0.25");
    if (context && output && output > context) throw new Error("Max output can't be more than the context window");
    const cost = { input: nums.costIn, output: nums.costOut, cache_read: nums.cacheRead, cache_write: nums.cacheWrite };
    const out: ModelOverride = {
      ...(nums.context !== undefined && { context: nums.context }),
      ...(nums.output !== undefined && { output: nums.output }),
      ...(nums.input !== undefined && { input: nums.input }),
      ...(Object.values(cost).some((x) => x !== undefined) && { cost: Object.fromEntries(Object.entries(cost).filter(([, x]) => x !== undefined)) }),
      ...Object.fromEntries(Object.entries(flags).filter(([, x]) => x !== undefined)),
      ...(parseJson(f.options, "Options") && { options: parseJson(f.options, "Options") }),
      ...(cleanHeaders(headers) && { headers: cleanHeaders(headers) }),
    };
    return Object.keys(out).length ? out : null;
  };
  const save = async () => {
    try {
      await onSave(build());
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <Dialog
      onOpenChange={(open) => !open && onClose()}
      size="md"
      title="Advanced settings"
      description={
        <>
          <span className="font-mono text-ink-2">{mid}</span> from {provider?.name ?? cat.data?.name ?? pid}. Empty fields keep the catalogue's value.
        </>
      }
      footer={
        <>
          {o && (
            <Button variant="ghost" className="mr-auto text-ink-3" onClick={() => onSave(null)} done="Back to the catalogue's values">
              Reset all
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} done="Model settings saved">
            Save
          </Button>
        </>
      }
    >
      <ErrorBox error={error} />
      <Group title="Limits" hint="opencode compacts the conversation as it nears the context window, and asks for at most the max output per reply. Tokens; 128k and 1m work too.">
        <div className="grid grid-cols-3 gap-2.5 max-sm:grid-cols-1">
          <Num label="Context window" value={f.context} onChange={set("context")} placeholder={c.context ? shortTokens(c.context) : "128k"} unit="tokens" bad={bad("context")} />
          <Num label="Max output" value={f.output} onChange={set("output")} placeholder={c.output ? shortTokens(c.output) : context ? shortTokens(Math.min(32_000, Math.floor(context / 4))) : "32k"} unit="tokens" bad={bad("output")} />
          <Num label="Max input" value={f.input} onChange={set("input")} placeholder="none" unit="tokens" bad={bad("input")} />
        </div>
      </Group>
      <Group title="Prices" hint="USD per million tokens. Spend on the Wall and in Stats comes from these, so fix them for a discount or a self-hosted model.">
        <div className="grid grid-cols-4 gap-2.5 max-sm:grid-cols-2">
          <Num label="Input" value={f.costIn} onChange={set("costIn")} placeholder={c.costIn != null ? String(c.costIn) : "0"} bad={bad("costIn")} />
          <Num label="Output" value={f.costOut} onChange={set("costOut")} placeholder={c.costOut != null ? String(c.costOut) : "0"} bad={bad("costOut")} />
          <Num label="Cache read" value={f.cacheRead} onChange={set("cacheRead")} placeholder={c.costCacheRead != null ? String(c.costCacheRead) : "none"} bad={bad("cacheRead")} />
          <Num label="Cache write" value={f.cacheWrite} onChange={set("cacheWrite")} placeholder="none" bad={bad("cacheWrite")} />
        </div>
      </Group>
      <Group title="Capabilities">
        <FlagRow label="Reasoning" hint="Thinking levels and reasoning output" value={flags.reasoning} base={c.reasoning ?? null} onChange={(v) => setFlags({ ...flags, reasoning: v })} />
        <FlagRow label="Tool calling" hint="Agents need it to read files and run commands" value={flags.tool_call} base={c.tools ?? null} onChange={(v) => setFlags({ ...flags, tool_call: v })} />
        <FlagRow label="Images and files" hint="Attachments in the prompt" value={flags.attachment} base={null} onChange={(v) => setFlags({ ...flags, attachment: v })} />
        <FlagRow label="Temperature" hint="Whether opencode may send one" value={flags.temperature} base={null} onChange={(v) => setFlags({ ...flags, temperature: v })} />
      </Group>
      <Group
        title="Request options"
        hint={
          <>
            Sent with every request to this model, as opencode model options. On OpenAI-compatible servers they land in the request body, for example{" "}
            <span className="font-mono text-ink-2">{'{"temperature": 0.6, "top_p": 0.95}'}</span>.
          </>
        }
      >
        <textarea className="input h-24 w-full font-mono text-xs" spellCheck={false} aria-label="Request options" placeholder="{ }" value={f.options} onChange={(e) => set("options")(e.target.value)} />
      </Group>
      <Group title="Headers" hint="Extra HTTP headers on every request to this model.">
        <EnvEditor value={headers} onChange={setHeaders} header secret={false} placeholder="X-Header" add="Add header" />
      </Group>
      <p className="m-0 text-xs text-ink-3">{APPLIES}</p>
    </Dialog>
  );
}

const SECONDS: [keyof Pick<ProviderOverride, "timeout" | "headerTimeout" | "chunkTimeout">, string, string, string][] = [
  ["timeout", "Whole request", "none", "Longest a request may take from start to end"],
  ["headerTimeout", "First response", "300", "Wait for the server to start answering"],
  ["chunkTimeout", "Between chunks", "300", "Longest pause while streaming"],
];

export function ProviderAdvancedDialog({ provider, settings, onSave, onClose }: { provider: ConnectedProvider; settings: Settings; onSave: (o: ProviderOverride | null) => Promise<void>; onClose: () => void }) {
  const o = settings.providerOverrides?.[provider.id];
  const [t, setT] = useState<Record<string, string>>(() => Object.fromEntries(SECONDS.map(([k]) => [k, o?.[k] === undefined ? "" : String(o[k]! / 1000)])));
  const [options, setOptions] = useState(json(o?.options));
  const [headers, setHeaders] = useState<Record<string, string>>(o?.headers ?? {});
  const [error, setError] = useState<string | null>(null);
  const models = Object.keys(settings.modelOverrides ?? {}).filter((m) => m.startsWith(`${provider.id}/`)).length;

  const save = async () => {
    try {
      const out: ProviderOverride = {};
      for (const [k, label] of SECONDS) {
        const n = parseNumber(t[k]);
        if (Number.isNaN(n)) throw new Error(`${label}: seconds, or 0 for no timeout`);
        if (n !== undefined) out[k] = Math.round(n * 1000);
      }
      const opts = parseJson(options, "Options");
      if (opts) out.options = opts;
      if (cleanHeaders(headers)) out.headers = cleanHeaders(headers);
      await onSave(Object.keys(out).length ? out : null);
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <Dialog
      onOpenChange={(open) => !open && onClose()}
      size="md"
      title="Advanced settings"
      description={
        <>
          {provider.name}, for all its models{models > 0 && <>; {models === 1 ? "1 model has" : `${models} models have`} its own settings too</>}.
        </>
      }
      footer={
        <>
          {o && (
            <Button variant="ghost" className="mr-auto text-ink-3" onClick={() => onSave(null)} done="Back to opencode's defaults">
              Reset all
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} done="Provider settings saved">
            Save
          </Button>
        </>
      }
    >
      <ErrorBox error={error} />
      <Group title="Timeouts" hint="Seconds. Empty keeps opencode's default, 0 turns it off. Slow local models and long reasoning may need more.">
        <div className="grid grid-cols-3 gap-2.5 max-sm:grid-cols-1">
          {SECONDS.map(([k, label, def, hint]) => (
            <div key={k} title={hint}>
              <Num label={label} value={t[k]} onChange={(v) => setT({ ...t, [k]: v })} placeholder={def} unit="s" bad={Number.isNaN(parseNumber(t[k]))} />
            </div>
          ))}
        </div>
      </Group>
      <Group
        title="Provider options"
        hint={
          <>
            Extra opencode provider options, passed to the AI SDK when it connects, like <span className="font-mono text-ink-2">{'{"setCacheKey": true}'}</span>. The base URL and keys are set when you edit the provider.
          </>
        }
      >
        <textarea className="input h-24 w-full font-mono text-xs" spellCheck={false} aria-label="Provider options" placeholder="{ }" value={options} onChange={(e) => setOptions(e.target.value)} />
      </Group>
      <Group title="Headers" hint="Extra HTTP headers on every request to this provider.">
        <EnvEditor value={headers} onChange={setHeaders} header secret={false} placeholder="X-Header" add="Add header" />
      </Group>
      <p className="m-0 text-xs text-ink-3">{APPLIES}</p>
    </Dialog>
  );
}
