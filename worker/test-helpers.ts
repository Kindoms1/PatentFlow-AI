import assert from "node:assert/strict";
import { checkCode, issueCookie } from "./gate.ts";
import worker from "./index.ts";

type Env = Parameters<typeof worker.fetch>[1];
let sequence = 0;

// All credentials and endpoints in Worker tests are synthetic. No configuration files are loaded.
export function environment(overrides: Partial<Env> = {}): Env {
  return {
    ACCESS_CODES: `synthetic-invite-${++sequence}`,
    SESSION_SECRET: "synthetic-session-secret-for-tests-only-123456789",
    AGNES_API_KEY: "synthetic-model-key",
    AGNES_BASE_URL: "https://model.example.test/v1",
    ANYSEARCH_API_KEY: "synthetic-search-key",
    ANYSEARCH_BASE_URL: "https://search.example.test",
    ASSETS: { fetch: async () => new Response("synthetic asset") },
    ...overrides,
  };
}

export function context() {
  const tasks: Promise<unknown>[] = [];
  return { tasks, waitUntil(task: Promise<unknown>) { tasks.push(task); } };
}

export async function authenticated(path: string, env: Env, init: RequestInit = {}): Promise<Request> {
  const tag = await checkCode(env, env.ACCESS_CODES!);
  assert.ok(tag);
  const headers = new Headers(init.headers);
  headers.set("Cookie", (await issueCookie(env, tag, true)).split(";")[0]);
  return new Request(`https://app.example.test${path}`, { ...init, headers });
}

export function completion(text = "synthetic reply"): Response {
  return Response.json({ choices: [{ message: { content: text }, finish_reason: "stop" }] });
}

export function streamedRequest(path: string, chunks: Uint8Array[], headers: HeadersInit = {}) {
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled === chunks.length) controller.close();
      else controller.enqueue(chunks[pulled++]);
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const init: RequestInit & { duplex: string } = { method: "POST", body, headers, duplex: "half" };
  return {
    request: new Request(`https://app.example.test${path}`, init),
    get pulled() { return pulled; },
    get cancelled() { return cancelled; },
  };
}
