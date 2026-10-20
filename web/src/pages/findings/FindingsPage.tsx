/**
 * Findings (`/findings`): every finding across runs in four lists over the same findings (to triage, to report,
 * resolved, reviewed) plus what the agents set aside themselves. Search narrows the list; Copy for LLM copies
 * what's shown. Pick one to read and triage it; after a triage the next one in the list opens.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { IconChevronDown, IconCopy, IconSearch, IconX } from "@tabler/icons-react";
import { copyListForLlm, inView, refOf, type FindingView } from "../../lib/findings.ts";
import { useFindings } from "../../lib/findings.ts";
import { useRuns } from "../../lib/runs.ts";
import { runName } from "../../lib/fleet.ts";
import { useLastLooked, useSeenRuns, seenAt } from "../../lib/seen.ts";
import type { Finding } from "../../lib/types.ts";
import { Button } from "../../components/ui.tsx";
import { Menu } from "../../components/ui/overlay.tsx";
import { toast } from "../../components/Toast.tsx";
import { IC_XS, Kbd } from "../../components/ui/bits.tsx";
import { FindingsTable, viewGroups } from "./FindingsTable.tsx";
import { FindingDetail } from "./FindingDetail.tsx";

const VIEWS: { id: FindingView; label: string; title: string }[] = [
  { id: "triage", label: "To triage", title: "Findings to triage" },
  { id: "report", label: "Report", title: "Findings to report" },
  { id: "resolved", label: "Resolved", title: "Resolved findings" },
  { id: "reviewed", label: "Reviewed", title: "Triaged findings" },
  { id: "aside", label: "Set aside", title: "Leads and findings the agents ruled out" },
];

/** What Copy for LLM asks for, per list: the default first. */
const LIST_PURPOSES: Record<FindingView, ("list" | "triage" | "verify" | "variants")[]> = {
  triage: ["triage", "list", "verify"],
  report: ["list", "verify", "variants"],
  resolved: ["list", "variants"],
  reviewed: ["list", "triage", "variants"],
  aside: ["list", "verify"],
};
const PURPOSE_LABEL: Record<string, string> = { list: "As context", triage: "To triage them", verify: "To check them", variants: "To find variants" };

const VIEW_KEY = "pixel.findings.view";
const readView = (): FindingView => {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return VIEWS.some((x) => x.id === v) ? (v as FindingView) : "triage";
  } catch {
    return "triage";
  }
};

