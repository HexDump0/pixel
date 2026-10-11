import { useState } from "react";
import { api } from "../../lib/api.ts";
import { useAsync, useThrottled, useTick } from "../../lib/hooks.ts";
import { useLive } from "../../lib/live.ts";
import { Link } from "../../lib/router.tsx";
import { ago, duration, money, tokens } from "../../lib/format.ts";
import { Badge, ErrorBox, Notice, PageHeader, Stat, Tabs } from "../../components/ui.tsx";
import { Controls } from "./Controls.tsx";
import { TranscriptTab } from "./TranscriptTab.tsx";
import { TimelineTab } from "./TimelineTab.tsx";
import { WorkbaseBrowser } from "../../components/WorkbaseBrowser.tsx";
import { ReportTab } from "./ReportTab.tsx";
import { TerminalTab } from "./TerminalTab.tsx";
import { MachineTab } from "./MachineTab.tsx";
import { OverviewTab } from "./OverviewTab.tsx";

type TabId = "overview" | "transcript" | "timeline" | "workbase" | "report" | "terminal" | "machine";

export function RunPage({ id }: { id: string }) {
  useTick(10_000);
  const detail = useAsync(() => api.run(id), [id]);
  const [tab, setTab] = useState<TabId>(() => (location.hash.slice(1) as TabId) || "overview");
  const reload = useThrottled(() => void detail.reload(), 1500);

  useLive(id, (m) => {
    if (m.type === "run") detail.setData((d) => (d ? { ...d, run: { ...d.run, ...m.data } } : d));
    if (["todos", "question", "question.closed", "session", "synced"].includes(m.type)) reload();
  });

  const changeTab = (t: TabId) => {
    setTab(t);
    history.replaceState(null, "", `#${t}`);
  };

  if (detail.error && !detail.data) return <ErrorBox error={detail.error} />;
  const d = detail.data;
  if (!d) return null;
  const r = d.run;
  const elapsed = r.started_at ? (r.finished_at ?? Date.now()) - r.started_at : null;
  const pending = d.questions.filter((q) => q.status === "pending");

  return (
    <div>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {r.id} <Badge value={r.status} />
            {["running", "recovering"].includes(r.status) && <Badge value={r.agent_status} />}
          </span>
        }
        subtitle={
          <>
            <a href={r.repo} target="_blank" rel="noreferrer">
              {r.repo}
            </a>
            {r.ref && ` @ ${r.ref}`}
            {r.commit_sha && <span className="font-mono"> · {r.commit_sha.slice(0, 10)}</span>}
            {r.language && ` · ${r.language}`}
            {r.parent_run && (
              <>
                {" · follow-up of "}
                <Link to={`/runs/${encodeURIComponent(r.parent_run)}`}>{r.parent_run}</Link>
              </>
            )}
          </>
        }
      />
      {r.status_detail && <Notice>{r.status_detail}</Notice>}
      {pending.length > 0 && tab !== "overview" && (
        <div className="mt-2">
          <Notice>
            The agent is waiting for an answer.{" "}
            <button className="cursor-pointer text-accent underline" onClick={() => changeTab("overview")}>
              Answer it
            </button>
          </Notice>
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Runtime" value={duration(elapsed)} hint={r.started_at ? `started ${ago(r.started_at)}` : undefined} />
        <Stat label="Last activity" value={ago(r.last_activity)} />
        <Stat label="Tokens" value={tokens(r.tokens_in + r.tokens_out + r.tokens_reasoning)} hint={`${tokens(r.tokens_in)} in · ${tokens(r.tokens_out)} out · ${tokens(r.tokens_cache)} cache`} />
        <Stat label="Cost" value={money(r.cost)} hint={r.model} />
        <Stat label="Recoveries" value={`${r.continues} / ${r.oom_restarts}`} hint="continues / OOM restarts" />
        <Stat label="Machine" value={`${r.size.cpu} CPU · ${r.size.memoryGiB} GiB`} hint={r.vm_name ?? "–"} />
      </div>

      <Controls detail={d} onChange={detail.reload} />

      <Tabs<TabId>
        value={tab}
        onChange={changeTab}
        tabs={[
          { id: "overview", label: `Overview${pending.length ? ` (${pending.length}❗)` : ""}` },
          { id: "transcript", label: "Transcript" },
          { id: "timeline", label: "Timeline" },
          { id: "workbase", label: "Workbase" },
          { id: "report", label: `Report & triage${d.report ? " ✓" : ""}` },
          { id: "terminal", label: "Terminal" },
          { id: "machine", label: "Machine" },
        ]}
      />
      {tab === "overview" && <OverviewTab detail={d} onChange={detail.reload} />}
      {tab === "transcript" && <TranscriptTab detail={d} />}
      {tab === "timeline" && <TimelineTab runId={id} />}
      {tab === "workbase" && <WorkbaseBrowser runId={id} />}
      {tab === "report" && <ReportTab detail={d} onChange={detail.reload} />}
      {tab === "terminal" && <TerminalTab detail={d} />}
      {tab === "machine" && <MachineTab detail={d} onChange={detail.reload} />}
    </div>
  );
}
