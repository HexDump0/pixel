/**
 * Snowflake Cortex: its REST API has no GET /models (404), so the model list comes from the SQL API
 * (`SHOW MODELS IN SNOWFLAKE.MODELS`), which takes the same programmatic access token (PAT).
 * Checked 2026-10-20: Claude models answer on /messages (Anthropic API, Bearer auth only; the 5.5
 * models nowhere else), the others on /chat/completions, where OpenAI models want max_completion_tokens.
 */

/** The account's host when a base URL points at Snowflake, else null. */
export function snowflakeHost(baseURL: string) {
  try {
    const h = new URL(baseURL).host;
    return h.endsWith(".snowflakecomputing.com") ? h : null;
  } catch {
    return null;
  }
}

/** An account identifier from what people paste: the identifier, the host, or the account URL. */
export const snowflakeAccount = (v: string) =>
  v
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\.snowflakecomputing\.com.*$/, "")
    .replace(/\/.*$/, "");

/** Cortex models that aren't chat models (embeddings, extraction, translation, guards). */
const NOT_CHAT = /embed|^e5-|^multilingual-e5|^arctic-(extract|parse|sentiment|transcribe|translate|text2sql)|^voyage-|^twelvelabs-|^llamaguard/;

/** Run one SQL statement with a PAT; returns the rows or throws with Snowflake's message. */
async function sql(host: string, token: string, statement: string) {
  const res = await fetch(`https://${host}/api/v2/statements`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ statement, timeout: 30 }),
    signal: AbortSignal.timeout(30_000),
  }).catch((e) => {
    throw new Error(`cannot reach ${host}: ${e.message}`);
  });
  const body: any = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body, message: String(body?.message ?? "").slice(0, 300) };
}

/** Chat models the account's Cortex lists, lowercased as the REST API wants them. */
export async function cortexModels(host: string, token: string) {
  if (!token) throw new Error("paste the PAT first; Snowflake lists models only to a signed-in account");
  const r = await sql(host, token, "SHOW MODELS IN SNOWFLAKE.MODELS");
  if (!r.ok) throw new Error(`Snowflake answered ${r.status}${r.message ? `: ${r.message}` : ""}`);
  const cols: string[] = (r.body?.resultSetMetaData?.rowType ?? []).map((c: any) => c.name);
  const at = cols.indexOf("name");
  const names: string[] = (r.body?.data ?? []).map((row: any[]) => String(row[at] ?? "").toLowerCase());
  return [...new Set(names.filter((n) => n && !NOT_CHAT.test(n)))].sort();
}

/** A free check that the PAT works for this account. */
export async function testCortexKey(host: string, token: string) {
  const r = await sql(host, token, "SHOW MODELS LIKE 'CLAUDE%' IN SNOWFLAKE.MODELS");
  return { ok: r.ok, status: r.status, body: r.ok ? "" : r.message };
}
