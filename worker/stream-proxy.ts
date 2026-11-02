import type { AgentEvent, AgentRequest } from "../src/agent-events.ts";
import { describeStatus, joinUrl, SECRET_MASK } from "../server/llm-gateway.ts";
import type { GatewayProvider } from "../server/llm-gateway.ts";
import { SECURITY } from "./gate.ts";

const enc = new TextEncoder();
const replacement = enc.encode(SECRET_MASK);

export function acceptsEventStream(accept: string | null): boolean {
  return (accept || "").split(",").some((part) => {
    const [type, ...parameters] = part.toLowerCase().split(";").map((item) => item.trim());
    if (type !== "text/event-stream") return false;
    const quality = parameters.find((item) => /^q\s*=/.test(item));
    return quality === undefined || Number(quality.slice(quality.indexOf("=") + 1)) > 0;
  });
}

function findBytes(data: Uint8Array, needle: Uint8Array, start: number): number {
  for (let at = data.indexOf(needle[0], start); at >= 0 && at <= data.length - needle.length; at = data.indexOf(needle[0], at + 1)) {
    let index = 1;
    while (index < needle.length && data[at + index] === needle[index]) index++;
    if (index === needle.length) return at;
  }
  return -1;
}

function upstreamReader(source: ReadableStream<Uint8Array>) {
  let byob: ReadableStreamBYOBReader | undefined;
  try {
    byob = source.getReader({ mode: "byob" });
    if (typeof byob.readAtLeast === "function") {
      const reader = byob;
      let first = true;
      return {
        read() {
          const minimum = first ? 1 : 65_536;
          first = false;
          // readAtLeast detaches its input buffer; a short EOF read is still done:false.
          return reader.readAtLeast(minimum, new Uint8Array(65_536));
        },
        cancel: () => reader.cancel(),
        releaseLock: () => reader.releaseLock(),
      };
    }
  } catch { /* Standard streams may not support BYOB or Cloudflare's extension. */ }
  byob?.releaseLock();
  return source.getReader();
}

/** Pull-driven byte redaction: retain only the longest key minus one byte between reads.
 * Unchanged UTF-8 bytes and SSE framing pass through verbatim, including terminal frames.
 * This does not parse events or accumulate the answer, and uses no detached producer. */
function redactStream(source: ReadableStream<Uint8Array>, keys: string[], signal: AbortSignal, upstream: AbortController): ReadableStream<Uint8Array> {
  const needles = keys.map((key) => enc.encode(key)).sort((a, b) => b.length - a.length);
  const keep = Math.max(0, ...needles.map((needle) => needle.length - 1));
  const reader = upstreamReader(source);
  let tail: Uint8Array = new Uint8Array();
  let closed = false;
  let output: ReadableStreamDefaultController<Uint8Array>;
  const cleanup = () => { signal.removeEventListener("abort", abort); tail = new Uint8Array(); };
  const cancel = () => {
    if (closed) return;
    closed = true;
    cleanup();
    upstream.abort();
    void reader.cancel().catch(() => {}).finally(() => reader.releaseLock());
  };
  const abort = () => {
    if (closed) return;
    cancel();
    output.error(new DOMException("已停止。", "AbortError"));
  };
  function emit(chunk: Uint8Array, final: boolean) {
    let data = chunk;
    if (tail.length) {
      data = new Uint8Array(tail.length + chunk.length);
      data.set(tail);
      data.set(chunk, tail.length);
    }
    const limit = final ? data.length : Math.max(0, data.length - keep);
    let offset = 0;
    while (offset < limit) {
      let found = limit;
      let length = 0;
      for (const needle of needles) {
        const at = findBytes(data, needle, offset);
        if (at >= 0 && at < found) { found = at; length = needle.length; }
      }
      if (found > offset) output.enqueue(data.subarray(offset, found));
      if (length) { output.enqueue(replacement); offset = found + length; }
      else offset = limit;
    }
    // Copy the small suffix so it cannot retain a large upstream chunk's backing buffer.
    tail = data.slice(offset);
    return offset > 0;
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull() {
      try {
        while (!closed) {
          const { value, done } = await reader.read();
          if (closed) return;
          const emitted = emit(value || new Uint8Array(), done);
          if (done) { closed = true; cleanup(); reader.releaseLock(); output.close(); return; }
          if (emitted) return;
        }
      } catch {
        if (closed) return;
        cancel();
        output.error(new Error("上游连接中断。"));
      }
    },
    cancel,
  }, { highWaterMark: 0 });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function readJsonBody(body: ReadableStream<Uint8Array>): Promise<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) { void reader.cancel().catch(() => {}); throw new Error("JSON reply too large"); }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}

