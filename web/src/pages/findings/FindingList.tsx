/**
 * The Findings page's left column: the lists (to triage, report, done, all) with their counts, search,
 * Copy for LLM for what's shown, and the findings of the list in their groups, two lines each.
 */
import { type ReactNode, type RefObject } from "react";
import { IconCopy, IconSearch, IconX } from "@tabler/icons-react";
import { cn } from "../../lib/cn.ts";
import { byPriority, deadlineOf, disclosureOf, dispositionLabel, refOf, sevOf, STATE_WORD, type FindingView } from "../../lib/findings.ts";
import { runName } from "../../lib/fleet.ts";
import { age } from "../../lib/health.ts";
import type { Finding, Run } from "../../lib/types.ts";
import { Menu } from "../../components/ui/overlay.tsx";
import { IC_XS, Kbd, Sev } from "../../components/ui/bits.tsx";
import { EMPTY, repoName } from "./FindingsTable.tsx";

export const LISTS: { id: FindingView; label: string; title: string }[] = [
  { id: "triage", label: "Triage", title: "Findings to triage" },
  { id: "report", label: "Report", title: "Findings to report" },
  { id: "resolved", label: "Done", title: "Findings fixed upstream or dropped" },
  { id: "all", label: "All", title: "All findings" },
];

export type ListPurpose = "list" | "triage" | "verify" | "variants";
export const LIST_PURPOSES: Record<FindingView, ListPurpose[]> = {
  triage: ["triage", "list", "verify"],
  report: ["list", "verify", "variants"],
  resolved: ["list", "variants"],
  all: ["list", "triage", "variants"],
};
export const PURPOSE_LABEL: Record<ListPurpose, string> = { list: "As context", triage: "To triage them", verify: "To check them", variants: "To find variants" };

const TONE: Record<string, string> = { bad: "text-critical", warn: "text-warning", "": "text-ink-3" };

/** The right-hand word of a row: what matters about it in this list. */
function badge(f: Finding, view: FindingView, isNew: boolean): { text: string; cls: string; title?: string } | null {
  const d = disclosureOf(f);
  if (d === "reported") {
    const dl = deadlineOf(f);
    if (dl) return { text: dl.short, cls: TONE[dl.tone], title: `Deadline ${new Date(f.deadline!).toLocaleDateString()}` };
  }
  if (view === "resolved") return d === "fixed" ? { text: "fixed", cls: "text-good" } : { text: "dropped", cls: "text-ink-3", title: f.disclosure_note ?? undefined };
  // Not sent: the group says so; only a check that found it fixed upstream is worth a word.
  if (view === "report") return f.upstream_status === "fixed" ? { text: "fixed?", cls: "text-warning", title: "The latest upstream check says it's fixed" } : null;
  if (view === "all") return f.disposition ? { text: dispositionLabel(f.disposition).toLowerCase(), cls: f.disposition === "report" ? "text-good" : "text-ink-3" } : { text: STATE_WORD[f.state], cls: "text-ink-3" };
  return isNew ? { text: "new", cls: "text-accent" } : null;
}

function Item({ f, run, view, byProject, selected, isNew, onOpen }: { f: Finding; run?: Run; view: FindingView | "run"; byProject: boolean; selected: boolean; isNew: boolean; onOpen: (f: Finding) => void }) {
  const b = view === "run" ? (isNew && !f.disposition ? { text: "new", cls: "text-accent" } : badge(f, "all", false)) : badge(f, view, isNew);
  const dimmed = disclosureOf(f) === "dropped" || f.disposition === "invalid" || f.disposition === "duplicate" || f.state === "ruled_out";
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-finding={refOf(f)}
      onClick={() => onOpen(f)}
      className={cn("grid w-full cursor-pointer grid-cols-[8px_minmax(0,1fr)_auto] items-baseline gap-x-2.5 gap-y-0.5 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-s2 focus-visible:bg-s2 aria-selected:bg-s3", dimmed && "opacity-60")}
    >
      <Sev sev={sevOf(f)} done={!!f.disposition && f.disposition !== "report"} className="translate-y-[-1px]" />
      <span className="line-clamp-2 text-[13px] leading-snug font-medium text-ink">{f.title}</span>
      {b ? (
        <span title={b.title} className={cn("font-mono text-[11.5px] whitespace-nowrap", b.cls)}>
          {b.text}
        </span>
      ) : (
        <span />
      )}
      <span />
      <span className="truncate font-mono text-[11.5px] text-ink-3">
        {view === "run" ? [f.id, f.location].filter(Boolean).join(" ") : byProject ? `${f.id} ${run ? runName(run) : f.run_id}` : `${repoName(f.repo).split("/").pop()} ${f.id}`}
      </span>
      <span className="font-mono text-[11px] text-ink-4">{age(f.updated)}</span>
    </button>
  );
}

