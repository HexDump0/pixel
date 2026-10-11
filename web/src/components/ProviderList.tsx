/** Every provider agents can use, how it's connected, how it's doing right now, and its models. */
import { Fragment, type CSSProperties, type ReactNode } from "react";
import { api } from "../lib/api.ts";
import type { ConnectedProvider, ProviderHealth, Settings } from "../lib/types.ts";
import { Link } from "../lib/router.tsx";
import { Button, Empty } from "./ui.tsx";
import { ModelPicker } from "./ModelPicker.tsx";

const VIA: Record<string, (p: ConnectedProvider) => string> = {
  pixel: (p) => (p.custom ? `${p.custom.api === "anthropic" ? "Anthropic" : "OpenAI"} API · ${p.keyHint ? `key ${p.keyHint}` : "no key"}` : p.keyHint ? `key ${p.keyHint}` : "no key"),
  env: (p) => `env ${p.envVars.join(", ")}`,
  "auth.json": () => "auth.json in Settings",
  builtin: () => "built in · free models",
};

/** Stable tint per provider, from the run palette (--r0…--r5). */
const hue = (id: string) => [...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 6;

/** A provider's initial on a tile tinted by its id; children sit in the corner (the health dot). */
export function ProviderMark({ id, name, children }: { id: string; name: string; children?: ReactNode }) {
  return (
    <span className="pmark" style={{ "--hue": `var(--r${hue(id)})` } as CSSProperties} aria-hidden="true">
      {name.replace(/[^A-Za-z0-9]/g, "").slice(0, 1).toUpperCase() || "?"}
      {children}
    </span>
  );
}

const STATE_DOT: Record<string, string> = { ok: "running", degraded: "recovering", limited: "failed" };
const WORST = ["limited", "degraded", "ok", "idle"];

/** One provider's last-hour health, folded from its models. */
function summary(id: string, health: ProviderHealth) {
  const rows = health.filter((h) => h.key.startsWith(`${id}/`));
  const calls = rows.reduce((a, h) => a + h.calls, 0);
  const problems = rows.reduce((a, h) => a + h.errors + h.rateLimits, 0);
  const state = rows.map((h) => h.state).sort((a, b) => WORST.indexOf(a) - WORST.indexOf(b))[0] ?? "idle";
  return { calls, problems, state };
}

export function ProviderList({
  providers,
  settings,
  health,
  open,
  onOpen,
  onSettings,
  onEdit,
  onAdd,
  onRemoved,
}: {
  providers: ConnectedProvider[];
  settings: Settings;
  health: ProviderHealth;
  open: string | null;
  onOpen: (id: string | null) => void;
  onSettings: (s: Settings) => void;
  onEdit: (p: ConnectedProvider) => void;
  onAdd: () => void;
  onRemoved: () => void;
}) {
  const ids = new Set(providers.map((p) => p.id));
  const orphans = settings.models.filter((m) => !ids.has(m.split("/")[0]));

  return (
    <section className="card" style={{ padding: 0 }}>
      <div className="sec">
        <h3>
          {providers.length} provider{providers.length === 1 ? "" : "s"} <span>click one to choose its models</span>
        </h3>
      </div>
      {providers.map((p) => {
        const s = summary(p.id, health);
        const offered = settings.models.filter((m) => m.startsWith(`${p.id}/`));
        const isOpen = open === p.id;
        const removable = p.via.includes("pixel");
        return (
          <div key={p.id} className={`prov ${isOpen ? "open" : ""}`}>
            <div className="row" onClick={() => onOpen(isOpen ? null : p.id)}>
              <ProviderMark id={p.id} name={p.name}>
                <i className={`dot ${STATE_DOT[s.state] ?? ""}`} title={s.state === "idle" ? "no calls in the last hour" : s.state} />
              </ProviderMark>
              <div className="min-w-0">
                <button
                  className="name"
                  aria-expanded={isOpen}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen(isOpen ? null : p.id);
                  }}
                >
                  {p.name}
                </button>
                <div className="mono muted truncate" style={{ fontSize: 11.5 }} title={p.baseURL ?? undefined}>
                  {p.id}
                  {p.baseURL ? ` · ${p.baseURL.replace(/^https?:\/\//, "")}` : ""}
                </div>
              </div>
              <div className="via wide">
                {p.via.map((v) => (
                  <span key={v} className={`badge ${v === "pixel" || v === "builtin" ? "" : "stopped"}`} title={v === "pixel" ? "Added here" : v === "builtin" ? "opencode's own gateway, no key needed" : "Set up by hand under Settings → Agent credentials"}>
                    {VIA[v]?.(p) ?? v}
                  </span>
                ))}
              </div>
              <div className="chips wide">
                {offered.length === 0 ? (
                  <span className="muted" style={{ fontSize: 12 }}>
                    no models offered yet
                  </span>
                ) : (
                  <>
                    {offered.slice(0, 2).map((m) => (
                      <span key={m} className={`chip ${m === settings.defaultModel ? "on" : ""}`} title={m === settings.defaultModel ? "Default model for new runs" : m}>
                        {m === settings.defaultModel && "★ "}
                        {m.slice(p.id.length + 1)}
                      </span>
                    ))}
                    {offered.length > 2 && <span className="chip more">+{offered.length - 2}</span>}
                  </>
                )}
              </div>
              <div className="wide num" style={{ fontSize: 12, color: s.problems ? "var(--warn)" : s.calls ? "var(--fg2)" : "var(--fg3)" }}>
                {s.calls ? `${s.calls} calls/h${s.problems ? ` · ${s.problems} err` : ""}` : "idle"}
              </div>
              <div className="acts" onClick={(e) => e.stopPropagation()}>
                {p.via.includes("builtin") ? null : removable ? (
                  <>
                    <button className="btn btn-sm" onClick={() => onEdit(p)}>
                      Edit
                    </button>
                    <Button
                      small
                      variant="danger"
                      confirm={`Remove ${p.name}? Its key is deleted and its ${offered.length} model${offered.length === 1 ? "" : "s"} leave the new-run form. Running agents keep working.`}
                      onClick={async () => {
                        await api.removeProvider(p.id);
                        onRemoved();
                      }}
                      done={`${p.name} removed`}
                    >
                      Remove
                    </Button>
                  </>
                ) : (
                  <Link to="/settings" className="btn btn-sm">
                    Settings
                  </Link>
                )}
              </div>
              <span className="chev" aria-hidden="true">
                ›
              </span>
            </div>
            {isOpen && (
              <div className="models">
                <ModelPicker provider={p} settings={settings} onSettings={onSettings} />
              </div>
            )}
          </div>
        );
      })}
      {providers.length <= 1 && (
        <Empty>
          Only opencode's free models are available.{" "}
          <button className="btn btn-sm btn-primary" onClick={onAdd}>
            Add a provider
          </button>
        </Empty>
      )}
      {orphans.length > 0 && (
        <div className="sec" style={{ borderTop: "1px solid var(--line)" }}>
          <span className="text-sm" style={{ color: "var(--warn)" }}>
            Offered in the new-run form, but no key is set up for their provider:{" "}
            {orphans.map((m, i) => (
              <Fragment key={m}>
                {i > 0 && ", "}
                <span className="mono">{m}</span>
              </Fragment>
            ))}
          </span>
          <Button
            small
            className="self-start"
            onClick={async () => {
              const keep = settings.models.filter((m) => !orphans.includes(m));
              onSettings(await api.saveSettings({ models: keep, ...(orphans.includes(settings.defaultModel) && { defaultModel: keep[0] ?? "opencode/big-pickle" }) }));
            }}
            done="Removed from the new-run form"
          >
            Remove them from the list
          </Button>
        </div>
      )}
    </section>
  );
}
