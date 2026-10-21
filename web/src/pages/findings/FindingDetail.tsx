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
  IconDots,
  IconCopy,
  IconExternalLink,
  IconFileCode,
  IconFolder,
  IconGitFork,
  IconPencil,
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
import { Dialog, Menu, Select, type MenuEntry } from "../../components/ui/overlay.tsx";
import { toast } from "../../components/Toast.tsx";
import { Hue, IC_SM, IC_XS, Kbd, Sep, Sev } from "../../components/ui/bits.tsx";
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

// ---- facts column: one panel per fact, its state in large type, controls only where they're needed ----

function Panel({ title, right, children }: { title: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-[10px] bg-s2 p-3.5">
      <div className="-my-1 flex h-6 items-center gap-2 text-xs text-ink-3">
        <span className="shrink-0">{title}</span>
        {right && <span className="ml-auto flex min-w-0 items-center justify-end gap-1 truncate">{right}</span>}
      </div>
      {children}
    </section>
  );
}

/** The fact's current state, big enough to read at a glance. */
function State({ children, aside, className }: { children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-3">
      <span className={cn("min-w-0 truncate text-[17px] leading-tight font-medium tracking-[-0.01em]", className)}>{children}</span>
      {aside && <span className="ml-auto flex shrink-0 items-baseline gap-1.5 text-[13px]">{aside}</span>}
    </div>
  );
}

/** A small action in a panel's header (Change, the disclosure menu). */
const headAction = "-mr-1.5 inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs text-ink-3 outline-none hover:bg-s3 hover:text-ink data-[state=open]:bg-s3 data-[state=open]:text-ink";

const fieldClass = "h-[30px] w-full min-w-0 rounded-lg border border-line bg-s1 px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-4 focus:border-ink-3";

const DISPOSITION_TEXT: Record<string, string> = { report: "text-good", known: "text-ink", duplicate: "text-ink", weak: "text-ink-2", invalid: "text-ink-3" };

