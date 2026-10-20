/** The run's findings: grouped by state on the left, the one you pick on the right with its triage. */
import { useState } from "react";
import { useRunFindings, byPriority, isOpen } from "../../lib/findings.ts";
import type { Run } from "../../lib/types.ts";
import { RunFindingsList } from "../findings/FindingList.tsx";
import { FindingDetail } from "../findings/FindingDetail.tsx";
import { openRun } from "../../lib/actions.ts";

export function FindingsTab({ run, selected, onSelect, seen }: { run: Run; selected: string | null; onSelect: (id: string | null) => void; seen: number }) {
  const q = useRunFindings(run.id);
  const [showRemoved, setShowRemoved] = useState(false);
  const all = q.data ?? [];
  const current = all.find((f) => f.id === selected) ?? all.filter(isOpen).sort(byPriority)[0] ?? null;
  if (q.data && !all.length)
    return (
      <div className="px-7 py-10 text-[13.5px] text-ink-3">
        {run.status === "running" || run.status === "recovering" ? "No findings yet. They appear here as the agent writes them in findings/." : "No findings."}
      </div>
    );
  return (
    <div className="grid h-full grid-cols-[300px_minmax(0,1fr)] max-xl:block max-xl:h-auto">
      <div className="overflow-y-auto border-r border-line-2 px-2 pt-2 pb-10 max-xl:overflow-visible max-xl:border-r-0">
        <RunFindingsList findings={all} selected={current?.id} onOpen={(f) => onSelect(f.id)} showRemoved={showRemoved} onToggleRemoved={() => setShowRemoved((s) => !s)} isNew={(f) => f.updated > seen} />
      </div>
      <div className="flex min-h-0 flex-col max-xl:border-t max-xl:border-line-2">{current && <FindingDetail key={current.id} f={current} run={run} showRun={false} onOpen={(f) => (f.run_id === run.id ? onSelect(f.id) : openRun(f.run_id, `findings/${f.id}`))} />}</div>
    </div>
  );
}
