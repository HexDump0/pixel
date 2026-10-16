/**
 * An open run (`/runs/:id`), docked beside the run list: compact header with the live numbers, tabs,
 * the tab's content (Overview has a side column), and the message box. `[` hides the run list, `.` is
 * focus mode, Esc closes, j/k or ↑/↓ move between runs. Tabs live in the hash (#findings/F3, #files/poc/x.png).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  IconArrowsDiagonal,
  IconArrowsDiagonalMinimize2,
  IconBug,
  IconCpu,
  IconFileText,
  IconFolder,
  IconHistory,
  IconLayoutGrid,
  IconMessage,
  IconTerminal2,
} from "@tabler/icons-react";
import { api } from "../../lib/api.ts";
import { keys, queryClient } from "../../lib/query.ts";
import { useLive } from "../../lib/live.ts";
import { useThrottled, useTick } from "../../lib/hooks.ts";
import { navigate } from "../../lib/router.tsx";
import { useRuns, reloadRuns } from "../../lib/runs.ts";
import { useFleet } from "../../lib/fleet.ts";
import { useFindings, isOpen, useRunFindings } from "../../lib/findings.ts";
import { health, useLimits } from "../../lib/health.ts";
import { markRunSeen, seenAt, useLastLooked, useSeenRuns } from "../../lib/seen.ts";
import { getPref, usePref } from "../../lib/prefs.ts";
import { openRun } from "../../lib/actions.ts";
import { cn } from "../../lib/cn.ts";
import type { RunDetail } from "../../lib/types.ts";
import { ErrorBox, Button } from "../../components/ui.tsx";
import { IC_SM } from "../../components/ui/bits.tsx";
import { Tip } from "../../components/ui/overlay.tsx";
import { WorkbaseBrowser } from "../../components/WorkbaseBrowser.tsx";
import { buildView } from "../wall/RunCards.tsx";
import { Rail } from "./Rail.tsx";
import { RunHeader } from "./RunHeader.tsx";
import { SideColumn } from "./SideColumn.tsx";
import { Composer } from "./Composer.tsx";
import { OverviewTab } from "./OverviewTab.tsx";
import { FindingsTab } from "./FindingsTab.tsx";
import { ReportTab } from "./ReportTab.tsx";
import { TranscriptTab } from "./TranscriptTab.tsx";
import { TimelineTab } from "./TimelineTab.tsx";
import { TerminalTab } from "./TerminalTab.tsx";
import { MachineTab } from "./MachineTab.tsx";

type TabId = "overview" | "findings" | "report" | "transcript" | "files" | "timeline" | "terminal" | "machine";
const TABS: { id: TabId; label: string; Icon: typeof IconBug }[] = [
  { id: "overview", label: "Overview", Icon: IconLayoutGrid },
  { id: "findings", label: "Findings", Icon: IconBug },
  { id: "report", label: "Report", Icon: IconFileText },
  { id: "transcript", label: "Transcript", Icon: IconMessage },
  { id: "files", label: "Files", Icon: IconFolder },
  { id: "timeline", label: "Timeline", Icon: IconHistory },
  { id: "terminal", label: "Terminal", Icon: IconTerminal2 },
  { id: "machine", label: "Machine", Icon: IconCpu },
];
const OLD_TABS: Record<string, TabId> = { workbase: "files" };

/** `#findings/F3` → ["findings", "F3"] */
function readHash(): [TabId, string | null] {
  const h = decodeURIComponent(location.hash.slice(1));
  const i = h.indexOf("/");
  const tab = (i < 0 ? h : h.slice(0, i)) || "overview";
  const t = (OLD_TABS[tab] ?? tab) as TabId;
  return [TABS.some((x) => x.id === t) ? t : "overview", i < 0 ? null : h.slice(i + 1)];
}

