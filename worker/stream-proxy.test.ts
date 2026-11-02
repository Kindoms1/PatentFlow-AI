import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { TestContext } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { ReadableStream as NodeReadableStream } from "node:stream/web";
import worker from "./index.ts";
import { authenticated, completion, context, environment } from "./test-helpers.ts";

const enc = new TextEncoder();
const frame = (text: string) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n';
const end = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n';
const sample = frame("专利🌱") + end;

beforeEach((t) => {
  (t as TestContext).mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request in proxy test"); });
});

function bytes(text: string, size = 7) {
  const data = enc.encode(text);
  let offset = 0;
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      if (offset === data.length) controller.close();
      else { controller.enqueue(data.slice(offset, offset + size)); offset = Math.min(offset + size, data.length); }
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, get pulled() { return pulled; }, get cancelled() { return cancelled; } };
}

async function request(env = environment(), extra: Record<string, unknown> = {}, headers: HeadersInit = { Accept: "text/event-stream" }, signal?: AbortSignal) {
  return authenticated("/api/agent", env, {
    method: "POST", headers, signal, body: JSON.stringify({ messages: [{ role: "user", content: "synthetic question" }], tools: false, ...extra }),
  });
}

for (const [tools, accept, fast] of [
  [false, "text/event-stream", true],
  [false, "application/json, TEXT/EVENT-STREAM;q=1", true],
  [false, "text/event-stream;q=0", false],
  [false, "text/event-streaming", false],
  [false, "*/*", false],
  [false, "application/x-ndjson", false],
  [true, "text/event-stream", false],
  [undefined, "text/event-stream", false],
] as const) {
  test(`SSE negotiation tools=${tools} accept=${accept}`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response(sample, { headers: { "Content-Type": "text/event-stream" } }));
    const env = environment();
    const ctx = context();
    const response = await worker.fetch(await request(env, { tools }, { Accept: accept }), env, ctx);
    assert.ok(response.headers.get("Content-Type")!.startsWith(fast ? "text/event-stream" : "application/x-ndjson"));
    const body = await response.text();
    if (fast) {
      assert.equal(body, sample);
      assert.equal(response.headers.get("X-PatentFlow-Model"), "agnes-2.5-flash");
      assert.equal(response.headers.get("X-PatentFlow-Provider"), "css-agent");
      assert.equal(ctx.tasks.length, 0, "the SSE producer cannot depend on waitUntil");
    } else {
      assert.equal(JSON.parse(body.trim().split('\n').at(-1)!).type, "done");
      await Promise.all(ctx.tasks);
    }
  });
}

