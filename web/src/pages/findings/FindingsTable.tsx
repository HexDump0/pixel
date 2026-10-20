/**
 * Lists of findings across runs, one per view (to triage by project, to report by sent or not, done, all by
 * disposition): the groups the Findings page shows, and the table the Wall shows for To triage.
 * Each row: id, severity after triage (with the agent's when they differ), title and where, run, age, status.
 */
import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";
import { byPriority, dispositionLabel, disclosureOf, finalSev, inView, isOpen, refOf, sevChanged, sevOf, STATE_WORD, type FindingView } from "../../lib/findings.ts";
import { runName } from "../../lib/fleet.ts";
import { age } from "../../lib/health.ts";
import type { Finding, Run } from "../../lib/types.ts";
import { Hue, Join, Sev } from "../../components/ui/bits.tsx";

const by = (f: Finding) => (f.disposition_by?.startsWith("MCP: ") ? `by ${f.disposition_by.slice(5)} over MCP` : "by you in the dashboard");
const shortRef = (ref: string, runId: string) => (ref.startsWith(`${runId}/`) ? ref.slice(runId.length + 1) : ref);

/** The right-hand column: what matters about the finding in this list. */
function status(f: Finding, view: FindingView | "run", isNew?: boolean): { text: string; tone?: string; title?: string } {
  const d = disclosureOf(f);
  if (view === "report" || view === "resolved") {
    if (d === "reported") return { text: `sent ${age(f.reported_at)} ago`, title: f.report_url ?? undefined };
    if (d === "fixed") return { text: f.fix_ref ? `fixed in ${f.fix_ref}` : "fixed", tone: "text-good" };
    if (d === "dropped") return { text: "dropped", title: f.disclosure_note ?? undefined };
    return { text: "not sent", tone: "text-accent" };
  }
  if (f.disposition) {
    const text = f.disposition === "duplicate" && f.duplicate_of ? `dup of ${shortRef(f.duplicate_of, f.run_id)}` : d && d !== "ready" ? `${dispositionLabel(f.disposition).toLowerCase()}, ${d}` : dispositionLabel(f.disposition).toLowerCase();
    return { text, tone: f.disposition === "report" ? "text-good" : undefined, title: `Triaged ${by(f)}${f.disposition_note ? `: ${f.disposition_note}` : ""}` };
  }
  if (isNew) return { text: "new", tone: "text-accent" };
  if (f.removed_at) return { text: "removed" };
  return { text: STATE_WORD[f.state] };
}

/** Severity after triage, and the agent's struck through below it when the triage changed it. */
function SevCell({ f }: { f: Finding }) {
  const sev = finalSev(f);
  return (
    <span className="flex min-w-0 flex-col max-md:hidden" title={sevChanged(f) ? `The agent said ${f.severity ?? "no severity"}` : undefined}>
      <Sev sev={sevOf(f)} done={!!f.disposition && f.disposition !== "report"}>
        {sev === "none" ? "no impact" : (sev ?? "")}
      </Sev>
      {sevChanged(f) && <s className="pl-[13px] text-[11px] leading-tight text-ink-4">{f.severity ?? "none"}</s>}
    </span>
  );
}

function Row({ f, run, showRun, selected, isNew, view, onOpen }: { f: Finding; run?: Run; showRun: boolean; selected: boolean; isNew?: boolean; view: FindingView | "run"; onOpen: (f: Finding) => void }) {
  const st = status(f, view, isNew);
  const dimmed = !!f.removed_at || (view !== "run" && disclosureOf(f) === "dropped") || (view === "all" && (f.disposition === "invalid" || f.disposition === "duplicate"));
  return (
    <div
      role="option"
      tabIndex={0}
      aria-selected={selected}
      data-finding={refOf(f)}
      onClick={() => onOpen(f)}
      onKeyDown={(e) => e.key === "Enter" && onOpen(f)}
      className={cn(
        "grid cursor-pointer items-center gap-3 border-t border-line-2 px-4 py-2.5 outline-none hover:bg-s2 focus-visible:bg-s2 aria-selected:bg-s2",
        showRun ? "grid-cols-[26px_80px_minmax(0,1fr)_minmax(0,10em)_40px_104px]" : "grid-cols-[26px_80px_minmax(0,1fr)_40px_104px]",
        "max-md:grid-cols-[26px_minmax(0,1fr)_92px]",
        dimmed && "opacity-55",
      )}
    >
      <span className="font-mono text-xs text-ink-3">{f.id}</span>
      <SevCell f={f} />
      <span className="min-w-0">
        <b className="block truncate font-medium">{f.title}</b>
        {(f.location || f.class) && (
          <small className="block truncate font-mono text-xs text-ink-3">
            <Join items={[f.location, f.class]} />
          </small>
        )}
        {view === "resolved" && disclosureOf(f) === "dropped" && f.disclosure_note && <small className="block truncate text-xs text-ink-3">{f.disclosure_note}</small>}
      </span>
      {showRun && (
        <span className="flex min-w-0 items-center gap-2 text-[12.5px] text-ink-2 max-md:hidden">
          {run && <Hue hue={run.hue} />}
          <span className="truncate">{run ? runName(run) : f.run_id}</span>
        </span>
      )}
      <span className="text-right font-mono text-xs text-ink-3 max-md:hidden">{age(f.updated)}</span>
      <span title={st.title} className={cn("justify-self-end truncate text-[12.5px] whitespace-nowrap text-ink-3", st.tone)}>
        {st.text}
      </span>
    </div>
  );
}

