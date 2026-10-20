/** The chrome around every page: a sticky top bar (brand, pages, search, catch-up, theme, New run). No sidebar. */
import { useEffect, useState, type ReactNode } from "react";
import { IconHistory, IconMoon, IconPlus, IconSearch, IconSun, IconCommand } from "@tabler/icons-react";
import { Link, useLocation } from "../lib/router.tsx";
import { useLive } from "../lib/live.ts";
import { useRuns } from "../lib/runs.ts";
import { useFleet } from "../lib/fleet.ts";
import { useFindings, isOpen } from "../lib/findings.ts";
import { health, needsYou, useLimits } from "../lib/health.ts";
import { applyTheme, usePref } from "../lib/prefs.ts";
import { cn } from "../lib/cn.ts";
import { BrandMark, IC_SM, Kbd } from "./ui/bits.tsx";
import { Button, buttonClass } from "./ui.tsx";
import { TipProvider } from "./ui/overlay.tsx";
import { CommandPalette, openPalette } from "./CommandPalette.tsx";
import { CatchUp, onOpenCatchUp, useCatchUp } from "./CatchUp.tsx";
import { ModelDialogHost } from "./RunMenu.tsx";
import { SizeDialogHost } from "./MachineSize.tsx";

const NAV: { to: string; label: string; match: (p: string) => boolean }[] = [
  { to: "/", label: "Runs", match: (p) => p === "/" || p.startsWith("/runs") },
  { to: "/findings", label: "Findings", match: (p) => p === "/findings" },
  { to: "/activity", label: "Activity", match: (p) => p === "/activity" },
  { to: "/models", label: "Models", match: (p) => p === "/models" },
  { to: "/stats", label: "Stats", match: (p) => p === "/stats" || p.startsWith("/stats/") },
  { to: "/knowledge", label: "Knowledge", match: (p) => p.startsWith("/knowledge") },
  { to: "/templates", label: "Templates", match: (p) => p.startsWith("/templates") },
  { to: "/system", label: "System", match: (p) => p === "/system" },
  { to: "/settings", label: "Settings", match: (p) => p === "/settings" },
];

export function AppShell({ authEnabled, children }: { authEnabled: boolean; children: ReactNode }) {
  const { path } = useLocation();
  const [online, setOnline] = useState(true);
  const { runs } = useRuns();
  const fleet = useFleet();
  const findings = useFindings();
  const limits = useLimits();
  const [theme, setTheme] = usePref<"dark" | "light">("theme", "dark");
  const [catchUpOpen, setCatchUpOpen] = useState(false);
  const catchUp = useCatchUp();
  useEffect(() => onOpenCatchUp(() => setCatchUpOpen(true)), []);
  useLive("*", (m) => {
    if (m.type === "connected") setOnline(true);
    if (m.type === "disconnected") setOnline(false);
  });

  const needs = (runs ?? []).filter((r) => needsYou(health(r, fleet?.runs.find((f) => f.id === r.id), limits))).length;
  const untriaged = (findings ?? []).filter(isOpen).length;

  return (
    <TipProvider>
      <header className="gut sticky top-0 z-30 flex h-[60px] items-center gap-7 bg-bg/85 backdrop-blur-md max-md:h-auto max-md:flex-wrap max-md:gap-2.5 max-md:py-2.5">
        <Link to="/" className="flex shrink-0 items-center gap-2.5 text-[15px] font-semibold tracking-[-0.01em] text-ink no-underline hover:no-underline">
          <BrandMark />
          Pixel
        </Link>
        <nav aria-label="Pages" className="flex min-w-0 gap-0.5 overflow-x-auto [scrollbar-width:none] max-md:order-3 max-md:w-full">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              aria-current={n.match(path) ? "page" : undefined}
              className="inline-flex h-8 items-center gap-[7px] rounded-lg px-[11px] text-[13.5px] font-[450] whitespace-nowrap text-ink-3 no-underline hover:text-ink hover:no-underline aria-[current=page]:bg-s2 aria-[current=page]:text-ink"
            >
              {n.label}
              {n.to === "/" && needs > 0 && (
                <span title={`${needs} need${needs === 1 ? "s" : ""} you`} className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-warning px-[5px] font-mono text-[11.5px] font-medium text-on-warning">
                  {needs}
                </span>
              )}
              {n.to === "/findings" && untriaged > 0 && <span className="font-mono text-[11.5px] text-ink-3">{untriaged}</span>}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {!online && (
            <span className="mr-2 inline-flex items-center gap-[7px] text-[12.5px] text-warning">
              <span className="size-1.5 rounded-full bg-warning" />
              Reconnecting
            </span>
          )}
          <button
            type="button"
            onClick={() => openPalette()}
            aria-label="Search and commands"
            className="flex h-[34px] w-[200px] items-center gap-2 rounded-lg border border-line-2 bg-s1 pr-2 pl-2.5 text-left text-ink-3 hover:border-line hover:text-ink-2 max-xl:w-[34px] max-xl:justify-center max-xl:p-0"
          >
            <IconSearch {...IC_SM} />
            <span className="flex-1 max-xl:hidden">Search</span>
            <Kbd className="max-xl:hidden">
              <IconCommand size={12} stroke={2} />
            </Kbd>
            <Kbd className="max-xl:hidden">K</Kbd>
          </button>
          <Button variant="ghost" icon aria-label="Since you last looked" title="Since you last looked" className={cn(catchUp.count > 0 && "relative after:absolute after:top-1.5 after:right-1.5 after:size-1.5 after:rounded-full after:bg-accent after:ring-2 after:ring-bg")} onClick={() => setCatchUpOpen(true)}>
            <IconHistory {...IC_SM} />
          </Button>
          <Button
            variant="ghost"
            icon
            aria-label="Switch light or dark"
            title="Light or dark"
            onClick={() => {
              const next = theme === "light" ? "dark" : "light";
              setTheme(next);
              applyTheme(next);
            }}
          >
            {theme === "light" ? <IconMoon {...IC_SM} /> : <IconSun {...IC_SM} />}
          </Button>
          <Link to="/new" className={buttonClass("primary")}>
            <IconPlus {...IC_SM} />
            New run
          </Link>
        </div>
      </header>
      {children}
      <CommandPalette authEnabled={authEnabled} />
      <CatchUp open={catchUpOpen} onOpenChange={setCatchUpOpen} data={catchUp} />
      <ModelDialogHost runs={runs ?? []} />
      <SizeDialogHost runs={runs ?? []} />
    </TipProvider>
  );
}

/** Pages that keep their own layout get the gutter and a little top room. */
export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <main className={cn("gut pt-2 pb-16", className)}>{children}</main>;
}
