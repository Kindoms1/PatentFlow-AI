import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { TestContext } from "node:test";
import worker from "./index.ts";
import { authenticated, completion, context, environment, streamedRequest } from "./test-helpers.ts";

beforeEach((t) => {
  (t as TestContext).mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request in Worker test"); });
});

for (const path of ["/api/agent", "/__access"]) {
  for (const declared of [undefined, "1"]) {
    test(`${path} stops and cancels an oversized body with content-length ${declared ?? "missing"}`, async () => {
      const env = environment({ MAX_BODY_BYTES: "64" });
      const source = streamedRequest(path, Array.from({ length: 8 }, () => new Uint8Array(40)), {
        "Content-Type": path === "/__access" ? "application/x-www-form-urlencoded" : "application/json",
        ...(declared ? { "Content-Length": declared } : {}),
      });
      if (path.startsWith("/api/")) {
        source.request.headers.set("Cookie", (await authenticated(path, env)).headers.get("Cookie")!);
      }
      const response = await worker.fetch(source.request, env, context());
      assert.equal(response.status, 413);
      assert.equal(source.pulled, 2, "reading must stop at the first chunk exceeding the byte cap");
      assert.equal(source.cancelled, true);
    });
  }
}

test("a declared oversized body is cancelled without reading it", async () => {
  const env = environment({ MAX_BODY_BYTES: "64" });
  const source = streamedRequest("/api/agent", [new Uint8Array(100)], { "Content-Length": "100" });
  source.request.headers.set("Cookie", (await authenticated("/api/agent", env)).headers.get("Cookie")!);
  const response = await worker.fetch(source.request, env, context());
  assert.equal(response.status, 413);
  assert.equal(source.pulled, 0);
  assert.equal(source.cancelled, true);
});

test("body read failures become a generic client error", async () => {
  const env = environment();
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.error(new Error("synthetic private read failure")); },
  });
  const init: RequestInit & { duplex: string } = { method: "POST", body, duplex: "half" };
  const request = await authenticated("/api/agent", env, init);
  const response = await worker.fetch(request, env, context());
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), /synthetic private/);
});

test("the exact byte limit accepts a split UTF-8 JSON body", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ messages: [], note: "专利" }));
  const env = environment({ MAX_BODY_BYTES: String(bytes.length), AGNES_API_KEY: "" });
  const source = streamedRequest("/api/agent", Array.from(bytes, (byte) => Uint8Array.of(byte)));
  source.request.headers.set("Cookie", (await authenticated("/api/agent", env)).headers.get("Cookie")!);
  const ctx = context();
  const response = await worker.fetch(source.request, env, ctx);
  assert.equal(response.status, 409, "the body should reach the existing missing-key route response");
  await Promise.all(ctx.tasks);
});

test("bounded login parsing still accepts URL-encoded and multipart forms", async () => {
  for (const multipart of [false, true]) {
    const env = environment();
    const body = multipart ? new FormData() : new URLSearchParams();
    body.set("code", env.ACCESS_CODES!);
    const response = await worker.fetch(new Request("https://app.example.test/__access", { method: "POST", body }), env, context());
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("Location"), "/");
    assert.match(response.headers.get("Set-Cookie")!, /^pf_session=/);
  }
});

test("invalid gate configuration returns an uncached 503 for assets, APIs and login", async () => {
  for (const path of ["/", "/api/providers", "/__access"]) {
    const response = await worker.fetch(new Request(`https://app.example.test${path}`, { method: "POST" }), environment({ ACCESS_CODES: " , " }), context());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
});

test("login refuses cross-origin submissions and does not set a session cookie", async () => {
  const env = environment();
  const response = await worker.fetch(new Request("https://app.example.test/__access", {
    method: "POST", headers: { Origin: "https://other.example.test" }, body: new URLSearchParams({ code: env.ACCESS_CODES! }),
  }), env, context());
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("Set-Cookie"), null);
});

test("login rejects an oversized code instead of authenticating its truncated prefix", async () => {
  const env = environment({ ACCESS_CODES: "x".repeat(200) });
  const response = await worker.fetch(new Request("https://app.example.test/__access", {
    method: "POST", headers: { "CF-Connecting-IP": "synthetic-long-code" }, body: new URLSearchParams({ code: env.ACCESS_CODES + "wrong-suffix" }),
  }), env, context());
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("Set-Cookie"), null);
  assert.equal(response.headers.get("Location"), "/?e=1");
});

for (const path of ["/api/agent", "/api/chat"]) {
  for (const maxTokens of [undefined, null, "999999", -1, 0, 1.9, 999999, { unexpected: true }]) {
    test(`${path} enforces a configured token cap for maxTokens=${JSON.stringify(maxTokens)}`, async (t) => {
      const env = environment({ MAX_OUTPUT_TOKENS: "128" });
      const calls: Record<string, unknown>[] = [];
      t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
        calls.push(JSON.parse(String(init.body)));
        return completion();
      });
      const ctx = context();
      const request = await authenticated(path, env, {
        method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "synthetic question" }], maxTokens, tools: false }),
      });
      const response = await worker.fetch(request, env, ctx);
      assert.equal(response.status, 200);
      await response.text();
      await Promise.all(ctx.tasks);
      assert.equal(calls.length, 1);
      const tokens = calls[0].max_tokens as number;
      assert.ok(Number.isInteger(tokens) && tokens > 0 && tokens <= 128, `upstream max_tokens ${tokens} exceeds the configured cap`);
    });
  }
}

