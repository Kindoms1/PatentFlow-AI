/**
 * Events streamed from the server-side patent agent to the browser as NDJSON.
 * Shared by server/patent-agent.ts (producer) and src/agent-stream.ts (consumer).
 */

export interface AgentSource {
  /** 1-based citation number the model uses as [n]. */
  n: number;
  title: string;
  url: string;
  via: "search" | "extract";
}

export interface AgentUsage {
  input: number;
  output: number;
}

export type AgentEvent =
  | { type: "start"; model: string; provider: string; tools: string[] }
  | { type: "step"; step: number; label: string }
  | { type: "delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; ok: boolean; summary: string; sources: AgentSource[] }
  | { type: "notice"; detail: string }
  | { type: "done"; text: string; sources: AgentSource[]; steps: number; model: string; usage: AgentUsage }
  | { type: "error"; detail: string; status: number; sources?: AgentSource[] };

export type AgentRole = "system" | "user" | "assistant";

export interface AgentRequest {
  messages: Array<{ role: AgentRole; content: string }>;
  providerId?: string;
  /** Allow the model to call AnySearch tools. Defaults to true when a search key is configured. */
  tools?: boolean;
  maxSteps?: number;
  /** Output token cap for long single-step generations such as a full invention draft. */
  maxTokens?: number;
  /** Web search budget for this run; the server caps it at 8. */
  maxSearches?: number;
}

export const TOOL_LABEL: Record<string, string> = {
  web_search: "联网检索",
  read_url: "读取网页",
};
