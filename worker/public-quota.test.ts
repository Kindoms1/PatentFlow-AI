import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PublicQuota, quotaDay, quotaFetch, quotaLimit } from './public-quota.ts';
import type { QuotaKind } from './public-quota.ts';

function memoryState() {
  const values = new Map<string, unknown>(); let tail: Promise<unknown> = Promise.resolve();
  const state: ConstructorParameters<typeof PublicQuota>[0] = { storage: { transaction(operation) {
    const result = tail.then(() => operation({ get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined, put: async (key, value) => { values.set(key, structuredClone(value)); } }));
    tail = result.catch(() => {}); return result;
  } } };
  return { state, values };
}
const consume = (quota: PublicQuota, kind: QuotaKind) => quota.fetch(new Request('https://quota.internal/consume', { method: 'POST', body: JSON.stringify({ kind }) })).then(r => r.json() as Promise<{ allowed: boolean; remaining: number; resetAt: string }>);
test('shared limits are conservative by default and zero disables shared use', () => {
  assert.equal(quotaLimit({}, 'model'), 60); assert.equal(quotaLimit({}, 'search'), 300);
  assert.equal(quotaLimit({ PUBLIC_DAILY_MODEL_CALLS: '0' }, 'model'), 0);
});
test('daily boundary resets at midnight UTC+8 rather than UTC', () => {
  assert.deepEqual(quotaDay(Date.parse('2026-11-03T15:59:59Z')), { day: '2026-11-03', resetAt: '2026-11-03T16:00:00.000Z' });
  assert.equal(quotaDay(Date.parse('2026-11-03T16:00:00Z')).day, '2026-11-04');
});
test('concurrent requests share one atomic budget and survive object replacement', async () => {
  const { state, values } = memoryState(); const env = { PUBLIC_DAILY_MODEL_CALLS: '7' };
  const responses = await Promise.all(Array.from({ length: 40 }, () => consume(new PublicQuota(state, env), 'model')));
  assert.equal(responses.filter(r => r.allowed).length, 7);
  assert.equal((await consume(new PublicQuota(state, env), 'model')).allowed, false);
  assert.equal((await consume(new PublicQuota(state, env), 'search')).allowed, true);
  assert.equal(values.size, 1);
});
test('a new local day clears usage without an exposed reset endpoint', async t => {
  const { state } = memoryState(); const quota = new PublicQuota(state, { PUBLIC_DAILY_MODEL_CALLS: '1' });
  t.mock.method(Date, 'now', () => Date.parse('2026-11-03T15:59:00Z'));
  assert.equal((await consume(quota, 'model')).allowed, true); assert.equal((await consume(quota, 'model')).allowed, false);
  t.mock.method(Date, 'now', () => Date.parse('2026-11-03T16:00:00Z'));
  assert.equal((await consume(quota, 'model')).allowed, true);
  assert.equal((await quota.fetch(new Request('https://quota.internal/reset', { method: 'POST' }))).status, 404);
});
test('shared credentials are never sent to the quota service and denied calls do not reach upstream', async t => {
  let upstream = 0; const kinds: string[] = [];
  t.mock.method(globalThis, 'fetch', async () => { upstream++; return new Response('ok'); });
  const env = { ACCESS_MODE: 'public', PUBLIC_QUOTA: { idFromName: (name: string) => name, get: (id: unknown) => ({ fetch: async (request: Request) => {
    assert.equal(id, 'shared-upstream-quota'); assert.equal(request.headers.get('Authorization'), null);
    const text = await request.text(); assert.ok(!text.includes('synthetic')); kinds.push(JSON.parse(text).kind);
    return Response.json({ allowed: false });
  } }) } };
  const guarded = quotaFetch(env, 'synthetic-model-key', 'synthetic-search-key');
  const model = await guarded('https://api.example.com', { headers: { Authorization: 'Bearer synthetic-model-key' } }); assert.equal(model.status, 429);
  const search = await guarded('https://search.example.com', { headers: { Authorization: 'Bearer synthetic-search-key' } }); assert.equal(search.status, 429);
  assert.equal(upstream, 0); assert.deepEqual(kinds, ['model', 'search']);
});
test('BYOK does not spend the shared model budget and missing quota bindings fail closed for shared keys', async t => {
  let upstream = 0; t.mock.method(globalThis, 'fetch', async () => { upstream++; return new Response('ok'); });
  const publicFetch = quotaFetch({ ACCESS_MODE: 'public' }, 'shared-synthetic');
  assert.equal((await publicFetch('https://model.example.com', { headers: { Authorization: 'Bearer shared-synthetic' } })).status, 503);
  assert.equal((await publicFetch('https://model.example.com', { headers: { Authorization: 'Bearer user-synthetic' } })).status, 200);
  assert.equal(upstream, 1);
});