function TriageFact({ f, all, onTriaged, open }: { f: Finding; all: Finding[]; onTriaged?: () => void; open: (f: Finding) => void }) {
  const triage = useTriage();
  const [note, setNote] = useState(f.disposition_note ?? "");
  useEffect(() => setNote(f.disposition_note ?? ""), [f.run_id, f.id, f.disposition_note]);
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    setPicking(false);
    setEditing(false);
  }, [f.run_id, f.id]);

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
    setEditing(false);
    save({ f, disposition: d, note, duplicate_of: d === "duplicate" ? (f.duplicate_of ?? f.agent_duplicate_of) : undefined }, !f.disposition);
  };
  const saveNote = () => note !== (f.disposition_note ?? "") && save({ f, note });

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
  const sev = finalSev(f);
  const choosing = !f.disposition || editing || picking;
  const by = f.disposition ? `${who(f.disposition_by) === "You" ? "you" : who(f.disposition_by)}, ${age(f.disposition_at)}` : null;

  const sevMenu = (
    <Menu
      align="end"
      trigger={
        <button type="button" className="-mr-1.5 inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-[13px] text-ink outline-none hover:bg-s3 data-[state=open]:bg-s3" aria-label="Final severity">
          <Sev sev={sevOf(f)} />
          <span className="capitalize">{sevWord(sev)}</span>
          {sevChanged(f) && <s className="text-xs text-ink-4">{f.severity ?? "none"}</s>}
        </button>
      }
      items={[{ head: "Severity" }, ...FINAL_SEVERITIES.map((s) => ({ label: <span className="capitalize">{sevWord(s)}</span>, checked: sev === s, hint: s === f.severity ? "agent" : undefined, onSelect: () => save({ f, severity: s === f.severity ? null : s }) }))]}
    />
  );

  return (
    <Panel
      title="Triage"
      right={
        f.disposition && !choosing ? (
          <button type="button" className={headAction} onClick={() => setEditing(true)} aria-label="Change the triage" title="Change the triage">
            <IconPencil {...IC_SM} />
          </button>
        ) : f.disposition ? (
          <button type="button" className={headAction} onClick={() => (setEditing(false), setPicking(false))}>
            Done
          </button>
        ) : null
      }
    >
      {choosing ? (
        <>
          <div className="-mx-1.5 flex flex-col">
            {DISPOSITIONS.map((d) => (
              <button
                key={d.v}
                type="button"
                aria-pressed={f.disposition === d.v || (d.v === "duplicate" && picking)}
                disabled={triage.isPending}
                onClick={() => choose(d.v)}
                title={d.hint}
                className={cn(
                  "flex h-8 min-w-0 cursor-pointer items-center justify-between gap-2 rounded-md px-1.5 text-[13.5px] text-ink hover:bg-s3 aria-pressed:bg-s3 aria-pressed:font-medium",
                  d.v === "report" && "aria-pressed:text-good",
                )}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className={cn("size-[7px] shrink-0 rounded-full", d.v === "report" ? "bg-good" : "ring-[1.5px] ring-ink-4 ring-inset")} />
                  <span className="truncate">{d.label}</span>
                </span>
                <Kbd className="h-4 min-w-4 text-[10.5px]">{d.key.toUpperCase()}</Kbd>
              </button>
            ))}
          </div>
          {(picking || f.disposition === "duplicate") && (
            <Select
              field
              label="Duplicate of"
              value={f.duplicate_of ?? ""}
              onChange={(ref) => {
                setPicking(false);
                setEditing(false);
                save({ f, disposition: "duplicate", duplicate_of: ref, note }, !f.disposition);
              }}
              options={[
                ...(f.duplicate_of && !dupTarget ? [{ value: f.duplicate_of, label: f.duplicate_of }] : []),
                ...(!f.duplicate_of ? [{ value: "", label: <span className="text-ink-3">Duplicate of which finding</span> }] : []),
                ...candidates.map((x) => ({ value: refOf(x), label: `${shortRef(refOf(x), f.run_id)} ${x.title}`, hint: x.disposition ? dispositionLabel(x.disposition).toLowerCase() : undefined })),
              ]}
            />
          )}
          <div className="flex items-center justify-between text-[12.5px] text-ink-3">
            Severity
            {sevMenu}
          </div>
          <textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={saveNote}
            onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.currentTarget.blur()}
            placeholder="Note (for known: the CVE or issue)"
            aria-label="Triage note"
            className="max-h-56 min-h-[52px] [field-sizing:content] resize-none rounded-lg border border-transparent bg-s1 px-2.5 py-1.5 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-4 focus:border-ink-3"
          />
        </>
      ) : (
        <>
          <State className={DISPOSITION_TEXT[f.disposition!]} aside={sevMenu}>
            {dispositionLabel(f.disposition)}
          </State>
          {f.disposition === "duplicate" && f.duplicate_of && (
            <button type="button" onClick={() => dupTarget && open(dupTarget)} className="-mt-1 flex min-w-0 cursor-pointer items-baseline gap-1.5 text-left text-[13px] text-ink-2 hover:text-ink">
              <span className="shrink-0 text-ink-3">of</span>
              <span className="shrink-0 font-mono text-xs">{shortRef(f.duplicate_of, f.run_id)}</span>
              {dupTarget && <span className="truncate">{dupTarget.title}</span>}
            </button>
          )}
          {f.disposition_note && <p className="m-0 line-clamp-6 text-[13px] leading-relaxed text-ink-2">{f.disposition_note}</p>}
          {by && <span className="text-xs text-ink-3">{by} ago</span>}
        </>
      )}
    </Panel>
  );
}

const TONE_TEXT: Record<string, string> = { bad: "text-critical", warn: "text-warning", "": "text-ink" };
const TONE_BAR: Record<string, string> = { bad: "bg-critical", warn: "bg-warning", "": "bg-ink-2" };

