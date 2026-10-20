/**
 * One finding, laid out like the run view: a toolbar (check on latest upstream, hunt variants, Copy for LLM,
 * files), the README in a centred reading column with its history, and a facts column: triage (keys R K D W I,
 * final severity, duplicate of, note), disclosure with its deadline, the latest upstream check, runs started
 * from the finding, and related findings in the project. Triage goes to TRIAGE.md and TRIAGED.md; nothing is
 * sent to the run.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  IconAlertTriangle,
  IconChevronDown,
  IconCircleCheck,
  IconCopy,
  IconExternalLink,
  IconFileCode,
  IconFolder,
  IconGitFork,
  IconHelpCircle,
  IconRefresh,
} from "@tabler/icons-react";
import { Markdown } from "../../components/Markdown.tsx";
import { ModelSelect } from "../../components/ModelSelect.tsx";
import { cn } from "../../lib/cn.ts";
import {
  copyForLlm,
  deadlineOf,
  defaultPurpose,
  disclosureOf,
  DISPOSITIONS,
  dispositionLabel,
  FINAL_SEVERITIES,
  finalSev,
  LLM_PURPOSES,
  refOf,
  sevChanged,
  sevOf,
  startFindingRun,
  STATE_WORD,
  useDisclosure,
  useFindingEvents,
  useFindings,
  useTriage,
  type FindingRunKind,
} from "../../lib/findings.ts";
import { runName } from "../../lib/fleet.ts";
import { age } from "../../lib/health.ts";
import { day } from "../../lib/format.ts";
import { openRun } from "../../lib/actions.ts";
import { ACTIVE, useRuns } from "../../lib/runs.ts";
import { api } from "../../lib/api.ts";
import type { Disposition, Finding, FindingEvent, Run } from "../../lib/types.ts";
import { Button } from "../../components/ui.tsx";
import { Dialog, Menu, Select } from "../../components/ui/overlay.tsx";
import { toast } from "../../components/Toast.tsx";
import { Hue, IC_SM, IC_XS, Sep, Sev } from "../../components/ui/bits.tsx";
import { repoName } from "./FindingsTable.tsx";

const FIELD: Record<string, string> = { state: "state", severity: "severity", title: "title", summary: "summary", location: "location", poc: "PoC", class: "class", agent_duplicate_of: "duplicate of" };
const OLD_VERDICT: Record<string, string> = { real: "real", not_bug: "not a bug", duplicate: "duplicate", needs_work: "needs more work" };
const UPSTREAM_WORD: Record<string, string> = { present: "still present", fixed: "fixed", changed: "changed", unclear: "unclear" };
const who = (by: unknown) => (typeof by === "string" && by.startsWith("MCP: ") ? `${by.slice(5)} (MCP)` : "You");
const sevWord = (s: string | null | undefined) => (s === "none" ? "no impact" : (s ?? "no severity"));
const fileOf = (loc: string | null | undefined) => loc?.split(/[:\s]/)[0] || null;
const shortRef = (ref: string, runId: string) => (ref.startsWith(`${runId}/`) ? ref.slice(runId.length + 1) : ref);

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
    if (d) return `Disclosure ${words[d] ?? d}`;
    if (e.changes?.deadline) return `Deadline moved to ${day(Number(e.changes.deadline[1]))}`;
    return e.changes?.report_url ? "Report link changed" : e.changes?.fix_ref ? "Fix changed" : "Disclosure note";
  }
  if (e.action === "upstream") return `Latest upstream: ${UPSTREAM_WORD[String(e.changes?.upstream_status?.[1])] ?? "checked"}`;
  const parts = Object.entries(e.changes ?? {}).map(([k, [a, b]]) =>
    k === "state" ? `${STATE_WORD[String(a)] ?? a} to ${STATE_WORD[String(b)] ?? b}` : k === "severity" ? `severity ${a ?? "none"} to ${b}` : `${FIELD[k] ?? k} changed`,
  );
  return parts.length ? parts.join(", ").replace(/^./, (c) => c.toUpperCase()) : "Note";
}

/** "Copy for LLM" with what to ask for: the default for this finding on the button, the others in its menu. */
export function CopyLlm({ f, size = "sm" }: { f: Finding; size?: "xs" | "sm" }) {
  const purpose = defaultPurpose(f);
  const label = (p: string) => LLM_PURPOSES.find((x) => x.v === p)!.label.toLowerCase();
  const copy = (p: (typeof LLM_PURPOSES)[number]["v"]) =>
    copyForLlm(f, p).then(
      () => toast(`Copied ${f.id} for an LLM, ${label(p)}`),
      (e) => toast((e as Error).message, "error"),
    );
  return (
    <span className="inline-flex">
      <Button size={size} className="rounded-r-none" onClick={() => copy(purpose)} title={`The README, PoC, small files and what's triaged in the project as one text, asking it ${label(purpose)}`}>
        <IconCopy {...IC_XS} />
        Copy for LLM
        {purpose === "disclose" && <span className="font-normal text-ink-3">disclosure</span>}
      </Button>
      <Menu
        trigger={
          <Button size={size} icon className="-ml-px rounded-l-none" aria-label="Copy for LLM, asking for">
            <IconChevronDown {...IC_XS} />
          </Button>
        }
        items={[{ head: "Copy for an LLM, asking it" }, ...LLM_PURPOSES.map((p) => ({ label: p.label, hint: p.v === purpose ? "default" : undefined, onSelect: () => void copy(p.v) }))]}
      />
    </span>
  );
}

