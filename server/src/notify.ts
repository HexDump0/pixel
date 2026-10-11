import { getSettings } from "./settings.ts";

export type NotifyKind = "done" | "stopped" | "question" | "failed";

export async function notify(kind: NotifyKind | "test", title: string, body: string, link?: string) {
  const s = getSettings().notify;
  if (kind !== "test" && !s.on[kind]) return;
  const jobs: Promise<unknown>[] = [];
  if (s.ntfyUrl) {
    jobs.push(
      fetch(s.ntfyUrl, {
        method: "POST",
        headers: {
          Title: title.replace(/[^\x20-\x7e]/g, ""),
          Tags: { done: "white_check_mark", stopped: "warning", question: "question", failed: "x", test: "bell" }[kind],
          Priority: kind === "question" || kind === "failed" ? "high" : "default",
          ...(link ? { Click: link } : {}),
        },
        body,
      }),
    );
  }
  if (s.telegramToken && s.telegramChat) {
    jobs.push(
      fetch(`https://api.telegram.org/bot${s.telegramToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: s.telegramChat, text: `${title}\n\n${body}${link ? `\n${link}` : ""}`, disable_web_page_preview: true }),
      }),
    );
  }
  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === "rejected") console.error("notification failed:", r.reason);
  return results.map((r) => r.status);
}
