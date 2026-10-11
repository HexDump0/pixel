import { config } from "../config.ts";
import { IncusRuntime } from "./incus.ts";
import { LocalRuntime } from "./local.ts";
import type { Runtime } from "./types.ts";

export const runtime: Runtime = config.runtime === "local" ? new LocalRuntime() : new IncusRuntime();
