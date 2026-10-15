/** The run list beside an open run: a filter, then Live and Finished groups of compact tiles. */
import { useState } from "react";
import { IconLayoutSidebarLeftCollapse, IconSearch } from "@tabler/icons-react";
import { runName } from "../../lib/fleet.ts";
import { isFinished } from "../../lib/runs.ts";
import { Button } from "../../components/ui.tsx";
import { IC_SM } from "../../components/ui/bits.tsx";
import { MiniTile, type RunView } from "../wall/RunCards.tsx";

export function Rail({ views, current, onHide }: { views: RunView[]; current: string; onHide: () => void }) {
  const [q, setQ] = useState("");
  const shown = views
    .filter((v) => !q || `${runName(v.run)} ${v.run.id} ${v.run.repo}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (a.run.started_at ?? a.run.created_at) - (b.run.started_at ?? b.run.created_at));
  const live = shown.filter((v) => !isFinished(v.run));
  const fin = shown.filter((v) => isFinished(v.run)).reverse();
  return (
    <aside aria-label="Runs" data-rail className="flex flex-col gap-1.5 overflow-y-auto pt-px pr-1 pb-10 pl-px [scrollbar-width:thin] max-lg:hidden">
      <div className="mb-0.5 flex items-center gap-1.5">
        <Button size="sm" icon variant="ghost" title="Hide the run list ([)" aria-label="Hide the run list" onClick={onHide}>
          <IconLayoutSidebarLeftCollapse {...IC_SM} />
        </Button>
        <label className="inline-flex h-[34px] min-w-0 flex-1 items-center gap-2 rounded-[10px] border border-line-2 bg-s1 pr-2 pl-2.5 text-ink-3 focus-within:border-ink-4">
          <IconSearch {...IC_SM} />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setQ(""), e.currentTarget.blur())}
            placeholder="Filter"
            aria-label="Filter runs"
            data-rail-filter
            className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-ink outline-none [&::-webkit-search-cancel-button]:hidden"
          />
        </label>
      </div>
      {live.length > 0 && <GroupTitle title="Live" n={live.length} />}
      {live.map((v) => (
        <MiniTile key={v.run.id} v={v} current={v.run.id === current} />
      ))}
      {fin.length > 0 && <GroupTitle title="Finished" n={fin.length} />}
      {fin.map((v) => (
        <MiniTile key={v.run.id} v={v} current={v.run.id === current} />
      ))}
    </aside>
  );
}

const GroupTitle = ({ title, n }: { title: string; n: number }) => (
  <h3 className="mx-1 mt-3.5 mb-1 flex gap-2 text-[12.5px] font-medium text-ink-3">
    {title} <span className="font-mono text-xs">{n}</span>
  </h3>
);
