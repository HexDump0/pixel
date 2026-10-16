/** The run's side column: agents with their last hour of tool calls, todos, other workbases, and the run's facts. */
import { useQuery } from "@tanstack/react-query";
import { IconChevronDown } from "@tabler/icons-react";
import { api } from "../../lib/api.ts";
import { keys } from "../../lib/query.ts";
import { useLive } from "../../lib/live.ts";
import { useThrottled } from "../../lib/hooks.ts";
import { kindColor } from "../../lib/fleet.ts";
import { money, tokens } from "../../lib/format.ts";
import { age, elapsed, useLimits } from "../../lib/health.ts";
import { repoShort } from "../../lib/runs.ts";
import { openRun } from "../../lib/actions.ts";
import { cn } from "../../lib/cn.ts";
import type { FleetRun, RunDetail, Todo } from "../../lib/types.ts";
import { KeyMenu, openModelDialog, useRunKeyName } from "../../components/RunMenu.tsx";
import { AgentDot, IC_XS, Join, Nil } from "../../components/ui/bits.tsx";

const KINDS: [string, string][] = [
  ["shell", "shell"],
  ["read", "read"],
  ["edit", "edit"],
  ["task", "subagent"],
  ["web", "web"],
];

function Head({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="mb-2 flex items-center gap-2.5">
      <h2 className="m-0 text-[12.5px] font-medium text-ink-2">{title}</h2>
      {meta && <span className="text-[12.5px] text-ink-3">{meta}</span>}
    </div>
  );
}

/** Agents as a tree (subagents indented), each with what it runs now and its last 60 minutes as a lane coloured by tool kind. */
function Agents({ detail, fleet }: { detail: RunDetail; fleet: FleetRun }) {
  const r = detail.run;
  const minutes = 60;
  const lanes = useQuery({ queryKey: keys.runLanes(r.id, minutes), queryFn: () => api.lanes(r.id, minutes), refetchInterval: 30_000 });
  const refresh = useThrottled(() => void lanes.refetch(), 5000);
  useLive("*", (m) => m.type === "activity" && m.data.run === r.id && refresh());
  const data = lanes.data;
  const W = 600;
  const x = (t: number) => (data ? Math.max(0, Math.min(W, ((t - data.from) / (data.to - data.from)) * W)) : 0);
  const laneOf = (session: string) => data?.lanes.find((l) => l.session === session);
  const lane = (session: string, done: boolean) => {
    const l = laneOf(session);
    return (
      <svg viewBox={`0 0 ${W} 12`} preserveAspectRatio="none" aria-hidden className="mt-1.5 ml-4 block h-3 w-[calc(100%-16px)] overflow-visible opacity-75">
        <rect x={0} y={5.5} width={W} height={1} className="fill-line-2" />
        {l?.segs.map(([a, b, k], i) => <rect key={i} x={x(a)} y={done ? 3 : 1} width={Math.max(1.2, x(b) - x(a))} height={done ? 6 : 10} rx={0.6} style={{ fill: kindColor(k) }} />)}
      </svg>
    );
  };
  const nowText = (n: FleetRun["now"], state: string) => {
    if (state === "waiting") return <span className="font-sans">waiting on subagents</span>;
    if (state === "idle") return <span className="font-sans text-warning">idle</span>;
    if (state === "interrupted") return <span className="font-sans text-warning">interrupted, can be resumed</span>;
    if (state === "failed") return <span className="font-sans text-critical">failed</span>;
    if (state === "done" || state === "finished" || state === "paused") return null;
    if (n && (n.status === "running" || n.status === "pending"))
      return (
        <>
          <span className="shrink-0" style={{ color: kindColor(n.kind) }}>
            {n.tool}
          </span>
          <span className="truncate text-ink-2">{n.text}</span>
        </>
      );
    return <span className="font-sans">thinking</span>;
  };
  const subs = fleet.agents.subs;
  const node = (s: (typeof subs)[number]) => {
    const kids = subs.filter((k) => k.parent === s.id);
    const what = nowText(s.now, s.status === "running" ? "working" : s.status);
    return (
      <li key={s.id}>
        <div className="grid grid-cols-[6px_minmax(0,1fr)_auto] items-center gap-2.5 text-[13.5px]">
          <AgentDot s={s.status} />
          <span title={s.title} className={cn("truncate font-medium", s.status === "done" && "font-normal text-ink-3")}>
            {s.title}
          </span>
          <span className="font-mono text-[11.5px] text-ink-3">{elapsed(Date.now() - s.started)}</span>
        </div>
        {what && <div className="mt-[3px] ml-4 flex min-w-0 gap-2 font-mono text-xs text-ink-3">{what}</div>}
        {lane(s.id, s.status === "done")}
        {kids.length > 0 && <ul className="m-0 mt-3 ml-[3px] flex list-none flex-col gap-3.5 border-l border-line-2 p-0 pl-3.5">{kids.map(node)}</ul>}
      </li>
    );
  };
  const roots = subs.filter((s) => !s.parent);
  const mainWhat = nowText(fleet.now, fleet.agents.main);
  return (
    <section data-slot="agents">
      <Head title="Agents" />
      <ul className="m-0 flex list-none flex-col gap-3.5 p-0">
        <li>
          <div className="grid grid-cols-[6px_minmax(0,1fr)_auto] items-center gap-2.5 text-[13.5px]">
            <AgentDot s={fleet.agents.main} />
            <span className="truncate font-medium">Main agent</span>
            <span className="font-mono text-[11.5px] text-ink-3">{r.started_at ? elapsed(Date.now() - r.started_at) : ""}</span>
          </div>
          {mainWhat && <div className="mt-[3px] ml-4 flex min-w-0 gap-2 font-mono text-xs text-ink-3">{mainWhat}</div>}
          {r.session_id && lane(r.session_id, false)}
          {roots.length > 0 && <ul className="m-0 mt-3 ml-[3px] flex list-none flex-col gap-3.5 border-l border-line-2 p-0 pl-3.5">{roots.map(node)}</ul>}
        </li>
      </ul>
      <div className="mt-2.5 mb-2 ml-4 flex justify-between font-mono text-[10.5px] text-ink-4">
        <span>{minutes}m</span>
        <span>now</span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-3 opacity-80">
        {KINDS.map(([k, l]) => (
          <span key={k}>
            <i className="mr-[5px] inline-block size-2 rounded-[2px]" style={{ background: kindColor(k) }} />
            {l}
          </span>
        ))}
      </div>
    </section>
  );
}

