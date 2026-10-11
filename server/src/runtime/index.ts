import { config } from "../config.ts";
import { IncusRuntime } from "./incus.ts";
import { LocalRuntime } from "./local.ts";
import { SingleRuntime } from "./single.ts";
import type { Runtime } from "./types.ts";

const runtimes = { incus: IncusRuntime, single: SingleRuntime, local: LocalRuntime };
const Impl = runtimes[config.runtime];
if (!Impl) throw new Error(`PIXEL_RUNTIME must be one of ${Object.keys(runtimes).join(", ")}, not ${config.runtime}`);

export const runtime: Runtime = new Impl();