export function RunView({ id }: { id: string }) {
  useTick(10_000);
  const detail = useQuery({ queryKey: keys.run(id), queryFn: () => api.run(id) });
  const { runs } = useRuns();
  const snap = useFleet();
  const findings = useFindings() ?? [];
  const runFindings = useRunFindings(id).data ?? [];
  const limits = useLimits();
  const seenRuns = useSeenRuns();
  const [lastLooked] = useLastLooked();
  const [railOff, setRailOff] = usePref("run.railOff", false);
  const [focus, setFocus] = usePref("run.focus", false);
  const [[tab, sub], setRoute] = useState(readHash);

  // What counts as new for this visit is fixed when you open the run; leaving marks it seen.
  const seen = useRef(seenAt(seenRuns[id], lastLooked));
  useEffect(() => {
    seen.current = seenAt(getPref<Record<string, number>>("seenRuns", {})[id], lastLooked);
    return () => markRunSeen(id);
  }, [id]);

  useEffect(() => {
    const onHash = () => setRoute(readHash());
    window.addEventListener("hashchange", onHash);
    window.addEventListener("popstate", onHash);
    return () => (window.removeEventListener("hashchange", onHash), window.removeEventListener("popstate", onHash));
  }, []);
  useEffect(() => setRoute(readHash()), [id]);
  const go = (t: TabId, s: string | null = null) => {
    setRoute([t, s]);
    history.replaceState(null, "", `${location.pathname}${t === "overview" && !s ? "" : `#${t}${s ? `/${s}` : ""}`}`);
  };

  const reload = useThrottled(() => void detail.refetch(), 1500);
  useLive(id, (m) => {
    if (m.type === "run") queryClient.setQueryData<RunDetail>(keys.run(id), (d) => (d ? { ...d, run: { ...d.run, ...m.data } } : d));
    if (["todos", "question", "question.closed", "session", "synced", "message"].includes(m.type)) reload();
  });

  const views = useMemo(
    () => (runs ?? []).map((r) => buildView(r, snap?.runs.find((f) => f.id === r.id), health(r, snap?.runs.find((f) => f.id === r.id), limits), findings, seenAt(seenRuns[r.id], lastLooked))),
    [runs, snap, findings, limits, seenRuns, lastLooked],
  );
  const d = detail.data;
  const listRun = runs?.find((r) => r.id === id);
  const fleet = snap?.runs.find((f) => f.id === id);
  const run = d ? { ...d.run, ...listRun, question: listRun?.question } : null;
  const h = run ? health(run, fleet, limits) : null;
  const close = () => navigate("/");

  // keys
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [role=dialog], [role=menu], .xterm")) return;
      if (e.key === "Escape") return close();
      if (e.key === "[") return (e.preventDefault(), setRailOff(!railOff));
      if (e.key === ".") return (e.preventDefault(), setFocus(!focus));
      if (e.key === "/") {
        e.preventDefault();
        if (railOff) setRailOff(false);
        setTimeout(() => document.querySelector<HTMLInputElement>("[data-rail-filter]")?.focus(), 0);
        return;
      }
      if (e.key === "m") return (e.preventDefault(), document.querySelector<HTMLTextAreaElement>("[data-composer]")?.focus());
      const step = { j: 1, k: -1, ArrowDown: 1, ArrowUp: -1 }[e.key];
      if (step && tab !== "findings") {
        const ids = [...document.querySelectorAll<HTMLElement>("[data-rail] [data-run]")].map((x) => x.dataset.run!);
        const i = ids.indexOf(id);
        const next = ids[i + step];
        if (next) {
          e.preventDefault();
          openRun(next, tab === "overview" ? undefined : tab);
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  if (detail.error && !d) return <main className="gut pt-6"><ErrorBox error={(detail.error as Error).message} /></main>;
  if (!d || !run || !h) return null;

  const fCount = runFindings.filter((f) => !f.removed_at && f.state !== "lead").length;
  const fOpen = runFindings.filter(isOpen).length;
  const pending = d.questions.some((q) => q.status === "pending");
  const noRail = railOff || focus;
  let body: ReactNode;
  switch (tab) {
    case "findings":
      body = <FindingsTab run={run} selected={sub} onSelect={(f) => go("findings", f)} seen={seen.current} />;
      break;
    case "report":
      body = <ReportTab run={run} onOpenFinding={(f) => go("findings", f)} />;
      break;
    case "transcript":
      body = <TranscriptTab key={d.run.session_id ?? id} detail={d} />;
      break;
    case "files":
      body = <WorkbaseBrowser runId={id} path={sub ?? undefined} />;
      break;
    case "timeline":
      body = <Pad><TimelineTab runId={id} /></Pad>;
      break;
    case "terminal":
      body = <TerminalTab detail={d} />;
      break;
    case "machine":
      body = <MachineTab detail={d} onChange={() => void detail.refetch()} />;
      break;
    default:
      body = (
        <div className={cn("grid h-full grid-cols-[minmax(0,1fr)_minmax(300px,380px)] max-lg:block max-lg:h-auto", focus && "grid-cols-[minmax(0,1fr)]")}>
          <div className="flex flex-col gap-7 overflow-y-auto px-10 pt-6 pb-12 [scrollbar-width:thin] max-lg:overflow-visible max-md:px-4 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[760px]">
            <OverviewTab detail={d} fleet={fleet} seen={seen.current} onOpenFinding={(f) => go("findings", f)} onChange={() => (void detail.refetch(), void reloadRuns())} />
          </div>
          {!focus && <SideColumn detail={d} fleet={fleet} />}
        </div>
      );
  }

  return (
    <main className={cn("gut grid h-[calc(100dvh-60px)] gap-2.5 pt-1 pb-3 max-lg:h-auto max-lg:grid-cols-1", noRail ? "grid-cols-[minmax(0,1fr)]" : "grid-cols-[264px_minmax(0,1fr)]")}>
      {!noRail && <Rail views={views} current={id} onHide={() => setRailOff(true)} />}
      <section aria-label={run.label ?? run.id} className="grid min-h-0 min-w-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden rounded-2xl border border-line-2 bg-s1">
        <RunHeader detail={{ ...d, run }} fleet={fleet} h={h} railHidden={noRail} onShowRail={() => (setRailOff(false), setFocus(false))} onClose={close} />
        <div role="tablist" aria-label="Run views" className="flex items-center gap-0.5 overflow-x-auto border-b border-line-2 pt-1.5 pr-3.5 pb-2 pl-4 [scrollbar-width:none]">
          {TABS.map(({ id: t, label, Icon }) => {
            const disabled = t === "report" && !run.report_ready;
            const btn = (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                disabled={disabled}
                onClick={() => go(t)}
                className="group inline-flex h-[30px] shrink-0 items-center gap-[7px] rounded-[9px] px-2.5 text-[13px] whitespace-nowrap text-ink-3 enabled:hover:bg-s2 enabled:hover:text-ink disabled:cursor-default disabled:opacity-45 aria-selected:bg-s3 aria-selected:text-ink"
              >
                <Icon {...IC_SM} className="text-ink-4 group-aria-selected:text-ink-2" />
                {label}
                {t === "findings" && fCount > 0 && <span className={cn("font-mono text-xs", fOpen ? "text-warning" : "text-ink-3")}>{fOpen || fCount}</span>}
                {t === "overview" && pending && <span className="font-mono text-xs text-warning">1</span>}
              </button>
            );
            return disabled ? (
              <Tip key={t} content="Written when the run finishes">
                <span tabIndex={0}>{btn}</span>
              </Tip>
            ) : (
              btn
            );
          })}
          <span className="flex-1" />
          <Button size="sm" icon variant="ghost" title="Focus on the text (.)" aria-label="Focus mode" aria-pressed={focus} onClick={() => setFocus(!focus)}>
            {focus ? <IconArrowsDiagonalMinimize2 {...IC_SM} /> : <IconArrowsDiagonal {...IC_SM} />}
          </Button>
        </div>
        <div className={cn("min-h-0", tab === "overview" || tab === "findings" ? "overflow-hidden max-lg:overflow-y-auto" : tab === "transcript" || tab === "files" || tab === "terminal" ? "overflow-hidden max-md:overflow-y-auto" : "overflow-y-auto")}>{body}</div>
        {run.status !== "triaged" && <Composer run={run} />}
      </section>
    </main>
  );
}

const Pad = ({ children }: { children: ReactNode }) => <div className="px-7 pt-6 pb-10 max-md:px-4">{children}</div>;