// ---- start a run from a finding ----

const KINDS: { v: FindingRunKind; icon: ReactNode; label: string; hint: string; when: string }[] = [
  {
    v: "check",
    icon: <IconRefresh {...IC_SM} />,
    label: "Check on latest upstream",
    hint: "A fresh clone of the newest code: build, run the PoC, and answer still present, fixed or changed, with the trace or the fixing commit.",
    when: "Light machine, usually minutes",
  },
  {
    v: "variants",
    icon: <IconGitFork {...IC_SM} />,
    label: "Hunt variants",
    hint: "The same root cause elsewhere: other callers, copied code, sibling handlers. Its findings are its own and point back here.",
    when: "Runs like an audit, until it stops finding",
  },
];

export function StartRunDialog({ f, run, kind, onClose }: { f: Finding; run?: Run; kind: FindingRunKind; onClose: () => void }) {
  const [k, setK] = useState(kind);
  const [ref, setRef] = useState(run?.ref ?? "");
  const [model, setModel] = useState(run?.model ?? "");
  const [size, setSize] = useState("");
  const [busy, setBusy] = useState(false);
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 60_000 }).data;
  const presets = Object.entries(settings?.sizePresets ?? {});
  const auto = k === "check" && settings?.sizePresets.light ? "light" : (settings?.defaultSize ?? "default");
  const start = async () => {
    setBusy(true);
    try {
      const r = await startFindingRun(f, { kind: k, ref: ref.trim() || null, model: model || undefined, size: size || undefined });
      toast(`Started ${r.label ?? r.id}`);
      onClose();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="md"
      title={`Start a run from ${f.id}`}
      description={`${f.title}, ${repoName(f.repo)}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !model} onClick={start}>
            {k === "check" ? "Start check" : "Start hunt"}
          </Button>
        </>
      }
    >
      <div role="radiogroup" aria-label="What to run" className="grid grid-cols-2 gap-2 max-sm:grid-cols-1">
        {KINDS.map((x) => (
          <button
            key={x.v}
            type="button"
            role="radio"
            aria-checked={k === x.v}
            onClick={() => setK(x.v)}
            className="flex cursor-pointer flex-col gap-1.5 rounded-xl border border-line bg-s1 px-3.5 py-3 text-left hover:border-ink-4 aria-checked:border-ink aria-checked:bg-s3"
          >
            <span className="flex items-center gap-2 text-[13.5px] font-medium [&>svg]:text-ink-2">
              {x.icon}
              {x.label}
            </span>
            <span className="text-[12.5px] leading-snug text-ink-2">{x.hint}</span>
            <span className="font-mono text-[11.5px] text-ink-3">{x.when}</span>
          </button>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2.5 max-sm:grid-cols-1">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-ink-3">Branch or tag</span>
          <input className="input font-mono text-[12.5px]" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="default branch" />
        </label>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-ink-3">Model</span>
          <ModelSelect value={model} onChange={setModel} compact />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-ink-3">Machine</span>
          <Select field label="Machine" value={size} onChange={setSize} options={[{ value: "", label: `Auto, ${auto}` }, ...presets.map(([name, p]) => ({ value: name, label: name, hint: `${p.cpu} CPU, ${p.memoryGiB} GB` }))]} />
        </div>
      </div>
      <div className="flex flex-col gap-1 rounded-lg border border-line-2 bg-s2 px-3 py-2.5 text-[12.5px] text-ink-2">
        <span>The agent gets {f.id}'s write-up, PoC and logs (the original workbase, read-only) and the same tools as an audit.</span>
        <span className="text-ink-3">{k === "check" ? `Its answer shows on ${f.id} as the latest upstream check.` : `It shows under Runs from this finding; its findings go to triage like any run's.`}</span>
      </div>
    </Dialog>
  );
}

// ---- facts column ----

function Fact({ title, right, children }: { title: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 border-t border-line-2 py-4 first:border-t-0 first:pt-1">
      <div className="flex items-baseline gap-2 text-xs text-ink-3">
        <span>{title}</span>
        {right && <span className="ml-auto truncate">{right}</span>}
      </div>
      {children}
    </section>
  );
}

const fieldClass = "h-[30px] w-full min-w-0 rounded-lg border border-line bg-s1 px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-4 focus:border-ink-3";

function TriageFact({ f, all, onTriaged, open }: { f: Finding; all: Finding[]; onTriaged?: () => void; open: (f: Finding) => void }) {
  const triage = useTriage();
  const [note, setNote] = useState(f.disposition_note ?? "");
  useEffect(() => setNote(f.disposition_note ?? ""), [f.run_id, f.id, f.disposition_note]);
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
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest("input, textarea, select, [role=menu], [role=dialog]")) return;
      const d = DISPOSITIONS.find((x) => x.key === e.key.toLowerCase());
      if (d) {
        e.preventDefault();
        chooseRef.current(d.v);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const dupTarget = f.duplicate_of ? all.find((x) => refOf(x) === f.duplicate_of) : null;
  const showDup = picking || f.disposition === "duplicate";
  const sev = finalSev(f);
  const by = f.disposition ? `${who(f.disposition_by) === "You" ? "you" : who(f.disposition_by)}, ${age(f.disposition_at)}` : "keys R K D W I";

  return (
    <Fact title="Triage" right={by}>
      <div className="grid grid-cols-5 gap-1">
        {DISPOSITIONS.map((d) => (
          <button
            key={d.v}
            type="button"
            aria-pressed={f.disposition === d.v || (d.v === "duplicate" && picking)}
            disabled={triage.isPending}
            onClick={() => choose(d.v)}
            title={`${d.hint} (${d.key.toUpperCase()})`}
            className={cn(
              "h-[30px] min-w-0 cursor-pointer truncate rounded-lg border border-line px-1 text-[12px] text-ink-2 hover:border-ink-4 hover:text-ink aria-pressed:border-ink aria-pressed:bg-s3 aria-pressed:font-medium aria-pressed:text-ink",
              d.v === "report" && "aria-pressed:border-good",
            )}
          >
            {d.v === "duplicate" ? "Dup" : d.label}
          </button>
        ))}
      </div>
      {showDup && (
        <div className="flex flex-col gap-1.5">
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
              ...(!f.duplicate_of ? [{ value: "", label: "Duplicate of which finding?" }] : []),
              ...candidates.map((x) => ({ value: refOf(x), label: `${shortRef(refOf(x), f.run_id)} ${x.title}`, hint: x.disposition ? dispositionLabel(x.disposition).toLowerCase() : undefined })),
            ]}
          />
          {dupTarget && (
            <button type="button" className="cursor-pointer self-start text-left text-[12.5px] text-ink-2 underline decoration-ink-4 underline-offset-[3px] hover:text-ink" onClick={() => open(dupTarget)}>
              Open {shortRef(refOf(dupTarget), f.run_id)}
            </button>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 text-[13px]">
        <Menu
          align="start"
          trigger={
            <button type="button" className="inline-flex h-[28px] cursor-pointer items-center gap-1.5 rounded-lg border border-line px-2 text-ink hover:border-ink-4" aria-label="Final severity">
              <Sev sev={sevOf(f)} />
              <span className="capitalize">{sevWord(sev)}</span>
              <IconChevronDown {...IC_XS} className="text-ink-3" />
            </button>
          }
          items={FINAL_SEVERITIES.map((s) => ({ label: <span className="capitalize">{sevWord(s)}</span>, checked: sev === s, hint: s === f.severity ? "agent" : undefined, onSelect: () => save({ f, severity: s === f.severity ? null : s }) }))}
        />
        <span className="truncate text-xs text-ink-3">{sevChanged(f) ? `the agent said ${f.severity ?? "none"}` : f.severity ? "agrees with the agent" : ""}</span>
      </div>
      <textarea
        rows={2}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Why (for known: the CVE or issue)"
        className="min-h-[52px] w-full resize-y rounded-lg border border-line bg-s1 px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-4 focus:border-ink-3"
      />
      {note !== (f.disposition_note ?? "") && (
        <div>
          <Button size="xs" onClick={() => save({ f, note })} disabled={triage.isPending}>
            Save note
          </Button>
        </div>
      )}
    </Fact>
  );
}

function Step({ state, label, detail, last }: { state: "done" | "now" | "todo"; label: ReactNode; detail?: ReactNode; last?: boolean }) {
  return (
    <div className="grid grid-cols-[14px_minmax(0,1fr)] gap-x-2.5">
      <span className="flex flex-col items-center">
        <span className={cn("mt-[5px] size-[9px] shrink-0 rounded-full", state === "done" ? "bg-ink-2" : state === "now" ? "ring-2 ring-ink ring-inset" : "ring-[1.5px] ring-ink-4 ring-inset")} />
        {!last && <span className="min-h-3 w-px flex-1 bg-line" />}
      </span>
      <span className={cn("min-w-0 pb-2.5 text-[13px]", state === "todo" ? "text-ink-3" : "text-ink", state === "now" && "font-medium")}>
        {label}
        {detail && <span className="block text-xs font-normal text-ink-3">{detail}</span>}
      </span>
    </div>
  );
}

const TONE_TEXT: Record<string, string> = { bad: "text-critical", warn: "text-warning", "": "text-ink-2" };
const TONE_BAR: Record<string, string> = { bad: "bg-critical", warn: "bg-warning", "": "bg-ink-3" };

function DisclosureFact({ f }: { f: Finding }) {
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
  const dl = deadlineOf(f);
  const link = f.report_url && (
    <a href={f.report_url} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 text-ink-2 underline decoration-ink-4 underline-offset-[3px] hover:text-ink">
      <span className="truncate">{f.report_url.replace(/^https?:\/\/(www\.)?/, "")}</span>
      <IconExternalLink {...IC_XS} className="shrink-0" />
    </a>
  );
  const sent = d === "reported" || d === "fixed";

  return (
    <Fact title="Disclosure" right="set by you only">
      <div>
        <Step state={d === "ready" ? "now" : "done"} label="Not sent" detail={d === "ready" ? "The deadline clock starts when you send it" : undefined} />
        <Step state={d === "reported" ? "now" : sent || d === "dropped" ? "done" : "todo"} label={f.reported_at ? `Sent ${day(f.reported_at)}` : "Sent"} detail={sent || (d === "dropped" && f.reported_at) ? link : undefined} />
        {d === "dropped" ? (
          <Step state="now" label="Dropped" detail={f.disclosure_note} last />
        ) : (
          <Step state={d === "fixed" ? "now" : "todo"} label={d === "fixed" ? `Fixed ${day(f.fixed_at)}` : "Fixed"} detail={d === "fixed" && f.fix_ref ? `in ${f.fix_ref}` : undefined} last />
        )}
      </div>

      {d === "reported" && dl && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline gap-2 font-mono text-[11.5px]">
            <span className="text-ink-3">
              day {dl.elapsed} of {dl.total}
            </span>
            <span className={cn("ml-auto", TONE_TEXT[dl.tone])}>
              {day(f.deadline)}, {dl.over ? `${dl.days}d over` : `${dl.days}d left`}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-s3">
            <div className={cn("h-full rounded-full", TONE_BAR[dl.tone])} style={{ width: `${Math.min(100, ((dl.elapsed ?? 0) / Math.max(1, dl.total ?? 1)) * 100)}%` }} />
          </div>
        </div>
      )}

      {(d === "ready" || (d === "reported" && editLink)) && (
        <div className="flex gap-1.5">
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Advisory or issue link" className={fieldClass} aria-label="Report link" autoFocus={editLink} />
          {d === "reported" && (
            <Button size="sm" disabled={busy || url === (f.report_url ?? "")} onClick={() => set({ report_url: url.trim() || null }, "report link saved")}>
              Save
            </Button>
          )}
        </div>
      )}
      {d === "reported" && <input value={fix} onChange={(e) => setFix(e.target.value)} placeholder="Version or commit with the fix" className={fieldClass} aria-label="Fix" />}

      {dropping ? (
        <div className="flex flex-col gap-1.5">
          <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it's dropped" className={fieldClass} aria-label="Why it's dropped" onKeyDown={(e) => e.key === "Escape" && setDropping(false)} />
          <div className="flex gap-1">
            <Button size="sm" variant="danger" disabled={busy || !reason.trim()} onClick={() => set({ disclosure: "dropped", note: reason.trim() }, "dropped")}>
              Drop
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDropping(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1">
          {d === "ready" && (
            <Button size="sm" variant="primary" disabled={busy} onClick={() => set({ disclosure: "reported", report_url: url.trim() || null }, "sent upstream")}>
              Mark sent
            </Button>
          )}
          {d === "reported" && (
            <>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => set({ disclosure: "fixed", fix_ref: fix.trim() || null }, "fixed upstream")}>
                Mark fixed
              </Button>
              <Button size="sm" disabled={busy} onClick={() => set({ extend_days: 30 }, "deadline moved 30 days")}>
                Extend 30 days
              </Button>
              {!editLink && (
                <Button size="sm" variant="ghost" onClick={() => setEditLink(true)}>
                  {f.report_url ? "Change link" : "Add link"}
                </Button>
              )}
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => set({ disclosure: "ready", reported_at: null }, "back to not sent")}>
                Not sent
              </Button>
            </>
          )}
          {d === "fixed" && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => set({ disclosure: "reported" }, "back to sent")}>
              Not fixed after all
            </Button>
          )}
          {d === "dropped" && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => set({ disclosure: "ready", note: null }, "back to not sent")}>
              Take it back
            </Button>
          )}
          {(d === "ready" || d === "reported") && (
            <Button size="sm" variant="ghost" onClick={() => setDropping(true)}>
              Drop
            </Button>
          )}
        </div>
      )}
    </Fact>
  );
}

