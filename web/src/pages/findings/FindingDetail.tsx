/**
 * One finding: its README (findings/F<n>-name/ in the workbase), where, the PoC, Copy for LLM, its triage
 * (disposition with keys R K D W I, final severity, duplicate of, note), the disclosure for the ones to report,
 * other findings triaged as its duplicates, and its history. Triage goes to TRIAGE.md and TRIAGED.md for later
 * agents; nothing is sent to the run.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IconAlertTriangle, IconChevronDown, IconChevronRight, IconCopy, IconExternalLink, IconFileCode, IconFileText, IconFolder } from "@tabler/icons-react";
import { Markdown } from "../../components/Markdown.tsx";
import { cn } from "../../lib/cn.ts";
import {
  copyForLlm,
  defaultPurpose,
  DISCLOSURE_LABEL,
  disclosureOf,
  DISPOSITIONS,
  dispositionLabel,
  FINAL_SEVERITIES,
  finalSev,
  LLM_PURPOSES,
  refOf,
  sevChanged,
  sevOf,
  STATE_WORD,
  useDisclosure,
  useFindingEvents,
  useFindings,
  useTriage,
} from "../../lib/findings.ts";
import { runName } from "../../lib/fleet.ts";
import { age } from "../../lib/health.ts";
import { day } from "../../lib/format.ts";
import { openRun } from "../../lib/actions.ts";
import type { Disposition, Finding, FindingEvent, Run } from "../../lib/types.ts";
import { Button } from "../../components/ui.tsx";
import { Menu, Select } from "../../components/ui/overlay.tsx";
import { toast } from "../../components/Toast.tsx";
import { Hue, IC_XS, Kbd, Sep, Sev } from "../../components/ui/bits.tsx";

const FIELD: Record<string, string> = { state: "state", severity: "severity", title: "title", summary: "summary", location: "location", poc: "PoC", class: "class", agent_duplicate_of: "duplicate of" };
const OLD_VERDICT: Record<string, string> = { real: "real", not_bug: "not a bug", duplicate: "duplicate", needs_work: "needs more work" };
const who = (by: unknown) => (typeof by === "string" && by.startsWith("MCP: ") ? `${by.slice(5)} (MCP)` : "You");

function describe(e: FindingEvent) {
  if (e.action === "add") return "Added";
  if (e.action === "remove") return "Removed";
  if (e.action === "verdict") {
    const v = e.changes?.verdict?.[1] as string | null;
    return v ? `${who(e.changes?.by?.[1])}: ${OLD_VERDICT[v] ?? v}` : `${who(e.changes?.by?.[1])} cleared the verdict`;
  }
  if (e.action === "triage") {
    const c = e.changes ?? {};
    const parts: string[] = [];
    if (c.disposition) parts.push(c.disposition[1] ? dispositionLabel(String(c.disposition[1])).toLowerCase() : "cleared the triage");
    if (c.duplicate_of?.[1]) parts.push(`of ${c.duplicate_of[1]}`);
    if (c.severity_final) parts.push(c.severity_final[1] ? `severity ${c.severity_final[1]}` : "severity back to the agent's");
    return `${who(c.by?.[1])}: ${parts.join(", ") || "note"}`;
  }
  if (e.action === "disclosure") {
    const d = e.changes?.disclosure?.[1] as string | undefined;
    const words: Record<string, string> = { ready: "back to not sent", reported: "sent upstream", fixed: "fixed upstream", dropped: "dropped" };
    return d ? `Disclosure ${words[d] ?? d}` : e.changes?.report_url ? "Report link changed" : e.changes?.fix_ref ? "Fix changed" : "Disclosure note";
  }
  const parts = Object.entries(e.changes ?? {}).map(([k, [a, b]]) =>
    k === "state" ? `${STATE_WORD[String(a)] ?? a} to ${STATE_WORD[String(b)] ?? b}` : k === "severity" ? `severity ${a ?? "none"} to ${b}` : `${FIELD[k] ?? k} changed`,
  );
  return parts.length ? parts.join(", ").replace(/^./, (c) => c.toUpperCase()) : "Note";
}

/** "Copy for LLM" with what to ask for: the default for this finding on the button, the others in its menu. */
export function CopyLlm({ f }: { f: Finding }) {
  const purpose = defaultPurpose(f);
  const copy = (p: (typeof LLM_PURPOSES)[number]["v"]) =>
    copyForLlm(f, p).then(
      () => toast(`Copied ${f.id} for an LLM, ${LLM_PURPOSES.find((x) => x.v === p)!.label.toLowerCase()}`),
      (e) => toast((e as Error).message, "error"),
    );
  return (
    <span className="inline-flex">
      <Button size="xs" className="rounded-r-none" onClick={() => copy(purpose)} title={`The README, PoC, small files and what's triaged in the project as one text, with a token to download the rest. Asks it ${LLM_PURPOSES.find((x) => x.v === purpose)!.label.toLowerCase()}.`}>
        <IconCopy {...IC_XS} />
        Copy for LLM
      </Button>
      <Menu
        trigger={
          <Button size="xs" icon className="-ml-px rounded-l-none" aria-label="Copy for LLM, asking for">
            <IconChevronDown {...IC_XS} />
          </Button>
        }
        items={[{ head: "Copy for an LLM, asking it" }, ...LLM_PURPOSES.map((p) => ({ label: p.label, hint: p.v === purpose ? "default" : undefined, onSelect: () => void copy(p.v) }))]}
      />
    </span>
  );
}

