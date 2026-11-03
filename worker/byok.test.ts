import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { TestContext } from 'node:test';
import worker from './index.ts';
import { parseByok, byokHosts } from './byok.ts';
import { authenticated, completion, context, environment } from './test-helpers.ts';

const config = { name: '个人测试', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'test-model', apiKey: 'synthetic-personal-key', maxOutputTokens: 8192, tokenParameter: 'auto' };
beforeEach(t => { (t as TestContext).mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network'); }); });

for (const url of ['http://api.deepseek.com/v1', 'https://127.0.0.1/v1', 'https://[::1]/v1', 'https://169.254.169.254/v1', 'https://api.deepseek.com.evil.example/v1', 'https://api.deepseek.com@evil.example/v1', 'https://api.deepseek.com/v1?key=secret', 'https://api.deepseek.com:8443/v1', 'file:///private/key', 'https://unknown.example/v1']) {
  test('BYOK rejects unsafe or unapproved destination ' + url, () => assert.equal(typeof parseByok({ ...config, baseUrl: url }, {}), 'string'));
}
test('custom domains require explicit exact operator allowlisting', () => {
  assert.equal(typeof parseByok({ ...config, baseUrl: 'https://relay.example.com/llm/v1' }, { BYOK_ALLOWED_HOSTS: 'relay.example.com' }), 'object');
  assert.equal(typeof parseByok({ ...config, baseUrl: 'https://sub.relay.example.com/v1' }, { BYOK_ALLOWED_HOSTS: 'relay.example.com' }), 'string');
  assert.ok(!byokHosts({ BYOK_ALLOWED_HOSTS: '*.example.com,localhost,127.0.0.1' }).includes('localhost'));
});
test('BYOK validates credentials, capabilities and caps without echoing secret input', () => {
  for (const patch of [{ apiKey: '' }, { apiKey: 'a\nbbbbbbbbb' }, { apiKey: 'a'.repeat(2049) }, { name: config.apiKey }, { model: '' }, { protocol: 'shell' }, { maxOutputTokens: 1 }, { maxOutputTokens: 90000 }, { maxOutputTokens: 256.5 }, { tokenParameter: 'secret' }]) {
    const result = parseByok({ ...config, ...patch }, {});
    assert.equal(typeof result, 'string'); assert.ok(!String(result).includes(config.apiKey));
  }
  assert.equal(typeof parseByok(config, { BYOK_ENABLED: 'false' }), 'string');
});

for (const [path, accept] of [['/api/chat', 'application/json'], ['/api/agent', 'application/x-ndjson'], ['/api/agent', 'text/event-stream']] as const) {
  test('personal credentials are isolated for ' + path + ' ' + accept, async t => {
    const upstream: Array<{ url: string; body: string; auth: string; redirect?: string }> = [];
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => { upstream.push({ url: String(url), body: String(init?.body), auth: new Headers(init?.headers).get('Authorization') || '', redirect: init?.redirect }); return completion('reply ' + config.apiKey); });
    const env = environment(); const ctx = context();
    const response = await worker.fetch(await authenticated(path, env, { method: 'POST', headers: { Accept: accept }, body: JSON.stringify({ messages: [{ role: 'user', content: 'synthetic question' }], tools: false, maxTokens: 30000, clientProvider: config, providerId: 'css-agent' }) }), env, ctx);
    const text = await response.text(); await Promise.all(ctx.tasks);
    assert.equal(response.status, 200); assert.ok(upstream.length >= 1);
    assert.equal(upstream[0].auth, 'Bearer ' + config.apiKey);
    assert.match(upstream[0].url, /^https:\/\/api\.deepseek\.com/);
    assert.ok(!upstream[0].body.includes(config.apiKey)); assert.ok(!upstream[0].body.includes(env.AGNES_API_KEY!));
    assert.ok(['manual', 'error'].includes(upstream[0].redirect!));
    assert.ok(JSON.parse(upstream[0].body).max_tokens <= 8192);
    assert.ok(!text.includes(config.apiKey)); assert.ok(!text.includes(env.AGNES_API_KEY!));
  });
}

test('invalid BYOK never silently falls back to administrator credentials', async () => {
  const env = environment();
  const response = await worker.fetch(await authenticated('/api/chat', env, { method: 'POST', body: JSON.stringify({ clientProvider: { ...config, apiKey: '' } }) }), env, context());
  assert.equal(response.status, 400);
});
test('BYOK test and model listing remain authenticated and reject foreign origins', async () => {
  const env = environment();
  for (const path of ['/api/byok/test', '/api/byok/models']) {
    const body = JSON.stringify({ clientProvider: config });
    assert.equal((await worker.fetch(new Request('https://app.example.test' + path, { method: 'POST', body }), env, context())).status, 401);
    assert.equal((await worker.fetch(await authenticated(path, env, { method: 'POST', body, headers: { Origin: 'https://other.example.com' } }), env, context())).status, 403);
  }
});
test('personal model listing is scoped to its own key and exposes no key material', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer ' + config.apiKey);
    return Response.json({ data: [{ id: 'first-model' }, { id: config.apiKey }] });
  });
  const env = environment();
  const response = await worker.fetch(await authenticated('/api/byok/models', env, { method: 'POST', body: JSON.stringify({ clientProvider: config }) }), env, context());
  const text = await response.text(); assert.match(text, /first-model/); assert.ok(!text.includes(config.apiKey));
});
test('model list discovery does not require knowing a model ID first', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ id: 'discovered-model' }] }));
  const env = environment();
  const response = await worker.fetch(await authenticated('/api/byok/models', env, { method: 'POST', body: JSON.stringify({ clientProvider: { ...config, model: '' } }) }), env, context());
  assert.equal(response.status, 200); assert.match(await response.text(), /discovered-model/);
});
test('redirect responses are never followed with personal credentials', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => { calls++; assert.equal(init?.redirect, 'manual'); return new Response(null, { status: 302, headers: { Location: 'https://untrusted.example/' } }); });
  const env = environment();
  const response = await worker.fetch(await authenticated('/api/byok/test', env, { method: 'POST', body: JSON.stringify({ clientProvider: config }) }), env, context());
  assert.equal((await response.json() as { ok: boolean }).ok, false); assert.equal(calls, 1);
});
test('native Anthropic text proxy uses Messages and x-api-key, not the admin model', async t => {
  const own = { ...config, protocol: 'claude', baseUrl: 'https://api.anthropic.com/v1' };
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(url), 'https://api.anthropic.com/v1/messages');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-api-key'), own.apiKey); assert.equal(headers.get('Authorization'), null);
    const body = JSON.parse(String(init?.body)); assert.equal(body.system, 'system requirement');
    return Response.json({ content: [{ type: 'text', text: '正常输出' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 4 } });
  });
  const env = environment();
  const response = await worker.fetch(await authenticated('/api/agent', env, { method: 'POST', headers: { Accept: 'text/event-stream' }, body: JSON.stringify({ tools: false, clientProvider: own, messages: [{ role: 'system', content: 'system requirement' }, { role: 'user', content: 'question' }] }) }), env, context());
  assert.match(await response.text(), /正常输出/);
});
