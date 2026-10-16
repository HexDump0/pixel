/**
 * The models the new-run form offers, one row each: right now (calls, first token, speed, failures, use
 * against your limits) or across every run (finish rate, time, cost, findings that held up). Models
 * agents used that aren't offered follow, dimmed.
 */
import { useState } from "react";
import { IconAdjustments, IconAdjustmentsHorizontal, IconDots, IconMinus, IconPlayerPlay, IconPlus, IconServer2, IconStar, IconStarFilled } from "@tabler/icons-react";
import type { Leaderboard, ProviderHealth, Settings } from "../../lib/types.ts";
import { duration, money, tokens } from "../../lib/format.ts";
import { cn } from "../../lib/cn.ts";
import { Button } from "../../components/ui.tsx";
import { IC_SM, Join, Nil, Val } from "../../components/ui/bits.tsx";
import { Dialog, Menu, Tip } from "../../components/ui/overlay.tsx";
import { hueVar, ms, Share, Spark, splitModel } from "./common.tsx";
import { describeOverride } from "./Advanced.tsx";

export type LineupView = "now" | "runs";
type Health = ProviderHealth[number];
type Board = Leaderboard[number];
type Limit = { tpm?: number; rpm?: number };

export interface LineupRow {
  key: string;
  hue: number;
  offered: boolean;
  health: Health | null;
  board: Board | null;
}

const COLS: Record<LineupView, string> = {
  now: "grid-cols-[28px_minmax(220px,2fr)_64px_150px_130px_64px_minmax(150px,1fr)_64px]",
  runs: "grid-cols-[28px_minmax(180px,1.6fr)_56px_110px_80px_80px_72px_minmax(130px,1fr)_76px_72px_64px]",
};
const ROW = "grid items-center gap-3.5 px-3 max-lg:grid-cols-[28px_minmax(0,1fr)_auto]";
const NUM = "text-right font-mono text-xs tabular-nums text-ink-2 max-lg:hidden";
const COL = "max-lg:hidden";

const STATE: Record<string, { word: string; tone: string; dot: string }> = {
  limited: { word: "Rate limited", tone: "text-critical", dot: "bg-critical" },
  degraded: { word: "Degraded", tone: "text-warning", dot: "bg-warning" },
};

