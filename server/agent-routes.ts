/**
 * HTTP routes for the gateway, the patent agent and AnySearch.
 * Mounted by credentials-plugin.ts before its own routes, so these handlers win on shared paths.
 *
 * POST /api/agent            NDJSON stream of AgentEvent (see src/agent-events.ts)
 * POST /api/chat             one-shot completion, same reply shape as before
 * POST /api/search           AnySearch web search
 * POST /api/extract          AnySearch page extraction
 * POST /api/radar/run        patent radar for one topic (CN publication numbers only)
 * POST /api/providers/models refresh a provider's model list from its /models endpoint
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentEvent, AgentRequest, AgentRole } from "../src/agent-events.ts";
import { anyExtract, anySearch } from "./anysearch.ts";
import type { SearchConfig } from "./anysearch.ts";
import { complete, listModels, redact } from "./llm-gateway.ts";
import type { GatewayProvider } from "./llm-gateway.ts";
import { runPatentAgent } from "./patent-agent.ts";
import { runRadar, titleFromMention, titleFromPatentPage } from "./patent-radar.ts";
import type { RadarTopic } from "./patent-radar.ts";

export interface RouteProvider extends GatewayProvider {
  role: string;
  models?: string[];
}

export interface RouteStore {
  activeModelId: string;
  providers: RouteProvider[];
}

export interface RouteContext<S extends RouteStore> {
  read: () => S;
  write: (store: S) => void;
  publicView: (store: S) => unknown;
  readBody: (req: IncomingMessage) => Promise<string>;
  send: (res: ServerResponse, status: number, body: unknown) => void;
  fetchImpl?: typeof fetch;
}

type Json = Record<string, unknown>;

const ROLES = new Set<AgentRole>(["system", "user", "assistant"]);

function parseBody(raw: string): Json {
  if (!raw.trim()) return {};
  const value = JSON.parse(raw) as unknown;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

export function cleanMessages(value: unknown): AgentRequest["messages"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Json => Boolean(item) && typeof item === "object")
    .filter((item) => typeof item.content === "string" && ROLES.has(item.role as AgentRole))
    .slice(-40)
    .map((item) => ({ role: item.role as AgentRole, content: (item.content as string).slice(0, 120_000) }));
}

function pickModel<S extends RouteStore>(store: S, providerId: unknown): RouteProvider | undefined {
  const id = typeof providerId === "string" && providerId ? providerId : store.activeModelId;
  return store.providers.find((item) => item.id === id && item.role === "model");
}

function pickSearch<S extends RouteStore>(store: S): SearchConfig | null {
  const provider = store.providers.find((item) => item.role === "search" && item.secret);
  return provider ? { baseUrl: provider.baseUrl, secret: provider.secret } : null;
}

function abortOnClose(res: ServerResponse): AbortController {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller;
}

export async function handleAgentRoute<S extends RouteStore>(url: string, req: IncomingMessage, res: ServerResponse, ctx: RouteContext<S>): Promise<boolean> {
  if (req.method !== "POST") return false;

  if (url === "/api/agent") {
    const body = parseBody(await ctx.readBody(req));
    const store = ctx.read();
    const provider = pickModel(store, body.providerId);
    if (!provider?.secret) {
      ctx.send(res, 409, { error: provider ? "当前模型没有服务端密钥。" : "还没有可用的模型。" });
      return true;
    }
    const messages = cleanMessages(body.messages);
    const search = pickSearch(store);
    const secrets = [provider.secret, search?.secret];
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const controller = abortOnClose(res);
    const emit = (event: AgentEvent) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`${redact(JSON.stringify(event), secrets)}\n`);
    };
    try {
      await runPatentAgent({
        provider,
        search,
        messages,
        allowTools: body.tools !== false,
        maxSteps: typeof body.maxSteps === "number" ? body.maxSteps : undefined,
        maxTokens: typeof body.maxTokens === "number" ? body.maxTokens : undefined,
        maxSearches: typeof body.maxSearches === "number" ? body.maxSearches : undefined,
        signal: controller.signal,
        emit,
        fetchImpl: ctx.fetchImpl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      emit({ type: "error", detail: `Agent 运行失败：${redact(message, secrets).slice(0, 200)}`, status: 500 });
    } finally {
      if (!res.writableEnded) res.end();
    }
    return true;
  }

  if (url === "/api/chat") {
    const body = parseBody(await ctx.readBody(req));
    const store = ctx.read();
    const provider = pickModel(store, body.providerId);
    if (!provider?.secret) {
      ctx.send(res, 409, { ok: false, detail: "当前模型没有服务端密钥。" });
      return true;
    }
    const messages = cleanMessages(body.messages);
    const system = messages.filter((item) => item.role === "system").slice(-1);
    const dialog = messages.filter((item) => item.role !== "system").slice(-12);
    const controller = abortOnClose(res);
    const answered = await complete(provider, [...system, ...dialog], { stream: false, maxTokens: 4096, signal: controller.signal, fetchImpl: ctx.fetchImpl });
    ctx.send(res, 200, {
      ok: answered.ok,
      text: redact(answered.text, [provider.secret]),
      detail: answered.detail,
      model: provider.model || provider.name,
      usage: answered.usage,
    });
    return true;
  }

  if (url === "/api/radar/run") {
    const body = parseBody(await ctx.readBody(req));
    const search = pickSearch(ctx.read());
    const empty = { hits: [], queries: [], errors: [], skippedSeen: 0 };
    if (!search) {
      ctx.send(res, 409, { ok: false, detail: "AnySearch 密钥还没有放在服务端，请先在“模型与服务”里添加检索服务。", ...empty });
      return true;
    }
    const raw = body.topic && typeof body.topic === "object" && !Array.isArray(body.topic) ? (body.topic as Json) : {};
    const keywords = Array.isArray(raw.keywords)
      ? raw.keywords
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .map((item) => item.trim().slice(0, 40))
          .slice(0, 6)
      : [];
    const ipcRaw = typeof raw.ipc === "string" ? raw.ipc.trim().toUpperCase() : "";
    const topic: RadarTopic = {
      id: typeof raw.id === "string" ? raw.id.slice(0, 80) : "",
      name: typeof raw.name === "string" ? raw.name.slice(0, 80) : "",
      keywords,
      ipc: /^[A-H]\d{2}[A-Z]?(\d{1,4}(\/\d{1,6})?)?$/.test(ipcRaw) ? ipcRaw : undefined,
    };
    if (!topic.id || topic.keywords.length === 0) {
      ctx.send(res, 400, { ok: false, detail: "专题缺少 id 或关键词。", ...empty });
      return true;
    }
    const seen = new Set(Array.isArray(body.seen) ? body.seen.filter((item): item is string => typeof item === "string").slice(-3000) : []);
    const run = await runRadar(
      topic,
      async (query) => {
        const outcome = await anySearch(search, { query, maxResults: 10, zone: "cn", language: "zh-CN" }, { fetchImpl: ctx.fetchImpl });
        if (!outcome.ok) throw new Error(outcome.detail);
        return outcome.results.map((item) => ({ title: item.title, url: item.url, snippet: item.snippet }));
      },
      seen,
      new Date(),
      {
        resolveTitle: async (hit) => {
          const page = await anyExtract(search, hit.url, { fetchImpl: ctx.fetchImpl, timeoutMs: 12_000 });
          const found = page.ok ? titleFromPatentPage(page.title, page.content) : null;
          if (found) return found;
          // Google Patents 抽不出时，只接受来源页里“名为“X”的专利，…本号”这种明确指名；绝不把新闻页标题当发明名称。
          const source = hit.sourceUrl || "";
          if (!/^https?:\/\//i.test(source) || /patents\.google\./i.test(source) || /\.pdf(?:$|[?#])/i.test(source)) return null;
          const backup = await anyExtract(search, source, { fetchImpl: ctx.fetchImpl, timeoutMs: 12_000 });
          return backup.ok ? titleFromMention(backup.content, hit.pn) : null;
        },
      },
    );
    const ok = run.errors.length < run.queries.length;
    ctx.send(res, 200, { ok, detail: ok ? "" : run.errors[0] || "检索没有完成。", ...run });
    return true;
  }

  if (url === "/api/search") {
    const body = parseBody(await ctx.readBody(req));
    const search = pickSearch(ctx.read());
    if (!search) {
      ctx.send(res, 409, { error: "AnySearch 密钥还没有放在服务端。" });
      return true;
    }
    const zone = body.zone === "cn" || body.zone === "intl" ? body.zone : undefined;
    const outcome = await anySearch(
      search,
      {
        query: typeof body.query === "string" ? body.query : "",
        maxResults: typeof body.maxResults === "number" ? body.maxResults : 8,
        zone,
        language: typeof body.language === "string" ? body.language : "zh-CN",
      },
      { fetchImpl: ctx.fetchImpl },
    );
    ctx.send(res, outcome.status === 400 ? 400 : 200, outcome);
    return true;
  }

  if (url === "/api/extract") {
    const body = parseBody(await ctx.readBody(req));
    const search = pickSearch(ctx.read());
    if (!search) {
      ctx.send(res, 409, { error: "AnySearch 密钥还没有放在服务端。" });
      return true;
    }
    const outcome = await anyExtract(search, typeof body.url === "string" ? body.url : "", { fetchImpl: ctx.fetchImpl });
    ctx.send(res, 200, { ...outcome, content: outcome.content.slice(0, 40_000) });
    return true;
  }

  if (url === "/api/providers/models") {
    const body = parseBody(await ctx.readBody(req));
    const store = ctx.read();
    const provider = store.providers.find((item) => item.id === body.id && item.role === "model");
    if (!provider) {
      ctx.send(res, 404, { error: "没有这个模型提供方。" });
      return true;
    }
    const listed = await listModels(provider, { fetchImpl: ctx.fetchImpl });
    if (!listed.ok) {
      ctx.send(res, 200, { ok: false, detail: listed.detail });
      return true;
    }
    const keep = [provider.model, ...(provider.models ?? [])].filter(Boolean);
    provider.models = [...new Set([...keep, ...listed.models])].slice(0, 200);
    if (!provider.model) provider.model = listed.models[0];
    ctx.write(store);
    const view = ctx.publicView(store) as Json;
    ctx.send(res, 200, { ...view, ok: true, detail: listed.detail, fetched: listed.models.length });
    return true;
  }

  return false;
}
