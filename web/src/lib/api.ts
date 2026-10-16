/** Typed client for the Pixel API. */
import type {
  CrossReadEdge,
  FileContent,
  FileEntry,
  HistoryEntry,
  FleetSnapshot,
  Leaderboard,
  CatalogList,
  CatalogProvider,
  ConnectedProvider,
  PublicKey,
  ProcessInfo,
  PixelHealth,
  ProviderHealth,
  SpeedTestRow,
  Lanes,
  Message,
  RecentActivity,
  MetricRow,
  FeedEntry,
  Finding,
  FindingEvent,
  RunSeries,
  Verdict,
  Run,
  RunDetail,
  SearchHit,
  Settings,
  SystemInfo,
  Stats,
  Template,
  TemplateVersion,
  TimelineEntry,
  WorkbaseInfo,
} from "./types.ts";

export interface OfferedModel {
  model: string;
  provider: string;
  providerName: string;
  name: string;
  context: number | null;
  costIn: number | null;
  costOut: number | null;
  reasoning: boolean;
  connected: boolean;
}

export interface GithubInfo {
  tokenHint: string | null;
  mcp: boolean;
  toolsets: string;
  defaultToolsets: string;
  mcpUrl: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Called on 401 so the app can show the login page. */
export let onUnauthorized = () => {};
export const setOnUnauthorized = (fn: () => void) => (onUnauthorized = fn);

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, json.error ?? res.statusText);
  return json as T;
}

const q = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : "";
};
const r = (id: string) => `/runs/${encodeURIComponent(id)}`;

export interface CreateRunInput {
  repo: string;
  ref?: string;
  templateId: string;
  templateVersion?: number;
  model?: string;
  variant?: string;
  models?: string[];
  templateVersions?: number[];
  size?: string;
  parentRun?: string;
  autopilot?: boolean;
  promptOverride?: string;
  name?: string;
  keyId?: string;
  keyFailover?: boolean;
}

export interface RunKeys {
  provider: string;
  current: string | null;
  failover: boolean;
  next: string | null;
  keys: PublicKey[];
  costs: { key: string | null; name: string; cost: number }[];
}

