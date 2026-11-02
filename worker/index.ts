/**
 * PatentFlow AI on Cloudflare Workers: the built SPA (./dist) plus the /api routes.
 * Model and search keys live only in Worker secrets; the browser never sees them.
 * The /api handlers are the same code the Vite dev server runs (server/agent-routes.ts),
 * reached through a small IncomingMessage/ServerResponse shim.
 */
import { handleAgentRoute } from "../server/agent-routes.ts";
import { inferVendor, vendorColor } from "../src/vendor.ts";
import { SECURITY, checkCode, clearCookie, gateConfigured, gatePage, issueCookie, redirect, session } from "./gate.ts";
import type { GateEnv } from "./gate.ts";
import { RateLimiter } from "./rate-limit.ts";

interface Env extends GateEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  AGNES_API_KEY?: string;
  AGNES_BASE_URL?: string;
  AGNES_MODEL?: string;
  AGNES_WEBSITE?: string;
  ANYSEARCH_API_KEY?: string;
  ANYSEARCH_BASE_URL?: string;
  ANYSEARCH_WEBSITE?: string;
  MAX_BODY_BYTES?: string;
  MAX_OUTPUT_TOKENS?: string;
  AGENT_PER_HOUR?: string;
  TOOLS_PER_HOUR?: string;
}

interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

const HOUR = 3_600_000;
const limiter = new RateLimiter();
const ROUTES = new Set(["/api/agent", "/api/chat", "/api/search", "/api/extract", "/api/radar/run"]);
const LOCKED = "线上版的模型与密钥由管理员统一配置，不能在这里修改。";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY },
  });
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return value !== undefined && value.trim() !== "" && Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function outputTokenCap(env: Env): number {
  const value = Number(env.MAX_OUTPUT_TOKENS);
  return Number.isFinite(value) && value >= 1 ? Math.min(32_000, Math.floor(value)) : 32_000;
}

/** Count actual bytes while reading; Content-Length is only an early rejection hint. */
async function readBody(request: Request, max: number): Promise<Uint8Array | Response> {
  const tooLarge = () => json(413, { error: "内容太大了，请精简后再试。" });
  if (Number(request.headers.get("Content-Length") || 0) > max) {
    void request.body?.cancel().catch(() => {});
    return tooLarge();
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max) {
        void reader.cancel().catch(() => {});
        return tooLarge();
      }
      if (value.byteLength) chunks.push(value);
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } catch {
    return json(400, { error: "请求内容读取失败。" });
  } finally {
    reader.releaseLock();
  }
}

function storeFromEnv(env: Env) {
  return {
    activeModelId: "css-agent",
    providers: [
      {
        id: "css-agent",
        name: "css-agent",
        protocol: "openai" as const,
        role: "model",
        baseUrl: env.AGNES_BASE_URL || "https://apihub.agnes-ai.com/v1",
        website: env.AGNES_WEBSITE || "https://www.agnes-ai.com/",
        model: env.AGNES_MODEL || "agnes-2.5-flash",
        models: [] as string[],
        secret: env.AGNES_API_KEY || "",
        auth: "bearer" as const,
      },
      {
        id: "anysearch-agent",
        name: "agent",
        protocol: "openai" as const,
        role: "search",
        baseUrl: env.ANYSEARCH_BASE_URL || "https://api.anysearch.com",
        website: env.ANYSEARCH_WEBSITE || "https://www.anysearch.com/",
        model: "",
        models: [] as string[],
        secret: env.ANYSEARCH_API_KEY || "",
        auth: "bearer" as const,
      },
    ],
  };
}

