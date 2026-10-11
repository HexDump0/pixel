#!/usr/bin/env bun
/** `pixel` CLI: a thin client for the Pixel API. */
import { parseArgs } from "node:util";

const BASE = (process.env.PIXEL_URL || `http://127.0.0.1:${process.env.PIXEL_PORT || 7700}`).replace(/\/$/, "");
const PASSWORD = process.env.PIXEL_PASSWORD || "";

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { "content-type": "application/json", ...(PASSWORD ? { authorization: `Bearer ${PASSWORD}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`error: ${json.error ?? res.statusText}`);
    process.exit(1);
  }
  return json;
}

const ago = (ts?: number | null) => {
  if (!ts) return "-";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
};

function table(rows: string[][]) {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  for (const r of rows) console.log(r.map((c, i) => (c ?? "").padEnd(w[i])).join("  ").trimEnd());
}

const USAGE = `pixel: run and control audit agents

  pixel run <repo> [--ref R] [--template T] [--model M] [--size S] [--name N] [--follow-up RUN] [--no-autopilot] [--wait]
  pixel ls
  pixel show <run>
  pixel log <run>                 timeline, follows live
  pixel msg <run> <text...>       message the agent
  pixel continue|abort|pause|resume|stop|done|restart <run>
  pixel model <run> <provider/model>
  pixel triage <run> [--verdict V] [--notes TEXT] [--mark]
  pixel report <run>
  pixel rm <run> [--workbase]
  pixel templates

Environment: PIXEL_URL (default ${BASE}), PIXEL_PASSWORD.`;

async function followTimeline(id: string, until?: (status: string) => boolean) {
  const seen = new Set<number>();
  const print = (t: any) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    console.log(`${new Date(t.ts).toLocaleTimeString()}  ${t.actor.padEnd(5)}  ${t.message}`);
  };
  for (const t of await api<any[]>("GET", `/runs/${encodeURIComponent(id)}/timeline`)) print(t);
  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/ws`, { headers: PASSWORD ? { authorization: `Bearer ${PASSWORD}` } : {} } as any);
  ws.onopen = () => ws.send(JSON.stringify({ subscribe: [id] }));
  return new Promise<void>((resolve) => {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.run !== id) return;
      if (m.type === "timeline") print(m.data);
      if (m.type === "run" && until?.(m.data.status)) {
        ws.close();
        resolve();
      }
    };
    ws.onclose = () => resolve();
  });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values: o, positionals: pos } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      ref: { type: "string" },
      template: { type: "string" },
      model: { type: "string" },
      size: { type: "string" },
      name: { type: "string" },
      "follow-up": { type: "string" },
      "no-autopilot": { type: "boolean" },
      wait: { type: "boolean" },
      verdict: { type: "string" },
      notes: { type: "string" },
      mark: { type: "boolean" },
      workbase: { type: "boolean" },
    },
  });
  const id = pos[0] ? encodeURIComponent(pos[0]) : "";
  const need = () => {
    if (!id) {
      console.error(USAGE);
      process.exit(2);
    }
  };

  switch (cmd) {
    case "run": {
      need();
      const templates = await api<any[]>("GET", "/templates");
      const [run] = await api<any[]>("POST", "/runs", {
        repo: pos[0],
        ref: o.ref,
        templateId: o.template || templates[0]?.id,
        model: o.model,
        size: o.size,
        name: o.name,
        parentRun: o["follow-up"],
        autopilot: !o["no-autopilot"],
      });
      console.log(`created ${run.id}`);
      if (o.wait) await followTimeline(run.id, (s) => ["done", "stopped", "failed", "triaged"].includes(s));
      break;
    }
    case "ls":
    case undefined: {
      if (cmd === undefined) {
        console.log(USAGE);
        break;
      }
      const runs = await api<any[]>("GET", "/runs");
      table([
        ["RUN", "STATUS", "AGENT", "MODEL", "TOKENS", "COST", "ACTIVE", "REPORT", "CONT", "OOM"],
        ...runs.map((r) => [
          r.id,
          r.status,
          r.agent_status ?? "-",
          r.model,
          String(r.tokens_in + r.tokens_out + r.tokens_reasoning),
          `$${r.cost.toFixed(2)}`,
          ago(r.last_activity),
          r.report_ready ? "yes" : "-",
          String(r.continues),
          String(r.oom_restarts),
        ]),
      ]);
      break;
    }
    case "show": {
      need();
      const d = await api("GET", `/runs/${id}`);
      const r = d.run;
      console.log(`${r.id}  ${r.status}${r.status_detail ? ` (${r.status_detail})` : ""}`);
      console.log(`repo     ${r.repo}${r.ref ? ` @ ${r.ref}` : ""}  commit ${r.commit_sha ?? "-"}  ${r.language ?? ""}`);
      console.log(`model    ${r.model}   template ${r.template_id} v${r.template_version}   size ${r.size.cpu} CPU / ${r.size.memoryGiB} GiB`);
      console.log(`machine  ${r.vm_name ?? "-"}  ${r.endpoint ?? ""}`);
      console.log(`agent    ${r.agent_status ?? "-"}  continues ${r.continues}  oom restarts ${r.oom_restarts}  autopilot ${r.autopilot ? "on" : "off"}`);
      console.log(`usage    ${r.tokens_in} in / ${r.tokens_out} out / ${r.tokens_reasoning} reasoning   $${r.cost.toFixed(2)}`);
      if (d.attach) console.log(`attach   ${d.attach}`);
      if (d.shell) console.log(`shell    ${d.shell}`);
      for (const t of d.todos.flatMap((t: any) => t.todos)) console.log(`  [${t.status === "completed" ? "x" : t.status === "in_progress" ? ">" : " "}] ${t.content}`);
      break;
    }
    case "log":
      need();
      await followTimeline(decodeURIComponent(id));
      break;
    case "msg":
      need();
      await api("POST", `/runs/${id}/message`, { text: pos.slice(1).join(" ") });
      break;
    case "continue":
    case "abort":
    case "pause":
    case "resume":
    case "stop":
    case "done":
      need();
      await api("POST", `/runs/${id}/${cmd}`, {});
      console.log("ok");
      break;
    case "restart":
      need();
      await api("POST", `/runs/${id}/restart-opencode`, {});
      console.log("ok");
      break;
    case "model":
      need();
      await api("POST", `/runs/${id}/model`, { model: pos[1] });
      break;
    case "triage":
      need();
      await api("POST", `/runs/${id}/triage`, { verdict: o.verdict, notes: o.notes, markTriaged: !!o.mark });
      break;
    case "report": {
      need();
      const r = await api("GET", `/runs/${id}/report`);
      console.log(r.content ?? "(no report yet)");
      break;
    }
    case "rm":
      need();
      await api("DELETE", `/runs/${id}${o.workbase ? "?workbase=1" : ""}`);
      break;
    case "templates":
      table([["ID", "VERSION", "RUNS"], ...(await api<any[]>("GET", "/templates")).map((t) => [t.id, `v${t.version}`, String(t.runs)])]);
      break;
    default:
      console.log(USAGE);
      process.exit(2);
  }
}

await main();
