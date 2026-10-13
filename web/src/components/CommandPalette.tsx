/**
 * ⌘K / Ctrl+K: jump to any run or page, control the run you're looking at, message it,
 * or search every workbase. Opens from anywhere; `openPalette()` opens it from a button.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api.ts";
import { navigate, useLocation, match } from "../lib/router.tsx";
import { useRuns } from "../lib/runs.ts";
import type { SearchHit } from "../lib/types.ts";
import { Icon } from "./icons.tsx";
import { toast } from "./Toast.tsx";
import { startRename } from "./RunName.tsx";

interface Item {
  group: string;
  icon: ReactNode;
  label: string;
  sub?: string;
  run: () => void | Promise<unknown>;
  /** Keep the palette open (e.g. switch to message mode). */
  stay?: boolean;
}

const listeners = new Set<(messageTo?: string) => void>();
/** Open the palette; with a run id it opens straight into "message this run". */
export const openPalette = (messageTo?: string) => listeners.forEach((l) => l(messageTo));

/** The run the user is looking at: the run page, or the run open in the Runs panel. */
function currentRun(path: string, search: string) {
  return match("/runs/:id", path)?.id ?? new URLSearchParams(search).get("run");
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [messageTo, setMessageTo] = useState<string | null>(null);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const { runs } = useRuns();
  const { path, search } = useLocation();
  const here = currentRun(path, search);

  const show = (to?: string) => {
    setOpen(true);
    setQ("");
    setSel(0);
    setMessageTo(to ?? null);
    setHits([]);
  };
  const close = () => setOpen(false);

  useEffect(() => {
    listeners.add(show);
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => {
          if (!o) show(undefined);
          return !o;
        });
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      listeners.delete(show);
      window.removeEventListener("keydown", key);
    };
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 0);
  }, [open, messageTo]);

  // Workbase search, debounced, once the query is long enough to mean something.
  useEffect(() => {
    if (!open || messageTo || q.trim().length < 3) return setHits([]);
    const t = setTimeout(() => api.search(q.trim()).then((h) => setHits(h.slice(0, 6)), () => setHits([])), 220);
    return () => clearTimeout(t);
  }, [q, open, messageTo]);

  const items = useMemo<Item[]>(() => {
    if (messageTo) return [];
    const ctl = (id: string, action: string, done: string) => async () => {
      await api.control(id, action);
      toast(done);
    };
    const list: Item[] = [];
    const cur = runs?.find((r) => r.id === here);
    if (cur) {
      const g = `This run · ${cur.label ?? cur.id}`;
      list.push({ group: g, icon: <Icon name="msg" />, label: "Message the agent…", run: () => setMessageTo(cur.id), stay: true });
      list.push({ group: g, icon: <Icon name="edit" />, label: "Rename run…", run: () => startRename(cur.id) });
      if (["running", "recovering"].includes(cur.status)) list.push({ group: g, icon: <Icon name="pause" />, label: "Pause", run: ctl(cur.id, "pause", "Paused") });
      if (["paused", "stopped", "done"].includes(cur.status)) list.push({ group: g, icon: <Icon name="play" />, label: "Resume", run: () => api.resume(cur.id).then(() => toast("Resumed")) });
      if (cur.status === "running") list.push({ group: g, icon: <Icon name="next" />, label: "Send “continue”", run: ctl(cur.id, "continue", "Sent continue") });
      list.push({ group: g, icon: <Icon name="term" />, label: "Open terminal", run: () => navigate(`/runs/${encodeURIComponent(cur.id)}#terminal`) });
      list.push({ group: g, icon: <Icon name="open" />, label: "Open run page", run: () => navigate(`/runs/${encodeURIComponent(cur.id)}`) });
    }
    for (const r of runs ?? []) list.push({ group: "Runs", icon: <span className={`dot ${r.status}`} style={{ margin: "0 3px" }} />, label: r.label ? `${r.label} · ${r.id}` : r.id, sub: `${r.status} · ${r.repo.replace(/^https?:\/\/(www\.)?/, "")}`, run: () => navigate(`/?run=${encodeURIComponent(r.id)}`) });
    list.push(
      { group: "Go to", icon: <Icon name="plus" />, label: "New run", run: () => navigate("/new") },
      { group: "Go to", icon: <Icon name="runs" />, label: "Runs", run: () => navigate("/") },
      { group: "Go to", icon: <Icon name="activity" />, label: "Activity", run: () => navigate("/activity") },
      { group: "Go to", icon: <Icon name="gauge" />, label: "Models: provider health and leaderboard", run: () => navigate("/models") },
      { group: "Go to", icon: <Icon name="chart" />, label: "Stats: tokens, cache hit rate, cost, health", run: () => navigate("/stats") },
      { group: "Go to", icon: <Icon name="book" />, label: "Knowledge", run: () => navigate("/knowledge") },
      { group: "Go to", icon: <Icon name="file" />, label: "Templates", run: () => navigate("/templates") },
      { group: "Go to", icon: <Icon name="settings" />, label: "Settings", run: () => navigate("/settings") },
      { group: "Go to", icon: <Icon name="system" />, label: "System", run: () => navigate("/system") },
    );
    const t = q.trim().toLowerCase();
    const shown = t ? list.filter((i) => `${i.label} ${i.sub ?? ""} ${i.group}`.toLowerCase().includes(t)) : list;
    return [
      ...shown,
      ...hits.map((h) => ({
        group: "In workbases",
        icon: <Icon name="search" />,
        label: `${h.run_id}/${h.path}`,
        sub: h.snippet.replace(/<[^>]+>/g, "").slice(0, 80),
        run: () => navigate(`/runs/${encodeURIComponent(h.run_id)}#workbase`),
      })),
    ];
  }, [runs, here, q, hits, messageTo]);

  if (!open) return null;

  const exec = async (i: number) => {
    const it = items[i];
    if (!it) return;
    if (!it.stay) close();
    try {
      await it.run();
    } catch (e: any) {
      toast(e.message ?? String(e), "error");
    }
  };
  const send = async () => {
    const text = q.trim();
    if (!text || !messageTo) return;
    close();
    try {
      await api.message(messageTo, text);
      toast(`Sent to ${messageTo}`);
    } catch (e: any) {
      toast(e.message ?? String(e), "error");
    }
  };

  let lastGroup = "";
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="cmdk brk" role="dialog" aria-label="Command palette">
        <div className="prompt">
          <span>{messageTo ? "✉" : ">"}</span>
          <input
            ref={input}
            value={q}
            placeholder={messageTo ? `message to ${messageTo}` : "search runs, workbases, actions"}
            aria-label={messageTo ? "Message" : "Command"}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") return messageTo ? (setMessageTo(null), setQ("")) : close();
              if (messageTo) {
                if (e.key === "Enter") void send();
                return;
              }
              if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(s + 1, items.length - 1)));
              if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(s - 1, 0)));
              if (e.key === "Enter") void exec(sel);
            }}
          />
        </div>
        {messageTo ? (
          <ul>
            <li className="g">Enter sends it to the agent's session. Esc goes back.</li>
          </ul>
        ) : (
          <ul>
            {items.length === 0 && <li className="g">No matches</li>}
            {items.map((it, i) => {
              const head = it.group !== lastGroup ? <li className="g">{it.group}</li> : null;
              lastGroup = it.group;
              return (
                <FragmentRow key={`${it.group}-${it.label}`} head={head}>
                  <li className={`it ${i === sel ? "on" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => void exec(i)}>
                    {it.icon}
                    <span>{it.label}</span>
                    {it.sub && <span className="sub">{it.sub}</span>}
                  </li>
                </FragmentRow>
              );
            })}
          </ul>
        )}
        <div className="foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> {messageTo ? "send" : "run"}
          </span>
          <span>
            <kbd>esc</kbd> {messageTo ? "back" : "close"}
          </span>
        </div>
      </div>
    </div>
  );
}

function FragmentRow({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <>
      {head}
      {children}
    </>
  );
}
