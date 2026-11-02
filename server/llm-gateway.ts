/**
 * Server-side model gateway.
 *
 * One call shape for OpenAI-compatible Chat Completions (Agnes, DeepSeek, new-api relays, Qwen, Zhipu ...)
 * and Anthropic Messages. Handles streaming (SSE), tool calling, model listing and error mapping.
 * Secrets only ever travel in request headers and are scrubbed from anything returned.
 */

export interface GatewayProvider {
  id: string;
  name: string;
  protocol: string;
  baseUrl: string;
  model: string;
  secret: string;
  auth: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type Turn =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string; name: string };

export interface Usage {
  input: number;
  output: number;
}

export interface CompletionResult {
  ok: boolean;
  status: number;
  text: string;
  toolCalls: ToolCall[];
  finish: string;
  usage: Usage | null;
  detail: string;
}

export interface CompleteOptions {
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
  /** Ask the upstream for SSE. Defaults to true; non-SSE replies are still parsed. */
  stream?: boolean;
  /** Total cap on one call. Defaults to 180 s for a whole reply and 15 min for a streamed one. */
  timeoutMs?: number;
  /** A streamed reply is cut when upstream sends nothing for this long. Defaults to 90 s. */
  idleTimeoutMs?: number;
  /** How long a streamed call may wait for the response to start. Defaults to 180 s. */
  firstByteTimeoutMs?: number;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  fetchImpl?: typeof fetch;
}

interface Parsed {
  text: string;
  toolCalls: ToolCall[];
  finish: string;
  usage: Usage | null;
  error: string;
}

type Json = Record<string, unknown>;

export const SECRET_MASK = "[密钥已隐藏]";

/** A whole (non-streamed) reply, and the wait for a streamed reply to start. */
const DEFAULT_TOTAL_MS = 180_000;
const DEFAULT_FIRST_BYTE_MS = 180_000;
/** A streamed reply that goes quiet this long is treated as hung. Long drafts keep sending, so they pass. */
const DEFAULT_IDLE_MS = 90_000;
/** Backstop for a streamed reply that keeps trickling forever. */
const DEFAULT_STREAM_TOTAL_MS = 15 * 60_000;
/** A connection that drops before any response arrives is retried this many times; nothing has streamed yet, so it is safe. */
const CONNECT_RETRIES = 2;
const CONNECT_BACKOFF_MS = 800;

function formatSpan(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? String(ms / 60_000) + " 分钟" : String(Math.round(ms / 1000)) + " 秒";
}

export function joinUrl(baseUrl: string, suffix: "chat/completions" | "messages" | "models"): string {
  const root = baseUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(chat\/completions|messages|models)$/, "");
  if (/\/v\d+(beta)?$/i.test(root)) return `${root}/${suffix}`;
  return `${root}/v1/${suffix}`;
}

export function redact(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join(SECRET_MASK);
  }
  return out;
}

export function describeStatus(status: number): string {
  if (status === 401 || status === 403) return "密钥无效、过期或没有这个模型的权限";
  if (status === 402) return "上游额度不足";
  if (status === 404) return "接口地址或模型名不存在";
  if (status === 408) return "上游响应超时";
  if (status === 413) return "请求太长，请减少材料";
  if (status === 429) return "上游限流或额度不足，请稍后再试";
  if (status === 400 || status === 422) return "上游拒绝了请求参数";
  if (status >= 500) return "上游服务暂时故障";
  return status ? `上游返回 ${status}` : "没有连上上游";
}

export function upstreamMessage(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  try {
    const payload = JSON.parse(text) as Json;
    return errorText(payload);
  } catch {
    return /<html|<!doctype/i.test(text) ? "" : text.slice(0, 200);
  }
}

function errorText(payload: Json): string {
  const error = payload.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as Json).message;
    if (typeof message === "string") return message;
  }
  if (payload.type === "error" && typeof payload.message === "string") return payload.message;
  if (typeof payload.code === "number" && payload.code !== 0 && typeof payload.message === "string") return payload.message;
  return "";
}

