/** /api/providers and /api/speedtests: provider health, the model leaderboard, and text-only speed tests. */
import { health, leaderboard, speedTests, speedTestStatus, startSpeedTest } from "../providers.ts";
import { get, post, readJson } from "./router.ts";

get("/providers/health", ({ query }) => health(Math.min(24 * 60, Math.max(5, Number(query.get("minutes") ?? 60)))));
get("/providers/leaderboard", () => leaderboard());
get("/speedtests", () => ({ ...speedTestStatus(), results: speedTests() }));
post("/speedtests", async ({ req }) => startSpeedTest((await readJson<{ models?: string[] }>(req)).models ?? []));
