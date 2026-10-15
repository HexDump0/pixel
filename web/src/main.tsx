import { StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { api, setOnUnauthorized } from "./lib/api.ts";
import { queryClient } from "./lib/query.ts";
import { match, navigate, useLocation } from "./lib/router.tsx";
import { AppShell, PageBody } from "./components/AppShell.tsx";
import { Toasts } from "./components/Toast.tsx";
import { LoginPage } from "./pages/Login.tsx";
import { Wall } from "./pages/wall/Wall.tsx";
import { RunView } from "./pages/run/RunView.tsx";
import { FindingsPage } from "./pages/findings/FindingsPage.tsx";
import { NewRunPage } from "./pages/NewRun.tsx";
import { KnowledgePage } from "./pages/Knowledge.tsx";
import { TemplatesPage } from "./pages/Templates.tsx";
import { SettingsPage } from "./pages/Settings.tsx";
import { SystemPage } from "./pages/System.tsx";
import { ActivityPage } from "./pages/Activity.tsx";
import { ModelsPage } from "./pages/Models.tsx";
import { StatsPage } from "./pages/Stats.tsx";

function Routes() {
  const { path, search } = useLocation();
  const old = path === "/" && new URLSearchParams(search).get("run");
  useEffect(() => {
    // links from before the redesign: /?run=<id>
    if (old) navigate(`/runs/${encodeURIComponent(old)}`, true);
  }, [old]);
  let p: Record<string, string> | null;
  if (path === "/") return <Wall />;
  if ((p = match("/runs/:id", path))) return <RunView id={p.id} />;
  if (path === "/findings") return <FindingsPage />;
  let page: ReactNode = <div className="text-ink-3">Page not found.</div>;
  if (path === "/new") page = <NewRunPage />;
  else if (path === "/activity") page = <ActivityPage />;
  else if (path === "/models") page = <ModelsPage />;
  else if (path === "/knowledge") page = <KnowledgePage />;
  else if ((p = match("/templates/:id", path))) page = <TemplatesPage selected={p.id} />;
  else if (path === "/templates") page = <TemplatesPage />;
  else if (path === "/settings") page = <SettingsPage />;
  else if (path === "/system") page = <SystemPage />;
  else if (path === "/stats") page = <StatsPage />;
  return <PageBody>{page}</PageBody>;
}

function App() {
  const [me, setMe] = useState<{ authed: boolean; authEnabled: boolean; runtime: string } | null>(null);
  useEffect(() => {
    api.me().then(setMe, () => setMe({ authed: false, authEnabled: true, runtime: "?" }));
    setOnUnauthorized(() => setMe((m) => (m ? { ...m, authed: false } : m)));
  }, []);

  if (!me) return null;
  if (!me.authed) return <LoginPage onLogin={() => api.me().then(setMe)} />;
  return (
    <AppShell authEnabled={me.authEnabled}>
      <Routes />
    </AppShell>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <Toasts />
    </QueryClientProvider>
  </StrictMode>,
);