function parseJson(text: string): Json | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
  } catch {
    return null;
  }
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && typeof (part as Json).text === "string" ? ((part as Json).text as string) : ""))
      .join("");
  }
  return "";
}

function blank(): Parsed {
  return { text: "", toolCalls: [], finish: "", usage: null, error: "" };
}

export function safeArgs(raw: string): Record<string, unknown> {
  const parsed = parseJson(raw || "{}");
  return parsed ?? {};
}

/** Minimal spec-compliant SSE reader over a byte stream. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let data: string[] = [];
  const take = (line: string): { event: string; data: string } | null => {
    if (line === "") {
      if (data.length === 0) {
        event = "";
        return null;
      }
      const out = { event: event || "message", data: data.join("\n") };
      event = "";
      data = [];
      return out;
    }
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    return null;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        const out = take(line);
        if (out) yield out;
        index = buffer.indexOf("\n");
      }
      if (done) break;
    }
    if (buffer) {
      const out = take(buffer.replace(/\r$/, ""));
      buffer = "";
      if (out) yield out;
    }
    const tail = take("");
    if (tail) yield tail;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

function finishCalls(slots: Array<{ id: string; name: string; arguments: string } | undefined>): ToolCall[] {
  const calls: ToolCall[] = [];
  slots.forEach((slot, index) => {
    if (!slot || !slot.name) return;
    calls.push({ id: slot.id || `call_${index}_${Date.now().toString(36)}`, name: slot.name, arguments: slot.arguments.trim() || "{}" });
  });
  return calls;
}

function absorbOpenAiChunk(chunk: Json, out: Parsed, slots: Array<{ id: string; name: string; arguments: string } | undefined>, onDelta?: (text: string) => void) {
  const usage = chunk.usage;
  if (usage && typeof usage === "object") {
    out.usage = { input: num((usage as Json).prompt_tokens), output: num((usage as Json).completion_tokens) };
  }
  const choices = Array.isArray(chunk.choices) ? (chunk.choices as Json[]) : [];
  const choice = choices[0];
  if (!choice) return;
  const delta = ((choice.delta ?? choice.message ?? {}) as Json) || {};
  const piece = contentText(delta.content);
  if (piece) {
    out.text += piece;
    onDelta?.(piece);
  }
  const calls = Array.isArray(delta.tool_calls) ? (delta.tool_calls as Json[]) : [];
  calls.forEach((call, position) => {
    const index = typeof call.index === "number" ? call.index : position;
    const slot = (slots[index] ??= { id: "", name: "", arguments: "" });
    const fn = ((call.function ?? {}) as Json) || {};
    if (typeof call.id === "string" && call.id) slot.id = call.id;
    if (typeof fn.name === "string" && fn.name) slot.name = slot.name && slot.name !== fn.name ? slot.name + fn.name : fn.name;
    if (typeof fn.arguments === "string") slot.arguments += fn.arguments;
    else if (fn.arguments && typeof fn.arguments === "object") slot.arguments = JSON.stringify(fn.arguments);
  });
  if (typeof choice.finish_reason === "string" && choice.finish_reason) out.finish = choice.finish_reason;
}

async function readOpenAiStream(body: ReadableStream<Uint8Array>, onDelta?: (text: string) => void): Promise<Parsed> {
  const out = blank();
  const slots: Array<{ id: string; name: string; arguments: string } | undefined> = [];
  for await (const message of readSse(body)) {
    if (message.data.trim() === "[DONE]") break;
    const chunk = parseJson(message.data);
    if (!chunk) continue;
    const error = errorText(chunk);
    if (error && !Array.isArray(chunk.choices)) {
      out.error = error;
      break;
    }
    absorbOpenAiChunk(chunk, out, slots, onDelta);
  }
  out.toolCalls = finishCalls(slots);
  return out;
}

async function readClaudeStream(body: ReadableStream<Uint8Array>, onDelta?: (text: string) => void): Promise<Parsed> {
  const out = blank();
  const blocks = new Map<number, { kind: "text" | "tool"; id: string; name: string; json: string }>();
  const usage: Usage = { input: 0, output: 0 };
  for await (const message of readSse(body)) {
    const chunk = parseJson(message.data);
    if (!chunk) continue;
    const index = num(chunk.index);
    switch (chunk.type) {
      case "message_start": {
        const start = ((chunk.message as Json | undefined)?.usage ?? {}) as Json;
        usage.input = num(start.input_tokens);
        break;
      }
      case "content_block_start": {
        const block = (chunk.content_block ?? {}) as Json;
        if (block.type === "tool_use") {
          blocks.set(index, { kind: "tool", id: String(block.id ?? ""), name: String(block.name ?? ""), json: "" });
        } else {
          blocks.set(index, { kind: "text", id: "", name: "", json: "" });
          if (typeof block.text === "string" && block.text) {
            out.text += block.text;
            onDelta?.(block.text);
          }
        }
        break;
      }
      case "content_block_delta": {
        const delta = (chunk.delta ?? {}) as Json;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          out.text += delta.text;
          onDelta?.(delta.text);
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const block = blocks.get(index);
          if (block) block.json += delta.partial_json;
        }
        break;
      }
      case "message_delta": {
        const delta = (chunk.delta ?? {}) as Json;
        if (typeof delta.stop_reason === "string") out.finish = delta.stop_reason;
        usage.output = num(((chunk.usage ?? {}) as Json).output_tokens) || usage.output;
        break;
      }
      case "error": {
        out.error = errorText(chunk) || "上游在流式输出中报错";
        break;
      }
      default:
        break;
    }
    if (out.error) break;
  }
  out.usage = usage.input || usage.output ? usage : null;
  out.toolCalls = [...blocks.entries()]
    .sort((left, right) => left[0] - right[0])
    .filter(([, block]) => block.kind === "tool" && block.name)
    .map(([position, block]) => ({ id: block.id || `toolu_${position}`, name: block.name, arguments: block.json.trim() || "{}" }));
  return out;
}

async function parseWhole(claude: boolean, raw: string, onDelta?: (text: string) => void): Promise<Parsed> {
  const head = raw.trimStart();
  if (head.startsWith("data:") || head.startsWith("event:")) {
    const body = new Response(raw).body;
    if (body) return claude ? readClaudeStream(body, onDelta) : readOpenAiStream(body, onDelta);
  }
  const out = blank();
  const payload = parseJson(raw);
  if (!payload) {
    out.error = raw.trim() ? "上游返回了无法解析的内容" : "";
    return out;
  }
  const error = errorText(payload);
  if (claude) {
    if (error && !Array.isArray(payload.content)) {
      out.error = error;
      return out;
    }
    const blocks = Array.isArray(payload.content) ? (payload.content as Json[]) : [];
    out.text = blocks.filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("");
    out.toolCalls = blocks
      .filter((block) => block.type === "tool_use")
      .map((block, index) => ({ id: String(block.id ?? `toolu_${index}`), name: String(block.name ?? ""), arguments: JSON.stringify(block.input ?? {}) }))
      .filter((call) => call.name);
    out.finish = typeof payload.stop_reason === "string" ? payload.stop_reason : "";
    const usage = (payload.usage ?? {}) as Json;
    out.usage = { input: num(usage.input_tokens), output: num(usage.output_tokens) };
  } else {
    if (error && !Array.isArray(payload.choices)) {
      out.error = error;
      return out;
    }
    const slots: Array<{ id: string; name: string; arguments: string } | undefined> = [];
    absorbOpenAiChunk(payload, out, slots);
    out.toolCalls = finishCalls(slots);
  }
  if (out.text) onDelta?.(out.text);
  return out;
}

export function toOpenAiMessages(turns: Turn[]): Json[] {
  return turns.map((turn) => {
    if (turn.role === "tool") return { role: "tool", tool_call_id: turn.toolCallId, content: turn.content };
    if (turn.role === "assistant" && turn.toolCalls?.length) {
      return {
        role: "assistant",
        content: turn.content || null,
        tool_calls: turn.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments || "{}" } })),
      };
    }
    return { role: turn.role, content: turn.content };
  });
}

export function toClaudePayload(turns: Turn[]): { system: string; messages: Array<{ role: "user" | "assistant"; content: Json[] }> } {
  const system = turns
    .filter((turn) => turn.role === "system")
    .map((turn) => turn.content.trim())
    .filter(Boolean)
    .join("\n\n");
  const messages: Array<{ role: "user" | "assistant"; content: Json[] }> = [];
  const push = (role: "user" | "assistant", block: Json) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(block);
    else messages.push({ role, content: [block] });
  };
  for (const turn of turns) {
    if (turn.role === "system") continue;
    if (turn.role === "tool") {
      push("user", { type: "tool_result", tool_use_id: turn.toolCallId, content: turn.content });
      continue;
    }
    if (turn.role === "assistant") {
      if (turn.content.trim()) push("assistant", { type: "text", text: turn.content });
      for (const call of turn.toolCalls ?? []) push("assistant", { type: "tool_use", id: call.id, name: call.name, input: safeArgs(call.arguments) });
      continue;
    }
    if (turn.content.trim()) push("user", { type: "text", text: turn.content });
  }
  if (messages[0]?.role === "assistant") messages.unshift({ role: "user", content: [{ type: "text", text: "（继续）" }] });
  return { system, messages };
}

function failure(status: number, detail: string, finish = "error"): CompletionResult {
  return { ok: false, status, text: "", toolCalls: [], finish, usage: null, detail };
}

/** undici hides the real reason (ECONNRESET, UND_ERR_SOCKET, ...) behind a bare "fetch failed"; pull it out of error.cause. */
export function causeText(error: unknown): string {
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  if (!cause || typeof cause !== "object") return "";
  const parts = cause as { code?: unknown; message?: unknown };
  const code = typeof parts.code === "string" ? parts.code : "";
  const message = typeof parts.message === "string" ? parts.message : "";
  return [code, message && !message.includes(code) ? message : code ? "" : message].filter(Boolean).join(" ").slice(0, 160);
}

