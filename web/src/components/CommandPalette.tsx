/**
 * ⌘K / Ctrl+K: jump to any run or page, control the run you're looking at, message it, or search every
 * workbase. `openPalette()` opens it from a button; `openPalette(runId)` opens straight into "message this run".
 */
import { useEffect, useState, type ReactNode } from "react";
import { Command } from "cmdk";
import * as D from "@radix-ui/react-dialog";
import {
  IconActivity,
  IconBook,
  IconBug,
  IconChartBar,
  IconCpu,
  IconFileText,
  IconGauge,
  IconLayoutGrid,
  IconLogout,
  IconMessage,
  IconPencil,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerSkipForward,
  IconPlus,
  IconSearch,
  IconSettings,
  IconTerminal2,
} from "@tabler/icons-react";
import { api } from "../lib/api.ts";
import { navigate, useLocation, match } from "../lib/router.tsx";
import { useRuns, repoShort } from "../lib/runs.ts";
import { act, canPause, canResume, openRun } from "../lib/actions.ts";
import { runName } from "../lib/fleet.ts";
import type { SearchHit } from "../lib/types.ts";
import { Hue, IC_SM, Kbd } from "./ui/bits.tsx";
import { toast } from "./Toast.tsx";
import { startRename } from "./RunName.tsx";

const listeners = new Set<(messageTo?: string) => void>();
/** Open the palette; with a run id it opens straight into "message this run". */
export const openPalette = (messageTo?: string) => listeners.forEach((l) => l(messageTo));

function Item({ icon, label, sub, onSelect, value }: { icon: ReactNode; label: string; sub?: string; onSelect: () => void; value?: string }) {
  return (
    <Command.Item
      value={value ?? label}
      onSelect={onSelect}
      className="flex h-[38px] cursor-pointer items-center gap-2.5 rounded-lg px-3.5 data-[selected=true]:bg-s3 [&>svg]:text-ink-3"
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {sub && <span className="max-w-[45%] truncate font-mono text-xs text-ink-3">{sub}</span>}
    </Command.Item>
  );
}

const groupClass = "[&_[cmdk-group-heading]]:px-3.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-ink-3";

