/** Things you look up rarely: how to connect, the sessions, the prompt that was sent, related runs. */
import { Link } from "../../lib/router.tsx";
import { money, tokens } from "../../lib/format.ts";
import { runUrl } from "../../lib/actions.ts";
import type { RunDetail } from "../../lib/types.ts";
import { CopyText } from "../../components/ui.tsx";
import { SectionHead } from "../../components/ui/bits.tsx";

export function RunInfo({ detail }: { detail: RunDetail }) {
  const r = detail.run;
  return (
    <div className="mt-10 flex max-w-[980px] flex-col gap-8">
      <section>
        <SectionHead title="Connect" />
        <div className="flex flex-col gap-2 text-sm">
          {detail.attach ? (
            <>
              <div className="text-xs text-ink-3">Attach your opencode TUI to this agent</div>
              <CopyText text={detail.attach} />
            </>
          ) : (
            <span className="text-ink-3">No opencode endpoint yet.</span>
          )}
          {detail.shell && (
            <>
              <div className="text-xs text-ink-3">Shell on the machine (from the Pixel host)</div>
              <CopyText text={detail.shell} />
            </>
          )}
          <div className="text-xs text-ink-3">
            Inside the machine: target <code>{detail.paths.target}</code>, workbase <code>{detail.paths.workbase}</code>, scratch <code>{detail.paths.scratch}</code> · event stream {detail.watching ? "connected" : "not connected"}
          </div>
        </div>
      </section>
      <section>
        <SectionHead title="Sessions" meta={String(detail.sessions.length)} />
        <div className="overflow-hidden rounded-xl border border-line-2">
          {detail.sessions.map((s) => {
            const t = JSON.parse(s.tokens || "{}");
            return (
              <div key={s.id} className="grid grid-cols-[minmax(0,1fr)_80px_80px_70px] gap-3 border-t border-line-2 px-3.5 py-2 text-[13px] first:border-t-0">
                <span className="min-w-0">
                  <span className="block truncate">
                    {s.parent_id ? "↳ " : ""}
                    {(s.title ?? s.id).replace(/\s*\(@\w+ subagent\)$/, "")}
                  </span>
                  <span className="block truncate font-mono text-[11px] text-ink-3">{s.id}</span>
                </span>
                <span className="text-ink-3">{s.agent ?? "–"}</span>
                <span className="text-right font-mono text-xs tabular-nums">{tokens((t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0))}</span>
                <span className="text-right font-mono text-xs tabular-nums">{money(s.cost)}</span>
              </div>
            );
          })}
        </div>
      </section>
      {(detail.compare.length > 1 || detail.followUps.length > 0) && (
        <section>
          <SectionHead title="Related runs" />
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
            {detail.compare.filter((c) => c !== r.id).map((c) => (
              <Link key={c} to={runUrl(c)}>
                {c} <span className="text-ink-3">(compare)</span>
              </Link>
            ))}
            {detail.followUps.map((c) => (
              <Link key={c} to={runUrl(c)}>
                {c} <span className="text-ink-3">(follow-up)</span>
              </Link>
            ))}
          </div>
        </section>
      )}
      <section>
        <SectionHead title="Prompt" meta={r.template_id ? `${r.template_id} v${r.template_version}` : undefined} />
        {detail.prompt ? <pre className="max-h-96 overflow-auto rounded-xl border border-line-2 bg-s2 p-3.5 font-mono text-xs whitespace-pre-wrap">{detail.prompt}</pre> : <span className="text-sm text-ink-3">Not sent yet.</span>}
      </section>
    </div>
  );
}