const TRANSIENT_CONNECT = /fetch failed|socket hang up|other side closed|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|UND_ERR_CLOSED/i;

/** A network-level failure before any response: worth one more try. Aborts and timeouts are not. */
export function isTransientConnectError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return false;
  return TRANSIENT_CONNECT.test(error.message + " " + causeText(error));
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function thrown(error: unknown, outer: AbortSignal | undefined, secret: string): CompletionResult {
  if (outer?.aborted) return failure(0, "已停止。", "aborted");
  if (error instanceof Error && (error.name === "TimeoutError" || /timeout/i.test(error.message))) return failure(408, "模型响应超时。");
  const cause = causeText(error);
  const base = error instanceof Error ? error.message + (cause && !error.message.includes(cause) ? "（" + cause + "）" : "") : "";
  const message = redact(base, [secret]).slice(0, 220);
  return failure(0, message ? `没有连上模型：${message}` : "没有连上模型。");
}

function authHeaders(provider: GatewayProvider): Record<string, string> {
  if (provider.protocol === "claude") {
    const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
    if (provider.auth === "x-api-key") headers["x-api-key"] = provider.secret;
    else headers.Authorization = `Bearer ${provider.secret}`;
    return headers;
  }
  return { Authorization: `Bearer ${provider.secret}` };
}

