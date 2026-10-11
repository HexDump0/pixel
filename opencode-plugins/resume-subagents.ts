/**
 * opencode plugin: let an agent resume subagents that were interrupted instead of starting them again.
 *
 * When a session is stopped (or opencode dies) while task-tool subagents are running, each task call
 * ends as "Tool execution aborted" (or "[Tool execution was interrupted]" after a crash). The child
 * session survives with all its messages and tool output, and the task tool can continue it via
 * `task_id`, but the model never sees that id: it lives only in the call's metadata. So the agent
 * spawns fresh subagents and their work is lost.
 *
 * This plugin rewrites those calls in the copy of the history sent to the model (never the stored
 * session) so the error names the task_id and says how to resume it. Only the latest call per
 * subagent session gets the hint, so a subagent that was already resumed isn't offered again.
 *
 * Only the plugin itself is exported: opencode calls every exported function in a plugin file as a plugin.
 *
 * Install: copy this file to ~/.config/opencode/plugin/ (or <project>/.opencode/plugin/).
 * Uses the experimental `experimental.chat.messages.transform` hook (checked on opencode 1.18.23 / 1.19.0).
 */

interface Part {
  id: string;
  type: string;
  tool?: string;
  state?: { status: string; error?: string; input?: Record<string, unknown>; metadata?: Record<string, unknown>; [k: string]: unknown };
  [k: string]: unknown;
}
interface Message {
  info: unknown;
  parts: Part[];
}

const isTask = (p: Part) => p.type === "tool" && p.tool === "task" && !!p.state;

/** The subagent session a task call created or resumed. */
function subagentOf(p: Part): string | undefined {
  const id = p.state?.metadata?.sessionId ?? p.state?.input?.task_id;
  return typeof id === "string" ? id : undefined;
}

function interruptedReason(p: Part): string | undefined {
  const s = p.state!;
  if (s.metadata?.background === true) return; // background tasks report back on their own
  if (s.status === "pending" || s.status === "running") return "[Tool execution was interrupted]";
  if (s.status === "error" && (s.metadata?.interrupted === true || /abort/i.test(s.error ?? ""))) return s.error;
}

const hint = (sessionId: string) =>
  `The subagent was stopped before it finished, but its session (task_id "${sessionId}") still holds everything it did. ` +
  `To pick it up where it stopped, call the task tool again with task_id "${sessionId}" and a prompt saying to continue, ` +
  `instead of starting a new subagent. Don't resume it if that work is no longer needed.`;

/** Returns the messages with interrupted task calls rewritten. */
function annotateInterruptedTasks(messages: Message[]): Message[] {
  const latest = new Map<string, string>();
  for (const m of messages) for (const p of m.parts) if (isTask(p)) {
    const sid = subagentOf(p);
    if (sid) latest.set(sid, p.id);
  }
  return messages.map((m) => {
    let changed = false;
    const parts = m.parts.map((p) => {
      if (!isTask(p)) return p;
      const sid = subagentOf(p);
      const reason = interruptedReason(p);
      if (!sid || !reason || latest.get(sid) !== p.id) return p;
      changed = true;
      // As an error without `interrupted`, opencode shows the model exactly this text.
      const { interrupted: _, ...metadata } = p.state!.metadata ?? {};
      return { ...p, state: { ...p.state!, status: "error", error: `${reason}. ${hint(sid)}`, metadata, time: p.state!.time ?? { start: Date.now(), end: Date.now() } } };
    });
    return changed ? { ...m, parts } : m;
  });
}

export const ResumeSubagents = async () => ({
  "experimental.chat.messages.transform": async (_input: unknown, output: { messages: Message[] }) => {
    const next = annotateInterruptedTasks(output.messages);
    // opencode keeps using this same array, so swap the entries in place; the stored messages are untouched.
    output.messages.splice(0, output.messages.length, ...next);
  },
});
