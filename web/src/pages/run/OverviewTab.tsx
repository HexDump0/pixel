import { useState } from "react";
import { api } from "../../lib/api.ts";
import { useAsync } from "../../lib/hooks.ts";
import { Link } from "../../lib/router.tsx";
import { ago, money, tokens } from "../../lib/format.ts";
import type { Question, RunDetail, Todo } from "../../lib/types.ts";
import { Button, Card, CopyText, Empty } from "../../components/ui.tsx";

const TODO_ICON: Record<string, string> = { completed: "✓", in_progress: "▸", cancelled: "✗", pending: "○" };

function TodoList({ todos }: { todos: Todo[] }) {
  return (
    <ul className="flex flex-col gap-0.5 text-sm">
      {todos.map((t, i) => (
        <li
          key={i}
          className={t.status === "completed" || t.status === "cancelled" ? "muted line-through" : t.status === "in_progress" ? "text-accent" : ""}
        >
          <span className="inline-block w-5">{TODO_ICON[t.status] ?? "○"}</span>
          {t.content}
        </li>
      ))}
    </ul>
  );
}

function QuestionCard({ runId, q, onDone }: { runId: string; q: Question; onDone: () => void }) {
  const [answers, setAnswers] = useState<string[][]>(() => q.questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => q.questions.map(() => ""));
  const pick = (i: number, label: string, multiple?: boolean) =>
    setAnswers((a) => a.map((x, j) => (j !== i ? x : multiple ? (x.includes(label) ? x.filter((l) => l !== label) : [...x, label]) : [label])));
  const final = answers.map((a, i) => (custom[i].trim() ? [...a, custom[i].trim()] : a));

  return (
    <div className="rounded-md border border-amber-400/60 p-3">
      {q.questions.map((qq, i) => (
        <div key={i} className="mb-3">
          <div className="text-sm font-medium">{qq.question}</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {qq.options.map((o) => (
              <button key={o.label} title={o.description} className={`btn btn-sm ${answers[i].includes(o.label) ? "btn-primary" : ""}`} onClick={() => pick(i, o.label, qq.multiple)}>
                {o.label}
              </button>
            ))}
          </div>
          <input className="input mt-1.5 w-full" placeholder="Or type your own answer" value={custom[i]} onChange={(e) => setCustom((c) => c.map((x, j) => (j === i ? e.target.value : x)))} />
        </div>
      ))}
      <div className="flex gap-1.5">
        <Button
          variant="primary"
          small
          disabled={final.some((a) => !a.length)}
          onClick={async () => {
            await api.answer(runId, q.id, final);
            onDone();
          }}
        >
          Answer
        </Button>
        <Button
          small
          onClick={async () => {
            await api.answer(runId, q.id, null);
            onDone();
          }}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}

export function OverviewTab({ detail, onChange }: { detail: RunDetail; onChange: () => void }) {
  const r = detail.run;
  const reads = useAsync(() => api.runCrossReads(r.id), [r.id]);
  const pending = detail.questions.filter((q) => q.status === "pending");
  const root = detail.todos.find((t) => t.session_id === r.session_id)?.todos ?? [];
  const sub = detail.todos.filter((t) => t.session_id !== r.session_id && t.todos.length);
  const sessionTitle = (sid: string) => detail.sessions.find((s) => s.id === sid)?.title ?? sid;
  const others = new Map<string, number>();
  for (const x of reads.data ?? []) others.set(x.other_run, (others.get(x.other_run) ?? 0) + 1);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {pending.length > 0 && (
        <Card title="The agent is asking" className="lg:col-span-2">
          <div className="flex flex-col gap-3">
            {pending.map((q) => (
              <QuestionCard key={q.id} runId={r.id} q={q} onDone={onChange} />
            ))}
          </div>
        </Card>
      )}
      <Card title="Todos">
        {root.length ? <TodoList todos={root} /> : <Empty>No todos yet.</Empty>}
        {sub.map((t) => (
          <div key={t.session_id} className="mt-3">
            <div className="mb-1 text-xs muted">Subagent: {sessionTitle(t.session_id)}</div>
            <TodoList todos={t.todos} />
          </div>
        ))}
      </Card>

      <Card title="Connect">
        <div className="flex flex-col gap-2 text-sm">
          {detail.attach ? (
            <>
              <div className="text-xs muted">Attach your opencode TUI to this agent:</div>
              <CopyText text={detail.attach} />
            </>
          ) : (
            <span className="muted">No opencode endpoint yet.</span>
          )}
          {detail.shell && (
            <>
              <div className="text-xs muted">Shell on the machine (from the pixel host):</div>
              <CopyText text={detail.shell} />
            </>
          )}
          <div className="text-xs muted">
            Paths inside the machine: target <code>{detail.paths.target}</code>, workbase <code>{detail.paths.workbase}</code>, scratch <code>{detail.paths.scratch}</code>
          </div>
          <div className="text-xs muted">Event stream: {detail.watching ? "connected" : "not connected"}</div>
        </div>
      </Card>

      <Card title={`Sessions (${detail.sessions.length})`}>
        {detail.sessions.length ? (
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="th">Session</th>
                <th className="th">Agent</th>
                <th className="th text-right">Tokens</th>
                <th className="th text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {detail.sessions.map((s) => {
                const t = JSON.parse(s.tokens || "{}");
                return (
                  <tr key={s.id}>
                    <td className="td">
                      {s.parent_id ? "↳ " : ""}
                      {s.title ?? s.id}
                      <div className="font-mono text-[11px] muted">{s.id}</div>
                    </td>
                    <td className="td">{s.agent ?? "–"}</td>
                    <td className="td text-right tabular-nums">{tokens((t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0))}</td>
                    <td className="td text-right tabular-nums">{money(s.cost)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty>No sessions yet.</Empty>
        )}
      </Card>

      <Card title="Other workbases this agent looked at">
        {others.size ? (
          <ul className="text-sm">
            {[...others].map(([o, n]) => (
              <li key={o}>
                {o === "*" ? "the workbases index" : <Link to={`/runs/${encodeURIComponent(o)}`}>{o}</Link>} <span className="muted">× {n}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>None so far.</Empty>
        )}
        {reads.data?.length ? <div className="mt-2 text-xs muted">Last: {ago(reads.data[0].ts)} via {reads.data[0].tool}</div> : null}
      </Card>

      {(detail.compare.length > 1 || detail.followUps.length > 0) && (
        <Card title="Related runs">
          {detail.compare.length > 1 && (
            <div className="text-sm">
              Compare group:{" "}
              {detail.compare.map((c) => (
                <Link key={c} className="mr-2" to={`/runs/${encodeURIComponent(c)}`}>
                  {c}
                </Link>
              ))}
            </div>
          )}
          {detail.followUps.length > 0 && (
            <div className="text-sm">
              Follow-ups:{" "}
              {detail.followUps.map((c) => (
                <Link key={c} className="mr-2" to={`/runs/${encodeURIComponent(c)}`}>
                  {c}
                </Link>
              ))}
            </div>
          )}
        </Card>
      )}

      <Card title={`Prompt (${r.template_id} v${r.template_version})`} className="lg:col-span-2">
        {detail.prompt ? <pre className="max-h-96 overflow-auto font-mono text-xs whitespace-pre-wrap">{detail.prompt}</pre> : <Empty>Not sent yet.</Empty>}
      </Card>
    </div>
  );
}
