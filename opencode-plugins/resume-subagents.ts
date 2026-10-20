/**
 * opencode plugin: let an agent resume subagents that were interrupted instead of starting them again.
 *
 * When a session is stopped (or opencode dies) while subagents are running, each subagent call ends as
 * "Tool execution interrupted (sessionID: ses_...)". The child session survives with everything it did,
 * and the subagent tool can continue it when given that sessionID, but models tend to spawn a fresh
 * subagent and redo the work.
 *
 * This plugin adds a short hint to those calls in the copy of the history sent to the model (never
 * the stored session): the child's sessionID and how to resume it. Only the latest call per child
 * session gets the hint, so a subagent that was already resumed isn't offered again.
 *
 * opencode 2 plugin API (`setup` + `ctx.session.hook("context")`), checked on opencode 2.1.0.
 * Install: copy this file to ~/.config/opencode/plugins/ (or <project>/.opencode/plugins/).
 */

interface ToolResult {
  type: string;
  id?: string;
  name?: string;
  result?: { type?: string; value?: any };
  [k: string]: unknown;
}
interface Message {
  role: string;
  content: unknown;
  [k: string]: unknown;
}

const SESSION_ID = /sessionID:\s*(ses_[A-Za-z0-9]+)/;

/** The child session an interrupted subagent call left behind, if this part is one. */
export function interruptedChild(part: ToolResult): string | undefined {
  if (part?.type !== "tool-result" || part.name !== "subagent" || part.result?.type !== "error") return;
  const err = part.result.value?.error;
  if (err?.type !== "aborted") return;
  return SESSION_ID.exec(String(err.message ?? ""))?.[1];
}

export const hint = (sessionId: string) =>
  `The subagent was stopped before it finished, but its session (sessionID "${sessionId}") still holds everything it did. ` +
  `To pick it up where it stopped, call the subagent tool again with sessionID "${sessionId}" and a prompt saying to continue, ` +
  `instead of starting a new subagent. Don't resume it if that work is no longer needed.`;

const parts = (m: Message): ToolResult[] => (Array.isArray(m.content) ? (m.content as ToolResult[]) : []);

/** Messages with the latest interrupted call per child session given the resume hint. */
export function annotateInterruptedSubagents(messages: Message[]): Message[] {
  // Per child session: its latest interrupted call, and whether a call resumed it after that.
  const latest = new Map<string, ToolResult>();
  const resumedAfter = new Set<string>();
  for (const m of messages)
    for (const p of parts(m)) {
      const child = interruptedChild(p);
      if (child) {
        latest.set(child, p);
        resumedAfter.delete(child);
      }
      const input = (p as any).input;
      if (p.type === "tool-call" && p.name === "subagent" && typeof input?.sessionID === "string" && latest.has(input.sessionID)) resumedAfter.add(input.sessionID);
    }
  if (!latest.size) return messages;
  return messages.map((m) => {
    let changed = false;
    const content = parts(m).map((p) => {
      const child = interruptedChild(p);
      if (!child || latest.get(child) !== p || resumedAfter.has(child)) return p;
      changed = true;
      const err = p.result!.value.error;
      return { ...p, result: { ...p.result, value: { ...p.result!.value, error: { ...err, message: `${err.message}. ${hint(child)}` } } } };
    });
    return changed ? { ...m, content } : m;
  });
}

export default {
  id: "pixel.resume-subagents",
  async setup(ctx: any) {
    await ctx.session.hook("context", (event: { messages: Message[] }) => {
      const next = annotateInterruptedSubagents(event.messages);
      if (next !== event.messages) event.messages.splice(0, event.messages.length, ...next);
    });
  },
};
