import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, setOnUnauthorized } from "./lib/api.ts";
import { match, useLocation } from "./lib/router.tsx";
import { Layout } from "./components/Layout.tsx";
import { Toasts } from "./components/Toast.tsx";
import { LoginPage } from "./pages/Login.tsx";
import { RunsPage } from "./pages/Runs.tsx";
import { NewRunPage } from "./pages/NewRun.tsx";
import { RunPage } from "./pages/run/RunPage.tsx";
import { KnowledgePage } from "./pages/Knowledge.tsx";
import { TemplatesPage } from "./pages/Templates.tsx";
import { SettingsPage } from "./pages/Settings.tsx";
import { SystemPage } from "./pages/System.tsx";
import { ActivityPage } from "./pages/Activity.tsx";
import { ModelsPage } from "./pages/Models.tsx";

function Routes() {
  const { path } = useLocation();
  let p: Record<string, string> | null;
  if (path === "/") return <RunsPage />;
  if (path === "/new") return <NewRunPage />;
  if ((p = match("/runs/:id", path))) return <RunPage key={p.id} id={p.id} />;
  if (path === "/activity") return <ActivityPage />;
  if (path === "/models") return <ModelsPage />;
  if (path === "/knowledge") return <KnowledgePage />;
  if ((p = match("/templates/:id", path))) return <TemplatesPage selected={p.id} />;
  if (path === "/templates") return <TemplatesPage />;
  if (path === "/settings") return <SettingsPage />;
  if (path === "/system") return <SystemPage />;
  return <div className="muted">Page not found.</div>;
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
    <Layout runtime={me.runtime} authEnabled={me.authEnabled}>
      <Routes />
    </Layout>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <Toasts />
  </StrictMode>,
);