/** Every word in the id, title, where, class, run, project or text. */
function matches(f: Finding, words: string[], runLabel: string) {
  if (!words.length) return true;
  const hay = [refOf(f), f.title, f.location, f.class, runLabel, f.repo, f.summary, f.disposition_note].join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function FindingsPage() {
  const findings = useFindings();
  const { runs } = useRuns();
  const seenRuns = useSeenRuns();
  const [lastLooked] = useLastLooked();
  const [view, setView] = useState<FindingView>(readView);
  const [q, setQ] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const [sel, setSel] = useState<string | null>(() => decodeURIComponent(location.hash.slice(1)) || null);
  useEffect(() => {
    history.replaceState(null, "", sel ? `#${encodeURIComponent(sel)}` : location.pathname);
  }, [sel]);
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {}
  }, [view]);

  // "/" to search.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || (e.target as HTMLElement).closest("input, textarea, select, [role=menu]")) return;
      e.preventDefault();
      search.current?.focus();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const all = findings ?? [];
  const runById = useMemo(() => new Map((runs ?? []).map((r) => [r.id, r])), [runs]);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = all.filter((f) => matches(f, words, runById.get(f.run_id) ? runName(runById.get(f.run_id)!) : ""));
  const groups = viewGroups(shown, view);
  const order = groups.flatMap((g) => g.list);
  const counts = Object.fromEntries(VIEWS.map((v) => [v.id, shown.filter((f) => inView(f, v.id)).length])) as Record<FindingView, number>;
  const current = all.find((f) => refOf(f) === sel) ?? null;

  // After a triage in To triage, open the next finding: the one after it in the list as it last was while
  // it still held the selected one (the triaged one has left the list by then).
  const orderRef = useRef(order);
  orderRef.current = order;
  const snapshot = useRef<string[]>([]);
  if (sel && order.some((f) => refOf(f) === sel)) snapshot.current = order.map(refOf);
  const next = (from: string) => {
    if (view !== "triage") return;
    const still = new Set(orderRef.current.map(refOf));
    const before = snapshot.current;
    const i = before.indexOf(from);
    if (i < 0) return;
    const nxt = [...before.slice(i + 1), ...before.slice(0, i).reverse()].find((r) => still.has(r));
    if (nxt) setSel(nxt);
  };

  const copyList = (purpose: (typeof LIST_PURPOSES)[FindingView][number]) => {
    if (!order.length) return;
    const title = `${VIEWS.find((v) => v.id === view)!.title}${q ? `, matching "${q}"` : ""}`;
    copyListForLlm(order, purpose, title).then(
      () => toast(`Copied ${Math.min(order.length, 500)} findings for an LLM`),
      (e) => toast((e as Error).message, "error"),
    );
  };
  const purposes = LIST_PURPOSES[view];

  return (
    <main className="gut pt-2 pb-16">
      <div className="mt-4 mb-4 flex items-baseline gap-3">
        <h1 className="m-0 text-[22px] font-medium tracking-[-0.02em]">Findings</h1>
        <span className="text-ink-3">{counts.triage ? `${counts.triage} to triage` : "Nothing to triage"}</span>
      </div>

      <div className="sticky top-[60px] z-10 max-md:static -mx-1 mb-3 flex flex-wrap items-center gap-2 bg-bg px-1 py-2">
        <div role="tablist" aria-label="Lists" className="flex flex-wrap gap-0.5">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={view === v.id}
              onClick={() => setView(v.id)}
              className="inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-ink-3 hover:bg-s2 hover:text-ink aria-selected:bg-s3 aria-selected:text-ink"
            >
              {v.label}
              <span className="font-mono text-xs text-ink-4">{counts[v.id]}</span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1.5 max-md:ml-0 max-md:w-full">
          <label className="flex h-[30px] w-60 items-center gap-1.5 rounded-lg border border-line-2 bg-s1 px-2 focus-within:border-ink-4 max-md:w-auto max-md:min-w-0 max-md:flex-1">
            <IconSearch {...IC_XS} className="shrink-0 text-ink-4" />
            <input
              ref={search}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && (setQ(""), e.currentTarget.blur())}
              placeholder="Search findings"
              aria-label="Search findings"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-4"
            />
            {q ? (
              <button type="button" aria-label="Clear search" className="cursor-pointer text-ink-4 hover:text-ink" onClick={() => setQ("")}>
                <IconX {...IC_XS} />
              </button>
            ) : (
              <Kbd>/</Kbd>
            )}
          </label>
          <span className="inline-flex">
            <Button size="sm" className="rounded-r-none" disabled={!order.length} onClick={() => copyList(purposes[0])} title={`Every finding in this list (${order.length}) as one text, ${PURPOSE_LABEL[purposes[0]].toLowerCase()}`}>
              <IconCopy {...IC_XS} />
              Copy for LLM
            </Button>
            <Menu
              trigger={
                <Button size="sm" icon className="-ml-px rounded-l-none" disabled={!order.length} aria-label="Copy this list for an LLM, asking for">
                  <IconChevronDown {...IC_XS} />
                </Button>
              }
              items={[{ head: `Copy these ${order.length} for an LLM` }, ...purposes.map((p, i) => ({ label: PURPOSE_LABEL[p], hint: i === 0 ? "default" : undefined, onSelect: () => copyList(p) }))]}
            />
          </span>
        </div>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <FindingsTable groups={groups} view={view} runs={runs ?? []} selected={sel ?? undefined} onOpen={(f) => setSel(refOf(f))} isNew={(f) => f.updated > seenAt(seenRuns[f.run_id], lastLooked)} />
        <div className="sticky top-[118px] max-h-[calc(100dvh-134px)] overflow-y-auto rounded-2xl border border-line-2 bg-s1 max-lg:static max-lg:max-h-none">
          {current ? (
            <FindingDetail key={sel!} f={current} run={runById.get(current.run_id)} onTriaged={() => next(refOf(current))} onOpen={(f) => setSel(refOf(f))} />
          ) : (
            <div className="px-6 py-12 text-center text-[13.5px] text-ink-3">
              {q && !order.length ? `Nothing in ${VIEWS.find((v) => v.id === view)!.label} matches "${q}".` : "Pick a finding to read and triage it."}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