/** Same shape the dev server returns, minus anything secret (no key hint, no upstream URL). */
function publicProviders(env: Env) {
  const store = storeFromEnv(env);
  return {
    providers: store.providers.map((provider) => {
      const icon = inferVendor(provider as never);
      return {
        id: provider.id,
        name: provider.name,
        protocol: provider.protocol,
        role: provider.role,
        baseUrl: "",
        website: provider.website,
        model: provider.model,
        models: provider.model ? [provider.model] : [],
        icon,
        iconColor: vendorColor(icon),
        hasKey: Boolean(provider.secret),
        keyHint: provider.secret ? "已由管理员在服务端配置" : "未配置密钥",
        active: provider.role === "model" && provider.id === store.activeModelId,
      };
    }),
  };
}

/** Parse, drop client-chosen provider, cap cost knobs. Null when the body is not a JSON object. */
function sanitize(raw: string, env: Env): string | null {
  let body: Record<string, unknown>;
  try {
    const value = raw.trim() ? (JSON.parse(raw) as unknown) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    body = value as Record<string, unknown>;
  } catch {
    return null;
  }
  delete body.providerId;
  const cap = (key: string, max: number) => {
    if (typeof body[key] === "number") body[key] = Math.min(Math.max(0, body[key] as number), max);
  };
  const tokens = body.maxTokens;
  body.maxTokens = Math.min(
    typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 1 ? Math.floor(tokens) : 4096,
    outputTokenCap(env),
  );
  cap("maxSteps", 16);
  cap("maxSearches", 12);
  cap("maxResults", 10);
  return JSON.stringify(body);
}

/** Run one existing /api handler against a Web Request body and return its Response (streamed or JSON). */
function runRoute(path: string, bodyText: string, env: Env, ctx: Ctx, requestSignal: AbortSignal): Promise<Response> {
  const enc = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const controller = new AbortController();
  let settle: (response: Response) => void = () => {};
  const ready = new Promise<Response>((resolve) => (settle = resolve));
  let settled = false;
  const resolve = (response: Response) => {
    if (settled) return;
    settled = true;
    settle(response);
  };
  const closeHandlers: Array<() => void> = [];
  const headers = new Headers(SECURITY);
  const res = {
    statusCode: 200,
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
    setHeader(name: string, value: string) {
      headers.set(name, value);
    },
    flushHeaders() {
      if (!settled) resolve(new Response(readable, { status: res.statusCode, headers }));
    },
    write(chunk: string) {
      if (res.destroyed || res.writableEnded) return false;
      writer.write(enc.encode(chunk)).catch(disconnect);
      return true;
    },
    end() {
      if (res.writableEnded || res.destroyed) return;
      res.writableEnded = true;
      res.flushHeaders();
      writer.close().catch(disconnect);
    },
    on(event: string, fn: () => void) {
      if (event === "close") closeHandlers.push(fn);
      return res;
    },
  };
  function disconnect() {
    if (res.destroyed || res.writableFinished) return;
    res.destroyed = true;
    requestSignal.removeEventListener("abort", disconnect);
    controller.abort();
    for (const fn of closeHandlers) fn();
    void writer.abort().catch(() => {});
    resolve(json(499, { error: "请求已取消。" }));
  }
  // A consumer can cancel while no write is pending. Observe the writer's lifetime too.
  void writer.closed.then(() => {
    res.writableFinished = true;
    requestSignal.removeEventListener("abort", disconnect);
  }, disconnect);
  requestSignal.addEventListener("abort", disconnect, { once: true });
  if (requestSignal.aborted) {
    disconnect();
    return ready;
  }
  const routeCtx = {
    read: () => storeFromEnv(env),
    write: () => {},
    publicView: () => publicProviders(env),
    readBody: async () => bodyText,
    send: (_res: unknown, status: number, body: unknown) => {
      if (res.destroyed) return;
      res.writableEnded = true;
      res.writableFinished = true;
      requestSignal.removeEventListener("abort", disconnect);
      writer.close().catch(() => {});
      resolve(json(status, body));
    },
    fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
      if ((path === "/api/agent" || path === "/api/chat") && typeof init?.body === "string") {
        const payload = JSON.parse(init.body) as Record<string, unknown>;
        if (typeof payload.max_tokens === "number") {
          // Shared routes apply their own defaults/minima, including chat's fixed 4096 tokens.
          // Enforce the deployment's per-call cap after those defaults, at the upstream boundary.
          payload.max_tokens = Math.min(payload.max_tokens, outputTokenCap(env));
          init = { ...init, body: JSON.stringify(payload) };
        }
      }
      const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
      signal.throwIfAborted();
      return fetch(input, { ...init, signal });
    }) as typeof fetch,
  };
  const req = { method: "POST", url: path, headers: {} };
  const work = handleAgentRoute(path, req as never, res as never, routeCtx as never).then(
    (handled) => {
      if (!handled) routeCtx.send(res, 404, { error: "没有这个接口。" });
      else res.end();
    },
    (err) => {
      console.error("[agent-route] failed:", err instanceof Error ? err.name : "unknown");
      if (settled) {
        res.write(JSON.stringify({ type: "error", detail: "服务端出错，请稍后重试。", status: 500 }) + "\n");
        res.end();
      } else {
        routeCtx.send(res, 500, { error: "服务端出错，请稍后重试。" });
      }
    },
  );
  ctx.waitUntil(work);
  return ready;
}