test("non-finite JSON token values cannot bypass the configured cap", async (t) => {
  const env = environment({ MAX_OUTPUT_TOKENS: "1024" });
  let tokens = 0;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    tokens = JSON.parse(String(init.body)).max_tokens;
    return completion();
  });
  const ctx = context();
  const response = await worker.fetch(await authenticated("/api/agent", env, {
    method: "POST", body: '{"messages":[{"role":"user","content":"synthetic"}],"maxTokens":-1e999}',
  }), env, ctx);
  await response.text();
  await Promise.all(ctx.tasks);
  assert.equal(tokens, 1024);
});

test("token settings use finite positive integers and safe defaults", async (t) => {
  for (const [setting, expected] of [[" " , 32000], ["0", 32000], ["-1", 32000], ["invalid", 32000], ["Infinity", 32000], ["0.5", 32000], ["128.9", 128]] as const) {
    const env = environment({ MAX_OUTPUT_TOKENS: setting });
    let tokens = 0;
    t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
      tokens = JSON.parse(String(init.body)).max_tokens;
      return completion();
    });
    const ctx = context();
    const response = await worker.fetch(await authenticated("/api/agent", env, {
      method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "synthetic" }], maxTokens: 999999 }),
    }), env, ctx);
    await response.text();
    await Promise.all(ctx.tasks);
    assert.equal(tokens, expected, `invalid or fractional setting: ${setting}`);
  }
});

test("unauthenticated requests cannot reach assets or API handlers", async () => {
  let assets = 0;
  const env = environment({ ASSETS: { fetch: async () => { assets++; return new Response("synthetic"); } } });
  for (const path of ["/", "/api/providers", "/api/agent"]) {
    const response = await worker.fetch(new Request(`https://app.example.test${path}`), env, context());
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  assert.equal(assets, 0);
});

test("provider metadata omits keys and upstream endpoints and administration remains locked", async () => {
  const env = environment();
  const response = await worker.fetch(await authenticated("/api/providers", env), env, context());
  const text = await response.text();
  assert.equal(response.status, 200);
  for (const privateValue of [env.AGNES_API_KEY, env.ANYSEARCH_API_KEY, env.SESSION_SECRET, env.ACCESS_CODES, env.AGNES_BASE_URL, env.ANYSEARCH_BASE_URL]) {
    assert.equal(text.includes(privateValue!), false);
  }
  for (const path of ["/api/providers", "/api/providers/remove", "/api/ccswitch/import"]) {
    const blocked = await worker.fetch(await authenticated(path, env, { method: "POST", body: "{}" }), env, context());
    assert.equal(blocked.status, 403);
  }
  const models = await worker.fetch(await authenticated("/api/providers/models", env, { method: "POST" }), env, context());
  assert.equal(models.status, 200);
  assert.equal(((await models.json()) as { ok: boolean }).ok, false);
});

test("malformed and non-object JSON is rejected before a provider is called", async () => {
  for (const body of ["{", "[]", "null", "42", '"synthetic"']) {
    const env = environment();
    const response = await worker.fetch(await authenticated("/api/agent", env, { method: "POST", body }), env, context());
    assert.equal(response.status, 400);
  }
});

test("cross-origin API calls are blocked and client provider selection is ignored", async (t) => {
  const env = environment();
  const blocked = await worker.fetch(await authenticated("/api/chat", env, { method: "POST", headers: { Origin: "https://other.example.test" }, body: "{}" }), env, context());
  assert.equal(blocked.status, 403);
  let target = "";
  t.mock.method(globalThis, "fetch", async (input: unknown) => { target = String(input); return completion(); });
  const ctx = context();
  const response = await worker.fetch(await authenticated("/api/chat", env, {
    method: "POST", body: JSON.stringify({ providerId: "unknown-client-provider", messages: [{ role: "user", content: "synthetic" }] }),
  }), env, ctx);
  assert.equal(((await response.json()) as { ok: boolean }).ok, true);
  assert.equal(target, "https://model.example.test/v1/chat/completions");
  await Promise.all(ctx.tasks);
});

test("blank rate configuration uses the default instead of disabling the limit", async () => {
  const env = environment({ AGENT_PER_HOUR: " ", AGNES_API_KEY: "" });
  for (let i = 0; i < 31; i++) {
    const ctx = context();
    const response = await worker.fetch(await authenticated("/api/chat", env, { method: "POST", body: "{}" }), env, ctx);
    assert.equal(response.status, i < 30 ? 409 : 429);
    await Promise.all(ctx.tasks);
  }
});