test("long SSE drains to its original completion without token JSON parsing or detached work", async (t) => {
  const text = frame("灌溉🌱").repeat(7000) + end;
  const source = bytes(text, 97);
  t.mock.method(globalThis, "fetch", async () => new Response(source.stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8" } }));
  const env = environment();
  const ctx = context();
  const response = await worker.fetch(await request(env), env, ctx);
  assert.equal(ctx.tasks.length, 0);
  assert.ok(source.pulled < 3, "the complete response must not be buffered before downstream demand");
  t.mock.method(JSON, "parse", () => { throw new Error("token JSON parsing is forbidden"); });
  t.mock.method(JSON, "stringify", () => { throw new Error("token JSON serialization is forbidden"); });
  assert.equal(await response.text(), text);
});

test("SSE redaction spans every byte split, masks both keys, and preserves UTF-8 and completion", async (t) => {
  const env = environment({ AGNES_API_KEY: "synthetic-long-model-key", ANYSEARCH_API_KEY: "synthetic-search-key" });
  const raw = frame('前🌱' + env.AGNES_API_KEY + '中文' + env.ANYSEARCH_API_KEY + '尾') + end;
  const expected = raw.replaceAll(env.AGNES_API_KEY!, "[密钥已隐藏]").replaceAll(env.ANYSEARCH_API_KEY!, "[密钥已隐藏]");
  for (const size of [1, 2, 7, 19, 61]) {
    const source = bytes(raw, size);
    t.mock.method(globalThis, "fetch", async () => new Response(source.stream, { headers: { "Content-Type": "text/event-stream" } }));
    const ctx = context();
    const response = await worker.fetch(await request(env), env, ctx);
    assert.equal(await response.text(), expected);
    assert.equal(ctx.tasks.length, 0);
  }
});

test("SSE redaction handles overlapping keys and flushes a harmless partial-key suffix", async (t) => {
  const env = environment({ AGNES_API_KEY: "synthetic-key-long", ANYSEARCH_API_KEY: "synthetic-key" });
  const raw = frame('synthetic-key-long synthetic-key') + end + ': synthetic-ke';
  t.mock.method(globalThis, "fetch", async () => new Response(bytes(raw, 1).stream, { headers: { "Content-Type": "text/event-stream" } }));
  const response = await worker.fetch(await request(env), env, context());
  assert.equal(await response.text(), raw.replaceAll('synthetic-key-long', '[密钥已隐藏]').replaceAll('synthetic-key', '[密钥已隐藏]'));
});

test("proxy fixes endpoint, model and auth from server config and respects sanitized messages and token caps", async (t) => {
  const env = environment({ MAX_OUTPUT_TOKENS: "128", AGNES_MODEL: "server-model" });
  const calls: Array<{ input: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (input: unknown, init: RequestInit) => { calls.push({ input: String(input), init }); return new Response(sample, { headers: { "Content-Type": "text/event-stream" } }); });
  const messages = [{ role: "tool", content: "not accepted" }, ...Array.from({ length: 45 }, (_, i) => ({ role: "user", content: 'message-' + i, secret: "injected" }))];
  for (const maxTokens of [undefined, null, "999999", -1, 999999]) {
    const response = await worker.fetch(await request(env, { messages, maxTokens, providerId: "evil", baseUrl: "https://evil.example.test", model: "evil", secret: "injected", thinking: { type: "enabled" } }), env, context());
    await response.text();
    const call = calls.at(-1)!;
    const payload = JSON.parse(String(call.init.body));
    assert.equal(call.input, "https://model.example.test/v1/chat/completions");
    assert.equal(new Headers(call.init.headers).get("Authorization"), 'Bearer ' + env.AGNES_API_KEY);
    assert.equal(payload.model, "server-model");
    assert.equal(payload.stream, true);
    assert.equal(payload.max_tokens, 128);
    assert.equal(payload.messages.length, 40);
    assert.deepEqual(payload.messages[0], { role: "user", content: "message-5" });
    for (const name of ["tools", "providerId", "baseUrl", "secret", "thinking"]) assert.equal(name in payload, false);
    assert.equal(String(call.init.body).includes(env.AGNES_API_KEY!), false);
    assert.equal(String(call.init.body).includes(env.ANYSEARCH_API_KEY!), false);
  }
  assert.equal(calls.length, 5);
});

test("official DeepSeek V4 disables thinking with the same server gateway match rules", async (t) => {
  for (const [url, model, expected] of [
    ["https://api.deepseek.com/v1", "deepseek-v4-flash", true],
    ["https://api.deepseek.com", "deepseek-flash", true],
    ["https://api.deepseek.com/v1", "deepseek-v4-pro-2026", true],
    ["https://api.deepseek.com.evil.test/v1", "deepseek-v4-flash", false],
    ["https://model.example.test/v1", "deepseek-v4-flash", false],
    ["https://api.deepseek.com/v1", "other-model", false],
  ] as const) {
    let thinking: unknown;
    t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => { thinking = JSON.parse(String(init.body)).thinking; return new Response(sample, { headers: { "Content-Type": "text/event-stream" } }); });
    const env = environment({ AGNES_BASE_URL: url, AGNES_MODEL: model });
    await (await worker.fetch(await request(env), env, context())).text();
    assert.deepEqual(thinking, expected ? { type: "disabled" } : undefined);
  }
});

test("non-SSE JSON becomes the existing NDJSON event contract from one model request", async (t) => {
  const env = environment();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ choices: [{ message: { content: 'answer ' + env.AGNES_API_KEY + ' ' + env.ANYSEARCH_API_KEY }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 9 } }); });
  const ctx = context();
  const response = await worker.fetch(await request(env), env, ctx);
  const text = await response.text();
  const events = text.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(response.headers.get("Content-Type")!.startsWith("application/x-ndjson"));
  assert.deepEqual(events.map(event => event.type), ["start", "step", "delta", "done"]);
  assert.deepEqual(events.at(-1), { type: "done", text: "answer [密钥已隐藏] [密钥已隐藏]", sources: [], steps: 1, model: "agnes-2.5-flash", usage: { input: 7, output: 9 } });
  assert.equal(calls, 1);
  assert.equal(ctx.tasks.length, 0);
});

