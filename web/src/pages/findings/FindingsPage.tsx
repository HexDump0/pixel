/** Findings (`/findings`): every finding across runs, to triage first; pick one to read it and give a verdict. */
import { useEffect, useState } from "react";
import { useFindings, isOpen } from "../../lib/findings.ts";
import { useRuns } from "../../lib/runs.ts";
import { useLastLooked, useSeenRuns, seenAt } from "../../lib/seen.ts";
import { FindingsTable } from "./FindingsTable.tsx";
import { FindingDetail } from "./FindingDetail.tsx";

export function FindingsPage() {
  const findings = useFindings();
  const { runs } = useRuns();
  const seenRuns = useSeenRuns();
  const [lastLooked] = useLastLooked();
  const [sel, setSel] = useState<string | null>(() => decodeURIComponent(location.hash.slice(1)) || null);
  useEffect(() => {
    history.replaceState(null, "", sel ? `#${encodeURIComponent(sel)}` : location.pathname);
  }, [sel]);
  const all = findings ?? [];
  const current = all.find((f) => `${f.run_id}/${f.id}` === sel) ?? null;
  const open = all.filter(isOpen).length;

  return (
    <main className="gut pt-2 pb-16">
      <div className="mt-4 mb-5 flex items-baseline gap-3">
        <h1 className="m-0 text-[22px] font-medium tracking-[-0.02em]">Findings</h1>
        <span className="text-ink-3">{open ? `${open} to triage` : "Nothing to triage"}</span>
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <FindingsTable
          findings={all}
          runs={runs ?? []}
          selected={sel ?? undefined}
          onOpen={(f) => setSel(`${f.run_id}/${f.id}`)}
          isNew={(f) => f.updated > seenAt(seenRuns[f.run_id], lastLooked)}
        />
        <div className="sticky top-[76px] max-h-[calc(100dvh-92px)] overflow-y-auto rounded-2xl border border-line-2 bg-s1 max-lg:static max-lg:max-h-none">
          {current ? (
            <FindingDetail key={sel!} f={current} run={runs?.find((r) => r.id === current.run_id)} />
          ) : (
            <div className="px-6 py-12 text-center text-[13.5px] text-ink-3">Pick a finding to read it and give a verdict.</div>
          )}
        </div>
      </div>
    </main>
  );
}
