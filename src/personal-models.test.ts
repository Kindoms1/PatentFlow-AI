import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPersonalModels } from './personal-models.ts';
const input = { name: '测试模型', protocol: 'openai' as const, baseUrl: 'https://api.deepseek.com/v1', model: 'test-model', apiKey: 'synthetic-private-key', maxOutputTokens: 8192, tokenParameter: 'auto' as const };
const storage = () => { const values = new Map<string, string>(); return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } }; };
test('personal keys are absent from persistent config and public descriptors', () => {
  const local = storage(); const session = storage(); const store = createPersonalModels(local, session);
  store.save(input, false);
  assert.ok(!JSON.stringify([...local.values]).includes(input.apiKey));
  assert.ok(!JSON.stringify(store.list()).includes(input.apiKey));
  assert.equal(session.values.size, 0); assert.equal(store.request()?.apiKey, input.apiKey);
});
test('default memory-only keys do not survive reload and never fall back silently', () => {
  const local = storage(); const session = storage(); createPersonalModels(local, session).save(input, false);
  const reload = createPersonalModels(local, session);
  assert.equal(reload.list()[0].hasKey, false); assert.equal(reload.list()[0].active, true);
  assert.throws(() => reload.request(), /重新填写 API Key/);
  reload.use(); assert.equal(reload.request(), undefined);
});
test('explicit session retention survives refresh but is removable', () => {
  const local = storage(); const session = storage(); const id = createPersonalModels(local, session).save(input, true);
  const reload = createPersonalModels(local, session); assert.equal(reload.request()?.apiKey, input.apiKey);
  reload.remove(id); assert.deepEqual(reload.list(), []); assert.equal(session.values.size, 0); assert.equal(reload.request(), undefined);
});
test('editing can keep a key without exposing it and switching is per profile', () => {
  const store = createPersonalModels(); const first = store.save(input, false);
  store.save({ ...input, apiKey: '', name: '编辑后' }, false, first);
  assert.equal(store.request()?.name, '编辑后'); assert.equal(store.request()?.apiKey, input.apiKey);
  const second = store.save({ ...input, name: '第二个', apiKey: 'another-synthetic-key' }, false);
  assert.notEqual(second, first); store.use(first); assert.equal(store.request()?.name, '编辑后');
});
test('personal keys cannot be copied into persisted metadata', () => {
  const store = createPersonalModels(); assert.throws(() => store.save({ ...input, name: input.apiKey }, false), /密钥只能/);
});
test('switching service cannot silently reuse a previous credential', () => {
  const store = createPersonalModels(); const id = store.save(input, false);
  assert.throws(() => store.save({ ...input, baseUrl: 'https://other.example.com', apiKey: '' }, false, id), /API Key/);
  assert.equal(store.request()?.baseUrl, input.baseUrl);
});
test('blocked browser storage falls back to usable memory-only settings', () => {
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const store = createPersonalModels(blocked, blocked); store.save(input, false);
  assert.equal(store.request()?.apiKey, input.apiKey); assert.ok(store.warning());
});