test("upstream HTTP failures preserve useful status without exposing either key or forwarding headers", async (t) => {
  for (const status of [401, 429, 503]) {
    const env = environment();
    const source = bytes(env.AGNES_API_KEY + ' ' + env.ANYSEARCH_API_KEY, 1);
    t.mock.method(globalThis, "fetch", async () => new Response(source.stream, { status, headers: { Location: 'https://evil.example.test', 'X-Secret': env.AGNES_API_KEY! } }));
    const ctx = context();
    const response = await worker.fetch(await request(env), env, ctx);
    const text = await response.text();
    assert.equal(response.status, status);
    assert.equal(text.includes(env.AGNES_API_KEY!), false);
    assert.equal(text.includes(env.ANYSEARCH_API_KEY!), false);
    assert.equal(response.headers.get('X-Secret'), null);
    assert.equal(response.headers.get('Location'), null);
    assert.equal(source.cancelled, true);
    assert.equal(ctx.tasks.length, 0);
  }
});

test("downstream cancellation aborts the upstream request and cancels the source", async (t) => {
  let signal!: AbortSignal;
  const source = bytes(frame('long output').repeat(1000) + end, 256);
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => { signal = init.signal!; return new Response(source.stream, { headers: { "Content-Type": "text/event-stream" } }); });
  const env = environment();
  const response = await worker.fetch(await request(env), env, context());
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  await tick();
  assert.equal(signal.aborted, true);
  assert.equal(source.cancelled, true);
  assert.ok(source.pulled < 5);
});

test("client abort after headers cancels a quiet upstream stream", async (t) => {
  let cancelled = false;
  const client = new AbortController();
  let signal!: AbortSignal;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => { signal = init.signal!; return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "Content-Type": "text/event-stream" } }); });
  const env = environment();
  const response = await worker.fetch(await request(env, {}, undefined, client.signal), env, context());
  const read = response.text();
  client.abort();
  await assert.rejects(read);
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true);
});

test("missing credentials and malformed messages do not call upstream", async () => {
  const env = environment({ AGNES_API_KEY: "" });
  assert.equal((await worker.fetch(await request(env), env, context())).status, 409);
  const configured = environment();
  const response = await worker.fetch(await request(configured, { messages: [{ role: "tool", content: "invalid" }] }), configured, context());
  assert.equal(JSON.parse((await response.text()).trim()).type, "error");
});

test("SSE negotiation does not change the chat route or bypass origin, rate and size checks", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return completion(); });
  const env = environment({ AGENT_PER_HOUR: "1" });
  const ctx = context();
  const chat = await worker.fetch(await authenticated("/api/chat", env, { method: "POST", headers: { Accept: "text/event-stream" }, body: JSON.stringify({ tools: false, messages: [{ role: "user", content: "synthetic" }] }) }), env, ctx);
  assert.ok(chat.headers.get("Content-Type")!.startsWith("application/json"));
  await chat.text();
  await Promise.all(ctx.tasks);
  assert.equal((await worker.fetch(await request(env), env, context())).status, 429);
  const originEnv = environment();
  assert.equal((await worker.fetch(await request(originEnv, {}, { Accept: "text/event-stream", Origin: "https://evil.example.test" }), originEnv, context())).status, 403);
  const sizeEnv = environment({ MAX_BODY_BYTES: "1" });
  assert.equal((await worker.fetch(await request(sizeEnv), sizeEnv, context())).status, 413);
  assert.equal(calls, 1);
});

test("client cancellation before upstream headers ends the fetch without waiting for detached work", async (t) => {
  const client = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(globalThis, "fetch", (_input: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(new Error("synthetic private upstream failure")), { once: true });
    started();
  }));
  const env = environment();
  const ctx = context();
  const pending = worker.fetch(await request(env, {}, undefined, client.signal), env, ctx);
  await ready;
  client.abort();
  const response = await pending;
  assert.equal(response.status, 499);
  assert.doesNotMatch(await response.text(), /private upstream/);
  assert.equal(ctx.tasks.length, 0);
});

test("a transport failure closes the SSE stream without exposing the upstream exception", async (t) => {
  const env = environment();
  let first = true;
  let signal!: AbortSignal;
  const source = new ReadableStream<Uint8Array>({ pull(controller) {
    if (first) { first = false; controller.enqueue(enc.encode(frame("synthetic output"))); }
    else controller.error(new Error(env.AGNES_API_KEY));
  } }, { highWaterMark: 0 });
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => { signal = init.signal!; return new Response(source, { headers: { "Content-Type": "text/event-stream" } }); });
  const response = await worker.fetch(await request(env), env, context());
  await assert.rejects(response.text(), /上游连接中断/);
  assert.equal(signal.aborted, true);
});

