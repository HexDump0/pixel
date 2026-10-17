/**
 * Access tokens for the MCP endpoint. Made, listed and revoked on the Settings page; each has a name,
 * an access level (read: look only; full: also control runs and call any API route) and an optional
 * expiry. The token is shown once when made; Pixel keeps only its sha256. They open /api/mcp and
 * nothing else: not the dashboard, not the rest of the API.
 */
import { createHash, randomBytes } from "node:crypto";
import { db } from "./db.ts";

export type McpAccess = "read" | "full";
export const ACCESS: McpAccess[] = ["read", "full"];

export interface McpTokenRow {
  id: string;
  name: string;
  hash: string;
  hint: string;
  access: McpAccess;
  created: number;
  expires: number | null;
  used_at: number | null;
  used_tool: string | null;
  uses: number;
}
export type PublicMcpToken = Omit<McpTokenRow, "hash">;

const DAY = 24 * 3_600_000;
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
const pub = ({ hash, ...rest }: McpTokenRow): PublicMcpToken => rest;

export const listMcpTokens = () => db.query<McpTokenRow, []>("SELECT * FROM mcp_tokens ORDER BY created DESC").all().map(pub);

export function createMcpToken(input: { name?: string; access?: string; days?: number | null }, now = Date.now()) {
  const name = String(input.name ?? "").trim().slice(0, 80);
  if (!name) throw new Error("give the token a name");
  if (!ACCESS.includes(input.access as McpAccess)) throw new Error("access must be read or full");
  const days = input.days ? Math.round(Number(input.days)) : null;
  if (days !== null && !(days > 0 && days <= 3650)) throw new Error("expiry must be 1 to 3650 days, or never");
  const token = "pxm_" + randomBytes(32).toString("base64url");
  const id = randomBytes(6).toString("hex");
  db.query("INSERT INTO mcp_tokens (id, name, hash, hint, access, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    id,
    name,
    hashOf(token),
    token.slice(-4),
    input.access as McpAccess,
    now,
    days ? now + days * DAY : null,
  );
  return { token, info: pub(db.query<McpTokenRow, [string]>("SELECT * FROM mcp_tokens WHERE id = ?").get(id)!) };
}

export function updateMcpToken(id: string, input: { name?: string; access?: string }) {
  if (!db.query("SELECT 1 FROM mcp_tokens WHERE id = ?").get(id)) throw new Error("no such token");
  if (input.name !== undefined) {
    const name = String(input.name).trim().slice(0, 80);
    if (!name) throw new Error("give the token a name");
    db.query("UPDATE mcp_tokens SET name = ? WHERE id = ?").run(name, id);
  }
  if (input.access !== undefined) {
    if (!ACCESS.includes(input.access as McpAccess)) throw new Error("access must be read or full");
    db.query("UPDATE mcp_tokens SET access = ? WHERE id = ?").run(input.access, id);
  }
  return pub(db.query<McpTokenRow, [string]>("SELECT * FROM mcp_tokens WHERE id = ?").get(id)!);
}

export function revokeMcpToken(id: string) {
  return { removed: db.query("DELETE FROM mcp_tokens WHERE id = ?").run(id).changes > 0 };
}

/** The token a request carries (Authorization: Bearer pxm_...), if it is known and not expired. */
export function mcpTokenOf(req: Request, now = Date.now()) {
  const token = /^Bearer (pxm_[\w-]+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!token) return null;
  const row = db.query<McpTokenRow, [string]>("SELECT * FROM mcp_tokens WHERE hash = ?").get(hashOf(token));
  if (!row || (row.expires && row.expires < now)) return null;
  return pub(row);
}

/** Note a tool call on the token, for "last used" in Settings. */
export function markUsed(id: string, tool: string | null, now = Date.now()) {
  db.query("UPDATE mcp_tokens SET used_at = ?, used_tool = COALESCE(?, used_tool), uses = uses + (? IS NOT NULL) WHERE id = ?").run(now, tool, tool, id);
}
