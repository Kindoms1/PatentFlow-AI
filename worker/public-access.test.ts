import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from './index.ts';
import { authenticated, completion, context, environment } from './test-helpers.ts';
import { checkCode, gateConfigured, issueCookie, session } from './gate.ts';
import { NOTICE_VERSION } from '../src/site-info.ts';

const openEnv = () => environment({ ACCESS_MODE: 'public', ACCESS_CODES: undefined });
test('public mode needs a signing secret but never an invitation code', () => {
  assert.equal(gateConfigured(openEnv()), true);
  assert.equal(gateConfigured({ ...openEnv(), SESSION_SECRET: '' }), false);
});
test('public landing and access metadata do not contain an invitation form', async () => {
  const env = openEnv();
  const landing = await worker.fetch(new Request('https://app.example.test/'), env, context());
  assert.equal(landing.status, 200); const text = await landing.text();
  assert.match(text, /无需邀请码/); assert.doesNotMatch(text, /name="code"|请输入邀请码/);
  const meta = await worker.fetch(new Request('https://app.example.test/api/access'), env, context());
  assert.deepEqual(await meta.json(), { mode: 'public', noticeVersion: NOTICE_VERSION, requiresInvite: false });
});
test('public visitors can acknowledge and enter without a code or prior cookie', async () => {
  const env = openEnv();
  const response = await worker.fetch(new Request('https://app.example.test/__notice', { method: 'POST', body: new URLSearchParams({ notice: NOTICE_VERSION }) }), env, context());
  assert.equal(response.status, 303);
  const cookie = response.headers.get('Set-Cookie')!.split(';')[0]; assert.match(cookie, /^pf_session=p\./);
  const admitted = await worker.fetch(new Request('https://app.example.test/', { headers: { Cookie: cookie } }), env, context());
  assert.equal(await admitted.text(), 'synthetic asset');
  assert.equal(await checkCode(env, 'anything'), null);
});
test('anonymous access still requires notice and rejects foreign origins', async () => {
  const env = openEnv();
  const noNotice = await worker.fetch(new Request('https://app.example.test/api/chat', { method: 'POST', body: '{}' }), env, context());
  assert.equal(noNotice.status, 428);
  const foreign = await worker.fetch(new Request('https://app.example.test/__notice', { method: 'POST', headers: { Origin: 'https://foreign.example' }, body: new URLSearchParams({ notice: NOTICE_VERSION }) }), env, context());
  assert.equal(foreign.status, 403);
  const missing = await worker.fetch(new Request('https://app.example.test/__notice', { method: 'POST', body: new URLSearchParams() }), env, context());
  assert.equal(missing.headers.get('Set-Cookie'), null);
});
test('public and private session scopes cannot be exchanged', async () => {
  const env = environment(); const tag = (await checkCode(env, env.ACCESS_CODES!))!;
  const privateCookie = (await issueCookie(env, tag, true)).split(';')[0];
  const publicEnv = { ...env, ACCESS_MODE: 'public' };
  assert.equal(await session(new Request('https://app.example.test', { headers: { Cookie: privateCookie } }), publicEnv), null);
  const publicCookie = (await issueCookie(publicEnv, tag, true)).split(';')[0];
  assert.equal(await session(new Request('https://app.example.test', { headers: { Cookie: publicCookie } }), env), null);
});
test('minting another public cookie cannot bypass per-IP model limits', async t => {
  t.mock.method(globalThis, 'fetch', async () => completion());
  const env = environment({ ACCESS_MODE: 'public', AGENT_PER_HOUR: '1', PUBLIC_QUOTA: { idFromName: () => 'test', get: () => ({ fetch: async () => Response.json({ allowed: true }) }) } });
  const make = () => authenticated('/api/chat', env, { method: 'POST', headers: { 'CF-Connecting-IP': '192.0.2.240' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }) });
  const ctx = context(); const first = await worker.fetch(await make(), env, ctx); assert.equal((await first.json() as { ok: boolean }).ok, true); await Promise.all(ctx.tasks);
  const second = await worker.fetch(await make(), env, context()); assert.equal(second.status, 429);
});
test('agent model turns and internal search calls all consume their own shared quota', async t => {
  const kinds: string[] = []; let models = 0;
  const env = environment({ ACCESS_MODE: 'public', PUBLIC_QUOTA: { idFromName: () => 'test', get: () => ({ fetch: async (request: Request) => { kinds.push((await request.json() as { kind: string }).kind); return Response.json({ allowed: true }); } }) } });
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL) => {
    if (String(url).includes('search.example.test')) return Response.json({ results: [{ title: 'synthetic patent', url: 'https://example.com/patent', snippet: 'synthetic search result' }] });
    models++;
    return models === 1 ? Response.json({ choices: [{ message: { content: '', tool_calls: [{ id: 'call1', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: 'synthetic patent' }) } }] }, finish_reason: 'tool_calls' }] }) : completion('synthetic final answer');
  });
  const ctx = context();
  const response = await worker.fetch(await authenticated('/api/agent', env, { method: 'POST', headers: { 'CF-Connecting-IP': '192.0.2.239' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'search for a synthetic patent' }], tools: true, maxSteps: 3, maxSearches: 1 }) }), env, ctx);
  assert.match(await response.text(), /synthetic final answer/); await Promise.all(ctx.tasks);
  assert.deepEqual(kinds, ['model', 'search', 'model']);
});