function UpstreamFact({ f, checking, onCheck }: { f: Finding; checking: Run | undefined; onCheck: () => void }) {
  const st = f.upstream_status;
  const icon =
    st === "present" ? <IconCircleCheck {...IC_SM} className="mt-0.5 shrink-0 text-good" /> : st === "fixed" || st === "changed" ? <IconAlertTriangle {...IC_SM} className="mt-0.5 shrink-0 text-warning" /> : <IconHelpCircle {...IC_SM} className="mt-0.5 shrink-0 text-ink-3" />;
  const text =
    st === "present" ? "Still present" : st === "fixed" ? (f.upstream_fixed_by ? `Fixed by ${f.upstream_fixed_by.slice(0, 10)}` : "Fixed upstream") : st === "changed" ? "Code changed, the PoC no longer applies" : "Couldn't tell";
  return (
    <Fact
      title="Latest upstream"
      right={
        !checking && (
          <button type="button" onClick={onCheck} className="cursor-pointer text-ink-3 hover:text-ink">
            {st ? "Check again" : "Check"}
          </button>
        )
      }
    >
      {checking && (
        <button type="button" onClick={() => openRun(checking.id)} className="flex cursor-pointer items-center gap-2.5 text-left text-[13px] text-ink-2 hover:text-ink">
          <span className="size-1.5 shrink-0 rounded-full bg-good" />
          Checking, {age(checking.started_at ?? checking.created_at)}
        </button>
      )}
      {st ? (
        <div className="flex items-start gap-2.5 text-[13px]">
          {icon}
          <span className="min-w-0">
            {text}
            {f.upstream_commit && <span className="font-mono text-xs text-ink-2"> at {f.upstream_commit.slice(0, 10)}</span>}
            <span className="block text-xs text-ink-3">
              checked {age(f.upstream_at)} ago
              {f.upstream_run && (
                <>
                  <Sep />
                  <button type="button" className="cursor-pointer text-ink-3 underline decoration-ink-4 underline-offset-[3px] hover:text-ink" onClick={() => openRun(f.upstream_run!, "report")}>
                    answer
                  </button>
                </>
              )}
            </span>
          </span>
        </div>
      ) : (
        !checking && <span className="text-[13px] text-ink-3">Not checked</span>
      )}
    </Fact>
  );
}

