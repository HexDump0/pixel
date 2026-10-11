/** Single-password login for the dashboard. No password configured = no login (development only). */
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";
import { getSecret } from "./settings.ts";

const COOKIE = "pixel_auth";

function token() {
  return new Bun.CryptoHasher("sha256", getSecret()).update(`pixel:${config.password}`).digest("hex");
}

function eq(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const authEnabled = () => !!config.password;

export function isAuthed(req: Request) {
  if (!authEnabled()) return true;
  const cookie = req.headers.get("cookie") ?? "";
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]+)`).exec(cookie);
  if (m && eq(m[1], token())) return true;
  const bearer = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
  return !!bearer && eq(bearer[1], config.password);
}

export function login(password: string) {
  if (!authEnabled() || !eq(password, config.password)) return null;
  const secure = config.publicUrl.startsWith("https://") ? "; Secure" : "";
  return `${COOKIE}=${token()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 30}${secure}`;
}

export const logoutCookie = `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
