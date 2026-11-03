/**
 * Browser side of the patent agent: decodes agent NDJSON or a no-tool text SSE stream.
 */
import type { AgentEvent, AgentRequest, AgentSource } from "./agent-events.ts";
import { PersonalModelError, withPersonalModel } from './personal-models.ts';
import type { ModelSelection } from './personal-models.ts';

const EVENT_TYPES = new Set(["start", "step", "delta", "tool_call", "tool_result", "notice", "done", "error"]);

export function createNdjsonParser(onEvent: (event: AgentEvent) => void) {
  let buffer = "";
  const emitLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (value && typeof value === "object" && EVENT_TYPES.has(String((value as { type?: unknown }).type))) onEvent(value as AgentEvent);
    } catch {
      // A torn or foreign line is dropped; the terminal event decides success.
    }
  };
  return {
    push(chunk: string) {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        emitLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    },
    end() {
      const rest = buffer;
      buffer = "";
      emitLine(rest);
    },
  };
}

export type AgentOutcome = Extract<AgentEvent, { type: "done" } | { type: "error" }>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function createTextSseParser(onEvent: (event: AgentEvent) => void, headers: Headers) {
  const header = (name: string) => { const value = headers.get(name) || ''; try { return decodeURIComponent(value); } catch { return value; } };
  const headerModel = header("X-PatentFlow-Model");
  const provider = header("X-PatentFlow-Provider");
  let model = headerModel;
  let started = false;
  let terminal = false;
  let stopped = false;
  let buffer = "";
  let skipLf = false;
  let data: string[] = [];
  let eventName = "";
  const parts: string[] = [];
  const usage = { input: 0, output: 0 };
  const start = () => {
    if (started) return;
    started = true;
    onEvent({ type: "start", model, provider, tools: [] });
    onEvent({ type: "step", step: 1, label: "生成回答" });
  };
  const fail = (detail: string, status = 502) => {
    if (terminal) return;
    start();
    terminal = true;
    onEvent({ type: "error", detail, status });
  };
  const finish = () => {
    if (terminal) return;
    const text = parts.join("");
    if (!text.trim()) { fail("模型返回了空内容。"); return; }
    start();
    terminal = true;
    onEvent({ type: "done", text, sources: [], steps: 1, model, usage: { ...usage } });
  };
  const dispatch = () => {
    const raw = data.join("\n");
    const name = eventName;
    const hasData = data.length > 0;
    data = [];
    eventName = "";
    if (name === "error") { fail("上游模型返回错误，回答可能不完整。"); return; }
    if (!hasData) return;
    if (raw.trim() === "[DONE]") { finish(); return; }
    let value: unknown;
    try { value = JSON.parse(raw); } catch { fail("模型数据流格式不完整，请重试。"); return; }
    const payload = record(value);
    if (!payload) { fail("模型数据流格式不完整，请重试。"); return; }
    if (!headerModel && typeof payload.model === "string" && payload.model) model = payload.model;
    start();
    // Do not expose arbitrary upstream error bodies or reasoning transcripts.
    if (payload.error !== undefined && payload.error !== null) { fail("上游模型返回错误，回答可能不完整。"); return; }
    if (headers.get('X-PatentFlow-Protocol') === 'claude') {
      const message = record(payload.message);
      const counts = record(message?.usage ?? payload.usage);
      if (typeof counts?.input_tokens === 'number') usage.input = Math.max(0, counts.input_tokens);
      if (typeof counts?.output_tokens === 'number') usage.output = Math.max(0, counts.output_tokens);
      const block = record(payload.content_block);
      const delta = record(payload.delta);
      if (block?.type === 'tool_use' || delta?.type === 'input_json_delta') { fail('文本流返回了工具调用，回答未完成。'); return; }
      const text = payload.type === 'content_block_start' && block?.type === 'text' ? block.text : payload.type === 'content_block_delta' && delta?.type === 'text_delta' ? delta.text : '';
      if (typeof text === 'string' && text) { parts.push(text); onEvent({ type: 'delta', text }); }
      if (payload.type === 'message_delta' && delta?.stop_reason) {
        if (delta.stop_reason === 'end_turn' || delta.stop_reason === 'stop_sequence') stopped = true;
        else fail(delta.stop_reason === 'max_tokens' ? '模型达到输出上限，回答可能不完整。' : '模型未正常完成回答，请重试。');
      }
      if (payload.type === 'message_stop') { if (stopped) finish(); else fail('模型未正常结束，回答可能不完整。'); }
      return;
    }
    const counts = record(payload.usage);
    if (typeof counts?.prompt_tokens === "number" && Number.isFinite(counts.prompt_tokens) && counts.prompt_tokens >= 0) usage.input = counts.prompt_tokens;
    if (typeof counts?.completion_tokens === "number" && Number.isFinite(counts.completion_tokens) && counts.completion_tokens >= 0) usage.output = counts.completion_tokens;
    const choice = Array.isArray(payload.choices)
      ? payload.choices.map(record).find(item => item && (item.index === undefined || item.index === 0)) : null;
    if (!choice) return;
    const delta = record(choice.delta);
    if ((Array.isArray(delta?.tool_calls) && delta.tool_calls.length) || delta?.function_call) {
      fail("文本流返回了工具调用，回答未完成。");
      return;
    }
    if (typeof delta?.content === "string" && delta.content) {
      parts.push(delta.content);
      onEvent({ type: "delta", text: delta.content });
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (choice.finish_reason === "stop") stopped = true;
      else fail(choice.finish_reason === "length" ? "模型达到输出上限，回答可能不完整。" : "模型未正常完成回答，请重试。");
    }
  };
  const line = (value: string) => {
    if (!value) { dispatch(); return; }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const field = colon < 0 ? value : value.slice(0, colon);
    const content = colon < 0 ? "" : value.slice(colon + 1).replace(/^ /, "");
    if (field === "data") data.push(content);
    else if (field === "event") eventName = content;
  };
  return {
    push(chunk: string) {
      if (terminal || !chunk) return;
      let from = skipLf && chunk.startsWith("\n") ? 1 : 0;
      skipLf = false;
      for (let at = from; at < chunk.length; at++) {
        if (chunk[at] !== "\n" && chunk[at] !== "\r") continue;
        line(buffer + chunk.slice(from, at));
        buffer = "";
        if (terminal) return;
        if (chunk[at] === "\r") {
          if (chunk[at + 1] === "\n") at++;
          else if (at === chunk.length - 1) skipLf = true;
        }
        from = at + 1;
      }
      buffer += chunk.slice(from);
    },
    end() {
      if (terminal) return;
      // Unframed trailing data must not turn a torn response into a complete answer.
      if (buffer || data.length || !stopped) fail("连接中断，回答可能不完整。", 0);
      else finish();
    },
  };
}