export function FindingList({
  view,
  onView,
  counts,
  overdue,
  groups,
  q,
  onQ,
  search,
  runs,
  selected,
  onOpen,
  isNew,
  onCopy,
}: {
  view: FindingView;
  onView: (v: FindingView) => void;
  counts: Record<FindingView, number>;
  overdue: number;
  groups: { title: string; list: Finding[] }[];
  q: string;
  onQ: (q: string) => void;
  search: RefObject<HTMLInputElement | null>;
  runs: Map<string, Run>;
  selected: string | null;
  onOpen: (f: Finding) => void;
  isNew: (f: Finding) => boolean;
  onCopy: (purpose: ListPurpose) => void;
}) {
  const shown = groups.filter((g) => g.list.length);
  const total = shown.reduce((n, g) => n + g.list.length, 0);
  const purposes = LIST_PURPOSES[view];
  return (
    <nav aria-label="Findings" className="flex min-h-0 flex-col">
      <div className="flex flex-col gap-2 px-3 pt-3 pb-2">
        <div role="tablist" aria-label="Lists" className="grid grid-cols-4 gap-0.5 rounded-[9px] border border-line-2 p-0.5">
          {LISTS.map((l) => (
            <button
              key={l.id}
              type="button"
              role="tab"
              aria-selected={view === l.id}
              title={l.title}
              onClick={() => onView(l.id)}
              className="inline-flex h-[26px] cursor-pointer items-center justify-center gap-1.5 rounded-[7px] text-[12.5px] text-ink-3 hover:text-ink aria-selected:bg-s3 aria-selected:text-ink"
            >
              {l.label}
              <span className="font-mono text-[11px] text-ink-4">{counts[l.id]}</span>
              {l.id === "report" && overdue > 0 && <span title={`${overdue} past the disclosure deadline`} className="size-1.5 rounded-full bg-critical" />}
            </button>
          ))}
        </div>
        <div className="flex gap-1.5">
          <label className="flex h-[30px] min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-line-2 bg-s1 px-2 focus-within:border-ink-4">
            <IconSearch {...IC_XS} className="shrink-0 text-ink-4" />
            <input
              ref={search}
              value={q}
              onChange={(e) => onQ(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && (onQ(""), e.currentTarget.blur())}
              placeholder="Search"
              aria-label="Search findings"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-4"
            />
            {q ? (
              <button type="button" aria-label="Clear search" className="cursor-pointer text-ink-4 hover:text-ink" onClick={() => onQ("")}>
                <IconX {...IC_XS} />
              </button>
            ) : (
              <Kbd>/</Kbd>
            )}
          </label>
          <Menu
            trigger={
              <button type="button" disabled={!total} aria-label={`Copy these ${total} for an LLM`} title={`Copy these ${total} for an LLM`} className="inline-flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-lg border border-line-2 bg-s1 text-ink-3 hover:border-line hover:text-ink disabled:opacity-40">
                <IconCopy {...IC_XS} />
              </button>
            }
            items={[{ head: `Copy these ${total} for an LLM` }, ...purposes.map((p) => ({ label: PURPOSE_LABEL[p], onSelect: () => onCopy(p) }))]}
          />
        </div>
      </div>
      <div role="listbox" aria-label={LISTS.find((l) => l.id === view)!.title} className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {!shown.length && <div className="px-3 py-8 text-center text-[13px] text-ink-3">{q ? `Nothing here matches "${q}".` : EMPTY[view]}</div>}
        {shown.map((g) => (
          <div key={g.title}>
            <div className="flex items-baseline gap-2 px-2.5 pt-3 pb-1 text-xs text-ink-3">
              <span className="truncate">{g.title}</span>
              <span className="font-mono text-[11px] text-ink-4">{g.list.length}</span>
            </div>
            {g.list.map((f) => (
              <Item key={refOf(f)} f={f} run={runs.get(f.run_id)} view={view} byProject={view === "triage"} selected={selected === refOf(f)} isNew={isNew(f)} onOpen={onOpen} />
            ))}
          </div>
        ))}
      </div>
    </nav>
  );
}

const STATE_ORDER = ["confirmed", "suspected", "lead", "ruled_out"];
const STATE_GROUP: Record<string, string> = { confirmed: "Confirmed", suspected: "Suspected", lead: "Leads", ruled_out: "Ruled out" };

/** One run's findings (the run's Findings tab): grouped by state, removed ones behind a toggle. */
export function RunFindingsList({ findings, selected, onOpen, showRemoved, onToggleRemoved, isNew }: { findings: Finding[]; selected?: string; onOpen: (f: Finding) => void; showRemoved: boolean; onToggleRemoved: () => void; isNew?: (f: Finding) => boolean }) {
  const live = findings.filter((f) => !f.removed_at);
  const removed = findings.filter((f) => f.removed_at);
  const head = (title: string, n: number, right?: ReactNode) => (
    <div className="flex items-baseline gap-2 px-2.5 pt-3 pb-1 text-xs text-ink-3">
      <span>{title}</span>
      <span className="font-mono text-[11px] text-ink-4">{n}</span>
      {right && <span className="ml-auto">{right}</span>}
    </div>
  );
  return (
    <div role="listbox" aria-label="Findings">
      {STATE_ORDER.map((st) => {
        const list = live.filter((f) => f.state === st).sort(byPriority);
        if (!list.length) return null;
        return (
          <div key={st}>
            {head(STATE_GROUP[st], list.length)}
            {list.map((f) => (
              <Item key={f.id} f={f} view="run" byProject={false} selected={selected === f.id} isNew={!!isNew?.(f)} onOpen={onOpen} />
            ))}
          </div>
        );
      })}
      {removed.length > 0 && (
        <div>
          {head(
            "Removed",
            removed.length,
            <button type="button" onClick={onToggleRemoved} className="cursor-pointer text-xs text-ink-3 hover:text-ink hover:underline">
              {showRemoved ? "Hide" : "Show"}
            </button>,
          )}
          {showRemoved && removed.map((f) => <Item key={f.id} f={f} view="run" byProject={false} selected={selected === f.id} isNew={false} onOpen={onOpen} />)}
        </div>
      )}
    </div>
  );
}
