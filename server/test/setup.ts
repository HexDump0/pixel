/** Preloaded before every test file: isolated data dir, local runtime, fake opencode, fast watchdog. */
import { mkdtempSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const fake = join(import.meta.dir, "fake-opencode.ts");
chmodSync(fake, 0o755);

process.env.PIXEL_DATA = mkdtempSync(join(tmpdir(), "pixel-test-"));
process.env.PIXEL_RUNTIME = "local";
process.env.OPENCODE_BIN = fake;
process.env.PIXEL_WATCHDOG_MS = "300";
