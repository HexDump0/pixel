/**
 * All of Pixel's settings in one column of sections with a sticky index on the left. Everything but
 * GitHub is edited as a draft; a bar at the bottom saves or discards it. Each section also shows what
 * the settings are doing right now (host memory, last notification, last backup).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  IconArrowRight,
  IconBell,
  IconBrandGithub,
  IconCpu,
  IconDatabase,
  IconFolder,
  IconHourglass,
  IconKey,
  IconPlugConnected,
  IconPlus,
  IconRobot,
  IconServer,
  IconSparkles,
  IconX,
} from "@tabler/icons-react";
import { api } from "../lib/api.ts";
import { useAsync } from "../lib/hooks.ts";
import { ago, bytes } from "../lib/format.ts";
import { cn } from "../lib/cn.ts";
import { Link } from "../lib/router.tsx";
import type { NotifyStatus, Sent, Settings } from "../lib/types.ts";
import { Button, ErrorBox, PageHeader, buttonClass } from "../components/ui.tsx";
import { Select } from "../components/ui/overlay.tsx";
import { IC, IC_SM, IC_XS, Kbd } from "../components/ui/bits.tsx";
import { ProviderMark } from "../components/ProviderMark.tsx";
import { EnvEditor, NumberInput, Row, Section, State, Toggle } from "./settings/parts.tsx";
import { GithubSection } from "./settings/Github.tsx";
import { AgentAccessSection } from "./settings/AgentAccess.tsx";

type Update = <K extends keyof Settings>(key: K, value: Settings[K]) => void;
type Draft = Omit<Settings, "models" | "defaultModel" | "providerLimits" | "thinkingLevels" | "modelOverrides" | "providerOverrides" | "defaultProxy">;

/** Edited on the Models page; never sent from this draft so it can't overwrite them. */
const ELSEWHERE = ["defaults", "models", "defaultModel", "providerLimits", "thinkingLevels", "modelOverrides", "providerOverrides", "defaultProxy"];
const draftOf = (s: Settings): Draft => Object.fromEntries(Object.entries(s).filter(([k]) => !ELSEWHERE.includes(k))) as Draft;

/** Number of leaf values that differ (an env var added counts once). */
function changes(a: unknown, b: unknown): number {
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    let n = 0;
    for (const k of keys) n += changes((a as any)[k], (b as any)[k]);
    return n;
  }
  return JSON.stringify(a) === JSON.stringify(b) ? 0 : 1;
}

const GiB = 1024 ** 3;
/** Same headroom the System page keeps for Pixel itself. */
const HOST_RESERVE_GiB = 1.5;

const NAV: { id: string; label: string; icon: ReactNode }[] = [
  { id: "models", label: "Models", icon: <IconSparkles {...IC_SM} /> },
  { id: "github", label: "GitHub", icon: <IconBrandGithub {...IC_SM} /> },
  { id: "mcp", label: "Agent access", icon: <IconPlugConnected {...IC_SM} /> },
  { id: "machines", label: "Machines", icon: <IconCpu {...IC_SM} /> },
  { id: "autopilot", label: "Autopilot", icon: <IconRobot {...IC_SM} /> },
  { id: "workbase", label: "Workbase and disk", icon: <IconFolder {...IC_SM} /> },
  { id: "disclosure", label: "Disclosure", icon: <IconHourglass {...IC_SM} /> },
  { id: "environment", label: "Agent environment", icon: <IconKey {...IC_SM} /> },
  { id: "notifications", label: "Notifications", icon: <IconBell {...IC_SM} /> },
  { id: "backups", label: "Backups", icon: <IconDatabase {...IC_SM} /> },
];