export async function complete(provider: GatewayProvider, turns: Turn[], options: CompleteOptions = {}): Promise<CompletionResult> {
  if (!provider.secret) return failure(409, "当前模型没有服务端密钥。");
  if (!provider.baseUrl) return failure(409, "当前模型还没有接口地址。");
  const fetchImpl = options.fetchImpl ?? fetch;
  const claude = provider.protocol === "claude";
  const stream = options.stream !== false;
  // Two clocks. A full patent draft can stream for many minutes, so a fixed total cap would cut good replies.
  // The stall clock restarts on every chunk from upstream and catches a hung call; the total clock is a backstop.
  const totalMs = options.timeoutMs ?? (stream ? DEFAULT_STREAM_TOTAL_MS : DEFAULT_TOTAL_MS);
  const idleMs = options.idleTimeoutMs ?? DEFAULT_IDLE_MS;
  const firstByteMs = options.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_MS;
  const stall = new AbortController();
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const settle = () => {
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    stallTimer = undefined;
  };
  const arm = (ms: number, message: string) => {
    settle();
    stallTimer = setTimeout(() => {
      const reason = new Error(message);
      reason.name = "TimeoutError";
      stall.abort(reason);
    }, ms);
    (stallTimer as unknown as { unref?: () => void }).unref?.();
  };
  const timeout = AbortSignal.timeout(totalMs);
  const signal = AbortSignal.any(options.signal ? [options.signal, timeout, stall.signal] : [timeout, stall.signal]);
  const tools = options.tools?.length ? options.tools : undefined;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream, application/json" : "application/json",
    ...authHeaders(provider),
  };
  let url: string;
  let body: Json;
  if (claude) {
    const payload = toClaudePayload(turns);
    url = joinUrl(provider.baseUrl, "messages");
    body = {
      model: provider.model || "claude-sonnet-4-5",
      max_tokens: options.maxTokens ?? 4096,
      messages: payload.messages,
      stream,
      ...(payload.system ? { system: payload.system } : {}),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(tools ? { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}),
    };
  } else {
    url = joinUrl(provider.baseUrl, "chat/completions");
    // DeepSeek V4 enables thinking by default. This gateway's public Turn contract carries
    // text and tool calls, not provider-specific reasoning transcripts. Explicitly use its
    // supported non-thinking mode so tool continuations and bounded draft output work.
    // https://api-docs.deepseek.com/guides/thinking_mode
    const deepseekV4 = /^https:\/\/api\.deepseek\.com(?:\/|$)/i.test(provider.baseUrl.trim())
      && /^deepseek-(?:flash|v4-(?:flash|pro))(?:-|$)/i.test(provider.model);
    body = {
      model: provider.model || "gpt-4o-mini",
      messages: toOpenAiMessages(turns),
      max_tokens: options.maxTokens ?? 4096,
      stream,
      ...(deepseekV4 ? { thinking: { type: "disabled" } } : {}),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(tools
        ? {
            tools: tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
            tool_choice: "auto",
          }
        : {}),
    };
  }

  const stopped = (error: unknown): CompletionResult => {
    settle();
    if (options.signal?.aborted) return failure(0, "已停止。", "aborted");
    if (stall.signal.aborted) {
      const reason: unknown = stall.signal.reason;
      return failure(408, reason instanceof Error ? reason.message : "模型响应超时。");
    }
    if (timeout.aborted) return failure(408, "模型回复超过 " + formatSpan(totalMs) + " 的上限，已中断。");
    return thrown(error, options.signal, provider.secret);
  };
  const idleMessage = "模型连续 " + formatSpan(idleMs) + " 没有新输出，已中断。";

  // Only the connect phase is retried: once a response exists, part of the reply may already have been shown.
  const send = async (): Promise<Response> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal });
      } catch (error) {
        if (attempt >= CONNECT_RETRIES || signal.aborted || !isTransientConnectError(error)) throw error;
        await pause(CONNECT_BACKOFF_MS * 2 ** attempt, signal);
      }
    }
  };

  if (stream) arm(firstByteMs, "模型 " + formatSpan(firstByteMs) + " 内没有开始回复，已中断。");
  let response: Response;
  try {
    response = await send();
  } catch (error) {
    return stopped(error);
  }
  if (!response.ok) {
    try {
      const raw = await response.text().catch(() => "");
      const message = redact(upstreamMessage(raw), [provider.secret]).slice(0, 240);
      return failure(response.status, describeStatus(response.status) + (message ? "：" + message : "。"));
    } finally {
      settle();
    }
  }
  try {
    const type = response.headers.get("content-type") || "";
    const sseBody = type.includes("text/event-stream") ? response.body : null;
    let parsed: Parsed;
    if (sseBody) {
      // Every chunk restarts the stall clock: text, thinking deltas and keep-alive pings all prove the call is alive.
      arm(idleMs, idleMessage);
      const watched = sseBody.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          start(controller) {
            // Error the reader as soon as either clock fires, even when the upstream body ignores the abort.
            signal.addEventListener(
              "abort",
              () => {
                try {
                  controller.error(signal.reason);
                } catch {
                  // the stream already finished
                }
              },
              { once: true },
            );
          },
          transform(chunk, controller) {
            arm(idleMs, idleMessage);
            controller.enqueue(chunk);
          },
        }),
      );
      parsed = claude ? await readClaudeStream(watched, options.onDelta) : await readOpenAiStream(watched, options.onDelta);
    } else {
      parsed = await parseWhole(claude, await response.text(), options.onDelta);
    }
    settle();
    if (parsed.error) {
      return { ...failure(response.status, "上游报错：" + redact(parsed.error, [provider.secret]).slice(0, 240)), text: parsed.text };
    }
    const ok = Boolean(parsed.text.trim()) || parsed.toolCalls.length > 0;
    return {
      ok,
      status: response.status,
      text: parsed.text,
      toolCalls: parsed.toolCalls,
      finish: parsed.finish,
      usage: parsed.usage,
      detail: ok ? "模型已回复。" : parsed.finish === "length" || parsed.finish === "max_tokens"
        ? "模型达到输出上限，但没有返回正文。请降低思考强度、提高输出上限或更换模型。"
        : "模型返回了空内容。",
    };
  } catch (error) {
    return stopped(error);
  }
}

