import { useState, type ReactNode } from "react";
import { Link, useLocation } from "../lib/router.tsx";
import { useLive } from "../lib/live.ts";
import { api } from "../lib/api.ts";
import { cx } from "./ui.tsx";

const NAV = [
  { to: "/", label: "Runs", match: (p: string) => p === "/" || p.startsWith("/runs") },
  { to: "/new", label: "New run", match: (p: string) => p === "/new" },
  { to: "/knowledge", label: "Knowledge", match: (p: string) => p.startsWith("/knowledge") },
  { to: "/templates", label: "Templates", match: (p: string) => p.startsWith("/templates") },
  { to: "/settings", label: "Settings", match: (p: string) => p === "/settings" },
  { to: "/system", label: "System", match: (p: string) => p === "/system" },
];

export function Layout({ runtime, authEnabled, children }: { runtime: string; authEnabled: boolean; children: ReactNode }) {
  const { path } = useLocation();
  const [online, setOnline] = useState(true);
  useLive("*", (m) => {
    if (m.type === "connected") setOnline(true);
    if (m.type === "disconnected") setOnline(false);
  });

  return (
    <div className="grid min-h-screen grid-cols-1 md:grid-cols-[200px_1fr]">
      <nav className="flex flex-row flex-wrap gap-0.5 border-b border-zinc-200 bg-white p-2.5 md:sticky md:top-0 md:h-screen md:flex-col md:border-r md:border-b-0 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="px-2.5 pt-1 pb-3 text-lg font-bold tracking-wide">
          pi<span className="text-accent">x</span>el
        </div>
        {NAV.map((n) => (
          <Link
            key={n.to}
            to={n.to}
            className={cx(
              "rounded-md px-2.5 py-1.5 text-sm text-zinc-800 hover:bg-zinc-100 hover:no-underline dark:text-zinc-200 dark:hover:bg-zinc-800",
              n.match(path) && "bg-zinc-100 text-accent dark:bg-zinc-800 dark:text-accent",
            )}
          >
            {n.label}
          </Link>
        ))}
        <div className="mt-auto hidden flex-col gap-1 px-2.5 text-xs muted md:flex">
          <span className="flex items-center gap-1.5">
            <span className={cx("inline-block size-2 rounded-full", online ? "bg-emerald-500" : "bg-red-500")} />
            {online ? "live" : "reconnecting…"}
          </span>
          <span>runtime: {runtime}</span>
          {authEnabled && (
            <button className="cursor-pointer text-left hover:underline" onClick={() => api.logout().then(() => location.reload())}>
              Log out
            </button>
          )}
        </div>
      </nav>
      <main className="min-w-0 px-4 py-4 md:px-6">{children}</main>
    </div>
  );
}
