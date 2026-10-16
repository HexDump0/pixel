/**
 * A provider's API keys: name, notes, hint, whether it's working, and which runs use it. The order
 * matters: the first key is the default for new runs, and failover tries the rest in order. Drag a row
 * (or use its arrows) to reorder.
 */
import { useEffect, useState } from "react";
import { IconArrowDown, IconArrowUp, IconGripVertical, IconPlus, IconTrash } from "@tabler/icons-react";
import { api } from "../../lib/api.ts";
import { ago } from "../../lib/format.ts";
import { cn } from "../../lib/cn.ts";
import type { ConnectedProvider, PublicKey } from "../../lib/types.ts";
import { Button, Field } from "../../components/ui.tsx";
import { IC_SM, IC_XS, Sep } from "../../components/ui/bits.tsx";
import { Dialog, Tip } from "../../components/ui/overlay.tsx";
import { toast } from "../../components/Toast.tsx";

const STATE: Record<string, { text: string; tone: string }> = {
  rejected: { text: "Rejected", tone: "text-critical" },
  credit: { text: "Out of credit", tone: "text-critical" },
  ratelimit: { text: "Rate limited", tone: "text-warning" },
};

export function Keys({ provider, onChanged }: { provider: ConnectedProvider; onChanged: () => void }) {
  const [usage, setUsage] = useState<{ runs: Record<string, number>; callsPerHour: Record<string, number> } | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const keys = provider.keys;

  useEffect(() => {
    api.keyUsage(provider.id).then(setUsage, () => setUsage(null));
  }, [provider.id, keys.length]);

  // Runs and calls stored without a key id were on the default key.
  const used = (k: PublicKey, i: number, m?: Record<string, number>) => (m?.[k.id] ?? 0) + (i === 0 ? (m?.[""] ?? 0) : 0);

  const move = async (from: string, to: number) => {
    const ids = keys.map((k) => k.id).filter((id) => id !== from);
    ids.splice(to, 0, from);
    await api.orderKeys(provider.id, ids).catch((e) => toast(e.message, "error"));
    onChanged();
  };

  return (
    <section>
      <div className="mb-2 flex items-center gap-2.5">
        <h3 className="m-0 text-[13px] font-medium">Keys</h3>
        {keys.length > 1 && <span className="text-xs text-ink-3">Top one is the default; failover goes down the list</span>}
        <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setEditing("new")}>
          <IconPlus {...IC_XS} />
          Add key
        </Button>
      </div>
      <div className="overflow-hidden rounded-xl border border-line-2">
        {keys.length === 0 && (
          <div className="px-3.5 py-3 text-[13px] text-ink-3">
            No key: agents call {provider.name} without one{provider.id === "opencode" ? ", so only its free models work" : ""}.
          </div>
        )}
        {keys.map((k, i) =>
          <div
            key={k.id}
            className={cn("group grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-3 border-t border-line-2 px-3 py-2.5 first:border-t-0 hover:bg-s2 sm:grid-cols-[16px_minmax(0,1.2fr)_minmax(0,1fr)_auto]", drag === k.id && "opacity-50")}
            draggable={keys.length > 1}
            onDragStart={(e) => {
              setDrag(k.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => setDrag(null)}
            onDragOver={(e) => drag && drag !== k.id && e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (drag && drag !== k.id) void move(drag, i);
              setDrag(null);
            }}
          >
            <span className={cn("text-ink-4", keys.length > 1 && "cursor-grab group-hover:text-ink-3")} aria-hidden>
              {keys.length > 1 && <IconGripVertical size={14} stroke={1.75} />}
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[13px]">
                <b className="truncate font-medium">{k.name}</b>
                {i === 0 && keys.length > 1 && <span className="rounded-[5px] bg-s3 px-1.5 text-[11px] text-ink-2">default</span>}
                {k.status && (
                  <Tip content={`${k.status.detail}, ${ago(k.status.at)}`}>
                    <span className={cn("inline-flex items-center gap-1.5 text-xs", STATE[k.status.state].tone)}>
                      <i className={cn("size-1.5 rounded-full bg-current")} />
                      {STATE[k.status.state].text}
                    </span>
                  </Tip>
                )}
              </div>
              {k.note && <div className="truncate text-xs text-ink-3">{k.note}</div>}
            </div>
            <div className="col-start-2 min-w-0 font-mono text-xs text-ink-3 sm:col-start-3">
              <span className="text-ink-2">{k.hint ?? "no key"}</span>
              <Sep />
              {used(k, i, usage?.runs)} runs
              <Sep />
              {used(k, i, usage?.callsPerHour)} calls/h
            </div>
            <div className="col-start-3 row-span-2 row-start-1 flex items-center gap-0.5 sm:col-start-4 sm:row-span-1">
              {keys.length > 1 && (
                <span className="flex opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                  <Button size="xs" icon variant="ghost" aria-label={`Move ${k.name} up`} title="Move up" disabled={i === 0} onClick={() => move(k.id, i - 1)}>
                    <IconArrowUp {...IC_SM} />
                  </Button>
                  <Button size="xs" icon variant="ghost" aria-label={`Move ${k.name} down`} title="Move down" disabled={i === keys.length - 1} onClick={() => move(k.id, i + 1)}>
                    <IconArrowDown {...IC_SM} />
                  </Button>
                </span>
              )}
              <Button
                size="xs"
                variant="ghost"
                onClick={async () => {
                  const r = await api.testKey(provider.id, k.id);
                  toast(r.ok ? `${k.name}: the key works` : `${k.name}: ${r.message}`, r.ok ? "info" : "error");
                  onChanged();
                }}
              >
                Test
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setEditing(k.id)}>
                Edit
              </Button>
              <Button
                size="xs"
                icon
                variant="ghost"
                className="hover:enabled:text-critical"
                title="Remove key"
                aria-label={`Remove the key ${k.name}`}
                confirm={keys.length === 1 ? `Remove the key ${k.name}? Agents then call ${provider.name} without a key.` : `Remove the key ${k.name}? Runs using it go back to the default key at their next restart.`}
                onClick={async () => {
                  const r = await api.removeKey(provider.id, k.id);
                  toast(keys.length === 1 ? `${provider.name} now runs without a key` : r.moved.length ? `Key removed; ${r.moved.length} run${r.moved.length === 1 ? "" : "s"} moved to the default key` : "Key removed");
                  onChanged();
                }}
              >
                <IconTrash {...IC_SM} />
              </Button>
            </div>
            </div>
        )}
        {editing && <KeyDialog provider={provider} existing={keys.find((k) => k.id === editing)} onDone={() => (setEditing(null), onChanged())} />}
      </div>
    </section>
  );
}

