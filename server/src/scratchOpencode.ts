/**
 * A throwaway `opencode serve` for testing models (speed test, live test): an empty work folder,
 * only PATH/HOME/LANG/XDG plus the agents' provider credentials, and `permission: "ask"` so the
 * caller can refuse every tool call. The tools stay in the request: opencode's own gateways (Zen,
 * Go) refuse requests whose tool set differs from opencode's.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { OpencodeClient } from "./opencode.ts";
import { agentCredentials } from "./providerAccounts.ts";

export interface ScratchOpencode {
  client: OpencodeClient;
  /** The credentials it was started with, to notice when Settings or providers change. */
  creds: string;
  /** Is provider/model in this opencode's catalogue? An unknown model gets a bare 500 otherwise. */
  check(model: string): Promise<string | null>;
  /** The providers and models this opencode can use (with each model's variants = thinking levels). */
  providers(): Promise<Catalogue | null>;
  stop(): Promise<void>;
}

/** Model tests answer in text only, so skip the agents' MCP servers (and their start-up time and tool definitions). */
function withoutMcp(env: Record<string, string>) {
  if (!env.OPENCODE_CONFIG_CONTENT) return env;
  try {
    const { mcp, ...rest } = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    return { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(rest) };
  } catch {
    return env;
  }
}

type Catalogue = { providers: { id: string; models: Record<string, { variants?: Record<string, unknown> }> }[] };

const freePort = () => {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  return p;
};

export async function startScratchOpencode(kind: string): Promise<ScratchOpencode> {
  const creds = agentCredentials();
  const env = withoutMcp(creds.env);
  mkdirSync(join(config.dataDir, kind), { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(config.dataDir, kind, "run-"));
  const xdg = { XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data"), XDG_STATE_HOME: join(dir, "state"), XDG_CACHE_HOME: join(dir, "cache") };
  mkdirSync(join(xdg.XDG_CONFIG_HOME, "opencode"), { recursive: true });
  // Same plugins as the agents, so tests see the requests agents send.
  const plugins = join(xdg.XDG_CONFIG_HOME, "opencode", "plugin");
  mkdirSync(plugins, { recursive: true });
  for (const f of readdirSync(config.opencodePluginsDir).filter((f) => f.endsWith(".ts"))) copyFileSync(join(config.opencodePluginsDir, f), join(plugins, f));
  writeFileSync(join(xdg.XDG_CONFIG_HOME, "opencode", "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", autoupdate: false, share: "disabled", permission: "ask" }));
  if (creds.authJson.trim()) {
    mkdirSync(join(xdg.XDG_DATA_HOME, "opencode"), { recursive: true });
    writeFileSync(join(xdg.XDG_DATA_HOME, "opencode", "auth.json"), creds.authJson, { mode: 0o600 });
  }
  const work = join(dir, "work");
  mkdirSync(work);
  const password = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url");
  const port = freePort();
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([config.opencodeBin, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: work,
      // Only what opencode needs plus the provider credentials; none of Pixel's own environment.
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: dir, LANG: "C.UTF-8", ...xdg, ...env, OPENCODE_SERVER_PASSWORD: password },
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch (e: any) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`cannot start opencode (${config.opencodeBin}): ${e.message}`);
  }

  const stop = async () => {
    // opencode serve can ignore SIGTERM (seen with 1.18.23), so don't wait on it for long.
    proc.kill();
    if ((await Promise.race([proc.exited.then(() => true), Bun.sleep(5000).then(() => false)])) === false) {
      proc.kill("SIGKILL");
      await proc.exited;
    }
    rmSync(dir, { recursive: true, force: true });
  };

  const client = new OpencodeClient(`http://127.0.0.1:${port}`, password, work);
  try {
    await client.waitHealthy(30_000);
  } catch (e: any) {
    await stop();
    throw new Error(`opencode did not start: ${e.message}`);
  }

  let catalogue: Catalogue | null | undefined;
  const providers = async () => (catalogue ??= await client.req<Catalogue>("GET", "/config/providers").catch(() => null));
  const check = async (model: string) => {
    await providers();
    if (!catalogue?.providers) return null;
    const [providerID, ...rest] = model.split("/");
    const p = catalogue.providers.find((x) => x.id === providerID);
    if (!p) return `provider ${providerID} not configured (add it under Models → Providers)`;
    return rest.join("/") in (p.models ?? {}) ? null : `unknown model for ${providerID}`;
  };

  return { client, creds: JSON.stringify(creds), check, providers, stop };
}
