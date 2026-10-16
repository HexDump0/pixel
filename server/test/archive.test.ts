import { describe, expect, test } from "bun:test";
import { db } from "../src/db.ts";
import { archiveOldRuns, archiveRun } from "../src/archive.ts";
import { transcript } from "../src/runs/events.ts";

const day = 86_400_000;
const old = Date.now() - 10 * day;

function addRun(id: string, status: string, lastActivity: number) {
  db.query("INSERT INTO runs (id, repo, model, size, status, runtime, created_at, last_activity) VALUES (?, 'x', 'p/m', '{}', ?, 'local', ?, ?)").run(id, status, old, lastActivity);
  db.query("INSERT INTO sessions (id, run_id, parent_id, title, created_at) VALUES (?, ?, NULL, 'audit', ?)").run(`${id}-s`, id, old);
  db.query("INSERT INTO messages (id, run_id, session_id, role, data, created_at) VALUES (?, ?, ?, 'assistant', ?, ?)").run(`${id}-m`, id, `${id}-s`, JSON.stringify({ id: `${id}-m`, role: "assistant" }), old);
  for (let i = 0; i < 3; i++) addPart(id, `prt_${id}_${i}`, i === 1 ? "tool" : "text");
}
function addPart(run: string, id: string, type: string) {
  const data = type === "tool" ? { id, sessionID: `${run}-s`, messageID: `${run}-m`, type, tool: "bash", state: { status: "completed", input: { command: "make" }, output: "x".repeat(500), time: { start: old, end: old + 1 } } } : { id, sessionID: `${run}-s`, messageID: `${run}-m`, type, text: `text ${id}` };
  db.query("INSERT INTO parts (id, run_id, session_id, message_id, type, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, run, `${run}-s`, `${run}-m`, type, JSON.stringify(data), old);
}
const partRows = (run: string) => (db.query("SELECT COUNT(*) AS n FROM parts WHERE run_id = ?").get(run) as { n: number }).n;
const callRows = (run: string) => (db.query("SELECT COUNT(*) AS n FROM tool_calls WHERE run_id = ?").get(run) as { n: number }).n;

describe("transcript archive", () => {
  test("quiet finished runs move their parts to files; the transcript reads the same", async () => {
    addRun("ar-1", "done", old);
    addRun("ar-live", "running", old);
    addRun("ar-recent", "stopped", Date.now() - day);
    const before = await transcript("ar-1", "ar-1-s");
    expect(before[0].parts.length).toBe(3);

    await archiveOldRuns();
    expect(partRows("ar-1")).toBe(0);
    expect(callRows("ar-1")).toBe(1); // kept for stats and charts
    expect(await transcript("ar-1", "ar-1-s")).toEqual(before);
    // Live and recently active runs stay in the database.
    expect(partRows("ar-live")).toBe(3);
    expect(partRows("ar-recent")).toBe(3);
  });

  test("a resumed run: new parts merge with the archive, and the next pass folds them in", async () => {
    addPart("ar-1", "prt_ar-1_3", "text");
    const merged = await transcript("ar-1", "ar-1-s");
    expect(merged[0].parts.map((p: any) => p.id)).toEqual(["prt_ar-1_0", "prt_ar-1_1", "prt_ar-1_2", "prt_ar-1_3"]);
    await archiveRun("ar-1");
    expect(partRows("ar-1")).toBe(0);
    expect(await transcript("ar-1", "ar-1-s")).toEqual(merged);
  });

  test("an explicitly removed tool part still removes its tool call", () => {
    db.query("DELETE FROM parts WHERE id = 'prt_ar-live_1'").run();
    expect(callRows("ar-live")).toBe(0);
  });
});
