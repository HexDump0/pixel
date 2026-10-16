/**
 * The Wall (Runs page, `/`): the fleet row on top, a sticky toolbar to filter and sort, live runs as tiles
 * (or a table with bulk actions), finished runs as rows.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { IconArrowDown, IconBrain, IconFilterOff, IconLayoutGrid, IconListDetails, IconMessage, IconPlayerPause, IconPlayerPlay, IconPlayerStop, IconSearch, IconX } from "@tabler/icons-react";
import { useRuns, isFinished, isLive } from "../../lib/runs.ts";
import { useFleet, rate, runName } from "../../lib/fleet.ts";
import { useFindings, isOpen } from "../../lib/findings.ts";
import { health, needsYou, useLimits } from "../../lib/health.ts";
import { useLastLooked, useSeenRuns, seenAt } from "../../lib/seen.ts";
import { usePref } from "../../lib/prefs.ts";
import { useTick } from "../../lib/hooks.ts";
import { act, canPause, canResume, openRun } from "../../lib/actions.ts";
import { navigate } from "../../lib/router.tsx";
import { cn } from "../../lib/cn.ts";
import { ErrorBox, Button, buttonClass } from "../../components/ui.tsx";
import { IC_SM, Kbd, Nothing } from "../../components/ui/bits.tsx";
import { Dialog, Select } from "../../components/ui/overlay.tsx";
import { openCatchUp } from "../../components/CatchUp.tsx";
import { openPalette } from "../../components/CommandPalette.tsx";
import { toast } from "../../components/Toast.tsx";
import { FindingsTable } from "../findings/FindingsTable.tsx";
import { FleetRow } from "./FleetRow.tsx";
import { buildView, FinishedRow, LIST_COLS, ListRow, Tile, type RunView } from "./RunCards.tsx";

type FilterId = "all" | "running" | "needs" | "triage" | "finished";
const FILTERS: { id: FilterId; label: string; match: (v: RunView) => boolean }[] = [
  { id: "all", label: "All", match: () => true },
  { id: "running", label: "Running", match: (v) => isLive(v.run) && !needsYou(v.h) },
  { id: "needs", label: "Needs you", match: (v) => needsYou(v.h) },
  { id: "triage", label: "To triage", match: (v) => v.findings.some(isOpen) },
  { id: "finished", label: "Finished", match: (v) => isFinished(v.run) },
];
const SORTS: Record<string, { label: string; cmp: (a: RunView, b: RunView) => number }> = {
  started: { label: "Started", cmp: (a, b) => (a.run.started_at ?? a.run.created_at) - (b.run.started_at ?? b.run.created_at) },
  activity: { label: "Activity", cmp: (a, b) => (b.fleet ? rate(b.fleet.tps) : 0) - (a.fleet ? rate(a.fleet.tps) : 0) || (b.run.last_activity ?? 0) - (a.run.last_activity ?? 0) },
  cost: { label: "Cost", cmp: (a, b) => b.run.cost - a.run.cost },
  name: { label: "Name", cmp: (a, b) => runName(a.run).localeCompare(runName(b.run)) },
};
const onWall = (v: RunView) => !isFinished(v.run);

export function Wall() {
  useTick(10_000);
  const { runs, error } = useRuns();
  const snap = useFleet();
  const findings = useFindings() ?? [];
  const limits = useLimits();
  const seenRuns = useSeenRuns();
  const [lastLooked] = useLastLooked();
  // Opens on Running every time; the filter isn't remembered.
  const [filter, setFilter] = useState<FilterId>("running");
  const [sort, setSort] = usePref<string>("wall.sort", "started");
  const [layout, setLayout] = usePref<"tiles" | "list">("wall.layout", "tiles");
  const [q, setQ] = useState("");
  const [model, setModel] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulkMsg, setBulkMsg] = useState(false);
  const qRef = useRef<HTMLInputElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);

  const views = useMemo(
    () => (runs ?? []).map((r) => buildView(r, snap?.runs.find((f) => f.id === r.id), health(r, snap?.runs.find((f) => f.id === r.id), limits), findings, seenAt(seenRuns[r.id], lastLooked))),
    [runs, snap, findings, limits, seenRuns, lastLooked],
  );
  const textMatch = (v: RunView) => !q || `${runName(v.run)} ${v.run.id} ${v.run.repo} ${v.run.template_id}`.toLowerCase().includes(q.toLowerCase());
  const match = FILTERS.find((f) => f.id === filter)?.match ?? (() => true);
  const shown = views.filter(match).filter((v) => textMatch(v) && (!model || v.run.model === model)).sort(SORTS[sort]?.cmp ?? SORTS.started.cmp);
  const models = [...new Set(views.map((v) => v.run.model))];
  const live = shown.filter(onWall);
  const fin = shown.filter((v) => !onWall(v));
  const order = layout === "list" ? shown : [...live, ...fin];

  const chooseFilter = (f: FilterId) => {
    setFilter(f);
    toolbar.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const clear = () => (setFilter("all"), setQ(""), setModel(""));

  // Keys: / filter, 1–5 filters, arrows / j k move, Enter open, m message, n new run, f findings, x select.
  useEffect(() => {
    const cols = () => {
      const tiles = [...document.querySelectorAll<HTMLElement>("[data-tiles] [data-run]")];
      if (tiles.length < 2) return 1;
      return tiles.filter((t) => t.offsetTop === tiles[0].offsetTop).length;
    };
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest("input, textarea, select, [role=dialog], [role=menu]")) return;
      if (e.key === "/") return (e.preventDefault(), qRef.current?.focus(), qRef.current?.select());
      if (/^[1-5]$/.test(e.key)) return (e.preventDefault(), chooseFilter(FILTERS[+e.key - 1].id));
      if (e.key === "n") return (e.preventDefault(), navigate("/new"));
      if (e.key === "f") return (e.preventDefault(), navigate("/findings"));
      const ids = order.map((v) => v.run.id);
      const i = ids.indexOf(sel ?? "");
      const tileMode = layout === "tiles" && (i < 0 || i < live.length);
      const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: tileMode ? cols() : 1, ArrowUp: tileMode ? -cols() : -1, j: 1, k: -1 }[e.key];
      if (step && ids.length) {
        e.preventDefault();
        const next = ids[Math.max(0, Math.min(ids.length - 1, i < 0 ? 0 : i + step))];
        setSel(next);
        document.querySelector<HTMLElement>(`[data-wall] [data-run="${CSS.escape(next)}"]`)?.focus();
        return;
      }
      if (e.key === "Enter" && sel) return (e.preventDefault(), openRun(sel));
      if (e.key === "m" && sel) return (e.preventDefault(), openPalette(sel));
      if (e.key === "x" && sel && layout === "list") {
        e.preventDefault();
        setPicked((p) => {
          const n = new Set(p);
          n.has(sel) ? n.delete(sel) : n.add(sel);
          return n;
        });
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  const pickedRuns = views.filter((v) => picked.has(v.run.id)).map((v) => v.run);
  const bulk = (fn: (r: (typeof pickedRuns)[number]) => unknown, ok: (r: (typeof pickedRuns)[number]) => boolean) => {
    pickedRuns.filter(ok).forEach(fn);
    setPicked(new Set());
  };

  return (
    <main className="gut pt-2 pb-24" data-wall>
      <FleetRow snap={snap} runs={runs ?? []} findings={findings} onTriage={() => chooseFilter("triage")} onCatchUp={openCatchUp} />

      <div ref={toolbar} role="toolbar" aria-label="Filter and sort runs" className="sticky top-[60px] z-20 -mx-2 mt-6 mb-3 flex scroll-mt-[72px] flex-wrap items-center gap-x-4 gap-y-2.5 rounded-[14px] bg-bg/90 p-2 backdrop-blur-md">
        <div role="tablist" aria-label="Show" className="flex gap-0.5 overflow-x-auto rounded-[11px] border border-line-2 bg-s1 p-[3px] [scrollbar-width:none]">
          {FILTERS.map((f, i) => {
            const n = views.filter(f.match).length;
            return (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={filter === f.id}
                title={`${f.label} (${i + 1})`}
                onClick={() => chooseFilter(f.id)}
                className="group inline-flex h-[30px] items-center gap-[7px] rounded-lg px-3 text-[13px] font-[450] whitespace-nowrap text-ink-3 hover:text-ink aria-selected:bg-s3 aria-selected:text-ink"
              >
                {f.label}
                <span className={cn("font-mono text-[11.5px] font-medium text-ink-4 group-aria-selected:text-ink-2", f.id === "needs" && n > 0 && "text-warning group-aria-selected:text-warning")}>{n}</span>
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2 max-md:w-full">
          <label className="inline-flex h-[34px] w-[220px] items-center gap-2 rounded-[10px] border border-line-2 bg-s1 pr-2 pl-2.5 text-ink-3 focus-within:border-ink-4 max-md:flex-1">
            <IconSearch {...IC_SM} />
            <input
              ref={qRef}
              type="search"
              value={q}
              placeholder="Filter"
              aria-label="Filter runs by name, repo or template"
              autoComplete="off"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && (setQ(""), e.currentTarget.blur())}
              className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-ink outline-none [&::-webkit-search-cancel-button]:hidden"
            />
            <Kbd>/</Kbd>
          </label>
          <Select className="max-md:hidden" icon={<IconBrain {...IC_SM} />} label="Model" value={model} onChange={setModel} options={[["", "All models"], ...models.map((m) => [m, m.split("/").slice(1).join("/").replace(/^claude-/, "")] as [string, string])]} />
          <Select className="max-md:hidden" icon={<IconArrowDown {...IC_SM} />} label="Sort by" value={sort} onChange={setSort} options={Object.entries(SORTS).map(([k, s]) => [k, s.label])} />
          <div role="group" aria-label="Layout" className="inline-flex h-[34px] items-center rounded-[10px] border border-line-2 bg-s1 p-0.5">
            {(
              [
                ["tiles", "Tiles", IconLayoutGrid],
                ["list", "List", IconListDetails],
              ] as const
            ).map(([id, label, Icon]) => (
              <button key={id} type="button" title={label} aria-pressed={layout === id} onClick={() => setLayout(id)} className="inline-flex h-7 w-8 items-center justify-center rounded-lg text-ink-3 aria-pressed:bg-s3 aria-pressed:text-ink">
                <Icon {...IC_SM} />
              </button>
            ))}
          </div>
        </div>
      </div>

      <ErrorBox error={error} />

      {runs && !runs.length ? (
        <Nothing>
          No runs yet.
          <button type="button" className={buttonClass("primary", "sm")} onClick={() => navigate("/new")}>
            Start one
          </button>
        </Nothing>
      ) : runs && !shown.length ? (
        <Nothing>
          <IconFilterOff {...IC_SM} />
          Nothing matches.
          <button type="button" onClick={clear} className="cursor-pointer border-0 bg-transparent p-0 text-ink-3 hover:text-ink hover:underline">
            Clear filters
          </button>
        </Nothing>
      ) : layout === "list" ? (
        <div role="table" className="flex flex-col overflow-hidden rounded-2xl border border-line-2 bg-s1">
          <div role="row" className={cn(LIST_COLS, "h-[38px] border-b border-line-2 text-xs text-ink-3 max-lg:hidden")}>
            <label className="flex items-center justify-center">
              <input
                type="checkbox"
                aria-label="Select all"
                className="size-4 accent-[var(--accent-c)]"
                checked={shown.length > 0 && shown.every((v) => picked.has(v.run.id))}
                onChange={(e) => setPicked(e.target.checked ? new Set(shown.map((v) => v.run.id)) : new Set())}
              />
            </label>
            <span />
            <span>Run</span>
            <span>Status</span>
            <span>Output</span>
            <span>Findings</span>
            <span>Model</span>
            <span className="text-right">tok/s</span>
            <span className="text-right">Cost</span>
            <span className="text-right">Runtime</span>
            <span />
          </div>
          {shown.map((v) => (
            <ListRow
              key={v.run.id}
              v={v}
              selected={sel === v.run.id}
              onSelect={() => setSel(v.run.id)}
              picked={picked.has(v.run.id)}
              onPick={(on) =>
                setPicked((p) => {
                  const n = new Set(p);
                  on ? n.add(v.run.id) : n.delete(v.run.id);
                  return n;
                })
              }
            />
          ))}
        </div>
      ) : (
        <>
          {live.length > 0 && (
            <div data-tiles className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,380px),1fr))] gap-3">
              {live.map((v) => (
                <Tile key={v.run.id} v={v} selected={sel === v.run.id} onSelect={() => setSel(v.run.id)} />
              ))}
            </div>
          )}
          {fin.length > 0 && (
            <>
              <SectionTitle title="Finished" n={fin.length} />
              <div className="flex flex-col">
                {fin.map((v) => (
                  <FinishedRow key={v.run.id} v={v} selected={sel === v.run.id} onSelect={() => setSel(v.run.id)} />
                ))}
              </div>
            </>
          )}
        </>
      )}

      {filter === "triage" && (
        <>
          <SectionTitle title="Findings to triage" n={findings.filter(isOpen).length} />
          <FindingsTable findings={findings.filter(isOpen)} runs={runs ?? []} />
        </>
      )}

      {picked.size > 0 && layout === "list" && (
        <div role="region" aria-label="Selected runs" className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-[14px] bg-s3 py-1.5 pr-1.5 pl-4 text-[13px] text-ink-2 shadow-pop">
          <span className="mr-2">
            <b className="font-mono text-ink">{picked.size}</b> selected
          </span>
          <Button size="sm" variant="ghost" onClick={() => bulk((r) => act.pause(r.id), canPause)}>
            <IconPlayerPause {...IC_SM} />
            Pause
          </Button>
          <Button size="sm" variant="ghost" onClick={() => bulk((r) => act.resume(r.id), canResume)}>
            <IconPlayerPlay {...IC_SM} />
            Resume
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setBulkMsg(true)}>
            <IconMessage {...IC_SM} />
            Message
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-critical"
            onClick={() => {
              const ok = (r: (typeof pickedRuns)[number]) => isLive(r) || r.status === "paused";
              if (confirm(`Stop ${pickedRuns.filter(ok).length} runs? The agents are aborted; the machines are kept.`)) bulk((r) => act.stopNow(r.id), ok);
            }}
          >
            <IconPlayerStop {...IC_SM} />
            Stop
          </Button>
          <Button size="sm" icon variant="ghost" aria-label="Clear selection" title="Clear selection" onClick={() => setPicked(new Set())}>
            <IconX {...IC_SM} />
          </Button>
        </div>
      )}
      <BulkMessage open={bulkMsg} onOpenChange={setBulkMsg} runs={pickedRuns} onSent={() => setPicked(new Set())} />
    </main>
  );
}

function SectionTitle({ title, n }: { title: string; n: number }) {
  return (
    <div className="mt-8 mb-3 flex items-baseline gap-2 pl-0.5">
      <h2 className="m-0 text-[13.5px] font-medium text-ink-2">{title}</h2>
      <span className="font-mono text-xs text-ink-3">{n}</span>
    </div>
  );
}

/** One message sent to every selected run. */
function BulkMessage({ open, onOpenChange, runs, onSent }: { open: boolean; onOpenChange: (o: boolean) => void; runs: { id: string; label: string | null; hue: number | null; session_id: string | null }[]; onSent: () => void }) {
  const [text, setText] = useState("");
  const targets = runs.filter((r) => r.session_id);
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    const results = await Promise.allSettled(targets.map((r) => act.message(r.id, t)));
    const failed = results.filter((x) => x.status === "rejected").length;
    toast(failed ? `Sent to ${targets.length - failed}, ${failed} failed` : `Sent to ${targets.length} runs`, failed ? "error" : "info");
    setText("");
    onOpenChange(false);
    onSent();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={`Message ${targets.length} runs`}
      description="Sent to each run's main agent."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={send} disabled={!text.trim() || !targets.length}>
            Send
          </Button>
        </>
      }
    >
      <span className="flex flex-wrap gap-1.5">
        {targets.map((r) => (
          <span key={r.id} className="inline-flex h-7 items-center gap-[7px] rounded-lg border border-line-2 bg-s2 px-2.5 text-[12.5px]">
            <i className="size-2.5 rounded-[3px]" style={{ background: `var(--r${r.hue ?? 0})` }} />
            {runName(r)}
          </span>
        ))}
      </span>
      <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && void send()} placeholder="Message" aria-label="Message" className="input w-full" />
    </Dialog>
  );
}

