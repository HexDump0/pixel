/** REPORT.md once the run has written it (finding ids link to the findings), the run's result from its finding verdicts, and triage notes (→ TRIAGE.md). */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api.ts";
import { keys } from "../../lib/query.ts";
import { dateTime } from "../../lib/format.ts";
import { reloadRuns } from "../../lib/runs.ts";
import type { Run } from "../../lib/types.ts";
import { Markdown } from "../../components/Markdown.tsx";
import { Button } from "../../components/ui.tsx";

export function ReportTab({ run, onOpenFinding }: { run: Run; onOpenFinding: (id: string) => void }) {
  const report = useQuery({ queryKey: [...keys.runReport(run.id), run.report_ready], queryFn: () => api.report(run.id) });
  const [notes, setNotes] = useState(run.triage_notes ?? "");
  const [keepVm, setKeepVm] = useState(false);
  useEffect(() => {
    setNotes(run.triage_notes ?? "");
  }, [run.id]);
  // F3 in the report → a link to that finding
  const text = useMemo(
    () =>
      (report.data?.content ?? "")
        .split(/(```[\s\S]*?```|`[^`\n]*`)/)
        .map((part, i) => (i % 2 ? part : part.replace(/(?<![\w/[])F(\d+)\b(?!\]\()/g, "[F$1](#finding-F$1)")))
        .join(""),
    [report.data],
  );
  const save = (markTriaged: boolean) => async () => {
    await api.triage(run.id, { notes: notes || null, markTriaged, keepVm });
    void reloadRuns();
  };
  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-10 px-10 pt-6 pb-12 max-md:px-4">
      <article
        className="text-[15px] leading-[1.7] [&_.prose-pixel_h1]:mt-0 [&_.prose-pixel_h1]:text-[22px] [&_.prose-pixel_h1]:font-medium [&_.prose-pixel_h2]:mt-6 [&_.prose-pixel_h2]:text-[17px] [&_.prose-pixel_h2]:font-medium [&_.prose-pixel_pre]:border [&_.prose-pixel_pre]:border-line-2 [&_.prose-pixel_pre]:bg-term-bg [&_.prose-pixel_pre]:text-term-ink"
        onClick={(e) => {
          const a = (e.target as HTMLElement).closest("a");
          const m = a?.getAttribute("href")?.match(/^#finding-(F\d+)$/);
          if (m) {
            e.preventDefault();
            onOpenFinding(m[1]);
          }
        }}
      >
        {report.data?.content ? <Markdown text={text} /> : <p className="text-ink-3">REPORT.md is empty.</p>}
      </article>
      <section className="flex flex-col gap-3 border-t border-line-2 pt-6">
        <div className="flex items-baseline gap-2.5">
          <h2 className="m-0 text-[13.5px] font-medium">Triage</h2>
          <span className="text-[12.5px] text-ink-3">saved to TRIAGE.md{run.triaged_at ? ` · triaged ${dateTime(run.triaged_at)}` : ""}</span>
        </div>
        <p className="m-0 text-[13.5px] text-ink-2">
          {run.findings?.outcome ? `Result: ${run.findings.outcome}` : "No finding verdicts yet"}
          {run.findings?.untriaged ? `, ${run.findings.untriaged} still to triage` : ""}
          {run.triage_verdict && <span className="text-ink-3"> · earlier overall verdict: {run.triage_verdict}</span>}
        </p>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={6} placeholder="Notes (markdown)" aria-label="Notes" className="resize-y rounded-lg border border-line bg-s2 px-2.5 py-2 font-mono text-[12.5px] text-ink outline-none focus:border-ink-3" />
        <label className="flex items-center gap-2 text-[13px] text-ink-2">
          <input type="checkbox" checked={keepVm} onChange={(e) => setKeepVm(e.target.checked)} />
          Keep the machine when marking triaged
        </label>
        <div className="flex flex-wrap gap-1.5">
          <Button onClick={save(false)} done="Saved">
            Save
          </Button>
          <Button variant="primary" onClick={save(true)} disabled={run.status === "triaged"} confirm={keepVm ? undefined : "Mark triaged? The run's machine will be deleted (the workbase is kept)."} done="Marked triaged">
            Save and mark triaged
          </Button>
        </div>
      </section>
    </div>
  );
}
