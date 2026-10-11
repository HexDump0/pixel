import { useState, type ReactNode } from "react";
import { Link, useLocation } from "../lib/router.tsx";
import { useLive } from "../lib/live.ts";
import { api } from "../lib/api.ts";
import { ACTIVE, useRuns } from "../lib/runs.ts";
import { Icon, type IconName } from "./icons.tsx";
import { Mesh } from "./Mesh.tsx";
import { CommandPalette } from "./CommandPalette.tsx";

const NAV: { to: string; label: string; icon: IconName; match: (p: string) => boolean }[] = [
  { to: "/", label: "Runs", icon: "runs", match: (p) => p === "/" || p.startsWith("/runs") },
  { to: "/activity", label: "Activity", icon: "activity", match: (p) => p === "/activity" },
  { to: "/knowledge", label: "Knowledge", icon: "book", match: (p) => p.startsWith("/knowledge") },
  { to: "/templates", label: "Templates", icon: "file", match: (p) => p.startsWith("/templates") },
  { to: "/new", label: "New run", icon: "plus", match: (p) => p === "/new" },
];

/** Pages that lay themselves out edge to edge (toolbar + panels). */
const FLUSH = (p: string) => p === "/";

export function Layout({ runtime, authEnabled, children }: { runtime: string; authEnabled: boolean; children: ReactNode }) {
  const { path, search } = useLocation();
  const [online, setOnline] = useState(true);
  const { runs } = useRuns();
  useLive("*", (m) => {
    if (m.type === "connected") setOnline(true);
    if (m.type === "disconnected") setOnline(false);
  });
  const active = (runs ?? []).filter((r) => ACTIVE.includes(r.status));
  const selected = new URLSearchParams(search).get("run");

  return (
    <div className="shell">
      <aside className="side" aria-label="Navigation">
        <div className="brand">
          <span className="logo">
            <i />
          </span>
          Pixel
          <span className="ver">{runtime}</span>
        </div>
        {NAV.map((n) => (
          <Link key={n.to} to={n.to} className={`nav ${n.match(path) ? "on" : ""}`}>
            <Icon name={n.icon} />
            {n.label}
            {n.to === "/" && runs && <span className="count">{runs.length}</span>}
          </Link>
        ))}
        {active.length > 0 && (
          <>
            <div className="group">Active</div>
            {active.slice(0, 8).map((r) => (
              <Link key={r.id} to={`/?run=${encodeURIComponent(r.id)}`} className={`runlink ${selected === r.id ? "nav on" : ""}`} title={r.id}>
                <span className={`dot ${r.status}`} />
                {r.id}
              </Link>
            ))}
          </>
        )}
        {runs && runs.length > 0 && (
          <>
            <div className="group">Mesh</div>
            <Mesh runs={runs} />
          </>
        )}
        <div className="foot">
          <Link to="/system" className={`nav ${path === "/system" ? "on" : ""}`}>
            <Icon name="system" />
            System
          </Link>
          <Link to="/settings" className={`nav ${path === "/settings" ? "on" : ""}`}>
            <Icon name="settings" />
            Settings
          </Link>
          {authEnabled && (
            <button className="nav" style={{ border: 0, background: "none", cursor: "pointer", textAlign: "left" }} onClick={() => api.logout().then(() => location.reload())}>
              <Icon name="logout" />
              Log out
            </button>
          )}
          <div className="uplink">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
              <span className={`live-dot ${online ? "" : "off"}`} />
              {online ? "connected" : "reconnecting…"}
            </span>
            <br />
            host <b>{location.host}</b>
            <br />
            agents <b>{active.length}</b> · runtime <b>{runtime}</b>
          </div>
        </div>
      </aside>
      <main className={`page ${FLUSH(path) ? "flush" : ""}`}>{children}</main>
      <CommandPalette />
    </div>
  );
}
