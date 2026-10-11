/** REPORT.md and the triage form (→ TRIAGE.md in the workbase). */
import { useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import { useAsync } from "../../lib/hooks.ts";
import { dateTime } from "../../lib/format.ts";
import type { RunDetail } from "../../lib/types.ts";
import { Markdown } from "../../components/Markdown.tsx";
import { Button, Card, Empty, Field } from "../../components/ui.tsx";

const VERDICTS = ["real findings", "partly real", "false positives", "duplicate", "nothing found", "inconclusive"];

const NOTES_TEMPLATE = `## Findings

- Finding 1: real / false positive / duplicate / unclear. Notes…
`;

export function ReportTab({ detail, onChange }: { detail: RunDetail; onChange: () => void }) {
  const r = detail.run;
  const report = useAsync(() => api.report(r.id), [r.id, r.report_ready]);
  const [verdict, setVerdict] = useState(r.triage_verdict ?? "");
  const [notes, setNotes] = useState(r.triage_notes ?? "");
  const [keepVm, setKeepVm] = useState(false);
  useEffect(() => {
    setVerdict(r.triage_verdict ?? "");
    setNotes(r.triage_notes ?? "");
  }, [r.id]);

  const save = (markTriaged: boolean) => async () => {
    await api.triage(r.id, { verdict: verdict || null, notes: notes || null, markTriaged, keepVm });
    onChange();
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_420px]">
      <Card title="REPORT.md">{report.data?.content ? <Markdown text={report.data.content} /> : <Empty>No report yet.</Empty>}</Card>
      <Card title="Triage">
        <div className="flex flex-col gap-3">
          <div className="text-xs muted">
            Saved to <code>TRIAGE.md</code> in the workbase, so other agents can see which findings held up.
            {r.triaged_at && ` Triaged ${dateTime(r.triaged_at)}.`}
          </div>
          <Field label="Overall verdict">
            <input className="input" list="verdicts" value={verdict} onChange={(e) => setVerdict(e.target.value)} />
            <datalist id="verdicts">
              {VERDICTS.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </Field>
          <Field label="Notes per finding (markdown)">
            <textarea className="input h-72 font-mono text-xs" value={notes} placeholder={NOTES_TEMPLATE} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          {!notes && (
            <button className="self-start text-xs text-accent hover:underline" onClick={() => setNotes(NOTES_TEMPLATE)}>
              Start from a template
            </button>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={keepVm} onChange={(e) => setKeepVm(e.target.checked)} />
            Keep the machine when marking triaged
          </label>
          <div className="flex flex-wrap gap-1.5">
            <Button onClick={save(false)} done="Triage notes saved">
              Save notes
            </Button>
            <Button variant="primary" onClick={save(true)} disabled={r.status === "triaged"} confirm={keepVm ? undefined : "Mark triaged? The run's machine will be deleted (the workbase is kept)."} done="Marked triaged">
              Save & mark triaged
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
