/** /api/mcp/tokens: MCP access tokens for outside agents, managed on the Settings page (dashboard login). */
import { originOf } from "../findingShare.ts";
import { createMcpToken, listMcpTokens, revokeMcpToken, updateMcpToken } from "../mcpTokens.ts";
import { del, get, post, put, readJson } from "./router.ts";

get("/mcp/tokens", ({ req }) => ({ url: `${originOf(req)}/api/mcp`, tokens: listMcpTokens() }));
post("/mcp/tokens", async ({ req }) => createMcpToken(await readJson(req)));
put("/mcp/tokens/:id", async ({ req, params: { id } }) => updateMcpToken(id, await readJson(req)));
del("/mcp/tokens/:id", ({ params: { id } }) => revokeMcpToken(id));