async function api(request: Request, path: string, who: string, env: Env, ctx: Ctx): Promise<Response> {
  const method = request.method;
  if (method === "GET" && path === "/api/providers") return json(200, publicProviders(env));
  if (path === "/api/providers/models") return json(200, { ok: false, detail: "线上版的模型列表由管理员维护。", fetched: 0 });
  if (path.startsWith("/api/providers") || path.startsWith("/api/ccswitch")) return json(403, { error: LOCKED });
  if (method !== "POST" || !ROUTES.has(path)) return json(404, { error: "没有这个接口。" });

  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return json(403, { error: "跨站请求被拒绝。" });

  const heavy = path === "/api/agent" || path === "/api/chat";
  const limit = heavy ? num(env.AGENT_PER_HOUR, 30) : num(env.TOOLS_PER_HOUR, 120);
  if (!limiter.allow((heavy ? "llm:" : "tool:") + who, limit, HOUR)) return json(429, { error: "调用太频繁了，请稍后再试。" });

  const max = num(env.MAX_BODY_BYTES, 2_000_000);
  const buffer = await readBody(request, max);
  if (buffer instanceof Response) return buffer;
  const body = sanitize(new TextDecoder().decode(buffer), env);
  if (body === null) return json(400, { error: "请求格式不对。" });
  return runRoute(path, body, env, ctx, request.signal);
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") || "local";
}

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!gateConfigured(env)) {
      return new Response("站点还没有配置 ACCESS_CODES / SESSION_SECRET。", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...SECURITY } });
    }

    if (path === "/__access" && request.method === "POST") {
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) return json(403, { error: "跨站请求被拒绝。" });
      if (!limiter.allow("login:" + clientIp(request), 10, 600_000)) return redirect("/?e=2");
      const body = await readBody(request, Math.min(num(env.MAX_BODY_BYTES, 2_000_000), 16_384));
      if (body instanceof Response) return body;
      const form = await new Response(body, { headers: request.headers }).formData().catch(() => null);
      const value = form?.get("code");
      const code = typeof value === "string" ? value : "";
      const tag = code ? await checkCode(env, code) : null;
      if (!tag) return redirect("/?e=1");
      return redirect("/", await issueCookie(env, tag));
    }
    if (path === "/__logout") return redirect("/", clearCookie());

    const who = await session(request, env);
    if (!who) {
      if (path.startsWith("/api/")) return json(401, { error: "请先输入邀请码。" });
      return gatePage(url.searchParams.get("e"));
    }
    if (path.startsWith("/api/")) return api(request, path, who, env, ctx);

    const asset = await env.ASSETS.fetch(request);
    const out = new Response(asset.body, asset);
    for (const [name, value] of Object.entries(SECURITY)) out.headers.set(name, value);
    return out;
  },
};
