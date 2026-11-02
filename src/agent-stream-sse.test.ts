import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { AgentEvent, AgentRequest } from './agent-events.ts';
import { streamAgent } from './agent-stream.ts';

const request: AgentRequest = { tools: false, messages: [{ role: 'user', content: 'synthetic request' }] };
const encode = new TextEncoder();
const frame = (payload: unknown) => 'data: ' + JSON.stringify(payload) + '\n\n';
const delta = (text: string) => frame({ model: 'payload-model', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
const stop = frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
const done = 'data: [DONE]\n\n';

function chunked(text: string, contentType = 'text/event-stream', headers: Record<string, string> = {}) {
  const bytes = encode.encode(text);
  let offset = 0;
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) controller.close();
      else controller.enqueue(bytes.slice(offset, ++offset));
    },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 });
  return { response: new Response(body, { headers: { 'Content-Type': contentType, ...headers } }), get cancelled() { return cancelled; } };
}

async function consume(t: TestContext, response: Response, signal?: AbortSignal, input = request) {
  const events: AgentEvent[] = [];
  let sent: RequestInit | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => { sent = init; return response; });
  const outcome = await streamAgent(input, event => events.push(event), signal);
  return { outcome, events, sent };
}

test('SSE decodes actual UTF-8 byte chunks, multiline data, CRLF, metadata and trailing usage', async t => {
  const hidden = 'synthetic reasoning must stay private';
  const first = 'data: {"model":"payload-model",\r\n'
    + 'data: "choices":[{"index":0,"delta":{"content":"你好🌱","reasoning_content":"' + hidden + '"}}]}\r\n\r\n';
  const input = ': keepalive\r\n\r\n' + first + delta('完成') + stop
    + frame({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } }) + done + delta('must not be consumed');
  const fixture = chunked(input, 'text/event-stream; charset=utf-8', {
    'X-PatentFlow-Model': 'header-model', 'X-PatentFlow-Provider': 'fixture-provider',
  });
  const { outcome, events, sent } = await consume(t, fixture.response);
  assert.equal(new Headers(sent?.headers).get('Accept'), 'application/x-ndjson, text/event-stream');
  assert.deepEqual(events.map(event => event.type), ['start', 'step', 'delta', 'delta', 'done']);
  assert.deepEqual(events[0], { type: 'start', model: 'header-model', provider: 'fixture-provider', tools: [] });
  assert.equal(outcome.type, 'done');
  if (outcome.type !== 'done') return;
  assert.equal(outcome.text, '你好🌱完成');
  assert.equal(outcome.model, 'header-model');
  assert.equal(outcome.steps, 1);
  assert.deepEqual(outcome.sources, []);
  assert.deepEqual(outcome.usage, { input: 12, output: 7 });
  assert.equal(JSON.stringify(events).includes(hidden), false);
  assert.equal(fixture.cancelled, 1);
  assert.equal(fixture.response.body?.locked, false);
});

test('SSE accepts a proper stop at EOF and obtains model metadata from the payload', async t => {
  const fixture = chunked(delta('完整正文') + stop);
  const { outcome, events } = await consume(t, fixture.response);
  assert.equal(outcome.type, 'done');
  if (outcome.type !== 'done') return;
  assert.equal(outcome.model, 'payload-model');
  assert.deepEqual(outcome.usage, { input: 0, output: 0 });
  assert.deepEqual(events[0], { type: 'start', model: 'payload-model', provider: '', tools: [] });
  assert.equal(fixture.response.body?.locked, false);
});

test('SSE accepts DONE without a finish_reason', async t => {
  const { outcome } = await consume(t, chunked(delta('完整正文') + done).response);
  assert.equal(outcome.type, 'done');
});

test('SSE supports lone CR event delimiters', async t => {
  const { outcome } = await consume(t, chunked((delta('正文') + done).replaceAll('\n', '\r')).response);
  assert.equal(outcome.type, 'done');
});

for (const [name, input] of [
  ['empty stream', ''],
  ['empty completed answer', done],
  ['reasoning-only answer', frame({ choices: [{ delta: { reasoning_content: 'hidden reasoning' }, finish_reason: 'stop' }] }) + done],
  ['clean EOF without a terminal marker', delta('unfinished')],
  ['truncated JSON event', delta('unfinished') + 'data: {"choices":'],
  ['truncated usage after stop', delta('正文') + stop + 'data: {"usage":'],
  ['malformed data followed by DONE', delta('正文') + 'data: not-json\n\n' + done],
]) {
  test('SSE fails safely for ' + name, async t => {
    const fixture = chunked(input);
    const { outcome, events } = await consume(t, fixture.response);
    assert.equal(outcome.type, 'error');
    assert.equal(events.filter(event => event.type === 'error').length, 1);
    assert.equal(events.some(event => event.type === 'done'), false);
    assert.equal(JSON.stringify(events).includes('hidden reasoning'), false);
    assert.equal(fixture.response.body?.locked, false);
  });
}

