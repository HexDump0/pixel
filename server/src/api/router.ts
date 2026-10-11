/** Minimal method + path router for the JSON API. Handlers return data (sent as JSON) or a Response, or throw. */

export type Params = Record<string, string>;
export type Handler = (ctx: { req: Request; params: Params; query: URLSearchParams }) => unknown | Promise<unknown>;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const routes: Route[] = [];

function compile(path: string) {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" +
      path.replace(/:(\w+)/g, (_, k) => {
        keys.push(k);
        return "([^/]+)";
      }) +
      "$",
  );
  return { pattern, keys };
}

const add = (method: string) => (path: string, handler: Handler) => routes.push({ method, handler, ...compile(path) });
export const get = add("GET");
export const post = add("POST");
export const put = add("PUT");
export const del = add("DELETE");

export async function readJson<T = any>(req: Request): Promise<T> {
  const text = await req.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

/** Dispatch a request whose path starts with /api. */
export async function dispatch(req: Request, url: URL): Promise<Response> {
  const path = url.pathname.slice("/api".length) || "/";
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.pattern.exec(path);
    if (!m) continue;
    const params: Params = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    try {
      const out = await r.handler({ req, params, query: url.searchParams });
      return out instanceof Response ? out : Response.json(out ?? { ok: true });
    } catch (e: any) {
      const status = e instanceof HttpError ? e.status : 400;
      if (!(e instanceof HttpError)) console.error(`${req.method} ${url.pathname}: ${e?.message}`);
      return Response.json({ error: e?.message ?? String(e) }, { status });
    }
  }
  return Response.json({ error: "not found" }, { status: 404 });
}
