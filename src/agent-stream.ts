/**
 * Browser side of the patent agent: posts to /api/agent and decodes the NDJSON event stream.
 */
import type { AgentEvent, AgentRequest, AgentSource } from "./agent-events.ts";

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

export async function streamAgent(request: AgentRequest, onEvent: (event: AgentEvent) => void, signal?: AbortSignal): Promise<AgentOutcome> {
  const seen: { terminal: AgentOutcome | null } = { terminal: null };
  const forward = (event: AgentEvent) => {
    if (event.type === "done" || event.type === "error") seen.terminal = event;
    onEvent(event);
  };
  try {
    const response = await fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok || !response.body) {
      const payload = (await response.json().catch(() => null)) as { error?: string; detail?: string } | null;
      const failed: AgentOutcome = { type: "error", detail: payload?.error || payload?.detail || `服务端返回 ${response.status}`, status: response.status };
      onEvent(failed);
      return failed;
    }
    const parser = createNdjsonParser(forward);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
  } catch (error) {
    const aborted = signal?.aborted || (error instanceof DOMException && error.name === "AbortError");
    const failed: AgentOutcome = { type: "error", detail: aborted ? "已停止。" : "暂时连不上服务，请稍后重试。", status: 0 };
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
