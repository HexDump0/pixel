/** The run's action bar: message the agent and every manual control. */
import { useState } from "react";
import { api } from "../../lib/api.ts";
import { navigate } from "../../lib/router.tsx";
import type { RunDetail } from "../../lib/types.ts";
import { Button } from "../../components/ui.tsx";

export function Controls({ detail, onChange }: { detail: RunDetail; onChange: () => void }) {
  const r = detail.run;
  const id = r.id;
  const [text, setText] = useState("");
  const live = ["running", "recovering"].includes(r.status);
  const hasSession = !!r.session_id;
  const act = (fn: () => Promise<unknown>) => async () => {
    await fn();
    onChange();
  };

  const send = async () => {
    await api.message(id, text);
    setText("");
    onChange();
  };

  return (
    <div className="card mt-3 flex flex-col gap-2.5 p-3">
      <div className="flex gap-2">
        <textarea
          className="input h-9 min-h-9 flex-1 resize-y font-sans"
          placeholder={hasSession ? "Message the agent (Ctrl+Enter to send)…" : "The agent has no session yet"}
          value={text}
          disabled={!hasSession}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && text.trim()) void send();
          }}
        />
        <Button variant="primary" onClick={send} disabled={!hasSession || !text.trim()}>
          Send
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button small onClick={act(() => api.control(id, "continue"))} disabled={!hasSession} done="Sent continue">
          Continue
        </Button>
        {r.status === "paused" || r.status === "stopped" ? (
          <Button small onClick={act(() => api.resume(id))} disabled={!hasSession} done="Resumed">
            Resume
          </Button>
        ) : (
          <Button small onClick={act(() => api.control(id, "pause"))} disabled={!live} done="Paused">
            Pause autopilot
          </Button>
        )}
        <Button small onClick={act(() => api.control(id, "abort"))} disabled={!live || r.agent_status === "idle"} confirm="Abort what the agent is doing right now? The run will be paused.">
          Abort
        </Button>
        <Button small onClick={act(() => api.control(id, "restart-opencode"))} disabled={!r.endpoint} done="opencode restarted">
          Restart opencode
        </Button>
        <Button small onClick={act(() => api.setAutopilot(id, !r.autopilot))}>
          Autopilot: {r.autopilot ? "on" : "off"}
        </Button>
        <Button small onClick={act(() => api.control(id, "reset-counters"))} done="Counters reset">
          Reset counters
        </Button>
        <Button
          small
          onClick={act(async () => {
            const m = prompt("New model (provider/model):", r.model);
            if (m) await api.setModel(id, m);
          })}
        >
          Change model
        </Button>
        <span className="mx-1 w-px bg-zinc-200 dark:bg-zinc-800" />
        {r.status === "failed" && (
          <Button small onClick={act(() => api.control(id, "retry"))}>
            Retry preparing
          </Button>
        )}
        <Button small onClick={act(() => api.control(id, "done"))} disabled={!["running", "recovering", "paused", "stopped"].includes(r.status)} confirm="Mark this run done? opencode's machine will be stopped.">
          Mark done
        </Button>
        <Button small variant="danger" onClick={act(() => api.control(id, "stop"))} disabled={!["running", "recovering", "paused", "preparing"].includes(r.status)} confirm="Stop this run? The agent is aborted; the machine is kept.">
          Stop
        </Button>
        <Button
          small
          onClick={async () => {
            const run = await api.rerun(id, {});
            navigate(`/runs/${encodeURIComponent(run.id)}`);
          }}
        >
          Re-run
        </Button>
        <Button small onClick={() => navigate(`/new?repo=${encodeURIComponent(r.repo)}&parent=${encodeURIComponent(id)}${r.ref ? `&ref=${encodeURIComponent(r.ref)}` : ""}`)}>
          Follow-up audit…
        </Button>
        <Button
          small
          variant="danger"
          onClick={async () => {
            if (!confirm(`Delete run ${id}? Its machine is destroyed.`)) return;
            const wb = confirm("Also delete its workbase? (Cancel keeps the workbase as shared knowledge.)");
            await api.deleteRun(id, wb);
            navigate("/");
          }}
        >
          Delete…
        </Button>
      </div>
    </div>
  );
}
