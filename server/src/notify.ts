import { db } from "./db.ts";
import { getSettings } from "./settings.ts";

export type NotifyKind = "done" | "stopped" | "question" | "failed" | "deadline";
export type Channel = "ntfy" | "telegram";
export interface Sent {
  channel: Channel;
  ok: boolean;
  error?: string;
}
/** The last notification each channel sent (or failed to), kept for the Settings page. */
export type NotifyStatus = Partial<Record<Channel, { ts: number; kind: NotifyKind | "test"; title: string; ok: boolean; error?: string }>>;

export function notifyStatus(): NotifyStatus {
  const row = db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = '_lastNotify'").get();
  return row ? JSON.parse(row.value) : {};
}

/** POST and treat a non-2xx answer as a failure (fetch only rejects on network errors). */
async function send(channel: Channel, url: string, init: RequestInit): Promise<Sent> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    if (res.ok) return { channel, ok: true };
    const text = (await res.text().catch(() => "")).slice(0, 300);
    let message = text;
    try {
      message = JSON.parse(text).description ?? JSON.parse(text).error ?? text; // Telegram: description, ntfy: error
    } catch {}
    return { channel, ok: false, error: `HTTP ${res.status}${message ? `: ${message}` : ""}` };
  } catch (e: any) {
    return { channel, ok: false, error: e?.message ?? String(e) };
  }
}

export async function notify(kind: NotifyKind | "test", title: string, body: string, link?: string): Promise<Sent[]> {
  const s = getSettings().notify;
  if (kind !== "test" && !s.on[kind]) return [];
  const jobs: Promise<Sent>[] = [];
  if (s.ntfyUrl) {
    jobs.push(
      send("ntfy", s.ntfyUrl, {
        method: "POST",
        headers: {
          Title: title.replace(/[^\x20-\x7e]/g, ""),
          Tags: { done: "white_check_mark", stopped: "warning", question: "question", failed: "x", deadline: "hourglass", test: "bell" }[kind],
          Priority: kind === "question" || kind === "failed" || kind === "deadline" ? "high" : "default",
          ...(link ? { Click: link } : {}),
        },
        body,
      }),
    );
  }
  if (s.telegramToken && s.telegramChat) {
    jobs.push(
      send("telegram", `https://api.telegram.org/bot${s.telegramToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: s.telegramChat, text: `${title}\n\n${body}${link ? `\n${link}` : ""}`, disable_web_page_preview: true }),
      }),
    );
  }
  const results = await Promise.all(jobs);
  if (!results.length) return results;
  for (const r of results) if (!r.ok) console.error(`notification via ${r.channel} failed:`, r.error);
  const status = notifyStatus();
  for (const r of results) status[r.channel] = { ts: Date.now(), kind, title, ok: r.ok, ...(r.error && { error: r.error }) };
  db.query("INSERT INTO settings (key, value) VALUES ('_lastNotify', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(status));
  return results;
}
