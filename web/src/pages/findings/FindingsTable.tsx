/** Lists of findings: grouped by triage (across runs) or by state (one run), each row severity · title · where · verdict. */
import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";
import { byPriority, isOpen, sevOf, STATE_LABEL, STATE_WORD, verdictLabel } from "../../lib/findings.ts";
import { runName } from "../../lib/fleet.ts";
import { age } from "../../lib/health.ts";
import { openRun } from "../../lib/actions.ts";
import type { Finding, Run } from "../../lib/types.ts";
import { Hue, Sev } from "../../components/ui/bits.tsx";

/** What the verdict column says: the human's verdict, else "new" when changed since you looked, else the state. */
function VerdictCell({ f, isNew }: { f: Finding; isNew?: boolean }) {
  const v = f.verdict;
  const text = v ? verdictLabel(v).toLowerCase() : isNew ? "new" : f.removed_at ? "removed" : STATE_WORD[f.state];
  return (
    <span className={cn("justify-self-end text-[12.5px] whitespace-nowrap text-ink-3", v === "real" && "text-good", v === "needs_work" && "text-warning", !v && isNew && "text-accent")}>{text}</span>
  );
}

function Row({ f, run, showRun, selected, isNew, onOpen }: { f: Finding; run?: Run; showRun: boolean; selected: boolean; isNew?: boolean; onOpen: (f: Finding) => void }) {
  return (
    <div
      role="option"
      tabIndex={0}
      aria-selected={selected}
      data-finding={f.id}
      onClick={() => onOpen(f)}
      onKeyDown={(e) => e.key === "Enter" && onOpen(f)}
      className={cn(
        "grid cursor-pointer items-center gap-3 border-t border-line-2 px-4 py-2.5 outline-none hover:bg-s2 focus-visible:bg-s2 aria-selected:bg-s2",
        showRun ? "grid-cols-[26px_74px_minmax(0,1fr)_minmax(0,11em)_44px_88px]" : "grid-cols-[26px_74px_minmax(0,1fr)_44px_88px]",
        "max-md:grid-cols-[26px_minmax(0,1fr)_84px]",
        f.removed_at && "opacity-55",
      )}
    >
      <span className="font-mono text-xs text-ink-3">{f.id}</span>
      <Sev sev={sevOf(f)} done={!!f.verdict} className="max-md:hidden">
        {f.severity ?? ""}
      </Sev>
      <span className="min-w-0">
        <b className="block truncate font-medium">{f.title}</b>
        {(f.location || f.class) && <small className="block truncate font-mono text-xs text-ink-3">{[f.location, f.class].filter(Boolean).join(" · ")}</small>}
      </span>
      {showRun && (
        <span className="flex min-w-0 items-center gap-2 text-[12.5px] text-ink-2 max-md:hidden">
          {run && <Hue hue={run.hue} />}
          <span className="truncate">{run ? runName(run) : f.run_id}</span>
        </span>
      )}
      <span className="text-right font-mono text-xs text-ink-3 max-md:hidden">{age(f.updated)}</span>
      <VerdictCell f={f} isNew={isNew} />
    </div>
  );
}

function Group({ title, n, right, children }: { title: string; n: number; right?: ReactNode; children: ReactNode }) {
  return (
    <>
      <div className="flex items-center gap-2 border-t border-line-2 bg-s2 px-4 py-2.5 text-[12.5px] font-medium text-ink-3 first:border-t-0">
        {title} <span className="font-mono text-xs">{n}</span>
        {right && <span className="ml-auto">{right}</span>}
      </div>
      {children}
    </>
  );
}

/** Across runs: To triage, then Triaged. Clicking a row opens it in its run (or calls onOpen). */
export function FindingsTable({ findings, runs, selected, onOpen, isNew }: { findings: Finding[]; runs: Run[]; selected?: string; onOpen?: (f: Finding) => void; isNew?: (f: Finding) => boolean }) {
  const open = findings.filter(isOpen).sort(byPriority);
  const done = findings.filter((f) => !isOpen(f)).sort((a, b) => (b.verdict_at ?? b.updated) - (a.verdict_at ?? a.updated));
  const go = onOpen ?? ((f: Finding) => openRun(f.run_id, `findings/${f.id}`));
  const byId = new Map(runs.map((r) => [r.id, r]));
  if (!findings.length) return <div className="py-6 text-[13.5px] text-ink-3">No findings.</div>;
  return (
    <div role="listbox" aria-label="Findings" className="overflow-hidden rounded-xl border border-line-2 bg-s1">
      {open.length > 0 && (
        <Group title="To triage" n={open.length}>
          {open.map((f) => (
            <Row key={`${f.run_id}/${f.id}`} f={f} run={byId.get(f.run_id)} showRun selected={selected === `${f.run_id}/${f.id}`} isNew={isNew?.(f)} onOpen={go} />
          ))}
        </Group>
      )}
      {done.length > 0 && (
        <Group title="Triaged, leads and ruled out" n={done.length}>
          {done.map((f) => (
            <Row key={`${f.run_id}/${f.id}`} f={f} run={byId.get(f.run_id)} showRun selected={selected === `${f.run_id}/${f.id}`} isNew={isNew?.(f)} onOpen={go} />
          ))}
        </Group>
      )}
    </div>
  );
}

const STATE_ORDER = ["confirmed", "suspected", "lead", "ruled_out"];

/** One run: grouped by state (Confirmed, Suspected, Leads, Ruled out); removed ones behind a toggle. */
export function RunFindingsList({ findings, selected, onOpen, showRemoved, onToggleRemoved, isNew }: { findings: Finding[]; selected?: string; onOpen: (f: Finding) => void; showRemoved: boolean; onToggleRemoved: () => void; isNew?: (f: Finding) => boolean }) {
  const live = findings.filter((f) => !f.removed_at);
  const removed = findings.filter((f) => f.removed_at);
  return (
    <div role="listbox" aria-label="Findings" className="overflow-hidden rounded-xl border border-line-2 bg-s1">
      {STATE_ORDER.map((st) => {
        const list = live.filter((f) => f.state === st).sort(byPriority);
        if (!list.length) return null;
        return (
          <Group key={st} title={STATE_LABEL[st]} n={list.length}>
            {list.map((f) => (
              <Row key={f.id} f={f} showRun={false} selected={selected === f.id} isNew={isNew?.(f)} onOpen={onOpen} />
            ))}
          </Group>
        );
      })}
      {removed.length > 0 && (
        <Group
          title="Removed"
          n={removed.length}
          right={
            <button type="button" onClick={onToggleRemoved} className="cursor-pointer border-0 bg-transparent p-0 text-[12.5px] font-normal text-ink-3 hover:text-ink hover:underline">
              {showRemoved ? "Hide" : "Show"}
            </button>
          }
        >
          {showRemoved && removed.map((f) => <Row key={f.id} f={f} showRun={false} selected={selected === f.id} onOpen={onOpen} />)}
        </Group>
      )}
    </div>
  );
}