function RunsFact({ f, runs }: { f: Finding; runs: Run[] }) {
  if (!runs.length) return null;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return (
    <Fact title="Runs from this finding">
      <div className="flex flex-col gap-1">
        {runs.map((r) => {
          const live = ACTIVE.includes(r.status);
          const counts = r.findings ? [r.findings.total ? plural(r.findings.total, "finding") : "", r.findings.leads ? plural(r.findings.leads, "lead") : ""].filter(Boolean).join(", ") : "";
          const result =
            r.source_kind === "check"
              ? f.upstream_run === r.id && f.upstream_status
                ? UPSTREAM_WORD[f.upstream_status]
                : live
                  ? "checking"
                  : r.status
              : counts || (live ? "looking" : "nothing found");
          return (
            <button key={r.id} type="button" onClick={() => openRun(r.id)} className="grid cursor-pointer grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md py-1 text-left text-[13px] hover:text-ink">
              <span className={cn("size-1.5 rounded-full", live ? "bg-good" : r.status === "failed" ? "bg-critical" : "bg-ink-4")} />
              <span className="truncate">
                {r.source_kind === "check" ? "Check" : "Variants"}
                <span className="text-ink-3">: {result}</span>
              </span>
              <span className="font-mono text-[11.5px] text-ink-3">{age(r.created_at)}</span>
            </button>
          );
        })}
      </div>
    </Fact>
  );
}

