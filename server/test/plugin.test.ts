/** The resume-subagents opencode plugin, driven through its real hook with opencode-shaped messages. */
import { describe, expect, test } from "bun:test";
import { ResumeSubagents } from "../../opencode-plugins/resume-subagents.ts";

const task = (id: string, state: Record<string, unknown>) => ({ id, type: "tool", tool: "task", callID: `call_${id}`, state: { input: { description: "audit parser", prompt: "…", subagent_type: "general" }, ...state } });
const msg = (...parts: any[]) => ({ info: { role: "assistant" }, parts });

async function transform(messages: any[]) {
  const hooks = await ResumeSubagents();
  const output = { messages };
  await hooks["experimental.chat.messages.transform"]({}, output);
  return output.messages;
}

describe("resume-subagents plugin", () => {
  test("aborted task gets its task_id; stored message is not mutated", async () => {
    const aborted = task("p1", { status: "error", error: "Tool execution aborted", metadata: { sessionId: "ses_child1", interrupted: true }, time: { start: 1, end: 2 } });
    const original = structuredClone(aborted);
    const [m] = await transform([msg(aborted)]);
    const p = m.parts[0];
    expect(p.state.status).toBe("error");
    expect(p.state.error).toStartWith("Tool execution aborted. ");
    expect(p.state.error).toContain('task_id "ses_child1"');
    expect(p.state.metadata.interrupted).toBeUndefined();
    expect(aborted).toEqual(original);
  });

  test("task left running by a crash becomes an error with the hint", async () => {
    const [m] = await transform([msg(task("p1", { status: "running", metadata: { sessionId: "ses_crash" }, time: { start: 1 } }))]);
    expect(m.parts[0].state.status).toBe("error");
    expect(m.parts[0].state.error).toContain("[Tool execution was interrupted]");
    expect(m.parts[0].state.error).toContain('task_id "ses_crash"');
  });

  test("three parallel subagents all get their own id", async () => {
    const parts = ["a", "b", "c"].map((x) => task(x, { status: "error", error: "Tool execution aborted", metadata: { sessionId: `ses_${x}`, interrupted: true } }));
    const [m] = await transform([msg(...parts)]);
    expect(m.parts.map((p: any) => /task_id "(ses_\w)"/.exec(p.state.error)?.[1])).toEqual(["ses_a", "ses_b", "ses_c"]);
  });

  test("an already resumed subagent is not offered again; a re-interrupted one is", async () => {
    const first = task("p1", { status: "error", error: "Tool execution aborted", metadata: { sessionId: "ses_x", interrupted: true } });
    const resumed = task("p2", { status: "completed", output: "done", input: { task_id: "ses_x" }, metadata: { sessionId: "ses_x" } });
    let out = await transform([msg(first), msg(resumed)]);
    expect(out[0].parts[0].state.error).toBe("Tool execution aborted");

    const again = task("p3", { status: "error", error: "Tool execution aborted", input: { task_id: "ses_x" }, metadata: { sessionId: "ses_x", interrupted: true } });
    out = await transform([msg(first), msg(again)]);
    expect(out[0].parts[0].state.error).toBe("Tool execution aborted");
    expect(out[1].parts[0].state.error).toContain('task_id "ses_x"');
  });

  test("leaves completed, failed, background and non-task calls alone", async () => {
    const parts = [
      task("ok", { status: "completed", output: "fine", metadata: { sessionId: "ses_ok" } }),
      task("bad", { status: "error", error: "Subagent failed (task_id: ses_bad): boom", metadata: { sessionId: "ses_bad" } }),
      task("bg", { status: "running", metadata: { sessionId: "ses_bg", background: true } }),
      { id: "b1", type: "tool", tool: "bash", state: { status: "error", error: "Tool execution aborted", metadata: { interrupted: true } } },
      { id: "t1", type: "text", text: "hi" },
    ];
    const input = [msg(...parts)];
    const out = await transform(input);
    expect(out[0]).toBe(input[0]);
  });
});
