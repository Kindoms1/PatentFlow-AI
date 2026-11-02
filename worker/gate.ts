/**
 * Invite-code gate for the whole site. A valid code earns an HMAC-signed, HttpOnly session cookie.
 * Removing a code from ACCESS_CODES revokes every session issued for it.
 */
export interface GateEnv {
  ACCESS_CODES?: string;
  SESSION_SECRET?: string;
  SESSION_DAYS?: string;
}

const COOKIE = "pf_session";
const enc = new TextEncoder();
export const SECURITY: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};

function b64url(bytes: ArrayBuffer): string {
  let text = "";
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

async function label(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode("pf-code:" + code));
  return Array.from(new Uint8Array(digest).slice(0, 6), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

let cache: { raw: string; codes: Map<string, string> } | null = null;

function configuredCodes(env: GateEnv): string[] {
  return (env.ACCESS_CODES || "").split(/[\s,]+/).filter(Boolean);
}

async function codes(env: GateEnv): Promise<Map<string, string>> {
  const raw = env.ACCESS_CODES || "";
  if (cache && cache.raw === raw) return cache.codes;
  const map = new Map<string, string>();
  for (const code of configuredCodes(env)) {
    map.set(await label(code), code);
  }
  cache = { raw, codes: map };
  return map;
}

export function gateConfigured(env: GateEnv): boolean {
  const entries = configuredCodes(env);
  // Reject the entire configuration instead of silently discarding malformed invite codes.
  return Boolean(env.SESSION_SECRET && env.SESSION_SECRET.trim().length >= 32)
    && entries.length > 0 && entries.every((code) => code.length >= 6 && code.length <= 200);
}

/** Returns the code's label when the code is valid, else null. */
export async function checkCode(env: GateEnv, input: string): Promise<string | null> {
  if (!gateConfigured(env)) return null;
  const code = input.trim();
  if (code.length < 6 || code.length > 200) return null;
  const tag = await label(code);
  const stored = (await codes(env)).get(tag);
  return stored && same(stored, code) ? tag : null;
}

export async function issueCookie(env: GateEnv, tag: string): Promise<string> {
  if (!gateConfigured(env)) throw new Error("Invalid access gate configuration");
  const days = Math.min(Math.max(Number(env.SESSION_DAYS) || 7, 1), 30);
  const maxAge = Math.floor(days * 86400);
  const exp = Math.floor(Date.now() / 1000) + maxAge;
  const body = tag + "." + exp;
  const sig = await hmac(env.SESSION_SECRET || "", body);
  return COOKIE + "=" + body + "." + sig + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + maxAge;
}

export function clearCookie(): string {
  return COOKIE + "=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}

/** The session's code label, or null when there is no valid session. */
export async function session(request: Request, env: GateEnv): Promise<string | null> {
  if (!gateConfigured(env)) return null;
  const header = request.headers.get("Cookie") || "";
  const match = header.match(/(?:^|;\s*)pf_session=([a-f0-9]{12})\.(\d{10})\.([A-Za-z0-9_-]{43})(?:;|$)/);
  if (!match) return null;
  const [, tag, exp, sig] = match;
  if (Number(exp) * 1000 <= Date.now()) return null;
  if (!same(await hmac(env.SESSION_SECRET || "", tag + "." + exp), sig)) return null;
  if (!(await codes(env)).has(tag)) return null;
  return tag;
}

export function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store", ...SECURITY });
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

export function gatePage(error: string | null): Response {
  const msg = error === "1" ? "邀请码不对，请检查后重试。" : error === "2" ? "尝试次数太多，请 10 分钟后再试。" : "";
  const html = [
    "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    "<title>PatentFlow AI</title><meta name=\"robots\" content=\"noindex\">",
    "<style>body{font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;background:#f6f7f9;display:grid;place-items:center;min-height:100vh;margin:0}",
    "form{background:#fff;padding:32px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);width:min(360px,90vw)}h1{font-size:20px;margin:0 0 8px}p{color:#666;font-size:14px;margin:0 0 20px}",
    "input{width:100%;box-sizing:border-box;padding:10px 12px;font-size:15px;border:1px solid #ccc;border-radius:8px}",
    "button{margin-top:14px;width:100%;padding:10px;font-size:15px;border:0;border-radius:8px;background:#1f6feb;color:#fff;cursor:pointer}.err{color:#c0392b;margin-top:12px;font-size:14px}</style></head><body>",
    "<form method=\"post\" action=\"/__access\"><h1>PatentFlow AI</h1><p>内测中，请输入邀请码。</p>",
    "<input name=\"code\" type=\"password\" autocomplete=\"off\" placeholder=\"邀请码\" required maxlength=\"200\" autofocus>",
    "<button type=\"submit\">进入</button>",
    msg ? "<div class=\"err\">" + msg + "</div>" : "",
    "</form></body></html>",
  ].join("");
  return new Response(html, { status: 401, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...SECURITY } });
}