function RelatedFact({ f, all, open }: { f: Finding; all: Finding[]; open: (f: Finding) => void }) {
  const file = fileOf(f.location);
  const items: { f: Finding; why: string }[] = [];
  const add = (x: Finding | undefined, why: string) => {
    if (x && refOf(x) !== refOf(f) && !items.some((i) => refOf(i.f) === refOf(x))) items.push({ f: x, why });
  };
  const byRef = (ref: string | null) => (ref ? all.find((x) => refOf(x) === ref) : undefined);
  add(byRef(f.duplicate_of), "this duplicates it");
  if (!f.disposition) add(byRef(f.agent_duplicate_of), "the agent says this repeats it");
  for (const x of all) if (x.duplicate_of === refOf(f)) add(x, "duplicate of this");
  if (file)
    for (const x of all) {
      if (x.removed_at || x.repo !== f.repo || fileOf(x.location) !== file) continue;
      add(x, `same file, ${x.disposition ? dispositionLabel(x.disposition).toLowerCase() : STATE_WORD[x.state]}`);
    }
  if (!items.length) return null;
  const shown = items.slice(0, 6);
  return (
    <Fact title={`Related in ${repoName(f.repo).split("/").pop()}`} right={items.length > shown.length ? `${items.length - shown.length} more` : undefined}>
      <div className="flex flex-col gap-1">
        {shown.map(({ f: x, why }) => (
          <button key={refOf(x)} type="button" onClick={() => open(x)} className="grid cursor-pointer grid-cols-[8px_minmax(0,1fr)] items-baseline gap-x-2.5 rounded-md py-1 text-left text-[13px] hover:text-ink">
            <Sev sev={sevOf(x)} done={!!x.disposition && x.disposition !== "report"} className="translate-y-[-1px]" />
            <span className="min-w-0">
              <span className="line-clamp-2">
                <span className="font-mono text-xs text-ink-3">{shortRef(refOf(x), f.run_id)} </span>
                {x.title}
              </span>
              <span className="block text-xs text-ink-3">{why}</span>
            </span>
          </button>
        ))}
      </div>
    </Fact>
  );
}

