/** Quick text-only speed test in a dialog: the same prose prompt to each picked model, one after another. */
import { useMemo, useState } from "react";
import { IconLoader2, IconPlus, IconX } from "@tabler/icons-react";
import { api } from "../../lib/api.ts";
import { useAsync, useThrottled } from "../../lib/hooks.ts";
import { useLive } from "../../lib/live.ts";
import { ago } from "../../lib/format.ts";
import { cn } from "../../lib/cn.ts";
import type { SpeedTestRow } from "../../lib/types.ts";
import { Button, ErrorBox } from "../../components/ui.tsx";
import { IC_SM, IC_XS, Join, Nil } from "../../components/ui/bits.tsx";
import { Dialog } from "../../components/ui/overlay.tsx";
import { toast } from "../../components/Toast.tsx";
import { ms } from "./common.tsx";

const keyOf = (r: SpeedTestRow) => `${r.provider}/${r.model}`;
const MAX = 12;

function Bar({ value, max, className }: { value: number; max: number; className: string }) {
  return (
    <span className="block h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-s3">
      <i className={cn("block h-full rounded-full", className)} style={{ width: `${Math.max(2, (value / max) * 100)}%` }} />
    </span>
  );
}

export function SpeedTestDialog({ onClose }: { onClose: () => void }) {
  const tests = useAsync(() => api.speedTests(), []);
  const settings = useAsync(() => api.settings(), []);
  const board = useAsync(() => api.leaderboard(), []);
  const health = useAsync(() => api.providerHealth(360), []);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [extra, setExtra] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [showAll, setShowAll] = useState(false);
  const reload = useThrottled(() => void tests.reload(), 500);

  useLive("*", (m) => {
    if (m.type !== "speedtest") return;
    if (m.data?.current) tests.setData((d) => (d ? { ...d, running: m.data.batch, current: m.data.current } : d));
    else reload();
  });

  const results = tests.data?.results ?? [];
  const running = tests.data?.running ?? null;

  // Models worth offering: your configured ones, everything that has run, and earlier tests that worked.
  const known = useMemo(() => {
    const s = new Set<string>([...(settings.data?.models ?? []), ...(board.data ?? []).map((m) => m.model), ...(health.data ?? []).map((h) => h.key), ...results.filter((r) => r.ok).map(keyOf), ...extra]);
    return [...s].filter((m) => m.includes("/")).sort();
  }, [settings.data, board.data, health.data, results, extra]);
  const selected = picked ?? new Set(settings.data?.models ?? []);
  const toggle = (m: string) => {
    const s = new Set(selected);
    s.has(m) ? s.delete(m) : s.add(m);
    setPicked(s);
  };
  const add = () => {
    const m = input.trim();
    if (!m.includes("/")) return toast("Use provider/model, e.g. opencode/big-pickle", "error");
    if (!known.includes(m)) setExtra((x) => [...x, m]);
    setPicked(new Set([...selected, m]));
    setInput("");
  };
  const start = async () => {
    try {
      const r = await api.startSpeedTest([...selected]);
      tests.setData((d) => ({ results: d?.results ?? [], running: r.batch, models: r.models, current: null }));
    } catch (e: any) {
      toast(e.message ?? String(e), "error");
    }
  };

  // The batch to show: the running one, else the latest.
  const batch = running ?? results[0]?.batch ?? null;
  const batchRows = results.filter((r) => r.batch === batch);
  const queue = running ? (tests.data?.models.length ? tests.data.models : [...new Set([...batchRows.map(keyOf), tests.data?.current ?? ""])].filter(Boolean)) : batchRows.map(keyOf);
  const rowFor = (m: string) => batchRows.find((r) => keyOf(r) === m);
  const ordered = running ? queue : [...queue].sort((a, b) => (rowFor(b)?.tps ?? -1) - (rowFor(a)?.tps ?? -1));
  const maxTps = Math.max(1, ...batchRows.map((r) => r.tps ?? 0));
  const maxTtft = Math.max(1, ...batchRows.map((r) => r.ttft_ms ?? 0));
  const older = results.filter((r) => r.batch !== batch);

  return (
    <Dialog onOpenChange={(o) => !o && onClose()} title="Speed test" description="The same 250-word prose prompt to each model, text only, one sample each.">
      <ErrorBox error={tests.error} />

      <div className="flex flex-wrap items-center gap-1.5">
        {known.map((m) => {
          const on = selected.has(m);
          return (
            <span key={m} className={cn("inline-flex h-[26px] items-center rounded-md border font-mono text-xs", on ? "border-line bg-s3 text-ink" : "border-line-2 text-ink-3")}>
              <button type="button" aria-pressed={on} onClick={() => toggle(m)} className="h-full cursor-pointer border-0 bg-transparent px-2 text-inherit">
                {m}
              </button>
              {extra.includes(m) && (
                <button type="button" aria-label={`Remove ${m}`} onClick={() => setExtra((x) => x.filter((y) => y !== m))} className="mr-1 inline-flex cursor-pointer border-0 bg-transparent p-0.5 text-ink-3 hover:text-ink">
                  <IconX {...IC_XS} />
                </button>
              )}
            </span>
          );
        })}
        <form
          className="inline-flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input className="input h-[26px] w-48 py-0 font-mono text-xs" placeholder="provider/model" value={input} onChange={(e) => setInput(e.target.value)} aria-label="Add a model" />
          <Button size="xs" icon type="submit" aria-label="Add" disabled={!input.trim()}>
            <IconPlus {...IC_XS} />
          </Button>
        </form>
      </div>
      <div className="flex items-center gap-3">
        <Button size="sm" variant="primary" disabled={!!running || !selected.size || selected.size > MAX} onClick={start}>
          {running ? <IconLoader2 {...IC_SM} className="animate-spin" /> : null}
          {running ? "Testing" : `Test ${selected.size} model${selected.size === 1 ? "" : "s"}`}
        </Button>
        {selected.size > MAX && <span className="text-xs text-warning">At most {MAX} models per test</span>}
        {batchRows[0] && !running && <span className="ml-auto text-xs text-ink-3">Last test {ago(batchRows[0].ts)}</span>}
      </div>

      {queue.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-line-2">
          <div className="min-w-[640px]">
            <div className="grid h-[34px] grid-cols-[minmax(200px,1.2fr)_minmax(0,1fr)_minmax(0,0.8fr)_64px] items-center gap-4 border-b border-line-2 px-3 text-xs text-ink-3">
              <span>Model</span>
              <span>Output tok/s</span>
              <span>First token</span>
              <span className="text-right">Total</span>
            </div>
            {ordered.map((m) => {
              const r = rowFor(m);
              const now = running && tests.data?.current === m;
              return (
                <div key={m} className="grid min-h-11 grid-cols-[minmax(200px,1.2fr)_minmax(0,1fr)_minmax(0,0.8fr)_64px] items-center gap-4 border-t border-line-2 px-3 py-1.5 first-of-type:border-t-0">
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 font-mono text-[12.5px]">
                      {now ? <IconLoader2 {...IC_XS} className="shrink-0 animate-spin text-ink-3" /> : <i className={cn("size-1.5 shrink-0 rounded-full", r ? (r.ok ? "bg-good" : "bg-critical") : "bg-ink-4")} />}
                      <span className="truncate">{m}</span>
                    </span>
                    {r?.error && (
                      <span className="block truncate pl-3.5 text-xs text-critical" title={r.error}>
                        {r.error}
                      </span>
                    )}
                  </span>
                  {r?.ok ? (
                    <>
                      <span className="flex items-center gap-2.5">
                        <Bar value={r.tps ?? 0} max={maxTps} className="bg-[var(--accent-c)]" />
                        <span className="w-9 text-right font-mono text-xs tabular-nums">{r.tps == null ? <Nil /> : Math.round(r.tps)}</span>
                      </span>
                      <span className="flex items-center gap-2.5">
                        <Bar value={r.ttft_ms ?? 0} max={maxTtft} className="bg-ink-3" />
                        <span className="w-14 text-right font-mono text-xs text-ink-2 tabular-nums">{ms(r.ttft_ms)}</span>
                      </span>
                      <span className="text-right font-mono text-xs text-ink-2 tabular-nums">{ms(r.total_ms)}</span>
                    </>
                  ) : (
                    <span className="col-span-3 text-xs text-ink-4">{now ? "waiting for the answer" : r ? "" : "queued"}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {older.length > 0 && (
        <div>
          <div className="mb-1.5 flex items-center text-xs text-ink-3">
            Earlier
            {older.length > 6 && (
              <button type="button" className="ml-auto cursor-pointer border-0 bg-transparent p-0 text-xs text-ink-3 hover:text-ink" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show fewer" : `Show all ${older.length}`}
              </button>
            )}
          </div>
          {(showAll ? older : older.slice(0, 6)).map((r) => (
            <div key={r.id} className="grid grid-cols-[90px_minmax(0,1fr)_auto] items-center gap-3 border-t border-line-2 py-1.5 font-mono text-xs">
              <span className="text-ink-3">{ago(r.ts)}</span>
              <span className="truncate text-ink-2">{keyOf(r)}</span>
              {r.ok ? (
                <span className="text-ink-2 tabular-nums">
                  <Join items={[r.tps == null ? "" : `${Math.round(r.tps)} tok/s`, ms(r.ttft_ms)]} />
                </span>
              ) : (
                <span className="max-w-60 truncate text-critical" title={r.error ?? ""}>
                  {r.error}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
