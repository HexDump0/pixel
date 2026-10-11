/** Every automatic and manual action on the run, in order. */
import { useState } from "react";
import { api } from "../../lib/api.ts";
import { useAsync } from "../../lib/hooks.ts";
import { useLive } from "../../lib/live.ts";
import type { TimelineEntry } from "../../lib/types.ts";
import { Empty } from "../../components/ui.tsx";

const ACTOR_STYLE: Record<TimelineEntry["actor"], string> = {
  pixel: "text-amber-600 dark:text-amber-400",
  user: "text-accent",
  agent: "text-emerald-600 dark:text-emerald-400",
};

export function TimelineTab({ runId }: { runId: string }) {
  const tl = useAsync(() => api.timeline(runId), [runId]);
  const [actor, setActor] = useState<"" | TimelineEntry["actor"]>("");
  useLive(runId, (m) => {
    if (m.type === "timeline") tl.setData((xs = []) => (xs.some((x) => x.id === m.data.id) ? xs : [...xs, m.data]));
  });
  const shown = (tl.data ?? []).filter((t) => !actor || t.actor === actor).slice().reverse();

  return (
    <div>
      <div className="mb-3 flex gap-1.5">
        {(["", "pixel", "user", "agent"] as const).map((a) => (
          <button key={a} className={`btn btn-sm ${actor === a ? "btn-primary" : ""}`} onClick={() => setActor(a)}>
            {a || "all"}
          </button>
        ))}
      </div>
      {!shown.length && <Empty>Nothing yet.</Empty>}
      <div className="card p-0">
        {shown.map((t) => (
          <div key={t.id} className="grid grid-cols-[150px_56px_1fr] gap-2 border-b border-zinc-100 px-3 py-1.5 text-sm last:border-0 dark:border-zinc-800/60">
            <span className="text-xs whitespace-nowrap tabular-nums muted">{new Date(t.ts).toLocaleString()}</span>
            <span className={`text-xs ${ACTOR_STYLE[t.actor]}`}>{t.actor}</span>
            <span className="break-words">{t.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