export function SettingsPage() {
  const loaded = useAsync(api.settings, []);
  const sys = useAsync(api.system, []);
  const providers = useAsync(api.providers, []);
  const gh = useAsync(api.github, []);
  const mcp = useAsync(api.mcpTokens, []);
  const notifyStatus = useAsync(api.notifyStatus, []);
  const workbases = useAsync(api.workbases, []);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sentNow, setSentNow] = useState<Sent[] | null>(null);
  const active = useActiveSection();

  useEffect(() => {
    if (loaded.data) (setSaved(loaded.data), setS(loaded.data));
  }, [loaded.data]);

  const dirty = s && saved ? changes(draftOf(s), draftOf(saved)) : 0;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty > 0]);

  const save = async () => {
    if (!s) return;
    try {
      const next = await api.saveSettings(draftOf(s));
      setSaved(next);
      setS(next);
      setError(null);
    } catch (e: any) {
      setError(e.message);
      throw e;
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty) save().catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!s || !saved) return <ErrorBox error={loaded.error} />;
  const d = loaded.data!.defaults;
  const update: Update = (k, v) => setS({ ...s, [k]: v });
  /** Reset link for a top-level number setting that differs from the default. */
  const reset = (k: keyof Settings, unit = "") => ({ show: s[k] !== d[k], to: `${d[k]}${unit}`, onReset: () => update(k, d[k]) });

  const p = providers.data ?? [];
  const ns = notifyStatus.data ?? {};
  const channels = (s.notify.ntfyUrl ? 1 : 0) + (s.notify.telegramToken && s.notify.telegramChat ? 1 : 0);
  const last = sys.data?.backup.last;
  const backupOn = !!s.backup.repository && s.backup.dailyHour >= 0;

  const navState: Record<string, ReactNode> = {
    models: <span className="font-mono">{s.models.length}</span>,
    github: gh.data?.tokenHint && <Dot tone="good" />,
    mcp: mcp.data && mcp.data.tokens.length > 0 && <span className="font-mono">{mcp.data.tokens.length}</span>,
    machines: s.defaultSize,
    notifications: channels ? <Dot tone={Object.values(ns).some((x) => x && !x.ok) ? "bad" : "good"} /> : "Off",
    backups: !backupOn ? "Off" : last && !last.ok ? <Dot tone="bad" /> : <Dot tone="good" />,
  };

  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader title="Settings" />
      <ErrorBox error={error} />
      <div className="grid gap-x-10 lg:grid-cols-[176px_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="sticky top-[84px] self-start max-lg:hidden">
          <ul className="m-0 flex list-none flex-col gap-px p-0">
            {NAV.map((n) => (
              <li key={n.id}>
                <a
                  href={`#${n.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    document.getElementById(n.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
                    history.replaceState(null, "", `#${n.id}`);
                  }}
                  aria-current={active === n.id ? "true" : undefined}
                  className="flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-ink-3 no-underline hover:bg-s2 hover:text-ink hover:no-underline aria-[current]:bg-s2 aria-[current]:text-ink [&>svg]:shrink-0"
                >
                  {n.icon}
                  <span className="flex-1 truncate">{n.label}</span>
                  <span className="text-[11.5px] text-ink-4">{navState[n.id]}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex min-w-0 flex-col gap-9 pb-28">
          <ModelsSection s={s} providers={p} />

          <GithubSection g={gh.data} setG={(g) => gh.setData(g)} error={gh.error} />

          <AgentAccessSection data={mcp.data} setData={(d) => mcp.setData(d)} error={mcp.error} />

          <MachinesSection s={s} update={update} memTotal={sys.data?.host.memTotal} committedGiB={sys.data?.committedMemoryGiB} />

          <Section id="autopilot" icon={<IconRobot {...IC} />} title="Autopilot" meta="What Pixel does when a run stops on its own">
            <Row label="Continue when the agent stops early" hint="It stopped without writing REPORT.md: send the continue message, up to this many times in a row before the run stops." reset={reset("maxAutoContinues")}>
              <NumberInput label="Automatic continues in a row" value={s.maxAutoContinues} onChange={(v) => update("maxAutoContinues", v)} unit="times" zero="off" />
            </Row>
            <Row label="Count starts over after" hint="Tool calls the agent makes after an automatic continue that show it is working again, so long runs aren't stopped for a few early ends." reset={reset("continueResetCalls", " calls")}>
              <NumberInput label="Tool calls that reset the count" value={s.continueResetCalls} onChange={(v) => update("continueResetCalls", v)} unit="calls" zero="never" />
            </Row>
            <Row
              label="Wait for background commands"
              hint="The agent ended its turn with commands still running in the background (a build, a fuzzer); opencode wakes it when they finish. Subagents are always waited for. After this long it gets the reminder below, which isn't counted as a continue."
              reset={reset("backgroundWaitMin", " min")}
            >
              <NumberInput label="Wait for background commands" value={s.backgroundWaitMin} onChange={(v) => update("backgroundWaitMin", v)} unit="min" zero="no limit" />
            </Row>
            <Row
              wide
              label="Reminder while background commands run"
              hint={
                <>
                  <span className="font-mono">{"{minutes}"}</span> and <span className="font-mono">{"{commands}"}</span> are filled in.
                </>
              }
              reset={{ show: s.backgroundWaitMessage !== d.backgroundWaitMessage, to: "text", onReset: () => update("backgroundWaitMessage", d.backgroundWaitMessage) }}>
              <textarea className="input h-20 w-full text-[13px]" aria-label="Reminder while background commands run" value={s.backgroundWaitMessage} onChange={(e) => update("backgroundWaitMessage", e.target.value)} />
            </Row>
            <Row wide label="Continue message" reset={{ show: s.continueMessage !== d.continueMessage, to: "text", onReset: () => update("continueMessage", d.continueMessage) }}>
              <input className="input w-full" aria-label="Continue message" value={s.continueMessage} onChange={(e) => update("continueMessage", e.target.value)} />
            </Row>
            <Row label="Restart after an OOM kill" hint="The machine ran out of memory and the kernel killed the agent." reset={reset("maxOomRestarts")}>
              <NumberInput label="OOM restarts per run" value={s.maxOomRestarts} onChange={(v) => update("maxOomRestarts", v)} unit="times" zero="off" />
            </Row>
            <Row wide label="Message after an OOM kill" reset={{ show: s.oomMessage !== d.oomMessage, to: "text", onReset: () => update("oomMessage", d.oomMessage) }}>
              <input className="input w-full" aria-label="Message after an OOM kill" value={s.oomMessage} onChange={(e) => update("oomMessage", e.target.value)} />
            </Row>
            <Row label="Dismiss unanswered questions after" hint="So a run on autopilot doesn't wait for you; the agent carries on without an answer." reset={reset("questionTimeoutMin", " min")}>
              <NumberInput label="Question timeout" value={s.questionTimeoutMin} onChange={(v) => update("questionTimeoutMin", v)} unit="min" zero="never" />
            </Row>
            <Row
              label="Free memory of paused or stopped runs after"
              hint="Stops their opencode; it starts again on the same session when you resume or message the run. Fuzzers and other background processes keep running."
              reset={reset("releaseIdleMin", " min")}
            >
              <NumberInput label="Free memory after" value={s.releaseIdleMin} onChange={(v) => update("releaseIdleMin", v)} unit="min" zero="never" />
            </Row>
            <Row label="Key failover" hint="When a run's API key runs out or is rejected, move the run to the provider's next key. Applies to new runs; each run can override it.">
              <Toggle label="Key failover" checked={s.keyFailover} onChange={(v) => update("keyFailover", v)} />
            </Row>
          </Section>

          <WorkbaseSection s={s} d={d} update={update} reset={reset} workbases={workbases.data} />

          <Section id="disclosure" icon={<IconHourglass {...IC} />} title="Disclosure" meta="For findings you send upstream">
            <Row label="Deadline after sending" hint="Counted from the day you mark a finding sent. Each finding can be extended on its own." reset={reset("disclosureDays", " days")}>
              <NumberInput label="Disclosure deadline" value={s.disclosureDays} onChange={(v) => update("disclosureDays", v)} unit="days" min={1} />
            </Row>
            <Row label="Due soon from" hint="Before the deadline: the finding turns amber and one notification goes out (Notifications, Disclosure deadline)." reset={reset("disclosureWarnDays", " days")}>
              <NumberInput label="Due soon from" value={s.disclosureWarnDays} onChange={(v) => update("disclosureWarnDays", v)} unit="days before" width="w-[170px]" min={1} />
            </Row>
          </Section>

          <EnvironmentSection s={s} update={update} providers={p} />

          <NotificationsSection
            s={s}
            update={update}
            status={ns}
            sentNow={sentNow}
            dirty={changes(s.notify, saved.notify) > 0}
            onTest={async () => {
              if (changes(s.notify, saved.notify)) await save();
              const r = await api.testNotify();
              setSentNow(r.results);
              void notifyStatus.reload();
              if (!r.results.length) throw new Error("No channel set up yet");
            }}
          />

          <BackupsSection
            s={s}
            update={update}
            last={last}
            running={sys.data?.backup.running ?? false}
            dirty={changes(s.backup, saved.backup) > 0}
            onBackup={async () => {
              await api.backup();
              await sys.reload();
            }}
          />
        </div>
      </div>

      {dirty > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4">
          <div role="status" className="pointer-events-auto flex items-center gap-3 rounded-xl border border-line bg-s2 py-1.5 pr-1.5 pl-4 shadow-pop">
            <span className="text-[13px]">
              <span className="font-mono tabular-nums">{dirty}</span> unsaved {dirty === 1 ? "change" : "changes"}
            </span>
            <span className="inline-flex items-center gap-1 max-sm:hidden">
              <Kbd>Ctrl</Kbd>
              <Kbd>S</Kbd>
            </span>
            <Button size="sm" variant="ghost" onClick={() => (setS(saved), setError(null))}>
              Discard
            </Button>
            <Button size="sm" variant="primary" onClick={save} done="Settings saved">
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Which section is at the top of the window, for the index. */
function useActiveSection() {
  const [active, setActive] = useState("models");
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const els = [...document.querySelectorAll<HTMLElement>("[data-section]")];
        const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
        const current = atBottom ? els[els.length - 1] : els.filter((el) => el.getBoundingClientRect().top <= 120).pop();
        setActive(current?.id ?? els[0]?.id ?? "models");
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => (window.removeEventListener("scroll", onScroll), cancelAnimationFrame(raf));
  }, []);
  return active;
}

const Dot = ({ tone }: { tone: "good" | "bad" }) => <span className={cn("inline-block size-1.5 rounded-full align-middle", tone === "good" ? "bg-good" : "bg-critical")} />;

/** One labelled figure in a strip of cells. */
function Cell({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 px-4 py-3.5", className)}>
      <div className="mb-1.5 text-xs text-ink-3">{label}</div>
      {children}
    </div>
  );
}

// ---- models ----

function ModelsSection({ s, providers }: { s: Settings; providers: Awaited<ReturnType<typeof api.providers>> }) {
  const [prov, model] = s.defaultModel.includes("/") ? [s.defaultModel.slice(0, s.defaultModel.indexOf("/")), s.defaultModel.slice(s.defaultModel.indexOf("/") + 1)] : ["", s.defaultModel];
  const keys = providers.reduce((n, p) => n + Math.max(p.keys.length, p.via.includes("pixel") ? 0 : 1), 0);
  return (
    <Section
      id="models"
      icon={<IconSparkles {...IC} />}
      title="Models and providers"
      right={
        <Link to="/models" className={buttonClass("default", "sm")}>
          Models page
          <IconArrowRight {...IC_XS} />
        </Link>
      }
    >
      <div className="grid divide-line-2 sm:grid-cols-3 sm:divide-x max-sm:divide-y">
        <Cell label="Default for new runs">
          <div className="truncate font-mono text-[13.5px]" title={s.defaultModel}>
            {model}
          </div>
          <div className="mt-0.5 truncate text-xs text-ink-3">{providers.find((p) => p.id === prov)?.name ?? prov}</div>
        </Cell>
        <Cell label="Offered in the new-run form">
          <div className="font-mono text-[13.5px] tabular-nums">{s.models.length}</div>
          <div className="mt-0.5 text-xs text-ink-3" title={s.models.join("\n")}>
            {s.models
              .slice(0, 3)
              .map((m) => m.slice(m.indexOf("/") + 1))
              .join(", ")}
            {s.models.length > 3 && ` and ${s.models.length - 3} more`}
          </div>
        </Cell>
        <Cell label="Providers">
          {providers.length ? (
            <>
              <div className="flex flex-wrap items-center gap-1">
                {providers.map((x) => (
                  <span key={x.id} title={`${x.name}${x.keys.length ? `, ${x.keys.length} ${x.keys.length === 1 ? "key" : "keys"}` : ""}, from ${x.via.join(" and ")}`}>
                    <ProviderMark id={x.id} name={x.name} size={20} />
                  </span>
                ))}
              </div>
              <div className="mt-1 text-xs text-ink-3">
                {providers.length} connected, {keys} {keys === 1 ? "key" : "keys"}
              </div>
            </>
          ) : (
            <Link to="/models?add=1" className="inline-flex items-center gap-1.5 text-[13px]">
              <IconPlus {...IC_XS} />
              Add a provider
            </Link>
          )}
        </Cell>
      </div>
    </Section>
  );
}

// ---- machines ----

function MachinesSection({ s, update, memTotal, committedGiB }: { s: Settings; update: Update; memTotal?: number; committedGiB?: number }) {
  const [name, setName] = useState("");
  const entries = Object.entries(s.sizePresets);
  const budget = memTotal ? Math.max(0, memTotal / GiB - HOST_RESERVE_GiB) : null;
  const free = budget != null && committedGiB != null ? Math.max(0, budget - committedGiB) : null;
  const pct = budget && committedGiB != null ? Math.min(100, (committedGiB / budget) * 100) : 0;
  const set = (n: string, field: "cpu" | "memoryGiB" | "diskGiB", v: number) => update("sizePresets", { ...s.sizePresets, [n]: { ...s.sizePresets[n], [field]: v } });
  const add = () => {
    const n = name.trim();
    if (!n || s.sizePresets[n]) return;
    update("sizePresets", { ...s.sizePresets, [n]: { cpu: 2, memoryGiB: 4, diskGiB: 20 } });
    setName("");
  };

  return (
    <Section id="machines" icon={<IconCpu {...IC} />} title="Machine sizes" meta="For new runs">
      {budget != null && committedGiB != null && (
        <Row label="Memory promised to machines" hint={`Host memory ${fmtGiB(memTotal! / GiB)} GiB, less ${HOST_RESERVE_GiB} GiB for Pixel. Machines of runs that still exist keep their share until the run is deleted.`}>
          <div className="flex w-[260px] flex-col gap-1.5 max-sm:w-full">
            <div className="flex items-baseline justify-between text-xs text-ink-3">
              <span>
                <span className={cn("font-mono text-[13px] tabular-nums", pct >= 100 ? "text-critical" : pct >= 90 ? "text-warning" : "text-ink")}>{fmtGiB(committedGiB)}</span> of {fmtGiB(budget)} GiB
              </span>
              <span>{fmtGiB(free!)} free</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-s3">
              <div className={cn("h-full rounded-full", pct >= 100 ? "bg-critical" : pct >= 90 ? "bg-warning" : "bg-accent")} style={{ width: `${pct}%` }} />
            </div>
          </div>
        </Row>
      )}
      <div className="overflow-x-auto px-2 py-1.5">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="text-left text-xs text-ink-3">
              <th className="px-2 py-2 font-normal">Size</th>
              <th className="px-2 py-2 font-normal">CPU</th>
              <th className="px-2 py-2 font-normal">Memory</th>
              <th className="px-2 py-2 font-normal">Disk</th>
              <th className="px-2 py-2 font-normal" title="How many more machines of this size the free memory holds now, of how many the host holds at most">
                Room now
              </th>
              <th className="w-px px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {entries.map(([n, p]) => {
              const isDefault = s.defaultSize === n;
              return (
                <tr key={n} className="group">
                  <td className="px-2 py-1.5">
                    <span className="inline-flex items-center gap-2">
                      <span className="font-medium">{n}</span>
                      {isDefault ? (
                        <span className="rounded-md bg-s3 px-1.5 py-0.5 text-[11px] text-ink-2">Default</span>
                      ) : (
                        <button type="button" onClick={() => update("defaultSize", n)} className="cursor-pointer rounded-md px-1.5 py-0.5 text-[11px] text-ink-3 opacity-0 group-hover:opacity-100 hover:bg-s3 hover:text-ink focus-visible:opacity-100">
                          Make default
                        </button>
                      )}
                    </span>
                  </td>
                  <td className="px-2 py-1.5">
                    <NumberInput label={`${n} CPUs`} value={p.cpu} onChange={(v) => set(n, "cpu", v)} unit="CPU" min={1} width="w-[96px]" />
                  </td>
                  <td className="px-2 py-1.5">
                    <NumberInput label={`${n} memory`} value={p.memoryGiB} onChange={(v) => set(n, "memoryGiB", v)} unit="GiB" min={1} width="w-[96px]" />
                  </td>
                  <td className="px-2 py-1.5">
                    <NumberInput label={`${n} disk`} value={p.diskGiB} onChange={(v) => set(n, "diskGiB", v)} unit="GiB" min={1} width="w-[96px]" />
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    {budget != null && free != null && p.memoryGiB > 0 ? (
                      <span className="text-xs text-ink-3">
                        <span className={cn("font-mono text-[13px] tabular-nums", Math.floor(free / p.memoryGiB) === 0 ? "text-warning" : "text-ink")}>{Math.floor(free / p.memoryGiB)}</span> of {Math.floor(budget / p.memoryGiB)}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-2 py-1.5">
                    <Button
                      size="sm"
                      icon
                      variant="ghost"
                      aria-label={`Remove ${n}`}
                      title={isDefault ? "The default size can't be removed" : `Remove ${n}`}
                      className="hover:enabled:text-critical"
                      disabled={entries.length < 2 || isDefault}
                      onClick={() => update("sizePresets", Object.fromEntries(entries.filter(([x]) => x !== n)))}
                    >
                      <IconX {...IC_SM} />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <form
          className="flex items-center gap-1.5 px-2 pt-1 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input className="input h-[30px] w-[160px] text-[12.5px]" aria-label="New size name" placeholder="New size" value={name} onChange={(e) => setName(e.target.value)} />
          <Button size="sm" type="submit" disabled={!name.trim() || !!s.sizePresets[name.trim()]}>
            <IconPlus {...IC_XS} />
            Add
          </Button>
        </form>
      </div>
    </Section>
  );
}

const fmtGiB = (n: number) => (Math.round(n * 10) / 10).toString();

// ---- workbase and disk ----

function WorkbaseSection({ s, d, update, reset, workbases }: { s: Settings; d: Settings; update: Update; reset: (k: keyof Settings, unit?: string) => { show: boolean; to: string; onReset: () => void }; workbases?: Awaited<ReturnType<typeof api.workbases>> }) {
  const biggest = workbases?.length ? workbases.reduce((a, b) => (b.bytes > a.bytes ? b : a)) : null;
  const near = biggest && biggest.bytes >= s.workbaseLimitGiB * GiB * 0.8;
  return (
    <Section id="workbase" icon={<IconFolder {...IC} />} title="Workbase and disk" meta="Checked while runs work">
      <Row
        label="Workbase size limit"
        hint={
          <>
            A run whose workbase grows past this is stopped.
            {biggest && (
              <>
                {" "}
                Largest now:{" "}
                <Link to={`/runs/${encodeURIComponent(biggest.run)}`} className={cn("font-mono", near && "text-warning")}>
                  {biggest.run}
                </Link>{" "}
                at <span className={cn("font-mono", near && "text-warning")}>{bytes(biggest.bytes)}</span>.
              </>
            )}
          </>
        }
        reset={reset("workbaseLimitGiB", " GiB")}
      >
        <NumberInput label="Workbase size limit" value={s.workbaseLimitGiB} onChange={(v) => update("workbaseLimitGiB", v)} unit="GiB" min={1} />
      </Row>
      <Row label="Stop a run when its machine disk is" hint="Full disks corrupt builds and fuzzer corpora; stopping early keeps the workbase intact." reset={reset("diskFullPercent", "%")}>
        <NumberInput label="Disk full threshold" value={s.diskFullPercent} onChange={(v) => update("diskFullPercent", v)} unit="% full" min={1} max={100} />
      </Row>
      <Row
        label="When a machine disk fills up, give it"
        hint="Extra disk for a while and a message asking the agent to clean up. Once it is back under its normal disk, the extra goes away and the agent carries on."
        reset={reset("diskRescueGiB", " GiB")}
      >
        <NumberInput label="Extra disk for a cleanup" value={s.diskRescueGiB} onChange={(v) => update("diskRescueGiB", v)} unit="GiB extra" zero="just stop" />
      </Row>
      {s.diskRescueGiB > 0 && (
        <>
          <Row label="Automatic cleanups per run" hint="After these, a full disk stops the run. Give more disk on the run still works." reset={reset("diskRescueMax", " times")}>
            <NumberInput label="Automatic cleanups per run" value={s.diskRescueMax} onChange={(v) => update("diskRescueMax", v)} unit="times" zero="off" />
          </Row>
          <Row label="Time to clean up" hint="Not back under the normal disk by then: the run stops." reset={reset("diskRescueMin", " min")}>
            <NumberInput label="Time to clean up" value={s.diskRescueMin} onChange={(v) => update("diskRescueMin", v)} unit="min" min={1} />
          </Row>
          <Row
            wide
            label="Cleanup message"
            hint={
              <>
                Sent to the agent with the extra disk. <span className="font-mono">{"{used}"}</span>, <span className="font-mono">{"{limit}"}</span>, <span className="font-mono">{"{extra}"}</span>,{" "}
                <span className="font-mono">{"{goal}"}</span> and <span className="font-mono">{"{dirs}"}</span> are filled in.
              </>
            }
            reset={{ show: s.diskRescueMessage !== d.diskRescueMessage, to: "text", onReset: () => update("diskRescueMessage", d.diskRescueMessage) }}
          >
            <textarea className="input h-28 w-full text-[13px]" aria-label="Cleanup message" value={s.diskRescueMessage} onChange={(e) => update("diskRescueMessage", e.target.value)} />
          </Row>
        </>
      )}
      <Row label="Workbase history snapshots" hint="Git snapshots of each active workbase, kept outside it so agents never see them. Browse them in a run's Files tab." reset={reset("historyIntervalMin", " min")}>
        <NumberInput label="History snapshot interval" value={s.historyIntervalMin} onChange={(v) => update("historyIntervalMin", v)} unit="min" zero="off" />
      </Row>
    </Section>
  );
}

// ---- agent environment ----

function EnvironmentSection({ s, update, providers }: { s: Settings; update: Update; providers: Awaited<ReturnType<typeof api.providers>> }) {
  const readers = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of providers) for (const v of p.envVars) m.set(v, p.name);
    return m;
  }, [providers]);
  const auth = useMemo(() => {
    const t = s.agentAuthJson.trim();
    if (!t) return null;
    try {
      const v = JSON.parse(t);
      return v && typeof v === "object" && !Array.isArray(v) ? { ok: true as const, ids: Object.keys(v) } : { ok: false as const };
    } catch {
      return { ok: false as const };
    }
  }, [s.agentAuthJson]);
  const name = (id: string) => providers.find((p) => p.id === id)?.name ?? id;
  const count = Object.keys(s.agentEnv).filter(Boolean).length;

  return (
    <Section id="environment" icon={<IconKey {...IC} />} title="Agent environment" meta="Copied into every new machine">
      <Row
        wide
        label={
          <>
            Environment variables
            {count > 0 && <span className="font-mono text-xs text-ink-3">{count}</span>}
          </>
        }
        hint={
          <>
            Read-only tokens only: agents run code from the repos they audit. Provider keys belong on the <Link to="/models">Models page</Link>, the GitHub token above.
          </>
        }
      >
        <EnvEditor value={s.agentEnv} onChange={(v) => update("agentEnv", v)} tag={(k) => readers.get(k) && <>read by {readers.get(k)}</>} />
      </Row>
      <Row
        wide
        label={
          <>
            opencode auth.json
            {auth && (auth.ok ? <State tone="good">{auth.ids.length ? auth.ids.map(name).join(", ") : "Empty object"}</State> : <State tone="bad">Not a JSON object</State>)}
          </>
        }
        hint={
          <>
            Optional. API keys in it reach every agent through its opencode config; other logins are copied to <span className="font-mono">~/.local/share/opencode/auth.json</span>, which opencode only reads when it first starts.
          </>
        }
      >
        <textarea
          className={cn("input h-24 w-full font-mono text-xs", auth && !auth.ok && "border-critical/60")}
          aria-label="opencode auth.json"
          spellCheck={false}
          placeholder="{ }"
          value={s.agentAuthJson}
          onChange={(e) => update("agentAuthJson", e.target.value)}
        />
      </Row>
    </Section>
  );
}

// ---- notifications ----

const EVENTS: { k: keyof Settings["notify"]["on"]; label: string; hint: string }[] = [
  { k: "done", label: "Run done", hint: "REPORT.md is written" },
  { k: "question", label: "Question", hint: "The agent asks you something" },
  { k: "stopped", label: "Stopped", hint: "Out of continues, or paused or moved for an API key" },
  { k: "failed", label: "Failed", hint: "The run couldn't start" },
  { k: "deadline", label: "Disclosure deadline", hint: "A sent finding is due soon, then past its deadline" },
];

function ChannelState({ last, configured }: { last: NotifyStatus["ntfy"]; configured: boolean }) {
  if (!configured) return <State tone="off">Not set</State>;
  if (!last) return <State tone="off">Nothing sent yet</State>;
  return last.ok ? (
    <State tone="good" title={last.title}>
      Sent {ago(last.ts)}
    </State>
  ) : (
    <State tone="bad" title={last.error}>
      Failed {ago(last.ts)}: {last.error}
    </State>
  );
}

function NotificationsSection({ s, update, status, sentNow, dirty, onTest }: { s: Settings; update: Update; status: NotifyStatus; sentNow: Sent[] | null; dirty: boolean; onTest: () => Promise<void> }) {
  const n = s.notify;
  const set = (patch: Partial<Settings["notify"]>) => update("notify", { ...n, ...patch });
  const telegram = !!(n.telegramToken && n.telegramChat);
  const result = (c: Sent["channel"]) => sentNow?.find((r) => r.channel === c);
  return (
    <Section
      id="notifications"
      icon={<IconBell {...IC} />}
      title="Notifications"
      right={
        <Button size="sm" onClick={onTest} disabled={!n.ntfyUrl && !telegram} done="Test sent">
          {dirty ? "Save and send test" : "Send test"}
        </Button>
      }
    >
      <Row
        label={
          <>
            ntfy
            <ChannelState last={status.ntfy} configured={!!n.ntfyUrl} />
          </>
        }
        hint={
          <>
            A topic URL from{" "}
            <a href="https://ntfy.sh" target="_blank" rel="noreferrer">
              ntfy.sh
            </a>{" "}
            or your own server. Anyone with the URL can read it, so make the topic hard to guess.
          </>
        }
      >
        <input className="input w-[320px] font-mono text-[12.5px] max-sm:w-full" aria-label="ntfy topic URL" placeholder="https://ntfy.sh/your-secret-topic" value={n.ntfyUrl} onChange={(e) => set({ ntfyUrl: e.target.value })} />
      </Row>
      <Row
        label={
          <>
            Telegram
            <ChannelState last={status.telegram} configured={telegram} />
          </>
        }
        hint={
          <>
            A bot token from{" "}
            <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">
              BotFather
            </a>{" "}
            and the chat id to send to.
          </>
        }
      >
        <input className="input w-[180px] font-mono text-[12.5px] max-sm:flex-1" type="password" autoComplete="off" aria-label="Telegram bot token" placeholder="Bot token" value={n.telegramToken} onChange={(e) => set({ telegramToken: e.target.value })} />
        <input className="input w-[132px] font-mono text-[12.5px] max-sm:flex-1" aria-label="Telegram chat id" placeholder="Chat id" value={n.telegramChat} onChange={(e) => set({ telegramChat: e.target.value })} />
      </Row>
      {sentNow && sentNow.length > 0 && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 px-4 py-2.5">
          {(["ntfy", "telegram"] as const).map((c) => {
            const r = result(c);
            if (!r) return null;
            return (
              <State key={c} tone={r.ok ? "good" : "bad"} title={r.error}>
                Test via {c === "ntfy" ? "ntfy" : "Telegram"}: {r.ok ? "sent" : r.error}
              </State>
            );
          })}
        </div>
      )}
      <div className="grid gap-x-8 gap-y-3 px-4 py-3.5 sm:grid-cols-2">
        {EVENTS.map((e) => (
          <div key={e.k} className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[13px]">{e.label}</div>
              <div className="mt-0.5 text-xs text-ink-3">{e.hint}</div>
            </div>
            <Toggle label={`Notify: ${e.label}`} checked={n.on[e.k]} onChange={(v) => set({ on: { ...n.on, [e.k]: v } })} />
          </div>
        ))}
      </div>
    </Section>
  );
}