function KeyDialog({ provider, existing, onDone }: { provider: ConnectedProvider; existing?: PublicKey; onDone: () => void }) {
  const [name, setName] = useState(existing?.name ?? "");
  const [key, setKey] = useState("");
  const [note, setNote] = useState(existing?.note ?? "");

  const save = async () => {
    if (existing) await api.editKey(provider.id, existing.id, { name, note, ...(key.trim() && { key }) });
    else await api.addKey(provider.id, { name, key, note });
    onDone();
  };

  return (
    <Dialog
      onOpenChange={(o) => !o && onDone()}
      size="sm"
      title={existing ? `Edit ${existing.name}` : `Add a key for ${provider.name}`}
      footer={
        <>
          {existing && (
            <Button
              variant="ghost"
              className="mr-auto text-critical hover:enabled:text-critical"
              confirm={`Remove the key ${existing.name}? Runs using it go back to ${provider.name}'s default key at their next restart.`}
              onClick={async () => {
                const r = await api.removeKey(provider.id, existing.id);
                toast(r.moved.length ? `Key removed; ${r.moved.length} run${r.moved.length === 1 ? "" : "s"} moved to the default key` : "Key removed");
                onDone();
              }}
            >
              Remove
            </Button>
          )}
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="key-form" disabled={!existing && !key.trim()}>
            {existing ? "Save" : "Add key"}
          </Button>
        </>
      }
    >
      <form
        id="key-form"
        className="flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          save().then(
            () => toast(existing ? "Key saved" : "Key added"),
            (err) => toast(err.message ?? String(err), "error"),
          );
        }}
      >
        <Field label="Name">
          <input className="input" placeholder="Personal, Work, Trial credits" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="API key" hint={existing ? `Leave empty to keep ${existing.hint ?? "the current key"}.` : undefined}>
          <input className="input font-mono" type="password" autoComplete="off" placeholder={existing ? "unchanged" : "paste the key"} value={key} onChange={(e) => setKey(e.target.value)} />
        </Field>
        <Field label="Notes">
          <textarea className="input" rows={3} placeholder="Who pays, limits, expiry, what it's for" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}
