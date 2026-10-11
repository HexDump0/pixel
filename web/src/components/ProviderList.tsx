/** Every provider agents can use, how it's connected, how it's doing right now, and its models. */
import { Fragment } from "react";
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
          Providers <span>what agents can use · click one for its models</span>
        </h3>
      </div>
      {providers.map((p) => {
        const s = summary(p.id, health);
        const offered = settings.models.filter((m) => m.startsWith(`${p.id}/`)).length;
        const isOpen = open === p.id;
        const removable = p.via.includes("pixel");
        return (
          <div key={p.id} className={`prov ${isOpen ? "open" : ""}`}>
            <div className="row" style={{ cursor: "pointer" }} onClick={() => onOpen(isOpen ? null : p.id)}>
              <span className={`dot ${STATE_DOT[s.state] ?? ""}`} title={s.state === "idle" ? "no calls in the last hour" : s.state} />
              <div className="min-w-0">
                <button
                  style={{ all: "unset", cursor: "pointer", fontWeight: 500 }}
                  aria-expanded={isOpen}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen(isOpen ? null : p.id);
                  }}
                >
                  {isOpen ? "▾" : "▸"} {p.name}
                </button>
                <div className="mono muted" style={{ fontSize: 11.5 }}>
                  {p.id}
                  {p.baseURL ? ` · ${p.baseURL}` : ""}
                </div>
              </div>
              <div className="via wide">
                {p.via.map((v) => (
                  <span key={v} className={`badge ${v === "pixel" || v === "builtin" ? "" : "stopped"}`} title={v === "pixel" ? "Added here" : "Set up by hand under Settings → Agent credentials"}>
                    {VIA[v]?.(p) ?? v}
                  </span>
                ))}
              </div>
              <div className="wide num" style={{ color: offered ? "var(--fg)" : "var(--fg3)" }}>
                {offered} model{offered === 1 ? "" : "s"}
                {settings.defaultModel.startsWith(`${p.id}/`) && (
                  <span className="star on" title="Has the default model">
                    ★
                  </span>
                )}
              </div>
              <div className="wide num muted" style={{ fontSize: 12 }}>
                {s.calls ? (
                  <>
                    {s.calls} calls/h
                    {s.problems > 0 && <span style={{ color: "var(--warn)" }}> · {s.problems} errors</span>}
                  </>
                ) : (
                  "idle"
                )}
              </div>
              <div className="flex gap-1.5" onClick={(e) => e.stopPropagation()}>
                {p.via.includes("builtin") ? null : removable ? (
                  <>
                    <button className="btn btn-sm" onClick={() => onEdit(p)}>
                      Edit
                    </button>
                    <Button
                      small
                      variant="danger"
                      confirm={`Remove ${p.name}? Its key is deleted and its ${offered} model${offered === 1 ? "" : "s"} leave the new-run form. Running agents keep working.`}
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