export function Lineup({
  rows,
  view,
  settings,
  providerName,
  onDefault,
  onOffer,
  onLimit,
  onTest,
  onProvider,
  onAdvanced,
}: {
  rows: LineupRow[];
  view: LineupView;
  settings: Settings;
  providerName: (id: string) => string;
  onDefault: (key: string) => void;
  onOffer: (key: string, on: boolean) => void;
  onLimit: (key: string, l: Limit | null) => Promise<void>;
  onTest: (key: string) => void;
  onProvider: (id: string) => void;
  onAdvanced: (key: string) => void;
}) {
  const [limitFor, setLimitFor] = useState<string | null>(null);
  const firstExtra = rows.findIndex((r) => !r.offered);
  const head =
    view === "now"
      ? ["Calls", "First token", "Output tok/s", "Failed", "Tokens / min"]
      : ["Runs", "Finished", "Median time", "Tokens / run", "Cost / run", "Real findings", "Cost / real", "Continues, OOM"];

  return (
    <div role="table" className="overflow-x-auto rounded-2xl border border-line-2 bg-s1">
      <div className="min-w-fit lg:min-w-[960px]">
        <div role="row" className={cn(ROW, COLS[view], "h-[38px] border-b border-line-2 text-xs text-ink-3")}>
          <span />
          <span>Model</span>
          {head.map((h, i) => (
            <span key={h} className={cn(COL, (view === "now" ? [0, 3] : [0, 2, 3, 4, 6, 7]).includes(i) && "text-right")}>
              {h}
            </span>
          ))}
          <span />
        </div>
        {rows.map((r, i) => {
          const [pid, mid] = splitModel(r.key);
          const isDefault = settings.defaultModel === r.key;
          const h = r.health;
          const b = r.board;
          const st = h ? STATE[h.state] : undefined;
          const limit = settings.providerLimits[r.key] ?? null;
          const custom = describeOverride(settings.modelOverrides?.[r.key]);
          return (
            <div key={r.key}>
              {i === firstExtra && <div className="border-t border-line-2 px-3 pt-4 pb-1.5 text-xs text-ink-3">Used by runs, not offered</div>}
              <div role="row" className={cn(ROW, COLS[view], "group min-h-14 border-t border-line-2 py-2 hover:bg-s2", i === 0 && "border-t-0", i === firstExtra && "border-t-0")}>
                <span className="flex justify-center">
                  {r.offered ? (
                    <button
                      type="button"
                      onClick={() => onDefault(r.key)}
                      aria-pressed={isDefault}
                      aria-label={isDefault ? `${r.key} is the default model` : `Make ${r.key} the default model`}
                      title={isDefault ? "Default for new runs" : "Make default"}
                      className={cn("inline-flex size-6 cursor-pointer items-center justify-center rounded-md hover:bg-s3", isDefault ? "text-accent" : "text-ink-4 hover:text-ink-2")}
                    >
                      {isDefault ? <IconStarFilled size={14} /> : <IconStar size={14} stroke={1.75} />}
                    </button>
                  ) : (
                    <span className="size-1.5 rounded-full bg-ink-4" />
                  )}
                </span>
                <span className="flex min-w-0 items-center gap-2.5">
                  <i className={cn("size-2.5 shrink-0 rounded-[3px]", !r.offered && "opacity-40")} style={{ background: hueVar(r.hue) }} />
                  <span className="min-w-0">
                    <b className={cn("block truncate font-mono text-[13px] font-medium", !r.offered && "font-normal text-ink-2")}>{mid}</b>
                    <span className="flex min-w-0 items-center gap-2 text-xs">
                      <button type="button" onClick={() => onProvider(pid)} className="cursor-pointer truncate border-0 bg-transparent p-0 text-left text-ink-3 hover:text-ink hover:underline">
                        {providerName(pid)}
                      </button>
                      {custom.length > 0 && (
                        <button
                          type="button"
                          onClick={() => onAdvanced(r.key)}
                          title={`Set by hand: ${custom.join(", ")}`}
                          className="inline-flex min-w-0 cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-ink-3 hover:text-ink"
                        >
                          <IconAdjustments size={12} stroke={1.75} className="shrink-0" />
                          <span className="truncate">{custom[0]}{custom.length > 1 && ` and ${custom.length - 1} more`}</span>
                        </button>
                      )}
                      {st && (
                        <Tip content={h?.lastEvent ? `${h.lastEvent.kind}: ${h.lastEvent.message}` : undefined}>
                          <span className={cn("inline-flex shrink-0 items-center gap-1.5", st.tone)}>
                            <i className={cn("size-1.5 rounded-full", st.dot)} />
                            {st.word}
                          </span>
                        </Tip>
                      )}
                    </span>
                  </span>
                </span>

                {view === "now" ? (
                  <>
                    <span className={NUM}>{h?.calls || <Nil />}</span>
                    <span className={cn(COL, "flex items-center gap-2.5")}>
                      <Spark values={h?.buckets.map((x) => x.ttft) ?? []} color={hueVar(r.hue)} />
                      <span className="font-mono text-xs text-ink-2 tabular-nums"><Val v={h ? ms(h.ttft.p50) : ""} /></span>
                    </span>
                    <span className={cn(COL, "flex items-center gap-2.5")}>
                      <Spark values={h?.buckets.map((x) => x.tps) ?? []} color={hueVar(r.hue)} />
                      <span className="font-mono text-xs text-ink-2 tabular-nums">{h?.tps.p50 == null ? <Nil /> : Math.round(h.tps.p50)}</span>
                    </span>
                    <span className={cn(NUM, h && (h.errors || h.rateLimits) && "text-warning")} title={h ? `${h.errors} errors, ${h.rateLimits} rate limits, ${h.retries} retries` : undefined}>
                      {h ? h.errors + h.rateLimits || <span className="text-ink-4">0</span> : <Nil />}
                    </span>
                    <span className={COL}>
                      <Usage value={h?.tokensPerMin ?? 0} limit={limit?.tpm} onEdit={r.offered ? () => setLimitFor(r.key) : undefined} />
                    </span>
                  </>
                ) : (
                  <>
                    <span className={NUM}>
                      {b?.runs ?? <span className="text-ink-4">0</span>}
                      {b?.active ? <span className="block text-[11px] text-ink-3">{b.active} active</span> : null}
                    </span>
                    <span className={cn(COL, "font-mono text-xs text-ink-2")} title={b ? `${b.finished} wrote a report, ${b.gaveUp} stopped or failed` : undefined}>
                      <Share value={b?.finishRate ?? null} />
                    </span>
                    <span className={NUM}>{b?.medianDuration == null ? <Nil /> : duration(b.medianDuration).replace(/ \d+s$/, "")}</span>
                    <span className={NUM}>{b ? tokens(Math.round(b.avgTokens)) : <Nil />}</span>
                    <span className={NUM}>{b ? money(b.avgCost) : <Nil />}</span>
                    <span className={cn(COL, "font-mono text-xs text-ink-2")} title={b ? Object.entries(b.verdicts).map(([v, n]) => `${v}: ${n}`).join("\n") || "No verdicts yet" : undefined}>
                      {b?.triaged ? (
                        <span className="inline-flex items-center gap-2">
                          <Share value={b.realRate} />
                          <span className="text-ink-3">
                            {b.real}/{b.triaged}
                          </span>
                        </span>
                      ) : (
                        <Nil />
                      )}
                    </span>
                    <span className={NUM}>{b?.costPerReal == null ? <Nil /> : money(b.costPerReal)}</span>
                    <span className={NUM}>{b ? <Join items={[b.avgContinues.toFixed(1), b.avgOom.toFixed(1)]} /> : <Nil />}</span>
                  </>
                )}

                <span className="flex justify-end gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 max-lg:opacity-100">
                  <Button size="xs" icon variant="ghost" title="Live test" aria-label={`Live test ${r.key}`} onClick={() => onTest(r.key)}>
                    <IconPlayerPlay {...IC_SM} />
                  </Button>
                  <Menu
                    trigger={
                      <button type="button" aria-label={`More for ${r.key}`} className="inline-flex size-[26px] cursor-pointer items-center justify-center rounded-md text-ink-3 hover:bg-s3 hover:text-ink">
                        <IconDots {...IC_SM} />
                      </button>
                    }
                    items={[
                      r.offered && !isDefault && { label: "Make default", icon: <IconStar {...IC_SM} />, onSelect: () => onDefault(r.key) },
                      r.offered && { label: limit ? "Edit limits" : "Set limits", icon: <IconAdjustmentsHorizontal {...IC_SM} />, onSelect: () => setLimitFor(r.key) },
                      { label: "Advanced settings", icon: <IconAdjustments {...IC_SM} />, hint: custom.length ? "changed" : undefined, onSelect: () => onAdvanced(r.key) },
                      { label: `Open ${providerName(pid)}`, icon: <IconServer2 {...IC_SM} />, onSelect: () => onProvider(pid) },
                      "-",
                      r.offered
                        ? { label: "Remove from the new-run form", icon: <IconMinus {...IC_SM} />, disabled: isDefault, hint: isDefault ? "default" : undefined, onSelect: () => onOffer(r.key, false) }
                        : { label: "Offer in the new-run form", icon: <IconPlus {...IC_SM} />, onSelect: () => onOffer(r.key, true) },
                    ]}
                  />
                </span>
              </div>
            </div>
          );
        })}
      </div>
      {limitFor && <LimitDialog model={limitFor} limit={settings.providerLimits[limitFor] ?? null} onClose={() => setLimitFor(null)} onSave={(l) => onLimit(limitFor, l).then(() => setLimitFor(null))} />}
    </div>
  );
}