// ---- the whole finding ----

/** `onOpen`: show another finding (a related one); by default it opens in its run. */
export function FindingDetail({ f, run, showRun = true, onTriaged, onOpen }: { f: Finding; run?: Run; showRun?: boolean; onTriaged?: () => void; onOpen?: (f: Finding) => void }) {
  const open = onOpen ?? ((x: Finding) => openRun(x.run_id, `findings/${x.id}`));
  const events = useFindingEvents(f.run_id).data?.filter((e) => e.finding_id === f.id) ?? [];
  const all = useFindings() ?? [];
  const { runs } = useRuns();
  const triage = useTriage();
  const [starting, setStarting] = useState<FindingRunKind | null>(null);
  const fromHere = (runs ?? []).filter((r) => r.source_finding === refOf(f)).sort((a, b) => b.created_at - a.created_at);
  const checking = fromHere.find((r) => r.source_kind === "check" && ACTIVE.includes(r.status));
  const agentDup = !f.disposition && f.agent_duplicate_of ? all.find((x) => refOf(x) === f.agent_duplicate_of) : null;
  const sev = finalSev(f);
  const triageable = f.state !== "lead" && !f.removed_at;
  const pocName = f.poc && f.path && f.poc.startsWith(f.path.replace(/README\.md$/, "")) ? f.poc.slice(f.path.length - "README.md".length) : f.poc;

  return (
    <div className="@container flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line-2 px-4 py-2.5">
        <Button size="sm" onClick={() => setStarting("check")} title="Start a run that checks whether the bug is still in the latest code">
          <IconRefresh {...IC_XS} />
          Check on latest
        </Button>
        <Button size="sm" onClick={() => setStarting("variants")} title="Start a run that looks for the same root cause elsewhere">
          <IconGitFork {...IC_XS} />
          Hunt variants
        </Button>
        <CopyLlm f={f} />
        <span className="ml-auto flex items-center gap-1">
          {f.path && (
            <Button size="sm" variant="ghost" onClick={() => openRun(f.run_id, `files/${f.path}`)}>
              <IconFolder {...IC_XS} />
              Files
            </Button>
          )}
          {showRun && run && (
            <Button size="sm" variant="ghost" onClick={() => openRun(run.id, `findings/${f.id}`)}>
              Open run
            </Button>
          )}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 @max-[44rem]:block @max-[44rem]:overflow-y-auto">
        <article className="min-w-0 flex-1 overflow-y-auto px-8 pt-7 pb-12 @max-[70rem]:px-6 @max-[44rem]:overflow-visible max-sm:px-4">
          <div className="mx-auto flex max-w-[720px] flex-col gap-4">
            <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 font-mono text-xs text-ink-3">
              <span>{f.id}</span>
              <span>{f.removed_at ? `removed: ${f.removed_reason}` : STATE_WORD[f.state]}</span>
              <span>{age(f.updated)} ago</span>
              {showRun && run && (
                <button type="button" className="inline-flex cursor-pointer items-center gap-1.5 font-sans text-[12.5px] text-ink underline decoration-ink-4 underline-offset-[3px] hover:decoration-ink" onClick={() => openRun(run.id, "findings/" + f.id)}>
                  <Hue hue={run.hue} />
                  {runName(run)}
                </button>
              )}
            </div>
            <h1 className="m-0 text-[24px] leading-tight font-medium tracking-[-0.02em] text-balance">{f.title}</h1>
            <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 font-mono text-xs text-ink-3">
              <Sev sev={sevOf(f)} className="font-sans text-[12.5px]">
                {sevWord(sev)}
                {sevChanged(f) && <s className="text-ink-4">{f.severity ?? "none"}</s>}
              </Sev>
              {f.location && <code className="text-ink-2">{f.location}</code>}
              {f.class && <span>{f.class}</span>}
              {f.poc && (
                <button type="button" className="inline-flex cursor-pointer items-center gap-1 text-ink-2 hover:text-ink" onClick={() => openRun(f.run_id, `files/${f.poc}`)}>
                  <IconFileCode {...IC_XS} />
                  {pocName}
                </button>
              )}
            </div>
            {f.problem && (
              <div className="flex items-start gap-2 text-[12.5px] text-warning">
                <IconAlertTriangle {...IC_XS} className="mt-0.5 shrink-0" />
                <span>Pixel couldn't read all of {f.path ?? "the README"}: {f.problem}</span>
              </div>
            )}
            {f.agent_duplicate_of && !f.disposition && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-accent/35 bg-accent/5 px-3.5 py-2.5 text-[13px] text-ink-2">
                <IconGitFork {...IC_SM} className="shrink-0 text-accent" />
                <span className="min-w-0 flex-1">
                  The agent says this repeats <b className="font-medium text-ink">{shortRef(f.agent_duplicate_of, f.run_id)}</b>
                  {agentDup && (
                    <span className="text-ink-3">
                      , {agentDup.title}
                      {agentDup.disposition ? ` (${dispositionLabel(agentDup.disposition).toLowerCase()})` : ""}
                    </span>
                  )}
                </span>
                {agentDup && (
                  <Button size="xs" variant="ghost" onClick={() => open(agentDup)}>
                    Compare
                  </Button>
                )}
                <Button size="xs" disabled={triage.isPending} onClick={() => triage.mutate({ f, disposition: "duplicate", duplicate_of: f.agent_duplicate_of }, { onSuccess: () => onTriaged?.() })}>
                  Mark duplicate
                </Button>
              </div>
            )}
            {f.summary && <Markdown text={f.summary} className="mt-1 leading-relaxed text-ink" />}

            {events.length > 0 && (
              <div className="mt-6 border-t border-line-2 pt-4">
                <div className="mb-2 text-xs text-ink-3">History</div>
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
          </div>
        </article>

        <aside aria-label={`About ${f.id}`} className="w-[330px] shrink-0 overflow-y-auto border-l border-line-2 px-5 pt-4 pb-8 @max-[70rem]:w-[290px] @max-[70rem]:px-4 @max-[44rem]:w-auto @max-[44rem]:overflow-visible @max-[44rem]:border-t @max-[44rem]:border-l-0">
          {triageable && <TriageFact f={f} all={all} onTriaged={onTriaged} open={open} />}
          {f.disposition === "report" && !f.removed_at && <DisclosureFact f={f} />}
          {f.state !== "ruled_out" && <UpstreamFact f={f} checking={checking} onCheck={() => setStarting("check")} />}
          <RunsFact f={f} runs={fromHere} />
          <RelatedFact f={f} all={all} open={open} />
        </aside>
      </div>
      {starting && <StartRunDialog f={f} run={run} kind={starting} onClose={() => setStarting(null)} />}
    </div>
  );
}