export async function streamAgent(request: AgentRequest, onEvent: (event: AgentEvent) => void, signal?: AbortSignal, selection?: ModelSelection): Promise<AgentOutcome> {
  const seen: { terminal: AgentOutcome | null } = { terminal: null };
  const forward = (event: AgentEvent) => {
    signal?.throwIfAborted();
    if (event.type === "done" || event.type === "error") seen.terminal = event;
    onEvent(event);
  };
  try {
    signal?.throwIfAborted();
    const response = await fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson, text/event-stream" },
      body: JSON.stringify(selection ? { ...request, ...selection } : withPersonalModel(request)),
      signal,
    });
    if (!response.ok || !response.body) {
      const payload = record(await response.json().catch(() => null));
      signal?.throwIfAborted();
      const detail = typeof payload?.error === "string" ? payload.error : typeof payload?.detail === "string" ? payload.detail : "";
      const failed: AgentOutcome = { type: "error", detail: detail || `服务端返回 ${response.status}`, status: response.status };
      onEvent(failed);
      return failed;
    }
    const sse = response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() === "text/event-stream";
    const parser = sse ? createTextSseParser(forward, response.headers) : createNdjsonParser(forward);
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: sse });
    let ended = false;
    let cancelled = false;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      // Do not wait for a stalled producer's cancellation acknowledgement.
      void reader.cancel().catch(() => {});
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      signal?.throwIfAborted();
      while (true) {
        const { done, value } = await reader.read();
        signal?.throwIfAborted();
        if (done) { ended = true; break; }
        parser.push(decoder.decode(value, { stream: true }));
        signal?.throwIfAborted();
        if (sse && seen.terminal) break;
      }
      if (!sse || !seen.terminal) {
        parser.push(decoder.decode());
        parser.end();
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
      if (!ended) cancel();
      reader.releaseLock();
    }
  } catch (error) {
    const aborted = signal?.aborted || (error instanceof DOMException && error.name === "AbortError");
    const failed: AgentOutcome = { type: "error", detail: aborted ? "已停止。" : error instanceof PersonalModelError ? error.message : "暂时连不上服务，请稍后重试。", status: 0 };
    onEvent(failed);
    return failed;
  }
  if (seen.terminal) return seen.terminal;
  const cut: AgentOutcome = { type: "error", detail: "连接中断，回答可能不完整。", status: 0 };
  onEvent(cut);
  return cut;
}

/** Keep only sources the answer actually cites as [n]; fall back to all when none are cited. */
export function citedSources(text: string, sources: AgentSource[]): AgentSource[] {
  const cited = new Set<number>();
  for (const match of text.matchAll(/\[(\d{1,3})\]/g)) cited.add(Number(match[1]));
  const hits = sources.filter((source) => cited.has(source.n));
  return hits.length ? hits : sources;
}

export async function refreshProviderModels(id: string): Promise<{ ok: boolean; detail: string; fetched: number }> {
  try {
    const response = await fetch("/api/providers/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const body = (await response.json()) as { ok?: boolean; detail?: string; error?: string; fetched?: number };
    return { ok: Boolean(body.ok), detail: body.detail || body.error || "没有读到模型列表。", fetched: body.fetched ?? 0 };
  } catch {
    return { ok: false, detail: "暂时连不上服务，请稍后重试。", fetched: 0 };
  }
}

export async function extractPage(url: string): Promise<{ ok: boolean; title: string; url: string; content: string; detail: string }> {
  try {
    const response = await fetch("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const body = (await response.json()) as { ok?: boolean; title?: string; url?: string; content?: string; detail?: string; error?: string };
    return { ok: Boolean(body.ok), title: body.title || "", url: body.url || url, content: body.content || "", detail: body.detail || body.error || "" };
  } catch {
    return { ok: false, title: "", url, content: "", detail: "暂时连不上服务，请稍后重试。" };
  }
}