function Group({ title, n, right, children }: { title: ReactNode; n: number; right?: ReactNode; children: ReactNode }) {
  return (
    <>
      <div className="flex items-center gap-2 border-t border-line-2 bg-s2 px-4 py-2.5 text-[12.5px] font-medium text-ink-3 first:border-t-0">
        <span className="min-w-0 truncate">{title}</span> <span className="font-mono text-xs">{n}</span>
        {right && <span className="ml-auto">{right}</span>}
      </div>
      {children}
    </>
  );
}

/** "github.com/pnggroup/libpng" and "https://github.com/a/b.git" read as "pnggroup/libpng" and "a/b". */
export const repoName = (repo: string | null | undefined) => (repo ? repo.replace(/^https?:\/\//, "").replace(/^(www\.)?(github|gitlab)\.com\//, "").replace(/\.git$/, "") : "Unknown project");

const DISPOSITION_GROUPS = [
  ["report", "Report"],
  ["known", "Known"],
  ["duplicate", "Duplicate"],
  ["weak", "Weak"],
  ["invalid", "Invalid"],
] as const;

/** A view's findings in their groups, in the order they're shown (the page walks it to go to the next one). */
export function viewGroups(findings: Finding[], view: FindingView): { title: string; list: Finding[] }[] {
  const mine = findings.filter((f) => inView(f, view));
  const newest = (key: (f: Finding) => number | null) => (a: Finding, b: Finding) => (key(b) ?? b.updated) - (key(a) ?? a.updated);
  switch (view) {
    case "triage": {
      // By project, since duplicates and known bugs live within one; the project with the worst first.
      const byRepo = new Map<string, Finding[]>();
      for (const f of mine.sort(byPriority)) byRepo.set(repoName(f.repo), [...(byRepo.get(repoName(f.repo)) ?? []), f]);
      return [...byRepo].map(([title, list]) => ({ title, list }));
    }
    case "report":
      return [
        { title: "Not sent yet", list: mine.filter((f) => disclosureOf(f) === "ready").sort(byPriority) },
        { title: "Sent, waiting on upstream", list: mine.filter((f) => disclosureOf(f) === "reported").sort((a, b) => (a.deadline ?? Infinity) - (b.deadline ?? Infinity)) },
      ];
    case "resolved":
      return [
        { title: "Fixed upstream", list: mine.filter((f) => disclosureOf(f) === "fixed").sort(newest((f) => f.fixed_at)) },
        { title: "Dropped", list: mine.filter((f) => disclosureOf(f) === "dropped").sort(newest((f) => f.disclosure_at)) },
      ];
    case "all":
      return [
        ...DISPOSITION_GROUPS.map(([d, title]) => ({ title, list: mine.filter((f) => f.disposition === d).sort(newest((f) => f.disposition_at)) })),
        { title: "To triage", list: mine.filter(isOpen).sort(byPriority) },
        { title: "Leads, not yet findings", list: mine.filter((f) => !f.disposition && f.state === "lead").sort(byPriority) },
        { title: "Ruled out by the agent", list: mine.filter((f) => !f.disposition && f.state === "ruled_out").sort(newest(() => null)) },
      ];
  }
}

export const EMPTY: Record<FindingView, string> = {
  triage: "Nothing to triage.",
  report: "Nothing to report. Findings you triage as Report land here until they're sent and fixed.",
  resolved: "Nothing done yet: findings land here once fixed upstream or dropped.",
  all: "No findings.",
};

/** One view of the findings across runs. */
export function FindingsTable({ groups, view, runs, selected, onOpen, isNew }: { groups: { title: string; list: Finding[] }[]; view: FindingView; runs: Run[]; selected?: string; onOpen: (f: Finding) => void; isNew?: (f: Finding) => boolean }) {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const shown = groups.filter((g) => g.list.length);
  if (!shown.length) return <div className="rounded-xl border border-line-2 bg-s1 px-4 py-8 text-center text-[13.5px] text-ink-3">{EMPTY[view]}</div>;
  return (
    <div role="listbox" aria-label="Findings" className="overflow-hidden rounded-xl border border-line-2 bg-s1">
      {shown.map((g) => (
        <Group key={g.title} title={g.title} n={g.list.length}>
          {g.list.map((f) => (
            <Row key={refOf(f)} f={f} run={byId.get(f.run_id)} showRun view={view} selected={selected === refOf(f)} isNew={isNew?.(f)} onOpen={onOpen} />
          ))}
        </Group>
      ))}
    </div>
  );
}