function Box({ title, right, children }: { title: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="@container flex flex-col gap-3 rounded-xl border border-line-2 bg-s2 px-4 py-3.5">
      <div className="flex items-baseline gap-3 text-[12.5px] text-ink-3">
        <span>{title}</span>
        {right && <span className="ml-auto truncate text-xs">{right}</span>}
      </div>
      {children}
    </div>
  );
}

const fieldClass = "h-[30px] min-w-0 flex-1 rounded-lg border border-line bg-s1 px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-4 focus:border-ink-3";

/** Disposition, final severity, duplicate of and note. Clicking a disposition saves it (again clears it). */
function TriageBox({ f, all, onTriaged, open }: { f: Finding; all: Finding[]; onTriaged?: () => void; open: (f: Finding) => void }) {
  const triage = useTriage();
  const [note, setNote] = useState(f.disposition_note ?? "");
  useEffect(() => setNote(f.disposition_note ?? ""), [f.run_id, f.id, f.disposition_note]);
  // Picking what it duplicates before saving duplicate (when neither you nor the agent named one).
  const [picking, setPicking] = useState(false);
  useEffect(() => setPicking(false), [f.run_id, f.id]);

  // Same project first: that's where a duplicate lives. This run's findings, then the rest by run.
  const candidates = useMemo(
    () =>
      all
        .filter((x) => !x.removed_at && refOf(x) !== refOf(f) && (x.repo === f.repo || x.run_id === f.run_id))
        .sort((a, b) => Number(b.run_id === f.run_id) - Number(a.run_id === f.run_id) || a.run_id.localeCompare(b.run_id) || a.id.localeCompare(b.id, undefined, { numeric: true })),
    [all, f],
  );
  const save = (body: Parameters<typeof triage.mutate>[0], advance = false) => triage.mutate(body, { onSuccess: () => advance && onTriaged?.() });

  const choose = (d: Disposition) => {
    if (f.disposition === d) return save({ f, disposition: null, note });
    if (d === "duplicate" && !f.duplicate_of && !f.agent_duplicate_of) return setPicking(true);
    setPicking(false);
    save({ f, disposition: d, note, duplicate_of: d === "duplicate" ? (f.duplicate_of ?? f.agent_duplicate_of) : undefined }, !f.disposition);
  };

  // R K D W I while this finding is open (not while typing or in a menu).
  const chooseRef = useRef(choose);
  chooseRef.current = choose;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest("input, textarea, select, [role=menu]")) return;
      const d = DISPOSITIONS.find((x) => x.key === e.key.toLowerCase());
      if (d) {
        e.preventDefault();
        chooseRef.current(d.v);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const sev = f.severity_final ?? f.severity;
  const dupTarget = f.duplicate_of ? all.find((x) => refOf(x) === f.duplicate_of) : null;
  const showDup = picking || f.disposition === "duplicate";
  const by = f.disposition ? `${who(f.disposition_by) === "You" ? "you" : who(f.disposition_by)}, ${age(f.disposition_at)} ago` : null;

  return (
    <Box title="Triage, written to TRIAGE.md for later agents" right={by}>
      <div className="grid grid-cols-5 gap-1.5 max-md:grid-cols-2">
        {DISPOSITIONS.map((d) => (
          <button
            key={d.v}
            type="button"
            aria-pressed={f.disposition === d.v || (d.v === "duplicate" && picking)}
            disabled={triage.isPending}
            onClick={() => choose(d.v)}
            title={d.hint}
            className={cn(
              "flex min-w-0 cursor-pointer flex-col items-start gap-[3px] rounded-lg border border-line bg-s1 px-2.5 py-2 text-left text-ink hover:border-ink-4 aria-pressed:border-ink aria-pressed:bg-s3",
              d.v === "report" && "aria-pressed:border-good",
            )}
          >
            <b className="flex w-full items-center gap-1.5 text-[13px] font-medium">
              {d.label}
              <Kbd className="ml-auto">{d.key.toUpperCase()}</Kbd>
            </b>
            <small className="hidden text-[11.5px] leading-tight text-ink-3 @min-[34rem]:block">{d.hint}</small>
          </button>
        ))}
      </div>

      {showDup && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] text-ink-3">{picking ? "Duplicate of which finding?" : "Duplicate of"}</span>
          <Select
            field
            label="Duplicate of"
            value={f.duplicate_of ?? ""}
            onChange={(ref) => {
              setPicking(false);
              save({ f, disposition: "duplicate", duplicate_of: ref, note }, !f.disposition);
            }}
            options={[
              ...(f.duplicate_of && !dupTarget ? [{ value: f.duplicate_of, label: f.duplicate_of }] : []),
              ...(!f.duplicate_of ? [{ value: "", label: "Pick the finding it repeats" }] : []),
              ...candidates.map((x) => ({ value: refOf(x), label: `${x.run_id === f.run_id ? x.id : refOf(x)} ${x.title}`, hint: x.disposition ? dispositionLabel(x.disposition).toLowerCase() : undefined })),
            ]}
          />
          {dupTarget && (
            <button type="button" className="cursor-pointer self-start border-0 bg-transparent p-0 text-left text-[12.5px] text-ink-2 underline decoration-ink-4 underline-offset-[3px] hover:text-ink" onClick={() => open(dupTarget)}>
              Open {dupTarget.run_id === f.run_id ? dupTarget.id : refOf(dupTarget)}
            </button>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-[12.5px] text-ink-3">Severity{sevChanged(f) ? `, the agent said ${f.severity ?? "none"}` : ""}</span>
        <div role="radiogroup" aria-label="Final severity" className="flex flex-wrap gap-1">
          {FINAL_SEVERITIES.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={sev === s}
              disabled={triage.isPending}
              onClick={() => save({ f, severity: s === f.severity ? null : s })}
              title={s === f.severity ? "The agent's severity" : s === "none" ? "No security impact" : undefined}
              className="inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded-md border border-line bg-s1 px-2 text-xs text-ink-2 capitalize hover:border-ink-4 aria-checked:border-ink aria-checked:bg-s3 aria-checked:text-ink"
            >
              <Sev sev={s === "none" ? "info" : s} />
              {s === "none" ? <span className="normal-case">No impact</span> : s}
              {s === f.severity && <span className="text-[10.5px] text-ink-4 normal-case">agent</span>}
            </button>
          ))}
        </div>
      </div>

      <textarea
        rows={2}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Why (for known: where it's public, CVE or issue)"
        className="min-h-[56px] w-full resize-y rounded-lg border border-line bg-s1 px-2.5 py-2 text-ink outline-none placeholder:text-ink-4 focus:border-ink-3"
      />
      {note !== (f.disposition_note ?? "") && (
        <div>
          <Button size="xs" onClick={() => save({ f, note })} disabled={triage.isPending}>
            Save note
          </Button>
        </div>
      )}
    </Box>
  );
}

const STEPS = ["ready", "reported", "fixed"] as const;

/** Not sent, sent (with the advisory link), fixed (with the version or commit), or dropped with a reason. Only for Report. */
function DisclosureBox({ f }: { f: Finding }) {
  const disclose = useDisclosure();
  const d = disclosureOf(f)!;
  const [url, setUrl] = useState(f.report_url ?? "");
  const [fix, setFix] = useState(f.fix_ref ?? "");
  const [dropping, setDropping] = useState(false);
  const [reason, setReason] = useState("");
  const [editLink, setEditLink] = useState(false);
  useEffect(() => {
    setUrl(f.report_url ?? "");
    setFix(f.fix_ref ?? "");
    setDropping(false);
    setReason("");
    setEditLink(false);
  }, [f.run_id, f.id, f.report_url, f.fix_ref, f.disclosure]);
  const busy = disclose.isPending;
  const set = (body: Omit<Parameters<typeof disclose.mutate>[0], "f">, msg: string) => disclose.mutate({ f, ...body }, { onSuccess: () => toast(`${f.id}: ${msg}`) });
  const at = STEPS.indexOf(d as (typeof STEPS)[number]);

  return (
    <Box
      title="Disclosure, set only here"
      right={
        <span className="inline-flex items-center gap-1">
          {d === "dropped" ? (
            <span className="text-ink-2">Dropped</span>
          ) : (
            STEPS.map((s, i) => (
              <span key={s} className="inline-flex items-center gap-1">
                {i > 0 && <IconChevronRight size={10} stroke={2} className="text-ink-4" />}
                <span className={cn(i < at && "text-ink-2", i === at && "font-medium text-ink", i > at && "text-ink-4")}>{DISCLOSURE_LABEL[s]}</span>
              </span>
            ))
          )}
        </span>
      }
    >
      {(d === "reported" || d === "fixed") && (
        <div className="text-[13px] text-ink-2">
          Sent {day(f.reported_at)}
          {f.report_url && (
            <a href={f.report_url} target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-1 text-ink underline decoration-ink-4 underline-offset-[3px] hover:decoration-ink">
              {f.report_url.replace(/^https?:\/\//, "").slice(0, 60)}
              <IconExternalLink {...IC_XS} />
            </a>
          )}
          {d === "fixed" && (
            <>
              <Sep />
              Fixed {day(f.fixed_at)}
              {f.fix_ref ? ` in ${f.fix_ref}` : ""}
            </>
          )}
        </div>
      )}
      {d === "dropped" && <div className="text-[13px] text-ink-2">{f.disclosure_note}</div>}

      {(d === "ready" || (d === "reported" && editLink)) && (
        <div className="flex gap-1.5 max-md:flex-col">
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Advisory or issue link (optional)" className={fieldClass} aria-label="Report link" autoFocus={editLink} />
          {d === "ready" ? (
            <Button size="sm" variant="primary" disabled={busy} onClick={() => set({ disclosure: "reported", report_url: url.trim() || null }, "sent upstream")}>
              Mark sent
            </Button>
          ) : (
            <Button size="sm" disabled={busy || url === (f.report_url ?? "")} onClick={() => set({ report_url: url.trim() || null }, "report link saved")}>
              Save link
            </Button>
          )}
        </div>
      )}
      {d === "reported" && (
        <div className="flex gap-1.5 max-md:flex-col">
          <input value={fix} onChange={(e) => setFix(e.target.value)} placeholder="Version or commit with the fix" className={fieldClass} aria-label="Fix" />
          <Button size="sm" variant="primary" disabled={busy} onClick={() => set({ disclosure: "fixed", fix_ref: fix.trim() || null }, "fixed upstream")}>
            Mark fixed
          </Button>
        </div>
      )}

      {dropping ? (
        <div className="flex gap-1.5 max-md:flex-col">
          <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it's dropped" className={fieldClass} aria-label="Why it's dropped" onKeyDown={(e) => e.key === "Escape" && setDropping(false)} />
          <Button size="sm" variant="danger" disabled={busy || !reason.trim()} onClick={() => set({ disclosure: "dropped", note: reason.trim() }, "dropped")}>
            Drop
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDropping(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1">
          {d === "reported" && !editLink && (
            <Button size="xs" variant="ghost" onClick={() => setEditLink(true)}>
              {f.report_url ? "Change link" : "Add link"}
            </Button>
          )}
          {d === "reported" && (
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => set({ disclosure: "ready", reported_at: null }, "back to not sent")}>
              Back to not sent
            </Button>
          )}
          {d === "fixed" && (
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => set({ disclosure: "reported" }, "back to sent")}>
              Not fixed after all
            </Button>
          )}
          {d === "dropped" && (
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => set({ disclosure: "ready", note: null }, "back to not sent")}>
              Take it back
            </Button>
          )}
          {d !== "dropped" && d !== "fixed" && (
            <Button size="xs" variant="ghost" onClick={() => setDropping(true)}>
              Drop
            </Button>
          )}
        </div>
      )}
    </Box>
  );
}

/** `onOpen`: show another finding (a duplicate's original); by default it opens in its run. */
export function FindingDetail({ f, run, showRun = true, onTriaged, onOpen }: { f: Finding; run?: Run; showRun?: boolean; onTriaged?: () => void; onOpen?: (f: Finding) => void }) {
  const open = onOpen ?? ((x: Finding) => openRun(x.run_id, `findings/${x.id}`));
  const events = useFindingEvents(f.run_id).data?.filter((e) => e.finding_id === f.id) ?? [];
  const all = useFindings() ?? [];
  const triage = useTriage();
  const dupes = all.filter((x) => x.duplicate_of === refOf(f) && !x.removed_at);
  const agentDup = !f.disposition && f.agent_duplicate_of ? all.find((x) => refOf(x) === f.agent_duplicate_of) : null;
  const sev = finalSev(f);

  return (
    <article className="flex min-w-0 flex-col gap-[18px] px-6 pt-[22px] pb-[26px]">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 font-mono text-xs text-ink-3">
          <Sev sev={sevOf(f)}>{sev === "none" ? "no impact" : (sev ?? "no severity")}</Sev>
          {sevChanged(f) && <s className="-ml-2 text-ink-4">{f.severity ?? "none"}</s>}
          <span>{f.id}</span>
          <span>{f.removed_at ? `removed: ${f.removed_reason}` : STATE_WORD[f.state]}</span>
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
      {f.problem && (
        <div className="flex items-start gap-2 text-[12.5px] text-warning">
          <IconAlertTriangle {...IC_XS} className="mt-0.5 shrink-0" />
          <span>Pixel couldn't read all of {f.path ?? "the README"}: {f.problem}</span>
        </div>
      )}
      {f.agent_duplicate_of && !f.disposition && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line-2 px-3 py-2 text-[13px] text-ink-2">
          <span className="min-w-0">
            The agent says this repeats <b className="font-medium text-ink">{f.agent_duplicate_of}</b>
            {agentDup && <span className="text-ink-3">, {agentDup.title}{agentDup.disposition ? ` (${dispositionLabel(agentDup.disposition).toLowerCase()})` : ""}</span>}
          </span>
          <Button size="xs" className="ml-auto" disabled={triage.isPending} onClick={() => triage.mutate({ f, disposition: "duplicate", duplicate_of: f.agent_duplicate_of }, { onSuccess: () => onTriaged?.() })}>
            Mark duplicate
          </Button>
        </div>
      )}
      {f.summary && <Markdown text={f.summary} className="max-w-[72ch] leading-relaxed text-ink" />}
      <div className="flex flex-wrap gap-1.5">
        {f.path && (
          <Button size="xs" onClick={() => openRun(f.run_id, `files/${f.path}`)}>
            <IconFolder {...IC_XS} />
            {f.path.replace(/\/README\.md$/, "/")}
          </Button>
        )}
        {f.poc && (
          <Button size="xs" onClick={() => openRun(f.run_id, `files/${f.poc}`)}>
            <IconFileCode {...IC_XS} />
            {f.path && f.poc.startsWith(f.path.replace(/README\.md$/, "")) ? f.poc.slice(f.path.length - "README.md".length) : f.poc}
          </Button>
        )}
        <CopyLlm f={f} />
        {run?.report_ready ? (
          <Button size="xs" variant="ghost" onClick={() => openRun(f.run_id, "report")}>
            <IconFileText {...IC_XS} />
            REPORT.md
          </Button>
        ) : null}
      </div>

      {f.state !== "lead" && !f.removed_at && <TriageBox f={f} all={all} onTriaged={onTriaged} open={open} />}
      {f.disposition === "report" && !f.removed_at && <DisclosureBox f={f} />}

      {dupes.length > 0 && (
        <div>
          <div className="mb-2 text-[12.5px] text-ink-3">Triaged as duplicates of this</div>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
            {dupes.map((x) => (
              <li key={refOf(x)}>
                <button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-left text-ink-2 hover:text-ink" onClick={() => open(x)}>
                  <span className="font-mono text-xs text-ink-3">{x.run_id === f.run_id ? x.id : refOf(x)}</span> {x.title}
                </button>
              </li>
            ))}
          </ul>
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
                  {e.note && (
                    <span className="text-ink-3">
                      <Sep />
                      {e.note}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

