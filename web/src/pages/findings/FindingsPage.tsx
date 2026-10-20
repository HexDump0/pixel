/**
 * Findings (`/findings`): one panel like the run view. On the left the lists (to triage, report, done, all)
 * with search and Copy for LLM; on the right the picked finding: its text in a reading column and its facts
 * (triage, disclosure and deadline, latest upstream, runs from it, related). After a triage in To triage
 * the next finding opens.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { copyListForLlm, deadlineOf, inView, refOf, useFindings, type FindingView } from "../../lib/findings.ts";
import { useRuns } from "../../lib/runs.ts";
import { runName } from "../../lib/fleet.ts";
import { useLastLooked, useSeenRuns, seenAt } from "../../lib/seen.ts";
import type { Finding } from "../../lib/types.ts";
import { toast } from "../../components/Toast.tsx";
import { viewGroups } from "./FindingsTable.tsx";
import { FindingDetail } from "./FindingDetail.tsx";
import { FindingList, LISTS, PURPOSE_LABEL, type ListPurpose } from "./FindingList.tsx";

const VIEW_KEY = "pixel.findings.view";
const readView = (): FindingView => {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return LISTS.some((x) => x.id === v) ? (v as FindingView) : "triage";
  } catch {
    return "triage";
  }
};

/** Every word in the id, title, where, class, run, project, text or triage note. */
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
      if (e.key !== "/" || e.metaKey || e.ctrlKey || (e.target as HTMLElement).closest("input, textarea, select, [role=menu], [role=dialog]")) return;
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
  const counts = Object.fromEntries(LISTS.map((v) => [v.id, shown.filter((f) => inView(f, v.id)).length])) as Record<FindingView, number>;
  const overdue = all.filter((f) => deadlineOf(f)?.over).length;
  const current = all.find((f) => refOf(f) === sel) ?? (findings && !sel ? order[0] : null) ?? null;

  // After a triage in To triage, open the next finding: the one after it in the list as it last was while
  // it still held the selected one (the triaged one has left the list by then).
  const orderRef = useRef(order);
  orderRef.current = order;
  const snapshot = useRef<string[]>([]);
  if (current && order.some((f) => refOf(f) === refOf(current))) snapshot.current = order.map(refOf);
  const next = (from: string) => {
    if (view !== "triage") return;
    const still = new Set(orderRef.current.map(refOf));
    const before = snapshot.current;
    const i = before.indexOf(from);
    if (i < 0) return;
    const nxt = [...before.slice(i + 1), ...before.slice(0, i).reverse()].find((r) => still.has(r));
    if (nxt) setSel(nxt);
  };

  const copyList = (purpose: ListPurpose) => {
    if (!order.length) return;
    const title = `${LISTS.find((v) => v.id === view)!.title}${q ? `, matching "${q}"` : ""}`;
    copyListForLlm(order, purpose, title).then(
      () => toast(`Copied ${Math.min(order.length, 500)} findings for an LLM, ${PURPOSE_LABEL[purpose].toLowerCase()}`),
      (e) => toast((e as Error).message, "error"),
    );
  };

  return (
    <main className="gut pt-1 pb-5">
      <h1 className="sr-only">Findings</h1>
      <div className="flex h-[calc(100dvh-84px)] min-h-[560px] overflow-hidden rounded-2xl border border-line-2 bg-s1 max-lg:h-auto max-lg:flex-col">
        <div className="flex w-[310px] shrink-0 flex-col border-r border-line-2 max-lg:max-h-[46vh] max-lg:w-auto max-lg:border-r-0 max-lg:border-b">
          <FindingList
            view={view}
            onView={setView}
            counts={counts}
            overdue={overdue}
            groups={groups}
            q={q}
            onQ={setQ}
            search={search}
            runs={runById}
            selected={current ? refOf(current) : null}
            onOpen={(f) => setSel(refOf(f))}
            isNew={(f) => f.updated > seenAt(seenRuns[f.run_id], lastLooked)}
            onCopy={copyList}
          />
        </div>
        {current ? (
          <FindingDetail key={refOf(current)} f={current} run={runById.get(current.run_id)} onTriaged={() => next(refOf(current))} onOpen={(f) => setSel(refOf(f))} />
        ) : (
          <div className="flex flex-1 items-center justify-center px-6 py-12 text-[13.5px] text-ink-3">{findings ? "Pick a finding to read and triage it." : ""}</div>
        )}
      </div>
    </main>
  );
}