test("invalid or error JSON responses terminate once without another model call or secret leakage", async (t) => {
  const env = environment();
  let calls = 0;
  for (const raw of ['{', JSON.stringify({ error: { message: env.AGNES_API_KEY + ' ' + env.ANYSEARCH_API_KEY } })]) {
    t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(raw, { headers: { "Content-Type": "application/json" } }); });
    const response = await worker.fetch(await request(env), env, context());
    const text = await response.text();
    const event = JSON.parse(text.trim());
    assert.equal(event.type, "error");
    assert.equal(event.status, 502);
    assert.equal(text.includes(env.AGNES_API_KEY!), false);
    assert.equal(text.includes(env.ANYSEARCH_API_KEY!), false);
  }
  assert.equal(calls, 2);
});

test("an oversized JSON fallback is cancelled instead of buffered without a bound", async (t) => {
  const source = bytes('x'.repeat(2_100_000), 64_000);
  t.mock.method(globalThis, "fetch", async () => new Response(source.stream, { headers: { "Content-Type": "application/json" } }));
  const env = environment();
  const response = await worker.fetch(await request(env), env, context());
  assert.equal(JSON.parse((await response.text()).trim()).type, "error");
  assert.equal(source.cancelled, true);
  assert.ok(source.pulled < 34);
});

test("native BYOB reads batch at 64 KiB with fresh buffers and preserve a partial EOF chunk", async (t) => {
  const env = environment();
  const firstSize = 128;
  const secretOffset = firstSize + 65_536 - 8;
  const raw = ': ' + 'x'.repeat(secretOffset - 2) + env.AGNES_API_KEY + '🌱中文' + 'y'.repeat(70_000) + env.ANYSEARCH_API_KEY + '\n\n' + end;
  const data = enc.encode(raw);
  const source = bytes(raw, 11).stream;
  const getReader = source.getReader.bind(source);
  const calls: Array<{ min: number; capacity: number; size: number; done: boolean }> = [];
  const buffers = new Set<ArrayBufferLike>();
  let offset = 0;
  let released = 0;
  let defaults = 0;
  const byob = {
    async readAtLeast(min: number, view: Uint8Array) {
      assert.equal(view.byteLength, 65_536);
      assert.equal(buffers.has(view.buffer), false, "a detached buffer must never be reused");
      buffers.add(view.buffer);
      const size = Math.min(calls.length ? 65_536 : firstSize, data.length - offset);
      view.set(data.subarray(offset, offset + size));
      offset += size;
      const transferred = structuredClone(view.buffer, { transfer: [view.buffer] });
      assert.equal(view.byteLength, 0);
      calls.push({ min, capacity: transferred.byteLength, size, done: size === 0 });
      return { value: new Uint8Array(transferred, 0, size), done: size === 0 };
    },
    async cancel() {},
    releaseLock() { released++; },
  };
  t.mock.method(source, "getReader", (options?: { mode?: string }) => {
    if (options?.mode === "byob") return byob;
    defaults++;
    return getReader();
  });
  t.mock.method(globalThis, "fetch", async () => new Response(source, { headers: { "Content-Type": "text/event-stream" } }));
  const response = await worker.fetch(await request(env), env, context());
  assert.equal(await response.text(), raw.replaceAll(env.AGNES_API_KEY!, '[密钥已隐藏]').replaceAll(env.ANYSEARCH_API_KEY!, '[密钥已隐藏]'));
  assert.equal(defaults, 0);
  assert.deepEqual(calls.map(call => call.min), [1, 65_536, 65_536, 65_536, 65_536]);
  assert.ok(calls.at(-2)!.size > 0 && calls.at(-2)!.size < 65_536);
  assert.equal(calls.at(-2)!.done, false);
  assert.equal(calls.at(-1)!.done, true);
  assert.equal(released, 1);
});

test("a BYOB reader without readAtLeast is unlocked before default-reader fallback", async (t) => {
  const env = environment();
  const data = enc.encode(sample);
  const source = new NodeReadableStream({ type: "bytes", start(controller) { controller.enqueue(data); controller.close(); } }) as unknown as ReadableStream<Uint8Array>;
  const getReader = source.getReader.bind(source);
  const modes: string[] = [];
  t.mock.method(source, "getReader", (options?: { mode?: string }) => {
    modes.push(options?.mode || "default");
    assert.equal(source.locked, false, "unused BYOB lock must be released before fallback");
    return options?.mode === "byob" ? getReader({ mode: "byob" }) : getReader();
  });
  t.mock.method(globalThis, "fetch", async () => new Response(source, { headers: { "Content-Type": "text/event-stream" } }));
  const response = await worker.fetch(await request(env), env, context());
  assert.equal(await response.text(), sample);
  assert.deepEqual(modes, ["byob", "default"]);
});
