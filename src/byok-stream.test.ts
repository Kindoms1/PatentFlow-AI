import assert from 'node:assert/strict';
import { test } from 'node:test';
import { streamAgent } from './agent-stream.ts';
import { joinUrl, modelTokenOptions } from '../server/llm-gateway.ts';

test('Gemini compatibility and explicit completion endpoint paths are preserved', () => {
  assert.equal(joinUrl('https://generativelanguage.googleapis.com/v1beta/openai', 'chat/completions'), 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(joinUrl('https://open.bigmodel.cn/api/paas/v4', 'chat/completions'), 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
  assert.equal(joinUrl('https://custom.example.com/endpoint/chat/completions', 'models'), 'https://custom.example.com/endpoint/models');
});
test('token parameter auto and overrides use the selected model protocol', () => {
  const provider = { id: 'test', name: 'test', baseUrl: 'https://api.openai.com/v1', model: 'test', protocol: 'openai', secret: 'synthetic-private', auth: 'bearer' };
  assert.deepEqual(modelTokenOptions(provider, 100), { max_completion_tokens: 100 });
  assert.deepEqual(modelTokenOptions({ ...provider, protocol: 'claude' }, 100), { max_tokens: 100 });
  assert.deepEqual(modelTokenOptions({ ...provider, tokenParameter: 'max_tokens' }, 100), { max_tokens: 100 });
});
for (const ending of ['end_turn', 'max_tokens', 'missing']) test('native Anthropic stream handles ' + ending, async t => {
  const frame = (value: unknown) => 'data: ' + JSON.stringify(value) + '\n\n';
  const text = frame({ type: 'message_start', message: { usage: { input_tokens: 3 } } })
    + frame({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'not public' } })
    + frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: '正文正常' } })
    + (ending === 'missing' ? '' : frame({ type: 'message_delta', delta: { stop_reason: ending }, usage: { output_tokens: 4 } }) + frame({ type: 'message_stop' }));
  t.mock.method(globalThis, 'fetch', async () => new Response(text, { headers: { 'Content-Type': 'text/event-stream', 'X-PatentFlow-Protocol': 'claude' } }));
  const result = await streamAgent({ messages: [{ role: 'user', content: 'question' }], tools: false }, () => {});
  assert.equal(result.type, ending === 'end_turn' ? 'done' : 'error');
  if (result.type === 'done') { assert.equal(result.text, '正文正常'); assert.deepEqual(result.usage, { input: 3, output: 4 }); }
});
test('explicit model selection is carried without adding credentials to message text', async t => {
  const clientProvider = { name: 'mine', protocol: 'openai' as const, baseUrl: 'https://api.deepseek.com/v1', model: 'test', apiKey: 'synthetic-private-key', maxOutputTokens: 8192, tokenParameter: 'auto' as const };
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); assert.equal(body.clientProvider.apiKey, clientProvider.apiKey);
    assert.ok(!JSON.stringify(body.messages).includes(clientProvider.apiKey));
    return new Response(JSON.stringify({ type: 'done', text: 'ok', sources: [], model: 'test', steps: 1, usage: null }) + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
  });
  const result = await streamAgent({ messages: [{ role: 'user', content: 'question' }] }, () => {}, undefined, { clientProvider });
  assert.equal(result.type, 'done');
});