/** Tokens per minute over the last 5 minutes, against your limit when one is set. */
function Usage({ value, limit, onEdit }: { value: number; limit?: number; onEdit?: () => void }) {
  const p = limit ? Math.min(1, value / limit) : null;
  const body = (
    <span className="inline-flex items-center gap-2 font-mono text-xs text-ink-2 tabular-nums">
      {p != null && (
        <span className="h-1 w-10 overflow-hidden rounded-full bg-s3">
          <i className={cn("block h-full rounded-full", p > 0.8 ? "bg-warning" : "bg-ink-3")} style={{ width: `${p * 100}%` }} />
        </span>
      )}
      <span className={cn(p != null && p > 0.8 && "text-warning", !value && !limit && "text-ink-4")}>
        {value ? tokens(Math.round(value)) : "0"}
        {limit ? <span className="text-ink-3"> / {tokens(limit)}</span> : null}
      </span>
    </span>
  );
  if (!onEdit) return body;
  return (
    <button type="button" onClick={onEdit} title={limit ? "Edit limits" : "Set limits from your provider plan"} className="-mx-1.5 cursor-pointer rounded-md border-0 bg-transparent px-1.5 py-1 text-left hover:bg-s3">
      {body}
    </button>
  );
}

function LimitDialog({ model, limit, onClose, onSave }: { model: string; limit: Limit | null; onClose: () => void; onSave: (l: Limit | null) => Promise<void> }) {
  const [tpm, setTpm] = useState(limit?.tpm ? String(limit.tpm) : "");
  const [rpm, setRpm] = useState(limit?.rpm ? String(limit.rpm) : "");
  const num = (s: string) => (s.trim() && Number(s) > 0 ? Number(s) : undefined);
  const save = () => {
    const l = { tpm: num(tpm), rpm: num(rpm) };
    return onSave(l.tpm || l.rpm ? l : null);
  };
  return (
    <Dialog
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title="Limits"
      description={<span className="font-mono text-xs">{model}</span>}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="limits-form">
            Save
          </Button>
        </>
      }
    >
      <form
        id="limits-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="grid grid-cols-2 gap-3"
      >
        <label className="label">
          <span>Tokens per minute</span>
          <input className="input font-mono" inputMode="numeric" value={tpm} onChange={(e) => setTpm(e.target.value)} placeholder="none" />
        </label>
        <label className="label">
          <span>Requests per minute</span>
          <input className="input font-mono" inputMode="numeric" value={rpm} onChange={(e) => setRpm(e.target.value)} placeholder="none" />
        </label>
        <p className="col-span-2 m-0 text-xs text-ink-3">From your provider plan. Usage turns amber above 80%.</p>
      </form>
    </Dialog>
  );
}
