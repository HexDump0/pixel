/** The ⋯ menu of a run (tile, list row, run header), and the model and key pickers it opens. */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  IconArrowBackUp,
  IconBolt,
  IconBrain,
  IconCircleCheck,
  IconDots,
  IconDownload,
  IconZzz,
  IconFileSearch,
  IconKey,
  IconMessage,
  IconPencil,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerSkipForward,
  IconPlayerStop,
  IconRefresh,
  IconRepeat,
  IconRotate,
  IconTerminal2,
  IconTrash,
} from "@tabler/icons-react";
import { api } from "../lib/api.ts";
import { act, canPause, canResume, canStop, openRun } from "../lib/actions.ts";
import { keys, queryClient } from "../lib/query.ts";
import { reloadRuns } from "../lib/runs.ts";
import type { Run } from "../lib/types.ts";
import { Button, type Size } from "./ui.tsx";
import { IC_SM } from "./ui/bits.tsx";
import { Dialog, Menu, type MenuEntry } from "./ui/overlay.tsx";
import { ModelAndThinking } from "./ModelSelect.tsx";
import { startRename } from "./RunName.tsx";
import { openPalette } from "./CommandPalette.tsx";
import { toast } from "./Toast.tsx";

const listeners = new Set<(id: string) => void>();
/** Open the model + thinking dialog for a run (from any menu or the side column). */
export const openModelDialog = (id: string) => listeners.forEach((l) => l(id));

export function runMenuItems(r: Run): MenuEntry[] {
  const hasSession = !!r.session_id;
  return [
    { label: "Message…", icon: <IconMessage {...IC_SM} />, hint: "m", onSelect: () => openPalette(r.id), disabled: !hasSession },
    r.status === "running" && { label: "Send “continue”", icon: <IconPlayerSkipForward {...IC_SM} />, onSelect: () => act.continue(r.id) },
    canPause(r) && { label: "Pause", icon: <IconPlayerPause {...IC_SM} />, onSelect: () => act.pause(r.id) },
    canResume(r) && { label: "Resume", icon: <IconPlayerPlay {...IC_SM} />, onSelect: () => act.resume(r.id), disabled: !hasSession },
    r.status === "failed" && { label: "Retry preparing", icon: <IconRefresh {...IC_SM} />, onSelect: () => act.retry(r.id) },
    canPause(r) && r.agent_status !== "idle" && { label: "Abort current step", icon: <IconBolt {...IC_SM} />, onSelect: () => act.abort(r.id) },
    "-",
    { label: "Autopilot", checked: !!r.autopilot, icon: <span />, hint: r.autopilot ? "continues when idle" : "off", onSelect: () => act.autopilot(r) },
    { label: "Model and thinking…", icon: <IconBrain {...IC_SM} />, hint: r.model.split("/").slice(1).join("/"), onSelect: () => openModelDialog(r.id) },
    { label: "Rename", icon: <IconPencil {...IC_SM} />, onSelect: () => (openRun(r.id), setTimeout(() => startRename(r.id), 50)) },
    { label: "Terminal", icon: <IconTerminal2 {...IC_SM} />, onSelect: () => openRun(r.id, "terminal") },
    { label: "Download transcript", icon: <IconDownload {...IC_SM} />, onSelect: () => location.assign(api.transcriptUrl(r.id)), disabled: !hasSession },
    { label: "Restart opencode", icon: <IconRotate {...IC_SM} />, onSelect: () => act.restartOpencode(r.id), disabled: !r.endpoint },
    ["paused", "stopped"].includes(r.status) && !r.asleep && { label: "Free memory", icon: <IconZzz {...IC_SM} />, hint: "stop opencode", onSelect: () => act.release(r.id), disabled: !r.endpoint },
    { label: "Reset counters", icon: <IconArrowBackUp {...IC_SM} />, hint: `${r.continues} continues · ${r.oom_restarts} OOM`, onSelect: () => act.resetCounters(r.id) },
    "-",
    ["running", "recovering", "paused", "stopped"].includes(r.status) && { label: "Mark done", icon: <IconCircleCheck {...IC_SM} />, onSelect: () => act.markDone(r.id) },
    { label: "Re-run", icon: <IconRepeat {...IC_SM} />, onSelect: () => void act.rerun(r.id) },
    { label: "Follow-up audit…", icon: <IconFileSearch {...IC_SM} />, onSelect: () => act.followUp(r) },
    canStop(r) && { label: "Stop", icon: <IconPlayerStop {...IC_SM} />, danger: true, onSelect: () => act.stop(r.id) },
    { label: "Delete…", icon: <IconTrash {...IC_SM} />, danger: true, onSelect: () => void act.delete(r.id) },
  ];
}

