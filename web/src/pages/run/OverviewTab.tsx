/**
 * Overview: what is happening and how it went, without repeating the Findings tab or the side column.
 * Charts (the run's whole life), Story (the run's notable events, new ones marked), Now (each working
 * agent's last tool calls, live). The agent's question, when it asks one, sits on top.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  IconAlertTriangle,
  IconBug,
  IconCheck,
  IconCircleX,
  IconFileCheck,
  IconKey,
  IconLoader2,
  IconMessage,
  IconMessageQuestion,
  IconPlayerPause,
  IconPlayerPlay,
  IconPointFilled,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";
import { api } from "../../lib/api.ts";
import { keys, queryClient } from "../../lib/query.ts";
import { useLive } from "../../lib/live.ts";
import { useThrottled } from "../../lib/hooks.ts";
import { kindColor } from "../../lib/fleet.ts";
import { age } from "../../lib/health.ts";
import { cn } from "../../lib/cn.ts";
import type { Activity, FleetRun, Question, RunDetail, TimelineEntry } from "../../lib/types.ts";
import { Button } from "../../components/ui.tsx";
import { AgentDot, IC_SM, Kbd, SectionHead, Sep } from "../../components/ui/bits.tsx";
import { RunCharts } from "../../components/charts/RunCharts.tsx";
import { toast } from "../../components/Toast.tsx";

// ---- the agent's question ----

function QuestionCard({ runId, q, onDone }: { runId: string; q: Question; onDone: () => void }) {
  const [answers, setAnswers] = useState<string[][]>(() => q.questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => q.questions.map(() => ""));
  const pick = (i: number, label: string, multiple?: boolean) =>
    setAnswers((a) => a.map((x, j) => (j !== i ? x : multiple ? (x.includes(label) ? x.filter((l) => l !== label) : [...x, label]) : [label])));
  const final = answers.map((a, i) => (custom[i].trim() ? [...a, custom[i].trim()] : a));
  const send = (reject: boolean) => api.answer(runId, q.id, reject ? null : final).then(onDone, (e) => toast(e.message, "error"));
  return (
    <section className="flex flex-col gap-3.5 rounded-2xl border border-warning/15 bg-[color-mix(in_srgb,var(--warning)_7%,var(--s1))] px-5 py-[18px]">
      <div className="flex items-center gap-2.5 text-[12.5px]">
        <span className="font-medium text-warning">The agent is asking</span>
        <span className="text-ink-3">{age(q.created_at)} ago</span>
      </div>
      {q.questions.map((qq, i) => (
        <div key={i} className="flex flex-col gap-2.5">
          <p className="m-0 text-[15px] leading-relaxed text-ink">{qq.question}</p>
          <div className="flex flex-wrap gap-1.5">
            {qq.options.map((o, k) => (
              <button
                key={o.label}
                type="button"
                title={o.description}
                aria-pressed={answers[i].includes(o.label)}
                onClick={() => pick(i, o.label, qq.multiple)}
                className="inline-flex min-h-[30px] items-center gap-2 rounded-lg border border-line bg-s2 py-1 pr-2.5 pl-1.5 text-left text-[12.5px] font-medium text-ink hover:border-warning aria-pressed:border-ink aria-pressed:bg-s3"
              >
                <Kbd>{k + 1}</Kbd>
                {o.label}
              </button>
            ))}
          </div>
          <input
            value={custom[i]}
            onChange={(e) => setCustom((c) => c.map((x, j) => (j === i ? e.target.value : x)))}
            placeholder="Or type your own answer"
            className="h-9 rounded-[10px] border border-line-2 bg-s1 px-2.5 text-ink outline-none focus:border-ink-3"
          />
        </div>
      ))}
      <div className="flex gap-1.5">
        <Button variant="primary" size="sm" disabled={final.some((a) => !a.length)} onClick={() => send(false)}>
          Answer
        </Button>
        <Button size="sm" variant="ghost" onClick={() => send(true)}>
          Dismiss
        </Button>
      </div>
    </section>
  );
}

// ---- now: each working agent's last few tool calls ----

const STATUS_ICON = { completed: IconCheck, error: IconX, running: IconLoader2, pending: IconLoader2 } as const;

function Now({ runId, fleet, rootSession }: { runId: string; fleet?: FleetRun; rootSession: string | null }) {
  const q = useQuery({ queryKey: keys.runActivity(runId), queryFn: () => api.activity(runId, 120) });
  useLive("*", (m) => {
    if (m.type !== "activity" || m.data.run !== runId) return;
    const a: Activity = m.data;
    queryClient.setQueryData<{ calls: Activity[]; events: unknown[] }>(keys.runActivity(runId), (d) => {
      if (!d) return d;
      const same = (x: Activity) => x.session === a.session && x.ts === a.ts && x.tool === a.tool;
      const calls = d.calls.some(same) ? d.calls.map((x) => (same(x) ? { ...x, ...a } : x)) : [a, ...d.calls];
      return { ...d, calls: calls.slice(0, 200) };
    });
  });
  if (!fleet) return null;
  const calls = q.data?.calls ?? [];
  const agents = [
    { id: rootSession ?? "", title: "Main agent", state: fleet.agents.main },
    ...fleet.agents.subs.filter((s) => s.status === "running" || s.status === "interrupted").map((s) => ({ id: s.id, title: s.title, state: s.status === "running" ? "working" : s.status })),
  ];
  const working = agents.filter((a) => a.state === "working");
  const quiet = agents.filter((a) => a.state !== "working");
  if (!working.length && !quiet.length) return null;
  return (
    <section>
      <SectionHead title="Now" />
      {working.map((a) => {
        const mine = calls.filter((c) => c.session === a.id).slice(0, 5);
        return (
          <div key={a.id} className="mb-4">
            <div className="mb-1.5 flex items-center gap-[9px] text-[13px]">
              <AgentDot s="working" />
              <span className="truncate font-medium">{a.title}</span>
              {mine[0] && <span className="ml-auto font-mono text-xs text-ink-3">{age(mine[0].ts)} ago</span>}
            </div>
            {mine.length ? (
              <ul className="m-0 ml-0.5 flex list-none flex-col border-l border-line-2 p-0 pl-[15px]">
                {mine.map((c, i) => {
                  const Icon = STATUS_ICON[c.status as keyof typeof STATUS_ICON] ?? IconPointFilled;
                  const running = c.status === "running" || c.status === "pending";
                  return (
                    <li key={`${c.ts}${c.tool}${i}`} className={cn("grid grid-cols-[48px_minmax(0,1fr)_18px_52px] items-center gap-2.5 py-[3px] font-mono text-[12.5px] leading-normal text-ink-2", i === 0 && "text-ink")}>
                      <span style={{ color: kindColor(c.kind) }}>{c.tool}</span>
                      <span className="truncate" title={c.text}>
                        {c.text}
                      </span>
                      <span className={cn("flex justify-center", c.status === "error" ? "text-critical" : running ? "text-good" : "text-ink-4")}>
                        <Icon size={13} stroke={2} className={running ? "animate-spin" : undefined} />
                      </span>
                      <span className="text-right text-[11.5px] text-ink-3">{c.end ? `${((c.end - c.ts) / 1000).toFixed(c.end - c.ts < 10_000 ? 1 : 0)}s` : running ? age(c.ts) : ""}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="ml-4 text-[13px] text-ink-3">thinking</div>
            )}
          </div>
        );
      })}
      {quiet.map((a) => (
        <div key={a.id} className="mb-1.5 flex items-center gap-[9px] text-[13px] text-ink-3">
          <AgentDot s={a.state} />
          <span className="truncate">{a.title}</span>
          <span><Sep className="ml-0" />{a.state === "waiting" ? "waiting on subagents" : a.state === "idle" ? "idle" : a.state === "interrupted" ? "interrupted" : a.state}</span>
        </div>
      ))}
    </section>
  );
}

// ---- story: the run's notable events ----

const STORY_KINDS = new Set(["created", "finding", "question", "message", "continue", "recover", "restart", "key", "limit", "done", "failed", "stopped", "idle", "triage", "pause", "resume", "stop", "model", "abort", "retry"]);

function storyIcon(e: TimelineEntry) {
  switch (e.kind) {
    case "finding":
      return { Icon: IconBug, k: "find" };
    case "question":
      return e.actor === "agent" ? { Icon: IconMessageQuestion, k: "warn" } : { Icon: IconMessage, k: "you" };
    case "message":
      return { Icon: IconMessage, k: "you" };
    case "recover":
    case "restart":
    case "key":
    case "limit":
    case "idle":
      return { Icon: IconAlertTriangle, k: "warn" };
    case "continue":
      return { Icon: IconRefresh, k: "" };
    case "failed":
    case "stopped":
    case "stop":
      return { Icon: IconCircleX, k: "bad" };
    case "done":
      return { Icon: IconFileCheck, k: "done" };
    case "pause":
    case "abort":
      return { Icon: IconPlayerPause, k: "you" };
    case "resume":
    case "created":
      return { Icon: IconPlayerPlay, k: e.actor === "user" ? "you" : "" };
    case "key":
      return { Icon: IconKey, k: "warn" };
    default:
      return { Icon: IconPointFilled, k: e.actor === "user" ? "you" : "" };
  }
}
const SEV_CLASS: Record<string, string> = { critical: "text-sev-high", high: "text-sev-high", medium: "text-sev-medium", low: "text-sev-low", info: "text-sev-low" };
const K_CLASS: Record<string, string> = { find: "text-sev-low", warn: "text-warning", bad: "text-critical", you: "text-accent", done: "text-good", "": "text-ink-3" };

function storyText(e: TimelineEntry): { main: string; note?: string } {
  const d = e.data as any;
  if (e.kind === "finding" && d?.title) {
    const what =
      d.action === "add"
        ? "Found"
        : d.action === "remove"
          ? "Removed"
          : d.action === "verdict" || d.action === "triage"
            ? "Triaged"
            : d.action === "disclosure"
              ? (({ ready: "Back to not sent", reported: "Sent upstream", fixed: "Fixed upstream", dropped: "Disclosure dropped" }) as Record<string, string>)[d.changes?.disclosure?.[1]] ?? "Disclosure updated"
            : d.changes?.state
              ? (({ confirmed: "Confirmed", ruled_out: "Ruled out", suspected: "Now suspected", lead: "Back to a lead" }) as Record<string, string>)[d.changes.state[1]] ?? "Updated"
              : "Updated";
    const v =
      d.action === "verdict"
        ? ` ${(d.changes?.verdict?.[1] ?? "untriaged").replace("_", " ").replace("not bug", "not a bug")}`
        : d.action === "triage" && d.changes?.disposition
          ? ` ${d.changes.disposition[1] ?? "untriaged"}`
          : "";
    return { main: `${what}${v}: ${d.title} (${d.finding})`, note: d.note ?? undefined };
  }
  return { main: e.message.replace(/^You: /, "You: ") };
}

function Story({ runId, seen, onOpenFinding }: { runId: string; seen: number; onOpenFinding: (id: string) => void }) {
  const q = useQuery({ queryKey: keys.runTimeline(runId), queryFn: () => api.timeline(runId) });
  const [all, setAll] = useState(false);
  useLive(runId, (m) => {
    if (m.type === "timeline") queryClient.setQueryData<TimelineEntry[]>(keys.runTimeline(runId), (d) => (d && !d.some((x) => x.id === m.data.id) ? [...d, m.data] : d));
  });
  const items = useMemo(() => (q.data ?? []).filter((e) => STORY_KINDS.has(e.kind) && !(e.kind === "restart" && /^Pixel restarted/.test(e.message))).reverse(), [q.data]);
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, 14);
  const fresh = items.filter((e) => e.ts > seen).length;
  return (
    <section>
      <SectionHead title="Story" meta={fresh ? `${fresh} new since you looked` : undefined} />
      <ol className="m-0 flex list-none flex-col p-0">
        {shown.map((e) => {
          const { Icon, k } = storyIcon(e);
          const d = e.data as any;
          const t = storyText(e);
          const finding = e.kind === "finding" ? d?.finding : null;
          return (
            <li
              key={e.id}
              onClick={finding ? () => onOpenFinding(finding) : undefined}
              className={cn(
                "grid grid-cols-[16px_minmax(0,1fr)_64px] items-start gap-3 rounded-lg px-2 py-[7px] text-[13.5px] leading-normal",
                e.ts > seen && "bg-accent/6",
                finding && "cursor-pointer hover:bg-s2",
              )}
            >
              <span className={cn("flex pt-0.5", finding ? (SEV_CLASS[d?.severity] ?? K_CLASS.find) : K_CLASS[k])}>
                <Icon {...IC_SM} />
              </span>
              <span className="min-w-0">
                {t.main}
                {t.note && <span className="block text-[12.5px] text-ink-3">{t.note}</span>}
              </span>
              <span className={cn("pt-0.5 text-right font-mono text-[11.5px]", e.ts > seen ? "text-accent" : "text-ink-3")}>{age(e.ts)}</span>
            </li>
          );
        })}
      </ol>
      {items.length > shown.length && (
        <button type="button" onClick={() => setAll(true)} className="mt-1.5 ml-2 cursor-pointer border-0 bg-transparent p-0 text-[12.5px] text-ink-3 hover:text-ink hover:underline">
          {items.length - shown.length} earlier
        </button>
      )}
    </section>
  );
}

// ---- charts ----

function Charts({ detail, fleet }: { detail: RunDetail; fleet?: FleetRun }) {
  const id = detail.run.id;
  const live = detail.run.status === "running" || detail.run.status === "recovering";
  const q = useQuery({ queryKey: keys.runSeries(id), queryFn: () => api.series(id), refetchInterval: live ? 60_000 : false });
  const refresh = useThrottled(() => void q.refetch(), 30_000);
  useLive(id, (m) => m.type === "message" && refresh());
  if (!q.data?.tps.length) return null;
  return (
    <section>
      <SectionHead title="Over the run" />
      <RunCharts s={q.data} contextLimit={fleet?.context.limit ?? null} />
    </section>
  );
}

export function OverviewTab({ detail, fleet, seen, onOpenFinding, onChange }: { detail: RunDetail; fleet?: FleetRun; seen: number; onOpenFinding: (id: string) => void; onChange: () => void }) {
  const r = detail.run;
  const pending = detail.questions.filter((q) => q.status === "pending");
  return (
    <>
      {pending.map((q) => (
        <QuestionCard key={q.id} runId={r.id} q={q} onDone={onChange} />
      ))}
      <Charts detail={detail} fleet={fleet} />
      <Story runId={r.id} seen={seen} onOpenFinding={onOpenFinding} />
      <Now runId={r.id} fleet={fleet} rootSession={r.session_id} />
    </>
  );
}