export function CommandPalette({ authEnabled }: { authEnabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [messageTo, setMessageTo] = useState<string | null>(null);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const { runs } = useRuns();
  const { path } = useLocation();
  const here = match("/runs/:id", path)?.id;
  const cur = runs?.find((r) => r.id === here);

  useEffect(() => {
    const show = (to?: string) => {
      setOpen(true);
      setQ("");
      setMessageTo(to ?? null);
    };
    listeners.add(show);
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        setQ("");
        setMessageTo(null);
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      listeners.delete(show);
      window.removeEventListener("keydown", key);
    };
  }, []);

  // Workbase search, debounced, once the query is long enough to mean something.
  useEffect(() => {
    if (!open || messageTo || q.trim().length < 3) return setHits([]);
    const t = setTimeout(() => api.search(q.trim()).then((h) => setHits(h.slice(0, 6)), () => setHits([])), 220);
    return () => clearTimeout(t);
  }, [q, open, messageTo]);

  const go = (fn: () => unknown) => () => {
    setOpen(false);
    void fn();
  };
  const send = async () => {
    const text = q.trim();
    if (!text || !messageTo) return;
    setOpen(false);
    try {
      await api.message(messageTo, text);
      toast("Sent");
    } catch (e: any) {
      toast(e.message ?? String(e), "error");
    }
  };
  const target = runs?.find((r) => r.id === messageTo);

  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-[850] bg-black/55" />
        <D.Content aria-describedby={undefined} className="fixed top-[12vh] left-1/2 z-[851] w-[min(620px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-2xl border border-line bg-s1 shadow-pop outline-none">
          <D.Title className="sr-only">Command palette</D.Title>
          <Command
            loop
            shouldFilter={!messageTo}
            onKeyDown={(e) => {
              if (messageTo && e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
              if (messageTo && e.key === "Escape") {
                e.preventDefault();
                setMessageTo(null);
                setQ("");
              }
            }}
          >
            <Command.Input
              value={q}
              onValueChange={setQ}
              placeholder={messageTo ? `Message ${target ? runName(target) : messageTo}` : "Search runs, workbases, actions"}
              className="h-14 w-full border-0 border-b border-line-2 bg-transparent px-5 text-base text-ink outline-none placeholder:text-ink-3"
            />
            <Command.List className="max-h-[400px] overflow-y-auto p-1.5">
              {messageTo ? (
                <div className="px-3.5 py-3 text-sm text-ink-3">Enter sends it to the agent's session. Esc goes back.</div>
              ) : (
                <>
                  <Command.Empty className="px-3.5 py-4 text-sm text-ink-3">No matches</Command.Empty>
                  {cur && (
                    <Command.Group heading={runName(cur)} className={groupClass}>
                      <Item icon={<IconMessage {...IC_SM} />} label="Message the agent…" onSelect={() => (setMessageTo(cur.id), setQ(""))} />
                      <Item icon={<IconPencil {...IC_SM} />} label="Rename run…" onSelect={go(() => startRename(cur.id))} />
                      {canPause(cur) && <Item icon={<IconPlayerPause {...IC_SM} />} label="Pause" onSelect={go(() => act.pause(cur.id))} />}
                      {canResume(cur) && <Item icon={<IconPlayerPlay {...IC_SM} />} label="Resume" onSelect={go(() => act.resume(cur.id))} />}
                      {cur.status === "running" && <Item icon={<IconPlayerSkipForward {...IC_SM} />} label="Send “continue”" onSelect={go(() => act.continue(cur.id))} />}
                      <Item icon={<IconTerminal2 {...IC_SM} />} label="Open terminal" onSelect={go(() => openRun(cur.id, "terminal"))} />
                      <Item icon={<IconBug {...IC_SM} />} label="Findings of this run" onSelect={go(() => openRun(cur.id, "findings"))} />
                    </Command.Group>
                  )}
                  <Command.Group heading="Runs" className={groupClass}>
                    {(runs ?? []).map((r) => (
                      <Item key={r.id} value={`${runName(r)} ${r.id} ${r.repo}`} icon={<Hue hue={r.hue} className="mx-[3px]" />} label={runName(r)} sub={`${r.status} · ${repoShort(r.repo)}`} onSelect={go(() => openRun(r.id))} />
                    ))}
                  </Command.Group>
                  <Command.Group heading="Go to" className={groupClass}>
                    <Item icon={<IconPlus {...IC_SM} />} label="New run" onSelect={go(() => navigate("/new"))} />
                    <Item icon={<IconLayoutGrid {...IC_SM} />} label="Runs" onSelect={go(() => navigate("/"))} />
                    <Item icon={<IconBug {...IC_SM} />} label="Findings" onSelect={go(() => navigate("/findings"))} />
                    <Item icon={<IconActivity {...IC_SM} />} label="Activity" onSelect={go(() => navigate("/activity"))} />
                    <Item icon={<IconGauge {...IC_SM} />} label="Models: provider health and leaderboard" onSelect={go(() => navigate("/models"))} />
                    <Item icon={<IconChartBar {...IC_SM} />} label="Stats: tokens, cache hit rate, cost, health" onSelect={go(() => navigate("/stats"))} />
                    <Item icon={<IconBook {...IC_SM} />} label="Knowledge" onSelect={go(() => navigate("/knowledge"))} />
                    <Item icon={<IconFileText {...IC_SM} />} label="Templates" onSelect={go(() => navigate("/templates"))} />
                    <Item icon={<IconSettings {...IC_SM} />} label="Settings" onSelect={go(() => navigate("/settings"))} />
                    <Item icon={<IconCpu {...IC_SM} />} label="System" onSelect={go(() => navigate("/system"))} />
                    {authEnabled && <Item icon={<IconLogout {...IC_SM} />} label="Log out" onSelect={go(() => api.logout().then(() => location.reload()))} />}
                  </Command.Group>
                  {hits.length > 0 && (
                    <Command.Group heading="In workbases" className={groupClass} forceMount>
                      {hits.map((h) => (
                        <Item key={`${h.run_id}/${h.path}`} value={`${q} ${h.run_id}/${h.path}`} icon={<IconSearch {...IC_SM} />} label={`${h.run_id}/${h.path}`} sub={h.snippet.replace(/<[^>]+>/g, "").slice(0, 80)} onSelect={go(() => openRun(h.run_id, "files"))} />
                      ))}
                    </Command.Group>
                  )}
                </>
              )}
            </Command.List>
            <div className="flex gap-4 border-t border-line-2 px-4.5 py-2.5 text-xs text-ink-3">
              <span className="inline-flex items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> move
              </span>
              <span className="inline-flex items-center gap-1">
                <Kbd>↵</Kbd> {messageTo ? "send" : "run"}
              </span>
              <span className="inline-flex items-center gap-1">
                <Kbd>esc</Kbd> {messageTo ? "back" : "close"}
              </span>
            </div>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