export function RunMenuButton({ run, size = "xs", ghost = true }: { run: Run; size?: Size; ghost?: boolean }) {
  return (
    <Menu
      items={runMenuItems(run)}
      trigger={
        <Button size={size} icon variant={ghost ? "ghost" : "default"} aria-label="More actions" title="More" onClick={(e) => e.stopPropagation()}>
          <IconDots {...IC_SM} />
        </Button>
      }
    />
  );
}

/** Mounted once: the model + thinking dialog any menu can open. */
export function ModelDialogHost({ runs }: { runs: Run[] }) {
  const [id, setId] = useState<string | null>(null);
  const [change, setChange] = useState<{ model: string; variant: string } | null>(null);
  useEffect(() => {
    const l = (rid: string) => {
      setId(rid);
      setChange(null);
    };
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  const r = runs.find((x) => x.id === id);
  useEffect(() => {
    if (r && !change) setChange({ model: r.model, variant: r.variant ?? "" });
  }, [r, change]);
  return (
    <Dialog open={!!id && !!change} onOpenChange={(o) => !o && setId(null)} title="Model and thinking" className="w-[min(560px,calc(100vw-32px))]">
      {r && change && (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-sm text-ink-3">Applies from the next message to the agent.</p>
          <ModelAndThinking model={change.model} variant={change.variant} onModel={(model) => setChange({ ...change, model })} onVariant={(variant) => setChange({ ...change, variant })} />
          <div className="mt-2 flex justify-end gap-2">
            <Button onClick={() => setId(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={change.model === r.model && change.variant === (r.variant ?? "")}
              done="Model updated"
              onClick={async () => {
                await api.setModel(r.id, change.model, change.variant);
                setId(null);
                void reloadRuns();
              }}
            >
              Apply
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** The run's API key as a clickable value: switch key, turn failover on or off. */
export function KeyMenu({ run, children }: { run: Run; children: React.ReactNode }) {
  const info = useQuery({ queryKey: keys.runKeys(run.id), queryFn: () => api.runKeys(run.id) });
  const k = info.data;
  const after = (p: Promise<unknown>, msg: string) =>
    p.then(
      () => (toast(msg), queryClient.invalidateQueries({ queryKey: keys.runKeys(run.id) }), reloadRuns()),
      (e) => toast(e.message, "error"),
    );
  const items: MenuEntry[] = k
    ? [
        { head: `${k.provider} keys` },
        ...k.keys.map((x) => ({ label: x.name, checked: x.id === k.current, icon: <IconKey {...IC_SM} />, hint: x.status ? "failing" : x.hint, onSelect: () => void after(api.setRunKey(run.id, x.id), `Key changed to ${x.name}`) })),
        "-",
        { label: "Failover", checked: k.failover, icon: <span />, hint: k.failover ? (k.next ? `next: ${k.next}` : "no other key") : "pauses on failure", onSelect: () => void after(api.setFailover(run.id, !k.failover), k.failover ? "Failover off" : "Failover on") },
        ...(k.costs.length > 1 ? (["-", { head: "Spent per key" }, ...k.costs.map((c) => ({ label: c.name, icon: <span />, hint: `$${c.cost.toFixed(2)}`, disabled: true }))] as MenuEntry[]) : []),
      ]
    : [{ label: "Loading…", disabled: true }];
  return <Menu align="start" items={items} trigger={children} />;
}

/** Name of the key a run uses (for the side column). */
export function useRunKeyName(run: Run) {
  const info = useQuery({ queryKey: keys.runKeys(run.id), queryFn: () => api.runKeys(run.id), staleTime: 60_000 });
  const k = info.data;
  return { name: k?.keys.find((x) => x.id === k.current)?.name ?? (k && !k.keys.length ? "from Settings" : "default"), failover: !!k?.failover, many: (k?.keys.length ?? 0) > 1 };
}