export interface StreamProxyOptions {
  provider: GatewayProvider;
  searchSecret?: string;
  /** Already filtered by cleanMessages and the Worker's request-size and token limits. */
  messages: AgentRequest["messages"];
  maxTokens: number;
  signal: AbortSignal;
}

export async function proxyAgentStream({ provider, searchSecret, messages, maxTokens, signal }: StreamProxyOptions): Promise<Response> {
  const keys = [...new Set([provider.secret, searchSecret].filter((key): key is string => Boolean(key)))].sort((a, b) => b.length - a.length);
  const scrub = (text: string) => keys.reduce((value, key) => value.split(key).join(SECRET_MASK), text);
  const model = scrub(provider.model || provider.name);
  const headers = { ...SECURITY, "Cache-Control": "no-cache, no-transform", "X-PatentFlow-Model": model, "X-PatentFlow-Provider": scrub(provider.name) };
  const failure = (status: number, error: string) => new Response(JSON.stringify({ error: scrub(error) }), { status, headers: { ...headers, "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" } });
  const ndjson = (events: AgentEvent[]) => new Response(events.map((event) => JSON.stringify(event)).join("\n") + "\n", { headers: { ...headers, "Content-Type": "application/x-ndjson; charset=utf-8" } });
  if (!provider.secret) return failure(409, "当前模型没有服务端密钥。");
  if (!messages.some((message) => message.role === "user" && message.content.trim())) return ndjson([{ type: "error", detail: "没有可以回答的用户消息。", status: 400 }]);
  const upstream = new AbortController();
  const fetchSignal = AbortSignal.any([signal, upstream.signal, AbortSignal.timeout(15 * 60_000)]);
  // Keep the official-endpoint/model match identical to server/llm-gateway.ts.
  const deepseekV4 = /^https:\/\/api\.deepseek\.com(?:\/|$)/i.test(provider.baseUrl.trim())
    && /^deepseek-(?:flash|v4-(?:flash|pro))(?:-|$)/i.test(provider.model);
  let response: Response;
  try {
    fetchSignal.throwIfAborted();
    response = await fetch(joinUrl(provider.baseUrl, "chat/completions"), {
      method: "POST", redirect: "manual", signal: fetchSignal,
      headers: { "Content-Type": "application/json", Accept: "text/event-stream, application/json", Authorization: "Bearer " + provider.secret },
      body: JSON.stringify({ model: provider.model, messages, max_tokens: maxTokens, stream: true, ...(deepseekV4 ? { thinking: { type: "disabled" } } : {}) }),
    });
  } catch {
    return failure(signal.aborted ? 499 : 502, signal.aborted ? "请求已取消。" : "模型连接失败，请稍后重试。");
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    const status = response.status >= 400 && response.status <= 599 ? response.status : 502;
    return failure(status, describeStatus(status));
  }
  if (!response.body) return failure(502, "模型返回了空内容。");
  const body = redactStream(response.body, keys, signal, upstream);
  if ((response.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase() === "text/event-stream") {
    return new Response(body, { headers: { ...headers, "Content-Type": "text/event-stream; charset=utf-8" } });
  }
  // A compatible provider may ignore stream:true. Consume that one response, never re-issue the request.
  try {
    const payload = record(await readJsonBody(body));
    const choice = record(Array.isArray(payload.choices) ? payload.choices[0] : undefined);
    const content = record(choice.message ?? choice.delta).content;
    const text = scrub(typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => { const value = record(part).text; return typeof value === "string" ? value : ""; }).join("") : "");
    if (payload.error || !text.trim()) return ndjson([{ type: "error", detail: "模型未返回可用的回答。", status: 502 }]);
    const usage = record(payload.usage);
    const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
    return ndjson([
      { type: "start", model, provider: scrub(provider.name), tools: [] },
      { type: "step", step: 1, label: "理解材料与问题" },
      { type: "delta", text },
      { type: "done", text, sources: [], steps: 1, model, usage: { input: count(usage.prompt_tokens), output: count(usage.completion_tokens) } },
    ]);
  } catch {
    return ndjson([{ type: "error", detail: signal.aborted ? "已停止。" : "模型返回了无法解析或过大的内容。", status: signal.aborted ? 0 : 502 }]);
  }
}