function DisclosureFact({ f }: { f: Finding }) {
  const disclose = useDisclosure();
  const d = disclosureOf(f)!;
  const [url, setUrl] = useState(f.report_url ?? "");
  const [fix, setFix] = useState(f.fix_ref ?? "");
  const [form, setForm] = useState<null | "send" | "fix" | "link" | "drop">(null);
  const [reason, setReason] = useState("");
  useEffect(() => {
    setUrl(f.report_url ?? "");
    setFix(f.fix_ref ?? "");
    setForm(null);
    setReason("");
  }, [f.run_id, f.id, f.report_url, f.fix_ref, f.disclosure]);
  const busy = disclose.isPending;
  const set = (body: Omit<Parameters<typeof disclose.mutate>[0], "f">, msg: string) => disclose.mutate({ f, ...body }, { onSuccess: () => toast(`${f.id}: ${msg}`) });
  const dl = d === "reported" ? deadlineOf(f) : null;
  const link = f.report_url && (
    <a href={f.report_url} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 text-ink-2 underline decoration-ink-4 underline-offset-[3px] hover:text-ink">
      <span className="truncate">{f.report_url.replace(/^https?:\/\/(www\.)?/, "")}</span>
      <IconExternalLink {...IC_XS} className="shrink-0" />
    </a>
  );

  const menu: MenuEntry[] =
    d === "ready"
      ? [{ label: "Drop", danger: true, onSelect: () => setForm("drop") }]
      : d === "reported"
        ? [
            { label: "Extend 30 days", onSelect: () => set({ extend_days: 30 }, "deadline moved 30 days") },
            { label: f.report_url ? "Change link" : "Add link", onSelect: () => setForm("link") },
            { label: "Back to not sent", onSelect: () => set({ disclosure: "ready", reported_at: null }, "back to not sent") },
            "-",
            { label: "Drop", danger: true, onSelect: () => setForm("drop") },
          ]
        : d === "fixed"
          ? [{ label: "Not fixed after all", onSelect: () => set({ disclosure: "reported" }, "back to sent") }]
          : [{ label: "Take it back", onSelect: () => set({ disclosure: "ready", note: null }, "back to not sent") }];

  const confirmRow = (label: string, onOk: () => void, ok: boolean, danger = false) => (
    <div className="flex gap-1.5">
      <Button size="sm" variant={danger ? "danger" : "default"} disabled={busy || !ok} onClick={onOk}>
        {label}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setForm(null)}>
        Cancel
      </Button>
    </div>
  );

  return (
    <Panel
      title="Disclosure"
      right={
        <Menu
          trigger={
            <button type="button" className={headAction} aria-label="More disclosure actions" disabled={busy}>
              <IconDots {...IC_SM} />
            </button>
          }
          items={menu}
        />
      }
    >
      {d === "ready" && <State>Not sent</State>}

      {d === "reported" && (
        <>
          <State aside={dl && <span className={cn("font-medium tabular-nums", TONE_TEXT[dl.tone])}>{dl.over ? `${dl.days} days over` : `${dl.days} days left`}</span>}>Sent</State>
          {dl && (
            <div className="flex flex-col gap-1.5">
              <div className="h-1 overflow-hidden rounded-full bg-s3">
                <div className={cn("h-full rounded-full", TONE_BAR[dl.tone])} style={{ width: `${Math.min(100, ((dl.elapsed ?? 0) / Math.max(1, dl.total ?? 1)) * 100)}%` }} />
              </div>
              <div className="flex justify-between font-mono text-[11.5px] text-ink-3 tabular-nums">
                <span>sent {day(f.reported_at)}</span>
                <span>due {day(f.deadline)}</span>
              </div>
            </div>
          )}
          {link && <div className="flex min-w-0 text-[13px]">{link}</div>}
        </>
      )}

      {d === "fixed" && (
        <>
          <State className="text-good" aside={f.fixed_at && <span className="text-ink-3">{day(f.fixed_at)}</span>}>
            Fixed
          </State>
          {(f.fix_ref || link) && (
            <div className="flex min-w-0 flex-col gap-1 text-[13px] text-ink-2">
              {f.fix_ref && <span className="font-mono text-xs">in {f.fix_ref}</span>}
              {link}
            </div>
          )}
        </>
      )}

      {d === "dropped" && (
        <>
          <State className="text-ink-3">Dropped</State>
          {f.disclosure_note && <p className="m-0 text-[13px] leading-relaxed text-ink-2">{f.disclosure_note}</p>}
        </>
      )}

      {form === "send" || form === "link" ? (
        <div className="flex flex-col gap-1.5">
          <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Advisory or issue link (optional)" className={fieldClass} aria-label="Report link" onKeyDown={(e) => e.key === "Escape" && setForm(null)} />
          {form === "send"
            ? confirmRow("Mark sent", () => set({ disclosure: "reported", report_url: url.trim() || null }, "sent upstream"), true)
            : confirmRow("Save link", () => set({ report_url: url.trim() || null }, "report link saved"), url !== (f.report_url ?? ""))}
        </div>
      ) : form === "fix" ? (
        <div className="flex flex-col gap-1.5">
          <input autoFocus value={fix} onChange={(e) => setFix(e.target.value)} placeholder="Version or commit (optional)" className={fieldClass} aria-label="Fix" onKeyDown={(e) => e.key === "Escape" && setForm(null)} />
          {confirmRow("Mark fixed", () => set({ disclosure: "fixed", fix_ref: fix.trim() || null }, "fixed upstream"), true)}
        </div>
      ) : form === "drop" ? (
        <div className="flex flex-col gap-1.5">
          <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it's dropped" className={fieldClass} aria-label="Why it's dropped" onKeyDown={(e) => e.key === "Escape" && setForm(null)} />
          {confirmRow("Drop", () => set({ disclosure: "dropped", note: reason.trim() }, "dropped"), !!reason.trim(), true)}
        </div>
      ) : d === "ready" ? (
        <Button size="sm" className="self-start" onClick={() => setForm("send")}>
          Mark sent
        </Button>
      ) : d === "reported" ? (
        <div className="flex gap-1.5">
          <Button size="sm" onClick={() => setForm("fix")}>
            Mark fixed
          </Button>
          {dl?.tone && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => set({ extend_days: 30 }, "deadline moved 30 days")}>
              Extend 30 days
            </Button>
          )}
        </div>
      ) : null}
    </Panel>
  );
}

