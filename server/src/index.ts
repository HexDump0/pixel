/** Pixel server entry: dashboard, API, websockets and the background loops. */
import { config } from "./config.ts";
import { listRuns, ACTIVE_STATUSES } from "./db.ts";
import { getSettings } from "./settings.ts";
import { dispatch } from "./api/index.ts";
import { authEnabled, isAuthed, login, logoutCookie } from "./auth.ts";
import { feedCount, feedData, terminalData, websocket, type SocketData } from "./live.ts";
import { reattach, startWatchdog, stopWatchdog } from "./runs/index.ts";
import { seedTemplates } from "./templates.ts";
import { snapshotWorkbase } from "./history.ts";
import { writeIndex } from "./knowledge.ts";
import { startBackupSchedule } from "./backup.ts";
import { startRelay } from "./relay.ts";
import { runtime } from "./runtime/index.ts";
import { startFleet, stopFleet } from "./fleet.ts";
import { startArchiving } from "./archive.ts";
import { startHealth } from "./health.ts";
import { startFindingsWatch, stopFindingsWatch } from "./findings.ts";
import { serveShare } from "./findingShare.ts";
import dashboard from "../../web/index.html";
import { liveShutdown } from "./liveTest.ts";
import { serveMcp } from "./mcp.ts";

/** Client-side routes of the dashboard SPA. */
const SPA_ROUTES = ["/", "/runs/*", "/new", "/activity", "/models", "/knowledge", "/templates", "/templates/*", "/settings", "/system", "/stats", "/findings", "/login"];

async function handleAuth(req: Request, url: URL): Promise<Response | null> {
  switch (url.pathname) {
    case "/api/login": {
      if (req.method !== "POST") return null;
      const { password } = await req.json().catch(() => ({}) as any);
      const cookie = login(String(password ?? ""));
      if (!cookie) return Response.json({ error: "wrong password" }, { status: 401 });
      return Response.json({ ok: true }, { headers: { "set-cookie": cookie } });
    }
    case "/api/logout":
      return Response.json({ ok: true }, { headers: { "set-cookie": logoutCookie } });
    case "/api/me":
      return Response.json({ authed: isAuthed(req), authEnabled: authEnabled(), runtime: runtime.kind });
  }
  return null;
}

const server = Bun.serve<SocketData>({
  hostname: config.host,
  port: config.port,
  idleTimeout: 120,
  development: config.dev ? { hmr: true, console: false } : false,
  routes: Object.fromEntries(SPA_ROUTES.map((r) => [r, dashboard])),
  async fetch(req, server) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });
    const auth = await handleAuth(req, url);
    if (auth) return auth;
    if (req.method === "GET" && url.pathname.startsWith("/api/share/")) return serveShare(req, url.pathname);
    if (!isAuthed(req)) return Response.json({ error: "login required" }, { status: 401 });

    if (url.pathname === "/api/mcp") return serveMcp(req);
    if (url.pathname === "/api/ws") {
      return server.upgrade(req, { data: feedData() }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    const term = /^\/api\/runs\/([^/]+)\/terminal$/.exec(url.pathname);
    if (term) {
      return server.upgrade(req, { data: terminalData(decodeURIComponent(term[1])) }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    return dispatch(req, url);
  },
  websocket,
});

// ---- background work ----

seedTemplates();
writeIndex();
if (config.detached) console.warn("PIXEL_DETACHED=1: runs are not reattached, watched or recovered");
else {
  await reattach();
  startWatchdog();
}
startFleet();
startFindingsWatch();
startArchiving();
startHealth(feedCount);
startBackupSchedule();
startRelay();


/** Git snapshots of active workbases every `historyIntervalMin`. */
let lastHistory = 0;
setInterval(async () => {
  const every = getSettings().historyIntervalMin * 60_000;
  if (every <= 0 || Date.now() - lastHistory < every) return;
  lastHistory = Date.now();
  for (const r of listRuns().filter((r) => ACTIVE_STATUSES.includes(r.status))) {
    await snapshotWorkbase(r.id).catch((e) => console.error(`history snapshot ${r.id}`, e));
  }
}, 30_000);

if (!authEnabled()) console.warn("PIXEL_PASSWORD is not set: the dashboard has no login. Only do this on a trusted machine.");
console.log(`Pixel (${runtime.kind} runtime) listening on http://${server.hostname}:${server.port}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopWatchdog();
    stopFleet();
    stopFindingsWatch();
    server.stop();
    // Don't leave the live test's opencode running; give it a few seconds at most.
    void Promise.race([liveShutdown(), Bun.sleep(6000)]).finally(() => process.exit(0));
  });
}