// ---- backups ----

const HOURS: [string, string][] = [["-1", "Off"], ...Array.from({ length: 24 }, (_, h) => [String(h), `Daily at ${String(h).padStart(2, "0")}:00`] as [string, string])];

function BackupsSection({ s, update, last, running, dirty, onBackup }: { s: Settings; update: Update; last?: { ts: number; ok: boolean; output: string }; running: boolean; dirty: boolean; onBackup: () => Promise<void> }) {
  const b = s.backup;
  const set = (patch: Partial<Settings["backup"]>) => update("backup", { ...b, ...patch });
  return (
    <Section
      id="backups"
      icon={<IconDatabase {...IC} />}
      title="Backups"
      meta={
        last ? (
          <State tone={last.ok ? "good" : "bad"}>
            {last.ok ? "Last backup" : "Last backup failed"} {ago(last.ts)}
          </State>
        ) : b.repository ? (
          <State tone="off">No backup yet</State>
        ) : undefined
      }
      right={
        <Button size="sm" onClick={onBackup} disabled={!b.repository || dirty || running} title={dirty ? "Save first" : undefined} done="Backup finished">
          {running ? "Backing up" : "Back up now"}
        </Button>
      }
    >
      <Row
        label="restic repository"
        hint={
          <>
            Workbases, the database, history and transcripts, sent off this host with{" "}
            <a href="https://restic.net" target="_blank" rel="noreferrer">
              restic
            </a>
            . For example <span className="font-mono">sftp:user@host:/backups/pixel</span> or <span className="font-mono">s3:https://host/bucket</span>.
          </>
        }
      >
        <input className="input w-[340px] font-mono text-[12.5px] max-sm:w-full" aria-label="restic repository" placeholder="sftp:user@host:/backups/pixel" value={b.repository} onChange={(e) => set({ repository: e.target.value })} />
      </Row>
      <Row label="Repository password" hint="Without it the backups can't be read, so keep a copy somewhere else.">
        <input className="input w-[240px] max-sm:w-full" type="password" autoComplete="off" aria-label="Repository password" value={b.password} onChange={(e) => set({ password: e.target.value })} />
      </Row>
      <Row label="Schedule" hint="In the server's time zone.">
        <Select field className="w-[180px]" label="Backup schedule" value={String(b.dailyHour)} onChange={(v) => set({ dailyHour: Number(v) })} options={HOURS} />
      </Row>
      <Row wide label="Extra environment" hint="Credentials for the repository's storage, like AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for S3.">
        <EnvEditor value={b.env} onChange={(v) => set({ env: v })} placeholder="AWS_ACCESS_KEY_ID" />
      </Row>
      {last?.output && (
        <details className="group px-4 py-3">
          <summary className="cursor-pointer text-[12.5px] text-ink-3 select-none hover:text-ink">
            <IconServer {...IC_XS} className="mr-1.5 inline-block align-[-1px]" />
            Output of the last backup
          </summary>
          <pre className="mt-2.5 max-h-56 overflow-auto rounded-lg bg-bg p-3 font-mono text-[11.5px] whitespace-pre-wrap text-ink-2">{last.output}</pre>
        </details>
      )}
    </Section>
  );
}