/** Shown once there's an answer or a check is running; the toolbar's Check on latest starts one. */
function UpstreamFact({ f, checking }: { f: Finding; checking: Run | undefined }) {
  const st = f.upstream_status;
  if (!st && !checking) return null;
  const word = st === "present" ? "Still present" : st === "fixed" ? "Fixed upstream" : st === "changed" ? "Code changed" : "Couldn't tell";
  const tone = st === "fixed" || st === "changed" ? "text-warning" : st === "present" ? "text-ink" : "text-ink-3";
  return (
    <Panel title="Latest upstream">
      {checking ? (
        <button type="button" onClick={() => openRun(checking.id)} className="flex cursor-pointer items-center gap-2.5 text-left">
          <span className="size-2 shrink-0 rounded-full bg-good" />
          <State aside={<span className="text-ink-3">{age(checking.started_at ?? checking.created_at)}</span>}>Checking</State>
        </button>
      ) : (
        <State className={tone} aside={f.upstream_commit && <span className="font-mono text-xs text-ink-3">{f.upstream_commit.slice(0, 10)}</span>}>
          {word}
        </State>
      )}
      {st && (
        <div className="-mt-1 flex flex-wrap items-center text-xs text-ink-3">
          {st === "fixed" && f.upstream_fixed_by && (
            <>
              <span className="font-mono">by {f.upstream_fixed_by.slice(0, 10)}</span>
              <Sep />
            </>
          )}
          {st === "changed" && (
            <>
              <span>the PoC no longer applies</span>
              <Sep />
            </>
          )}
          <span>{checking ? "last answer " : ""}{age(f.upstream_at)} ago</span>
          {f.upstream_run && (
            <>
              <Sep />
              <button type="button" className="cursor-pointer text-ink-3 underline decoration-ink-4 underline-offset-[3px] hover:text-ink" onClick={() => openRun(f.upstream_run!, "report")}>
                answer
              </button>
            </>
          )}
        </div>
      )}
    </Panel>
  );
}

