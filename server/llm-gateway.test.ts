import assert from "node:assert/strict";
import test from "node:test";
import { complete, joinUrl, listModels, readSse, redact, toClaudePayload, toOpenAiMessages } from "./llm-gateway.ts";
import type { GatewayProvider, Turn } from "./llm-gateway.ts";

const SECRET = "sk-test-secret-123456";

function provider(protocol: "openai" | "claude", extra: Partial<GatewayProvider> = {}): GatewayProvider {
  return { id: "p", name: "P", protocol, baseUrl: "https://api.example.com/v1", model: "m-1", secret: SECRET, auth: protocol === "claude" ? "x-api-key" : "bearer", ...extra };
}

function sse(events: unknown[], named = false): string {
  return events
    .map((event) => {
      const data = typeof event === "string" ? event : JSON.stringify(event);
      const type = named && typeof event === "object" && event ? `event: ${(event as { type: string }).type}\n` : "";
      return `${type}data: ${data}\n\n`;
    })
    .join("");
}

function chunked(text: string, size = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

test("joinUrl normalizes common base shapes", () => {
  assert.equal(joinUrl("https://apihub.agnes-ai.com/v1", "chat/completions"), "https://apihub.agnes-ai.com/v1/chat/completions");
  assert.equal(joinUrl("https://apihub.agnes-ai.com/v1/", "models"), "https://apihub.agnes-ai.com/v1/models");
  assert.equal(joinUrl("https://api.deepseek.com", "chat/completions"), "https://api.deepseek.com/v1/chat/completions");
  assert.equal(joinUrl("https://open.bigmodel.cn/api/paas/v4", "chat/completions"), "https://open.bigmodel.cn/api/paas/v4/chat/completions");
  assert.equal(joinUrl("https://x.com/v1/chat/completions", "models"), "https://x.com/v1/models");
  assert.equal(joinUrl("https://api.anthropic.com", "messages"), "https://api.anthropic.com/v1/messages");
});

test("redact masks secrets", () => {
  assert.equal(redact(`bad key ${SECRET}!`, [SECRET, undefined]), "bad key [密钥已隐藏]!");
});

test("readSse handles split chunks, CRLF and comments", async () => {
  const text = ": ping\r\nevent: a\r\ndata: one\r\ndata: two\r\n\r\ndata: {\"x\":1}\n\n";
  const out = [];
  for await (const item of readSse(chunked(text, 3))) out.push(item);
  assert.deepEqual(out, [
    { event: "a", data: "one\ntwo" },
    { event: "message", data: "{\"x\":1}" },
  ]);
});

test("OpenAI stream yields text deltas and assembled tool calls", async () => {
  const body = sse([
    { choices: [{ index: 0, delta: { role: "assistant", content: "先" } }] },
    { choices: [{ index: 0, delta: { content: "检索。" } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "web_search", arguments: "{\"que" } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "ry\":\"云检测\"}" } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 4 } },
    "[DONE]",
  ]);
  let seenBody: Record<string, unknown> = {};
  let seenUrl = "";
  let seenAuth = "";
  const deltas: string[] = [];
  const result = await complete(provider("openai"), [{ role: "user", content: "查新" }], {
    tools: [{ name: "web_search", description: "d", parameters: { type: "object" } }],
    onDelta: (text) => deltas.push(text),
    fetchImpl: (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init.body));
      seenAuth = (init.headers as Record<string, string>).Authorization;
      return new Response(chunked(body, 11), { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch,
  });
  assert.equal(seenUrl, "https://api.example.com/v1/chat/completions");
  assert.equal(seenAuth, `Bearer ${SECRET}`);
  assert.equal(seenBody.stream, true);
  assert.equal((seenBody.tools as unknown[]).length, 1);
  assert.equal(result.ok, true);
  assert.equal(result.text, "先检索。");
  assert.deepEqual(deltas, ["先", "检索。"]);
  assert.deepEqual(result.toolCalls, [{ id: "call_a", name: "web_search", arguments: "{\"query\":\"云检测\"}" }]);
  assert.equal(result.finish, "tool_calls");
  assert.deepEqual(result.usage, { input: 10, output: 4 });
});

test("OpenAI non-stream JSON reply is accepted", async () => {
  const result = await complete(provider("openai"), [{ role: "user", content: "hi" }], {
    stream: false,
    fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { content: "你好" }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, "你好");
});

test("Claude stream yields text and tool_use", async () => {
  const body = sse(
    [
      { type: "message_start", message: { usage: { input_tokens: 21 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "我来查" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "web_search", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"query\":" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"专利\"}" } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
      { type: "message_stop" },
    ],
    true,
  );
  let headers: Record<string, string> = {};
  let url = "";
  let sent: Record<string, unknown> = {};
  const result = await complete(provider("claude", { baseUrl: "https://api.anthropic.com" }), [
    { role: "system", content: "你是专利助手" },
    { role: "user", content: "查一下" },
  ], {
    tools: [{ name: "web_search", description: "d", parameters: { type: "object" } }],
    fetchImpl: (async (target: string, init: RequestInit) => {
      url = target;
      headers = init.headers as Record<string, string>;
      sent = JSON.parse(String(init.body));
      return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
    }) as unknown as typeof fetch,
  });
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(headers["x-api-key"], SECRET);
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(sent.system, "你是专利助手");
  assert.deepEqual((sent.tools as Array<{ input_schema: unknown }>)[0].input_schema, { type: "object" });
  assert.equal(result.ok, true);
  assert.equal(result.text, "我来查");
  assert.deepEqual(result.toolCalls, [{ id: "toolu_1", name: "web_search", arguments: "{\"query\":\"专利\"}" }]);
  assert.deepEqual(result.usage, { input: 21, output: 9 });
});

test("upstream errors are mapped and never echo the secret", async () => {
  const result = await complete(provider("openai"), [{ role: "user", content: "hi" }], {
    fetchImpl: (async () => new Response(JSON.stringify({ error: { message: `Incorrect API key ${SECRET}` } }), { status: 401 })) as unknown as typeof fetch,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.match(result.detail, /密钥无效/);
  assert.ok(!result.detail.includes(SECRET));
});

test("missing secret short-circuits without a request", async () => {
  let called = false;
  const result = await complete(provider("openai", { secret: "" }), [{ role: "user", content: "hi" }], {
    fetchImpl: (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch,
  });
  assert.equal(called, false);
  assert.equal(result.ok, false);
});

test("caller abort reports 已停止", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await complete(provider("openai"), [{ role: "user", content: "hi" }], {
    signal: controller.signal,
    fetchImpl: (async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return new Response("{}");
    }) as unknown as typeof fetch,
  });
  assert.equal(result.detail, "已停止。");
});

test("message converters keep tool turns valid for both protocols", () => {
  const turns: Turn[] = [
    { role: "system", content: "S" },
    { role: "user", content: "Q" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "web_search", arguments: "{\"query\":\"x\"}" }] },
    { role: "tool", toolCallId: "c1", name: "web_search", content: "R" },
  ];
  const openai = toOpenAiMessages(turns);
  assert.equal((openai[2] as { content: unknown }).content, null);
  assert.equal((openai[3] as { tool_call_id: string }).tool_call_id, "c1");
  const claude = toClaudePayload(turns);
  assert.equal(claude.system, "S");
  assert.deepEqual(claude.messages.map((item) => item.role), ["user", "assistant", "user"]);
  assert.deepEqual(claude.messages[1].content[0], { type: "tool_use", id: "c1", name: "web_search", input: { query: "x" } });
  assert.equal(claude.messages[2].content[0].type, "tool_result");
});

test("listModels reads OpenAI-style data arrays", async () => {
  const listed = await listModels(provider("openai"), {
    fetchImpl: (async (url: string) => {
      assert.equal(url, "https://api.example.com/v1/models");
      return new Response(JSON.stringify({ data: [{ id: "agnes-2.5-flash" }, { id: "agnes-3.0-flash" }, { id: "agnes-2.5-flash" }] }));
    }) as unknown as typeof fetch,
  });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.models, ["agnes-2.5-flash", "agnes-3.0-flash"]);
});

test("a streamed reply that goes quiet is cut by the stall clock instead of hanging", async () => {
  const encoder = new TextEncoder();
  const fetchImpl = (async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n'));
        // Then nothing: no more chunks, never closes, and ignores the abort signal.
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const started = Date.now();
  const result = await complete(provider("openai"), [{ role: "user", content: "hi" }], { fetchImpl, idleTimeoutMs: 60 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 408);
  assert.match(result.detail, /没有新输出/);
  assert.ok(Date.now() - started < 3000);
});

test("a long streamed reply that keeps sending is not cut, however long it runs", async () => {
  const encoder = new TextEncoder();
  const parts = ["权利要求书", "说明书", "技术领域", "背景技术", "发明内容", "具体实施方式"];
  const fetchImpl = (async () => {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const part of parts) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          controller.enqueue(encoder.encode("data: " + JSON.stringify({ choices: [{ delta: { content: part } }] }) + "\n\n"));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  // Six gaps of 40 ms run 240 ms in total, well past the 100 ms stall clock, yet no single gap reaches it.
  const result = await complete(provider("openai"), [{ role: "user", content: "hi" }], { fetchImpl, idleTimeoutMs: 100 });
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.text, parts.join(""));
});

test("a streamed call that never starts is cut by the first-byte clock", async () => {
  const fetchImpl = ((_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as typeof fetch;
  const result = await complete(provider("openai"), [{ role: "user", content: "hi" }], { fetchImpl, firstByteTimeoutMs: 50 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 408);
  assert.match(result.detail, /没有开始回复/);
});

test("stopping a streamed call reports a stop, not a timeout", async () => {
  const encoder = new TextEncoder();
  const fetchImpl = (async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"写到一半"}}]}\n\n'));
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 40);
  const result = await complete(provider("openai"), [{ role: "user", content: "hi" }], { fetchImpl, signal: controller.signal, idleTimeoutMs: 5_000 });
  assert.equal(result.ok, false);
  assert.equal(result.finish, "aborted");
  assert.equal(result.detail, "已停止。");
});

import { test as retryTest } from "node:test";
import retryAssert from "node:assert/strict";
import { complete as retryComplete, isTransientConnectError as retryTransient } from "./llm-gateway.ts";

const retryProvider = { protocol: "openai", baseUrl: "https://upstream.test/v1", secret: "sk-retry-test-123456", model: "m" } as unknown as Parameters<typeof retryComplete>[0];
const dropped = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });

retryTest("connect-phase retry: a dropped connection before any response is retried", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) throw dropped();
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "好" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const result = await retryComplete(retryProvider, [{ role: "user", content: "hi" }] as never, { stream: false, fetchImpl });
  retryAssert.equal(calls, 2);
  retryAssert.equal(result.ok, true);
  retryAssert.equal(result.text, "好");
});

retryTest("connect-phase retry: gives up after the retries and reports the cause code", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    throw dropped();
  }) as unknown as typeof fetch;
  const result = await retryComplete(retryProvider, [{ role: "user", content: "hi" }] as never, { stream: false, fetchImpl });
  retryAssert.equal(calls, 3);
  retryAssert.equal(result.ok, false);
  retryAssert.match(result.detail, /fetch failed/);
  retryAssert.match(result.detail, /ECONNRESET/);
});

retryTest("connect-phase retry: aborts and timeouts are not transient", () => {
  retryAssert.equal(retryTransient(dropped()), true);
  retryAssert.equal(retryTransient(Object.assign(new Error("x"), { name: "AbortError" })), false);
  retryAssert.equal(retryTransient(Object.assign(new Error("fetch failed"), { name: "TimeoutError" })), false);
  retryAssert.equal(retryTransient(new Error("上游拒绝")), false);
});
