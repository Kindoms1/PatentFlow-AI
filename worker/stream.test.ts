import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { TestContext } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import worker from "./index.ts";
import { authenticated, completion, context, environment } from "./test-helpers.ts";

beforeEach((t) => {
  (t as TestContext).mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request in Worker test"); });
});

function stalledUpstream(t: TestContext) {
  let signal: AbortSignal | undefined;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let finish!: (response: Response) => void;
  let fail!: (reason: unknown) => void;
  const pending = new Promise<Response>((resolve, reject) => { finish = resolve; fail = reject; });
  t.mock.method(globalThis, "fetch", (_input: unknown, init: RequestInit) => {
    signal = init.signal!;
    signal.addEventListener("abort", () => fail(new DOMException("Synthetic abort", "AbortError")), { once: true });
    started();
    return pending;
  });
  t.after(() => { finish(completion()); });
  return { ready, get signal() { return signal!; } };
}

test("cancelling a quiet agent stream aborts upstream after queued writes have drained", { timeout: 2000 }, async (t) => {
  const upstream = stalledUpstream(t);
  const env = environment();
  const ctx = context();
  const response = await worker.fetch(await authenticated("/api/agent", env, {
    method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "synthetic" }] }),
  }), env, ctx);
  await upstream.ready;
  const reader = response.body!.getReader();
  for (const expected of ["start", "step"]) {
    const chunk = await reader.read();
    assert.equal(JSON.parse(new TextDecoder().decode(chunk.value)).type, expected);
  }
  await tick();
  assert.equal(upstream.signal.aborted, false);
  await reader.cancel();
  await tick();
  assert.equal(upstream.signal.aborted, true, "cancel must be observed even with no pending writer.write");
  await Promise.all(ctx.tasks);
});

for (const [path, body] of [
  ["/api/chat", { messages: [{ role: "user", content: "synthetic" }] }],
  ["/api/search", { query: "synthetic" }],
  ["/api/extract", { url: "https://page.example.test/synthetic" }],
  ["/api/radar/run", { topic: { id: "synthetic", keywords: ["synthetic"] } }],
] as const) {
  test(`request cancellation aborts ${path} before response headers`, { timeout: 2000 }, async (t) => {
    const upstream = stalledUpstream(t);
    const client = new AbortController();
    const env = environment();
    const ctx = context();
    const response = worker.fetch(await authenticated(path, env, { method: "POST", body: JSON.stringify(body), signal: client.signal }), env, ctx);
    await upstream.ready;
    client.abort();
    await tick();
    assert.equal(upstream.signal.aborted, true);
    await (await response).text();
    await Promise.all(ctx.tasks);
  });
}

test("request cancellation also stops an agent response that is already streaming", { timeout: 2000 }, async (t) => {
  const upstream = stalledUpstream(t);
  const client = new AbortController();
  const env = environment();
  const ctx = context();
  const response = await worker.fetch(await authenticated("/api/agent", env, {
    method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "synthetic" }] }), signal: client.signal,
  }), env, ctx);
  await upstream.ready;
  client.abort();
  await tick();
  assert.equal(upstream.signal.aborted, true);
  await response.body!.cancel().catch(() => {});
  await Promise.all(ctx.tasks);
});

test("a normal agent response preserves all queued NDJSON events and finishes once", { timeout: 2000 }, async (t) => {
  let signal: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    signal = init.signal!;
    return completion("synthetic final answer");
  });
  const env = environment();
  const ctx = context();
  const response = await worker.fetch(await authenticated("/api/agent", env, {
    method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "synthetic" }] }),
  }), env, ctx);
  await Promise.all(ctx.tasks);
  await tick();
  const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type), ["start", "step", "delta", "done"]);
  assert.equal(events.at(-1).text, "synthetic final answer");
  assert.equal(signal!.aborted, false, "normal stream close must not abort completed work");
  assert.ok(response.headers.get("Content-Type")!.startsWith("application/x-ndjson"));
});

test("upstream failure produces one redacted terminal error and closes the stream", { timeout: 2000 }, async (t) => {
  const env = environment();
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: { message: `synthetic refusal ${env.AGNES_API_KEY}` } }, { status: 401 }));
  const ctx = context();
  const response = await worker.fetch(await authenticated("/api/agent", env, {
    method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "synthetic" }] }),
  }), env, ctx);
  const text = await response.text();
  const events = text.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.type === "error").length, 1);
  assert.equal(events.at(-1).status, 401);
  assert.equal(text.includes(env.AGNES_API_KEY!), false);
  await Promise.all(ctx.tasks);
});