export async function listModels(
  provider: GatewayProvider,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<{ ok: boolean; status: number; models: string[]; detail: string }> {
  if (!provider.secret) return { ok: false, status: 409, models: [], detail: "没有服务端密钥，无法读取模型列表。" };
  if (!provider.baseUrl) return { ok: false, status: 409, models: [], detail: "还没有接口地址。" };
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    const response = await fetchImpl(joinUrl(provider.baseUrl, "models"), { method: "GET", headers: { Accept: "application/json", ...authHeaders(provider) }, signal });
    const raw = await response.text();
    if (!response.ok) {
      const message = redact(upstreamMessage(raw), [provider.secret]).slice(0, 200);
      return { ok: false, status: response.status, models: [], detail: `${describeStatus(response.status)}${message ? `：${message}` : "。"}` };
    }
    const payload = parseJson(raw) ?? {};
    const list = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
    const models = [
      ...new Set(
        (list as unknown[])
          .map((item) => (typeof item === "string" ? item : item && typeof item === "object" ? String((item as Json).id ?? (item as Json).name ?? "") : ""))
          .map((item) => item.replace(/^models\//, "").trim())
          .filter(Boolean),
      ),
    ];
    return { ok: models.length > 0, status: response.status, models, detail: models.length ? `读到 ${models.length} 个模型。` : "上游没有列出模型。" };
  } catch (error) {
    const result = thrown(error, options.signal, provider.secret);
    return { ok: false, status: result.status, models: [], detail: result.detail };
  }
}
