/** The run's findings: grouped by state on the left, the one you pick on the right with its verdict buttons. */
import { useState } from "react";
import { useRunFindings, byPriority, isOpen } from "../../lib/findings.ts";
import type { Run } from "../../lib/types.ts";
import { RunFindingsList } from "../findings/FindingsTable.tsx";
import { FindingDetail } from "../findings/FindingDetail.tsx";

export function FindingsTab({ run, selected, onSelect, seen }: { run: Run; selected: string | null; onSelect: (id: string | null) => void; seen: number }) {
  const q = useRunFindings(run.id);
  const [showRemoved, setShowRemoved] = useState(false);
  const all = q.data ?? [];
  const current = all.find((f) => f.id === selected) ?? all.filter(isOpen).sort(byPriority)[0] ?? null;
  if (q.data && !all.length)
    return (
      <div className="px-7 py-10 text-[13.5px] text-ink-3">
        {run.status === "running" || run.status === "recovering" ? "No findings yet. They appear here as the agent records them with the finding tools." : "No findings."}
      </div>
    );
  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] max-xl:block max-xl:h-auto">
      <div className="overflow-y-auto border-r border-line-2 pt-5 pr-5 pb-10 pl-6 max-xl:overflow-visible max-xl:border-r-0">
        <RunFindingsList findings={all} selected={current?.id} onOpen={(f) => onSelect(f.id)} showRemoved={showRemoved} onToggleRemoved={() => setShowRemoved((s) => !s)} isNew={(f) => f.updated > seen} />
      </div>
      <div className="overflow-y-auto max-xl:border-t max-xl:border-line-2">{current && <FindingDetail key={current.id} f={current} run={run} showRun={false} />}</div>
    </div>
  );
}