function TodoList({ todos }: { todos: Todo[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-[7px] p-0 text-[13px]">
      {todos.map((t, i) => (
        <li key={i} className={cn("flex items-center gap-[9px]", (t.status === "completed" || t.status === "cancelled") && "text-ink-3")}>
          <span
            className={cn(
              "grid size-3.5 shrink-0 place-items-center rounded-full border-[1.5px] border-ink-4",
              t.status === "completed" && "bg-ink-4",
              t.status === "in_progress" && "border-good bg-[conic-gradient(var(--good)_0_50%,transparent_50%_100%)]",
            )}
          >
            {t.status === "completed" && <span className="h-[3px] w-1.5 translate-x-[0.5px] -translate-y-[0.5px] -rotate-45 border-b-[1.5px] border-l-[1.5px] border-s1" />}
          </span>
          <span className={t.status === "cancelled" ? "line-through" : undefined}>{t.content}</span>
        </li>
      ))}
    </ul>
  );
}

function Todos({ detail }: { detail: RunDetail }) {
  const r = detail.run;
  const root = detail.todos.find((t) => t.session_id === r.session_id)?.todos ?? [];
  const subs = detail.todos.filter((t) => t.session_id !== r.session_id && t.todos.length);
  if (!root.length && !subs.length) return null;
  const done = root.filter((t) => t.status === "completed").length;
  const title = (sid: string) => (detail.sessions.find((s) => s.id === sid)?.title ?? "subagent").replace(/\s*\(@\w+ subagent\)$/, "");
  return (
    <section>
      <Head title="Todos" meta={root.length ? `${done}/${root.length}` : undefined} />
      {root.length > 0 && (
        <>
          <div className="mb-3 h-[3px] overflow-hidden rounded-sm bg-s3">
            <i className="block h-full rounded-sm bg-ink-2" style={{ width: `${(done / root.length) * 100}%` }} />
          </div>
          <TodoList todos={root} />
        </>
      )}
      {subs.map((t) => (
        <div key={t.session_id} className="mt-3">
          <div className="mb-1.5 truncate text-xs text-ink-3">{title(t.session_id)}</div>
          <TodoList todos={t.todos} />
        </div>
      ))}
    </section>
  );
}

function OtherWorkbases({ runId }: { runId: string }) {
  const reads = useQuery({ queryKey: ["run", runId, "crossreads"], queryFn: () => api.runCrossReads(runId) });
  const others = new Map<string, number>();
  for (const x of reads.data ?? []) others.set(x.other_run, (others.get(x.other_run) ?? 0) + 1);
  if (!others.size) return null;
  return (
    <section>
      <Head title="Other workbases" />
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
        {[...others].map(([o, n]) => (
          <li key={o} className="flex items-baseline gap-2">
            {o === "*" ? <span>the workbases index</span> : <button type="button" className="cursor-pointer truncate border-0 bg-transparent p-0 text-left text-ink underline decoration-ink-4 underline-offset-[3px] hover:decoration-ink" onClick={() => openRun(o)}>{o}</button>}
            <span className="font-mono text-xs text-ink-3">{n}x</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Facts({ detail }: { detail: RunDetail }) {
  const r = detail.run;
  const key = useRunKeyName(r);
  const limits = useLimits();
  const hours = Math.max(0.25, ((r.finished_at ?? Date.now()) - (r.started_at ?? r.created_at)) / 3_600_000);
  const row = (k: string, v: React.ReactNode) => (
    <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-2.5 border-t border-line-2 py-[7px] text-[12.5px] first:border-t-0">
      <dt className="text-ink-3">{k}</dt>
      <dd className="m-0 truncate font-mono text-xs text-ink">{v}</dd>
    </div>
  );
  const small = (s: React.ReactNode) => <small className="ml-1 font-sans text-ink-3">{s}</small>;
  const factBtn = "inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-left font-mono text-xs text-ink hover:underline hover:underline-offset-[3px]";
  return (
    <section>
      <Head title="Run" />
      <dl className="m-0 flex flex-col">
        {row(
          "Repo",
          <a href={r.repo} target="_blank" rel="noreferrer" className="text-ink no-underline hover:underline">
            {repoShort(r.repo)}
          </a>,
        )}
        {row("Ref", `${r.ref ?? "default branch"}${r.commit_sha ? ` @ ${r.commit_sha.slice(0, 7)}` : ""}`)}
        {row("Template", r.template_id ? `${r.template_id} v${r.template_version}` : <Nil />)}
        {row(
          "Model",
          <button type="button" className={factBtn} aria-haspopup="dialog" onClick={() => openModelDialog(r.id)}>
            <span className="truncate">{r.model.split("/").slice(1).join("/")}</span>
            {r.variant && small(r.variant)}
            <IconChevronDown {...IC_XS} className="shrink-0" />
          </button>,
        )}
        {row(
          "API key",
          <KeyMenu run={r}>
            <button type="button" className={factBtn}>
              <span className="truncate">{key.name}</span>
              {key.many && key.failover && small("failover")}
              <IconChevronDown {...IC_XS} className="shrink-0" />
            </button>
          </KeyMenu>,
        )}
        {row("Tokens", <Join items={[`${tokens(r.tokens_in)} in`, `${tokens(r.tokens_out + r.tokens_reasoning)} out`]} />)}
        {row("Cost", <>{money(r.cost)}{small(`${money(r.cost / hours)}/h`)}</>)}
        {!!r.autopilot && row("Continues", <span className={cn(r.continues >= limits.maxContinues - 1 && "text-warning")}>{r.continues} of {limits.maxContinues}</span>)}
        {r.oom_restarts > 0 && row("OOM", `${r.oom_restarts} of ${limits.maxOom} restarts`)}
        {row("Machine", <Join items={[`${r.size.cpu} CPU`, `${r.size.memoryGiB} GB`]} />)}
        {row("Started", r.started_at ? `${age(r.started_at)} ago` : <Nil />)}
        {r.parent_run && row("Follow-up of", <button type="button" className={factBtn} onClick={() => openRun(r.parent_run!)}>{r.parent_run}</button>)}
        {detail.followUps.length > 0 && row("Follow-ups", <span className="flex flex-wrap gap-x-2">{detail.followUps.map((c) => <button key={c} type="button" className={factBtn} onClick={() => openRun(c)}>{c}</button>)}</span>)}
        {detail.compare.filter((c) => c !== r.id).length > 0 && row("Compared", <span className="flex flex-wrap gap-x-2">{detail.compare.filter((c) => c !== r.id).map((c) => <button key={c} type="button" className={factBtn} onClick={() => openRun(c)}>{c}</button>)}</span>)}
      </dl>
    </section>
  );
}

export function SideColumn({ detail, fleet }: { detail: RunDetail; fleet?: FleetRun }) {
  return (
    <aside className="flex min-w-0 flex-col gap-[30px] overflow-y-auto border-l border-line-2 bg-[color-mix(in_srgb,var(--bg)_35%,var(--s1))] pt-[22px] pr-5 pb-12 pl-[22px] [scrollbar-width:thin] max-lg:overflow-visible max-lg:border-t max-lg:border-l-0">
      {fleet && <Agents detail={detail} fleet={fleet} />}
      <Todos detail={detail} />
      <OtherWorkbases runId={detail.run.id} />
      <Facts detail={detail} />
    </aside>
  );
}
