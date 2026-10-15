/**
 * One finding: what the agent wrote, where, the PoC, its history, and your verdict (R real, N not a bug,
 * D duplicate, W needs work — "needs work" is also sent to the agent while the run is live).
 */
import { useEffect, useState } from "react";
import { IconFileCode, IconFileText } from "@tabler/icons-react";
import { cn } from "../../lib/cn.ts";
import { STATE_WORD, useFindingEvents, useSetVerdict, VERDICTS, verdictLabel } from "../../lib/findings.ts";
import { runName } from "../../lib/fleet.ts";
import { age } from "../../lib/health.ts";
import { openRun } from "../../lib/actions.ts";
import type { Finding, FindingEvent, Run } from "../../lib/types.ts";
import { Button } from "../../components/ui.tsx";
import { Hue, IC_XS, Kbd, Sev } from "../../components/ui/bits.tsx";

const FIELD: Record<string, string> = { state: "state", severity: "severity", title: "title", summary: "summary", location: "location", poc: "PoC", class: "class", verdict: "verdict" };

function describe(e: FindingEvent) {
  if (e.action === "add") return "Added";
  if (e.action === "remove") return "Removed";
  if (e.action === "verdict") {
    const v = e.changes?.verdict?.[1] as string | null;
    return v ? `You: ${verdictLabel(v).toLowerCase()}` : "You cleared the verdict";
  }
  const parts = Object.entries(e.changes ?? {}).map(([k, [a, b]]) =>
    k === "state" ? `${STATE_WORD[String(a)] ?? a} → ${STATE_WORD[String(b)] ?? b}` : k === "severity" ? `severity ${a ?? "none"} → ${b}` : `${FIELD[k] ?? k} changed`,
  );
  return parts.length ? parts.join(", ").replace(/^./, (c) => c.toUpperCase()) : "Note";
}

export function FindingDetail({ f, run, showRun = true }: { f: Finding; run?: Run; showRun?: boolean }) {
  const events = useFindingEvents(f.run_id).data?.filter((e) => e.finding_id === f.id) ?? [];
  const setVerdict = useSetVerdict();
  const [note, setNote] = useState(f.verdict_note ?? "");
  useEffect(() => setNote(f.verdict_note ?? ""), [f.run_id, f.id, f.verdict_note]);
  const live = run && (run.status === "running" || run.status === "recovering");

  const choose = (v: (typeof VERDICTS)[number]["v"]) => setVerdict.mutate({ f, verdict: f.verdict === v ? null : v, note });

  // R / N / D / W while this finding is open (not while typing).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest("input, textarea, select, [role=menu]")) return;
      const v = VERDICTS.find((x) => x.key === e.key.toLowerCase());
      if (v) {
        e.preventDefault();
        choose(v.v);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  return (
    <article className="flex min-w-0 flex-col gap-[18px] px-6 pt-[22px] pb-[26px]">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 font-mono text-xs text-ink-3">
          <Sev sev={f.severity ?? (f.state === "lead" ? "lead" : "low")}>{f.severity ?? "no severity"}</Sev>
          <span>{f.id}</span>
          <span>{f.removed_at ? `removed: ${f.removed_reason}${f.duplicate_of ? ` (${f.duplicate_of})` : ""}` : STATE_WORD[f.state]}</span>
          <span>{age(f.updated)} ago</span>
          {showRun && run && (
            <span className="inline-flex items-center gap-1.5">
              <Hue hue={run.hue} />
              <button type="button" className="cursor-pointer border-0 bg-transparent p-0 font-sans text-[12.5px] text-ink underline decoration-ink-4 underline-offset-[3px] hover:decoration-ink" onClick={() => openRun(run.id, "findings/" + f.id)}>
                {runName(run)}
              </button>
            </span>
          )}
        </div>
        <h2 className="m-0 text-xl leading-snug font-medium tracking-[-0.015em] text-balance">{f.title}</h2>
        {(f.location || f.class) && (
          <div className="flex flex-wrap gap-x-3.5 gap-y-1 font-mono text-xs text-ink-3">
            {f.location && <code className="text-ink-2">{f.location}</code>}
            {f.class && <span>{f.class}</span>}
          </div>
        )}
      </div>
      <p className="m-0 max-w-[72ch] leading-relaxed whitespace-pre-wrap text-ink">{f.summary}</p>
      <div className="flex flex-wrap gap-1.5">
        {f.poc && (
          <Button size="xs" onClick={() => openRun(f.run_id, `files/${f.poc}`)}>
            <IconFileCode {...IC_XS} />
            {f.poc}
          </Button>
        )}
        {run?.report_ready ? (
          <Button size="xs" variant="ghost" onClick={() => openRun(f.run_id, "report")}>
            <IconFileText {...IC_XS} />
            REPORT.md
          </Button>
        ) : null}
      </div>

      {f.state !== "lead" && !f.removed_at && (
        <div className="flex flex-col gap-2.5 rounded-xl border border-line-2 bg-s2 px-4 py-3.5">
          <div className="text-[12.5px] text-ink-3">Your verdict · written to TRIAGE.md{live ? "; “needs work” is also sent to the agent" : ""}</div>
          <div className="grid grid-cols-4 gap-1.5 max-md:grid-cols-2">
            {VERDICTS.map((v) => (
              <button
                key={v.v}
                type="button"
                aria-pressed={f.verdict === v.v}
                disabled={setVerdict.isPending}
                onClick={() => choose(v.v)}
                className={cn(
                  "flex min-w-0 flex-col items-start gap-[3px] rounded-lg border border-line bg-s1 px-2.5 py-[9px] text-left text-ink hover:border-ink-4 aria-pressed:border-ink aria-pressed:bg-s3",
                  v.v === "real" && "aria-pressed:border-good",
                  v.v === "needs_work" && "aria-pressed:border-warning",
                )}
              >
                <b className="flex w-full items-center gap-1.5 text-[13px] font-medium">
                  {v.label}
                  <Kbd className="ml-auto">{v.key.toUpperCase()}</Kbd>
                </b>
                <small className="text-[11.5px] leading-tight text-ink-3">{v.hint}</small>
              </button>
            ))}
          </div>
          <textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional): why, upstream issue, CVE"
            className="min-h-[60px] w-full resize-y rounded-lg border border-line bg-s1 px-2.5 py-2 text-ink outline-none focus:border-ink-3"
          />
          {f.verdict && note !== (f.verdict_note ?? "") && (
            <div>
              <Button size="xs" onClick={() => setVerdict.mutate({ f, verdict: f.verdict, note })}>
                Save note
              </Button>
            </div>
          )}
        </div>
      )}

      {events.length > 0 && (
        <div>
          <div className="mb-2 text-[12.5px] text-ink-3">History</div>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px]">
            {[...events].reverse().map((e) => (
              <li key={e.seq} className="grid grid-cols-[64px_minmax(0,1fr)] gap-3">
                <span className="pt-0.5 font-mono text-[11.5px] text-ink-3">{age(e.at)} ago</span>
                <span>
                  {describe(e)}
                  {e.note && <span className="text-ink-3"> · {e.note}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}
