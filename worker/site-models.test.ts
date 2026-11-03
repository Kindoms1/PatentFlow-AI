import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { TestContext } from 'node:test';
import worker from './index.ts';
import { authenticated, completion, context, environment } from './test-helpers.ts';

const secondary = { AGNES_SECONDARY_API_KEY: 'synthetic-secondary-model-key', AGNES_SECONDARY_STATUS: 'rate_limited', AGNES_SECONDARY_CHECKED_AT: '2026-11-03T09:00:00Z' };
beforeEach(t => { (t as TestContext).mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected upstream request'); }); });
test('the configured Agnes service is visible but unavailable and not the default', async () => {
  const env = environment(secondary);
  const response = await worker.fetch(await authenticated('/api/providers', env), env, context());
  const text = await response.text(); assert.ok(!text.includes(secondary.AGNES_SECONDARY_API_KEY)); assert.ok(!text.includes(env.AGNES_API_KEY!));
  const providers = JSON.parse(text).providers; const agnes = providers.find((p: { id: string }) => p.id === 'agnes-secondary');
  assert.equal(agnes.name, 'Agnes'); assert.equal(agnes.hasKey, true); assert.equal(agnes.active, false); assert.equal(agnes.available, false);
  assert.match(agnes.availabilityDetail, /429/); assert.match(agnes.availabilityDetail, /短连接/);
  assert.equal(providers.find((p: { active: boolean }) => p.active).id, 'css-agent');
});
test('unavailable and unknown site models never fall back to the default', async () => {
  const env = environment(secondary);
  for (const [id, status] of [['agnes-secondary', 503], ['unknown', 400]] as const) {
    const response = await worker.fetch(await authenticated('/api/chat', env, { method: 'POST', body: JSON.stringify({ siteProviderId: id, messages: [{ role: 'user', content: 'test' }] }) }), env, context());
    assert.equal(response.status, status);
  }
});
for (const [path, accept] of [['/api/chat', 'application/json'], ['/api/agent', 'text/event-stream'], ['/api/agent', 'application/x-ndjson']] as const) test('verified Agnes uses only its own key: ' + path + accept, async t => {
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(url), 'https://apihub.agnes-ai.com/v1/chat/completions');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer ' + secondary.AGNES_SECONDARY_API_KEY);
    assert.ok(!String(init?.body).includes(secondary.AGNES_SECONDARY_API_KEY));
    return completion('synthetic verified output');
  });
  const env = environment({ ...secondary, AGNES_SECONDARY_STATUS: 'ready' }); const ctx = context();
  const response = await worker.fetch(await authenticated(path, env, { method: 'POST', headers: { Accept: accept }, body: JSON.stringify({ siteProviderId: 'agnes-secondary', messages: [{ role: 'user', content: 'test' }], tools: false }) }), env, ctx);
  assert.equal(response.status, 200); assert.match(await response.text(), /synthetic verified output/); await Promise.all(ctx.tasks);
});
test('unavailable Agnes may be explicitly probed without enabling it or exposing keys', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer ' + secondary.AGNES_SECONDARY_API_KEY);
    assert.equal(JSON.parse(String(init?.body)).max_tokens, 300);
    return Response.json({ error: { message: secondary.AGNES_SECONDARY_API_KEY + ' limited' } }, { status: 429 });
  });
  const env = environment({ ...secondary, MAX_OUTPUT_TOKENS: '300' });
  const response = await worker.fetch(await authenticated('/api/site-models/test', env, { method: 'POST', body: JSON.stringify({ siteProviderId: 'agnes-secondary' }) }), env, context());
  const raw = await response.text(); assert.ok(!raw.includes(secondary.AGNES_SECONDARY_API_KEY)); assert.equal(JSON.parse(raw).status, 429);
  assert.equal(env.AGNES_SECONDARY_STATUS, 'rate_limited');
});
test('a site model cannot be combined with caller-supplied credentials or endpoint', async () => {
  const env = environment(secondary);
  const response = await worker.fetch(await authenticated('/api/chat', env, { method: 'POST', body: JSON.stringify({ siteProviderId: 'agnes-secondary', clientProvider: { apiKey: 'not-used' } }) }), env, context());
  assert.equal(response.status, 400);
});
