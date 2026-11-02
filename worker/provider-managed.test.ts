import test from 'node:test';
import assert from 'node:assert/strict';
import { listProviders, type PublicProvider } from '../src/provider-api.ts';
import worker from './index.ts';
import { authenticated, context, environment } from './test-helpers.ts';

test('hosted provider metadata marks every provider managed without exposing endpoints or keys', async t => {
  const env = environment();
  const request = await authenticated('/api/providers', env);
  let responseText = '';
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    assert.equal(url, '/api/providers');
    const response = await worker.fetch(request, env, context());
    assert.equal(response.status, 200);
    responseText = await response.clone().text();
    return response;
  });
  const providers = await listProviders();
  assert.equal(providers.length, 2);
  for (const provider of providers) {
    assert.equal(provider.managed, true);
    assert.equal(provider.baseUrl, '');
    assert.equal(Object.hasOwn(provider, 'secret'), false);
    assert.equal(Object.hasOwn(provider, 'apiKey'), false);
  }
  for (const privateValue of [env.AGNES_API_KEY, env.ANYSEARCH_API_KEY, env.AGNES_BASE_URL, env.ANYSEARCH_BASE_URL]) {
    assert.equal(responseText.includes(privateValue!), false);
  }
});

test('local provider metadata remains usable with no managed flag', async t => {
  const local: PublicProvider = {
    id: 'synthetic-local', name: 'Local model', protocol: 'openai', role: 'model',
    baseUrl: 'http://localhost:1234/v1', website: '', model: 'local-model',
    hasKey: false, keyHint: '', active: true,
  };
  t.mock.method(globalThis, 'fetch', async () => Response.json({ providers: [local] }));
  const providers = await listProviders();
  assert.deepEqual(providers, [local]);
  assert.equal(providers[0].managed, undefined);
});

test('managed metadata does not enable hosted provider administration routes', async t => {
  const env = environment();
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No upstream requests allowed in metadata tests.'); });
  for (const path of ['/api/providers/test', '/api/providers/import', '/api/providers/model', '/api/providers/activate', '/api/ccswitch']) {
    const request = await authenticated(path, env, path === '/api/ccswitch' ? {} : { method: 'POST', body: '{}' });
    const response = await worker.fetch(request, env, context());
    assert.equal(response.status, 403, path);
  }
});