function RunsFact({ f, runs }: { f: Finding; runs: Run[] }) {
  if (!runs.length) return null;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return (
    <Panel title="Runs from this finding">
      <div className="-mx-2 -my-1 flex flex-col">
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
            <button key={r.id} type="button" onClick={() => openRun(r.id)} className="grid h-8 cursor-pointer grid-cols-[6px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-2 text-left text-[13px] hover:bg-s3">
              <span className={cn("size-1.5 rounded-full", live ? "bg-good" : r.status === "failed" ? "bg-critical" : "bg-ink-4")} />
              <span className="truncate">
                {r.source_kind === "check" ? "Check" : "Variants"}
                <span className="text-ink-3"> {result}</span>
              </span>
              <span className="font-mono text-[11.5px] text-ink-3">{age(r.created_at)}</span>
            </button>
          );
        })}
      </div>
    </Panel>
  );
}

function RelatedFact({ f, all, runs, open }: { f: Finding; all: Finding[]; runs: Run[]; open: (f: Finding) => void }) {
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
  const where = (x: Finding) => {
    if (x.run_id === f.run_id) return x.id;
    const r = runs.find((y) => y.id === x.run_id);
    return `${x.id} in ${r ? runName(r) : x.run_id}`;
  };
  return (
    <Panel title={`Related in ${repoName(f.repo).split("/").pop()}`} right={items.length > shown.length ? `${items.length - shown.length} more` : undefined}>
      <div className="-mx-2 -my-1 flex flex-col">
        {shown.map(({ f: x, why }) => (
          <button key={refOf(x)} type="button" onClick={() => open(x)} className="grid cursor-pointer grid-cols-[7px_minmax(0,1fr)] items-baseline gap-x-2.5 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-s3">
            <Sev sev={sevOf(x)} done={!!x.disposition && x.disposition !== "report"} className="translate-y-[-1px]" />
            <span className="min-w-0">
              <span className="line-clamp-2">{x.title}</span>
              <span className="mt-0.5 flex min-w-0 items-center text-xs text-ink-3">
                <span className="truncate font-mono text-[11.5px]">{where(x)}</span>
                <Sep />
                <span className="shrink-0">{why}</span>
              </span>
            </span>
          </button>
        ))}
      </div>
    </Panel>
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

        <aside aria-label={`About ${f.id}`} className="flex w-[330px] shrink-0 flex-col gap-2.5 overflow-y-auto border-l border-line-2 p-3 pb-8 @max-[70rem]:w-[290px] @max-[44rem]:w-auto @max-[44rem]:overflow-visible @max-[44rem]:border-t @max-[44rem]:border-l-0">
          {triageable && <TriageFact f={f} all={all} onTriaged={onTriaged} open={open} />}
          {f.disposition === "report" && !f.removed_at && <DisclosureFact f={f} />}
          {f.state !== "ruled_out" && <UpstreamFact f={f} checking={checking} />}
          <RunsFact f={f} runs={fromHere} />
          <RelatedFact f={f} all={all} runs={runs ?? []} open={open} />
        </aside>
      </div>
      {starting && <StartRunDialog f={f} run={run} kind={starting} onClose={() => setStarting(null)} />}
    </div>
  );
}