for (const reason of ['length', 'content_filter', 'tool_calls']) {
  test('SSE does not turn ' + reason + ' into successful text completion', async t => {
    const { outcome, events } = await consume(t, chunked(delta('partial') + frame({ choices: [{ delta: {}, finish_reason: reason }] }) + done).response);
    assert.equal(outcome.type, 'error');
    assert.equal(events.some(event => event.type === 'done' || event.type === 'tool_call' || event.type === 'tool_result'), false);
  });
}

test('SSE never manufactures tool events from unexpected tool deltas', async t => {
  const input = frame({ choices: [{ delta: { tool_calls: [{ id: 'synthetic', function: { name: 'unexpected', arguments: '{}' } }] } }] }) + done;
  const { outcome, events } = await consume(t, chunked(input).response);
  assert.equal(outcome.type, 'error');
  assert.equal(events.some(event => event.type === 'tool_call' || event.type === 'tool_result'), false);
});

for (const [name, input] of [
  ['error payload', frame({ error: { message: 'synthetic sensitive upstream detail', code: 'bad_request' } })],
  ['error event', 'event: error\ndata: {"message":"synthetic sensitive upstream detail"}\n\n'],
]) {
  test('SSE maps an upstream ' + name + ' to one safe error', async t => {
    const fixture = chunked(delta('partial') + input + done);
    const { outcome, events } = await consume(t, fixture.response);
    assert.equal(outcome.type, 'error');
    assert.equal(events.filter(event => event.type === 'error').length, 1);
    assert.equal(events.some(event => event.type === 'done'), false);
    assert.equal(JSON.stringify(events).includes('synthetic sensitive upstream detail'), false);
    assert.equal(fixture.response.body?.locked, false);
  });
}

test('HTTP error objects produce a string error detail', async t => {
  const { outcome } = await consume(t, Response.json({ error: { message: 'synthetic sensitive upstream detail' } }, { status: 502 }));
  assert.equal(outcome.type, 'error');
  if (outcome.type !== 'error') return;
  assert.equal(typeof outcome.detail, 'string');
  assert.equal(outcome.detail.includes('synthetic sensitive upstream detail'), false);
});

test('cancellation interrupts a pending reader and releases its lock', async t => {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  let notify!: () => void;
  const waiting = new Promise<void>(resolve => { notify = resolve; });
  let reads = 0;
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { source = controller; },
    pull(controller) { if (reads++ === 0) controller.enqueue(encode.encode(delta('partial'))); else notify(); },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 });
  const response = new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  const controller = new AbortController();
  const pending = consume(t, response, controller.signal);
  await waiting;
  controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([pending, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 100); })]);
  clearTimeout(timer);
  if (!result) { source.close(); await pending; }
  assert.ok(result, 'abort must not wait for upstream EOF');
  assert.equal(result.outcome.type, 'error');
  if (result.outcome.type !== 'error') return;
  assert.equal(result.outcome.detail, '已停止。');
  assert.equal(result.sent?.signal, controller.signal);
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});

test('an already cancelled request does not start a fetch', async t => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return chunked(delta('正文') + done).response; });
  const outcome = await streamAgent(request, () => {}, controller.signal);
  assert.equal(outcome.type, 'error');
  assert.equal(calls, 0);
});

test('DONE terminates and cancels an upstream body that stays open', async t => {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { source = controller; controller.enqueue(encode.encode(delta('正文') + done)); },
    cancel() { cancelled++; },
  });
  const pending = consume(t, new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([pending, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 100); })]);
  clearTimeout(timer);
  if (!result) { source.close(); await pending; }
  assert.ok(result, 'DONE must not wait for upstream EOF');
  assert.equal(result.outcome.type, 'done');
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});

test('a network read failure stays an error and releases the reader', async t => {
  let reads = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads++ === 0) controller.enqueue(encode.encode(delta('partial')));
      else controller.error(new Error('synthetic sensitive network detail'));
    },
  }, { highWaterMark: 0 });
  const { outcome, events } = await consume(t, new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
  assert.equal(outcome.type, 'error');
  assert.equal(JSON.stringify(events).includes('synthetic sensitive network detail'), false);
  assert.equal(body.locked, false);
});

test('NDJSON tool events and terminal payload remain unchanged', async t => {
  const expected: AgentEvent[] = [
    { type: 'start', model: 'ndjson-model', provider: 'provider', tools: ['web_search'] },
    { type: 'tool_result', id: 'tool-1', name: 'web_search', ok: true, summary: 'synthetic', sources: [] },
    { type: 'delta', text: '旧协议正常🌱' },
    { type: 'done', text: '旧协议正常🌱', sources: [], steps: 2, model: 'ndjson-model', usage: { input: 8, output: 4 } },
  ];
  const fixture = chunked(expected.map(event => JSON.stringify(event)).join('\n'), 'application/x-ndjson');
  const { outcome, events, sent } = await consume(t, fixture.response, undefined, { ...request, tools: true });
  assert.deepEqual(events, expected);
  assert.deepEqual(outcome, expected.at(-1));
  assert.equal(new Headers(sent?.headers).get('Accept'), 'application/x-ndjson, text/event-stream');
  assert.equal(fixture.response.body?.locked, false);
});
