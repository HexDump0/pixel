/** The resume-subagents opencode plugin, driven through its real hook with opencode 2-shaped model messages. */
import { describe, expect, test } from "bun:test";
import plugin from "../../opencode-plugins/resume-subagents.ts";

const call = (id: string, input: Record<string, unknown> = {}) => ({ type: "tool-call", id, name: "subagent", input: { agent: "general", description: "audit parser", prompt: "...", ...input } });
const interrupted = (id: string, child: string, name = "subagent") => ({
  type: "tool-result",
  id,
  name,
  result: { type: "error", value: { error: { type: "aborted", message: `Tool execution interrupted: ${name} (sessionID: ${child})` }, content: [] } },
});
const assistant = (...content: any[]) => ({ role: "assistant", content });
const tool = (...content: any[]) => ({ role: "tool", content });
const message = (p: any) => p.result?.value?.error?.message as string;

async function transform(messages: any[]) {
  let hook: (e: { messages: any[] }) => void = () => {};
  await plugin.setup({ session: { hook: async (name: string, fn: any) => name === "context" && (hook = fn) } });
  const event = { messages };
  hook(event);
  return event.messages;
}

describe("resume-subagents plugin", () => {
  test("interrupted subagent gets the resume hint; the input messages are not mutated", async () => {
    const result = interrupted("c1", "ses_child1");
    const original = structuredClone(result);
    const out = await transform([assistant(call("c1")), tool(result)]);
    expect(message(out[1].content[0])).toStartWith("Tool execution interrupted: subagent (sessionID: ses_child1). ");
    expect(message(out[1].content[0])).toContain('sessionID "ses_child1"');
    expect(result).toEqual(original);
  });

  test("three parallel subagents each get their own id", async () => {
    const out = await transform([assistant(call("a"), call("b"), call("c")), tool(interrupted("a", "ses_a"), interrupted("b", "ses_b"), interrupted("c", "ses_c"))]);
    expect(out[1].content.map((p: any) => /call the subagent tool again with sessionID "(ses_\w)"/.exec(message(p))?.[1])).toEqual(["ses_a", "ses_b", "ses_c"]);
  });

  test("a resumed subagent is not offered again; one interrupted again is", async () => {
    const first = interrupted("c1", "ses_x");
    let out = await transform([assistant(call("c1")), tool(first), assistant(call("c2", { sessionID: "ses_x" }))]);
    expect(message(out[1].content[0])).not.toContain("call the subagent tool again");

    out = await transform([assistant(call("c1")), tool(first), assistant(call("c2", { sessionID: "ses_x" })), tool(interrupted("c2", "ses_x"))]);
    expect(message(out[1].content[0])).not.toContain("call the subagent tool again");
    expect(message(out[3].content[0])).toContain('sessionID "ses_x"');
  });

  test("leaves completed calls, other failures, other tools and text alone", async () => {
    const msgs = [
      assistant({ type: "text", text: "hi" }, call("ok"), call("bad")),
      tool(
        { type: "tool-result", id: "ok", name: "subagent", result: { type: "text", value: "done" } },
        { type: "tool-result", id: "bad", name: "subagent", result: { type: "error", value: { error: { type: "tool", message: "Subagent failed (sessionID: ses_bad): boom" } } } },
        interrupted("sh", "ses_none", "shell"),
      ),
    ];
    const out = await transform(structuredClone(msgs));
    expect(out).toEqual(msgs);
  });
});
