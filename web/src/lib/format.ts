/** Display formatting helpers. */

export function bytes(n: number | null | undefined) {
  if (n == null) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function duration(ms: number | null | undefined) {
  if (ms == null || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export const ago = (ts: number | null | undefined) => (ts ? `${duration(Date.now() - ts)} ago` : "");

export const dateTime = (ts: number | null | undefined) => (ts ? new Date(ts).toLocaleString() : "");

export const time = (ts: number) => new Date(ts).toLocaleTimeString();

export function tokens(n: number | null | undefined) {
  if (n == null) return "";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export const money = (n: number | null | undefined) => (n == null ? "" : `$${n.toFixed(n < 1 ? 3 : 2)}`);