export const api = {
  me: () => request<{ authed: boolean; authEnabled: boolean; runtime: string }>("GET", "/me"),
  login: (password: string) => request("POST", "/login", { password }),
  logout: () => request("POST", "/logout"),

  runs: () => request<Run[]>("GET", "/runs"),
  createRun: (input: CreateRunInput) => request<Run[]>("POST", "/runs", input),
  run: (id: string) => request<RunDetail>("GET", r(id)),
  transcript: (id: string, session?: string) => request<Message[]>("GET", `${r(id)}/transcript${q({ session })}`),
  timeline: (id: string) => request<TimelineEntry[]>("GET", `${r(id)}/timeline`),
  metrics: (id: string) => request<MetricRow[]>("GET", `${r(id)}/metrics`),
  runCrossReads: (id: string) => request<{ other_run: string; tool: string; path: string | null; ts: number }[]>("GET", `${r(id)}/crossreads`),
  report: (id: string) => request<{ content: string | null }>("GET", `${r(id)}/report`),
  findings: (o: { run?: string; untriaged?: boolean } = {}) => request<Finding[]>("GET", `/findings${q({ run: o.run, untriaged: o.untriaged ? 1 : undefined })}`),
  runFindings: (id: string) => request<Finding[]>("GET", `${r(id)}/findings`),
  findingLlm: (id: string, fid: string) => request<{ text: string; expires: number | null }>("GET", `${r(id)}/findings/${encodeURIComponent(fid)}/llm`),
  findingEvents: (id: string, finding?: string) => request<FindingEvent[]>("GET", `${r(id)}/findings/events${q({ finding })}`),
  allFindingEvents: (since?: number, limit = 200) => request<FindingEvent[]>("GET", `/findings/events${q({ since, limit })}`),
  setVerdict: (id: string, finding: string, verdict: Verdict | null, note?: string | null) => request<Finding>("POST", `${r(id)}/findings/${encodeURIComponent(finding)}/verdict`, { verdict, note }),
  feed: (limit = 50, since?: number) => request<FeedEntry[]>("GET", `/feed${q({ limit, since })}`),
  series: (id: string) => request<RunSeries>("GET", `${r(id)}/series`),
  vm: (id: string) => request<{ state: string; opencode: boolean }>("GET", `${r(id)}/vm`),
  processes: (id: string) => request<ProcessInfo[]>("GET", `${r(id)}/processes`),
  release: (id: string) => request<{ released: boolean }>("POST", `${r(id)}/release`),
  snapshots: (id: string) => request<{ name: string; created: string }[]>("GET", `${r(id)}/snapshots`),

  files: (id: string, path: string) => request<FileEntry[]>("GET", `${r(id)}/files${q({ path })}`),
  file: (id: string, path: string) => request<FileContent>("GET", `${r(id)}/file${q({ path })}`),
  rawFileUrl: (id: string, path: string) => `/api${r(id)}/raw${q({ path })}`,
  transcriptUrl: (id: string) => `/api${r(id)}/transcript.json`,
  saveFile: (id: string, path: string, content: string) => request("PUT", `${r(id)}/file${q({ path })}`, { content }),
  history: (id: string, path?: string) => request<HistoryEntry[]>("GET", `${r(id)}/history${q({ path })}`),
  snapshotHistory: (id: string) => request<{ commit: string | null }>("POST", `${r(id)}/history`),
  historyShow: (id: string, commit: string, path?: string) => request<{ patch: string }>("GET", `${r(id)}/history/${commit}${q({ path })}`),

  /** Simple POST controls: continue, abort, pause, stop, done, retry, restart-opencode, reset-counters, sync. */
  control: (id: string, action: string, body: unknown = {}) => request("POST", `${r(id)}/${action}`, body),
  message: (id: string, text: string) => request("POST", `${r(id)}/message`, { text }),
  resume: (id: string, message?: string) => request("POST", `${r(id)}/resume`, { message }),
  setModel: (id: string, model: string, variant?: string | null) => request("POST", `${r(id)}/model`, { model, variant }),
  setAutopilot: (id: string, on: boolean) => request("POST", `${r(id)}/autopilot`, { on }),
  setLabel: (id: string, label: string) => request("POST", `${r(id)}/label`, { label }),
  vmAction: (id: string, action: "start" | "stop" | "snapshot" | "restore", snapshot?: string) => request("POST", `${r(id)}/vm/${action}`, { snapshot }),
  deleteVm: (id: string) => request("DELETE", `${r(id)}/vm`),
  answer: (id: string, qid: string, answers: string[][] | null) => request("POST", `${r(id)}/question/${qid}`, answers ? { answers } : { reject: true }),
  triage: (id: string, body: { notes?: string | null; markTriaged?: boolean; keepVm?: boolean }) => request("POST", `${r(id)}/triage`, body),
  rerun: (id: string, body: { asFollowUp?: boolean; model?: string; templateVersion?: number }) => request<Run>("POST", `${r(id)}/rerun`, body),
  deleteRun: (id: string, workbase: boolean) => request("DELETE", `${r(id)}${q({ workbase: workbase ? 1 : undefined })}`),

  templates: () => request<Template[]>("GET", "/templates"),
  template: (id: string) => request<{ versions: TemplateVersion[]; variables: string[]; parts: { name: string; body: string }[] }>("GET", `/templates/${encodeURIComponent(id)}`),
  createTemplate: (t: { id: string; name?: string; body: string; note?: string }) => request<TemplateVersion>("POST", "/templates", t),
  addTemplateVersion: (id: string, body: string, note?: string) => request<TemplateVersion>("POST", `/templates/${encodeURIComponent(id)}/versions`, { body, note }),
  preview: (input: { body: string; repo?: string; ref?: string; model?: string; size?: string; parentRun?: string; name?: string }) =>
    request<{ prompt: string }>("POST", "/templates/preview", input),

  search: (query: string) => request<SearchHit[]>("GET", `/search${q({ q: query })}`),
  crossReads: () => request<CrossReadEdge[]>("GET", "/crossreads"),
  workbases: () => request<WorkbaseInfo[]>("GET", "/workbases"),
  workbaseIndex: () => request<{ content: string }>("GET", "/workbases/index"),

  settings: () => request<Settings & { defaults: Settings }>("GET", "/settings"),
  saveSettings: (patch: Partial<Settings>) => request<Settings & { defaults: Settings }>("PUT", "/settings", patch),
  github: () => request<GithubInfo>("GET", "/github"),
  saveGithub: (body: { token?: string; mcp?: boolean; toolsets?: string }) => request<GithubInfo>("PUT", "/github", body),
  checkGithub: () =>
    request<{ login: string; kind: string; scopes: string[] | null; writeScopes: string[]; rateLimit: number | null; rateRemaining: number | null }>("POST", "/github/check"),
  testNotify: () => request<{ results: string[] }>("POST", "/settings/test-notify"),
  system: () => request<SystemInfo>("GET", "/system"),
  stats: (days = 7) => request<Stats>("GET", `/stats${q({ days, tz: -new Date().getTimezoneOffset() })}`),
  fleet: () => request<FleetSnapshot>("GET", "/fleet"),
  lanes: (id: string, minutes = 20) => request<Lanes>("GET", `${r(id)}/lanes${q({ minutes })}`),
  providerHealth: (minutes = 60) => request<ProviderHealth>("GET", `/providers/health${q({ minutes })}`),
  leaderboard: () => request<Leaderboard>("GET", "/providers/leaderboard"),
  speedTests: () => request<{ running: string | null; models: string[]; current: string | null; results: SpeedTestRow[] }>("GET", "/speedtests"),
  startSpeedTest: (models: string[]) => request<{ batch: string; models: string[] }>("POST", "/speedtests", { models }),
  providers: () => request<ConnectedProvider[]>("GET", "/providers"),
  saveProvider: (id: string, body: { name?: string; key?: string; noKey?: boolean; baseURL?: string; custom?: { api?: "openai" | "anthropic"; models: string[]; context?: number; reasoning?: boolean } }) =>
    request<{ id: string }>("PUT", `/providers/${encodeURIComponent(id)}`, body),
  removeProvider: (id: string) => request("DELETE", `/providers/${encodeURIComponent(id)}`),
  keyUsage: (id: string) => request<{ runs: Record<string, number>; callsPerHour: Record<string, number> }>("GET", `/providers/${encodeURIComponent(id)}/keys/usage`),
  addKey: (id: string, body: { name?: string; key: string; note?: string }) => request<PublicKey>("POST", `/providers/${encodeURIComponent(id)}/keys`, body),
  editKey: (id: string, key: string, body: { name?: string; key?: string; note?: string }) => request<PublicKey>("PUT", `/providers/${encodeURIComponent(id)}/keys/${encodeURIComponent(key)}`, body),
  removeKey: (id: string, key: string) => request<{ moved: string[] }>("DELETE", `/providers/${encodeURIComponent(id)}/keys/${encodeURIComponent(key)}`),
  orderKeys: (id: string, ids: string[]) => request("PUT", `/providers/${encodeURIComponent(id)}/keys-order`, { ids }),
  testKey: (id: string, key: string) => request<{ ok: boolean; status: number; message: string }>("POST", `/providers/${encodeURIComponent(id)}/keys/${encodeURIComponent(key)}/test`),
  runKeys: (id: string) => request<RunKeys>("GET", `${r(id)}/keys`),
  setRunKey: (id: string, keyId: string | null) => request("POST", `${r(id)}/key`, { keyId }),
  setFailover: (id: string, on: boolean) => request("POST", `${r(id)}/failover`, { on }),
  discoverModels: (body: { baseURL: string; key?: string; id?: string; api?: "openai" | "anthropic" }) => request<{ models: string[] }>("POST", "/providers/discover", body),
  catalog: (refresh = false) => request<CatalogList>("GET", `/catalog${q({ refresh: refresh ? 1 : undefined })}`),
  catalogProvider: (id: string) => request<CatalogProvider>("GET", `/catalog/${encodeURIComponent(id)}`),
  livePrompt: (body: { model: string; variant?: string; text: string; session?: string; turn: string; key?: string }) => request<{ session: string; turn: string }>("POST", "/live", body),
  liveAbort: (session: string) => request("POST", `/live/${encodeURIComponent(session)}/abort`),
  models: () => request<{ defaultModel: string; models: OfferedModel[] }>("GET", "/models"),
  modelVariants: () => request<Record<string, string[]>>("GET", "/models/variants"),
  activity: (run?: string, limit = 200) => request<RecentActivity>("GET", `/activity${q({ run, limit })}`),
  backup: () => request<{ ok: boolean; output: string }>("POST", "/backup"),
  compactDb: () => request<{ before: number; after: number; ms: number }>("POST", "/system/compact"),
  health: () => request<PixelHealth>("GET", "/system/health"),
};
