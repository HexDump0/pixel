/**
 * A provider's API keys, on the Models page: name, notes, hint, whether it's working, and which runs
 * use it. The order matters: the first key is the default for new runs, and failover tries the rest
 * in order. Drag a row (or use its arrows) to reorder.
 */
import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { ago } from "../lib/format.ts";
import type { ConnectedProvider, PublicKey } from "../lib/types.ts";
import { Button } from "./ui.tsx";
import { toast } from "./Toast.tsx";

const STATE: Record<string, { text: string; cls: string }> = {
  rejected: { text: "rejected", cls: "failed" },
  credit: { text: "out of credit", cls: "failed" },
  ratelimit: { text: "rate limited", cls: "recovering" },
};

export function KeyList({ provider, onChanged }: { provider: ConnectedProvider; onChanged: () => void }) {
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
    <div className="keys">
      <div className="khead">
        <span className="eyebrow">API keys · first is the default, failover tries the rest in order</span>
        <button className="btn btn-sm" onClick={() => setEditing("new")}>
          + Add key
        </button>
      </div>
      {keys.length === 0 && editing !== "new" && <div className="muted text-sm">No key yet. Add one so agents can use {provider.name}.</div>}
      {keys.map((k, i) =>
        editing === k.id ? (
          <KeyForm key={k.id} provider={provider} existing={k} onDone={() => (setEditing(null), onChanged())} />
        ) : (
          <div
            key={k.id}
            className={`krow ${drag === k.id ? "dragging" : ""}`}
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
            <span className="grip" aria-hidden="true" title="Drag to reorder">
              ⋮⋮
            </span>
            <div className="min-w-0">
              <div className="kname">
                {k.name}
                {i === 0 && <span className="badge">default</span>}
                {k.status ? (
                  <span className={`badge ${STATE[k.status.state].cls}`} title={k.status.detail}>
                    {STATE[k.status.state].text}
                  </span>
                ) : null}
              </div>
              {k.note && <div className="knote">{k.note}</div>}
            </div>
            <div className="kstat">
              <span className="mono">{k.hint ?? "no key"}</span>
              <span className="muted">
                {k.status ? `${k.status.detail.slice(0, 40)} · ${ago(k.status.at)}` : `${used(k, i, usage?.runs)} active run${used(k, i, usage?.runs) === 1 ? "" : "s"} · ${used(k, i, usage?.callsPerHour)} calls/h`}
              </span>
            </div>
            <div className="kacts">
              {keys.length > 1 && (
                <>
                  <button className="iconbtn" aria-label={`Move ${k.name} up`} title="Move up" disabled={i === 0} onClick={() => void move(k.id, i - 1)}>
                    ↑
                  </button>
                  <button className="iconbtn" aria-label={`Move ${k.name} down`} title="Move down" disabled={i === keys.length - 1} onClick={() => void move(k.id, i + 1)}>
                    ↓
                  </button>
                </>
              )}
              <Button
                small
                onClick={async () => {
                  const r = await api.testKey(provider.id, k.id);
                  toast(r.ok ? `${k.name}: the key works` : `${k.name}: ${r.message}`, r.ok ? "info" : "error");
                  onChanged();
                }}
              >
                Test
              </Button>
              <button className="btn btn-sm" onClick={() => setEditing(k.id)}>
                Edit
              </button>
            </div>
          </div>
        ),
      )}
      {editing === "new" && <KeyForm provider={provider} onDone={() => (setEditing(null), onChanged())} />}
    </div>
  );
}

function KeyForm({ provider, existing, onDone }: { provider: ConnectedProvider; existing?: PublicKey; onDone: () => void }) {
  const [name, setName] = useState(existing?.name ?? "");
  const [key, setKey] = useState("");
  const [note, setNote] = useState(existing?.note ?? "");
  const idp = `key-${existing?.id ?? "new"}`;

  const save = async () => {
    if (existing) await api.editKey(provider.id, existing.id, { name, note, ...(key.trim() && { key }) });
    else await api.addKey(provider.id, { name, key, note });
    onDone();
  };

  return (
    <form
      className="kform"
      onSubmit={(e) => {
        e.preventDefault();
        save().then(
          () => toast(existing ? "Key saved" : "Key added"),
          (err) => toast(err.message ?? String(err), "error"),
        );
      }}
    >
      <label htmlFor={`${idp}-name`}>Name</label>
      <input id={`${idp}-name`} className="input" placeholder={`e.g. Personal, Work, Trial credits`} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      <label htmlFor={`${idp}-key`}>API key</label>
      <input
        id={`${idp}-key`}
        className="input mono"
        type="password"
        autoComplete="off"
        placeholder={existing ? `unchanged (${existing.hint ?? "no key"})` : "paste the key"}
        value={key}
        onChange={(e) => setKey(e.target.value)}
      />
      <label htmlFor={`${idp}-note`}>Notes</label>
      <textarea id={`${idp}-note`} className="input" rows={2} placeholder="Who pays, limits, expiry, what it's for…" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="kformacts">
        {existing ? (
          <Button
            small
            variant="danger"
            confirm={`Remove the key ${existing.name}? Runs using it go back to ${provider.name}'s default key at their next restart.`}
            onClick={async () => {
              const r = await api.removeKey(provider.id, existing.id);
              toast(r.moved.length ? `Key removed; ${r.moved.length} run${r.moved.length === 1 ? "" : "s"} moved to the default key` : "Key removed");
              onDone();
            }}
          >
            Remove key
          </Button>
        ) : (
          <span />
        )}
        <span className="row">
          <button type="button" className="btn btn-sm" onClick={onDone}>
            Cancel
          </button>
          <button type="submit" className="btn btn-sm btn-primary" disabled={!existing && !key.trim()}>
            {existing ? "Save" : "Add key"}
          </button>
        </span>
      </div>
    </form>
  );
}
