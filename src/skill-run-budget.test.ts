import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { AgentRequest } from './agent-events.ts';
import { runPatentTurn } from './skill-run.ts';
import { FIGURE_SAMPLE } from './figure-sample.ts';

type Turn = Parameters<typeof runPatentTurn>[0];

async function captureRequest(t: TestContext, intent: NonNullable<Turn['intent']>): Promise<AgentRequest> {
  const controller = new AbortController();
  const requests: AgentRequest[] = [];
  const unexpected: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === '/api/agent') {
      requests.push(JSON.parse(String(init?.body)));
      assert.equal(init?.signal, controller.signal);
      controller.abort();
      throw new DOMException('Synthetic request captured; no model call.', 'AbortError');
    }
    if (String(url) === '/api/search') return Response.json({ ok: true, detail: '', results: [] });
    unexpected.push(String(url));
    throw new Error('Unexpected request in budget fixture.');
  });
  const draft: NonNullable<Turn['draft']> = {
    text: FIGURE_SAMPLE, score: 100, at: '2026-11-03T00:00:00.000Z', model: 'synthetic-model',
    revised: false, pendingMarks: 0, claimCount: 2, priorArt: [], checks: [], distinguishing: [], pending: [],
  };
  await runPatentTurn({
    caseId: 'synthetic-budget-case', intent, recordUser: false, signal: controller.signal,
    userText: intent === 'revise' ? '仅润色背景技术中的过渡句，保留技术内容。' : '根据给定材料完成当前任务。',
    materials: [{ name: 'synthetic-material.md', kind: 'text', text: '一种分区灌溉控制系统，采集各分区土壤含水量并控制电磁阀，按各分区水分需求分别执行灌溉。' }],
    draft: intent === 'revise' ? draft : undefined,
    dispatch: () => {},
  });
  assert.deepEqual(unexpected, []);
  assert.equal(requests.length, 1, 'stop immediately after the first outgoing model request');
  return requests[0];
}

for (const intent of ['draft', 'revise'] as const) {
  test(intent + ' requests a 24000-token no-tool output budget', async t => {
    const request = await captureRequest(t, intent);
    assert.equal(request.maxTokens, 24000);
    assert.equal(request.tools, false);
    assert.equal(request.maxSteps, 1);
  });
}

for (const intent of ['outline', 'create'] as const) {
  test(intent + ' retains its 6000-token output budget', async t => {
    assert.equal((await captureRequest(t, intent)).maxTokens, 6000);
  });
}

for (const intent of ['chat', 'ideas'] as const) {
  test(intent + ' retains the normal server-default output budget', async t => {
    const request = await captureRequest(t, intent);
    assert.equal(Object.hasOwn(request, 'maxTokens'), false);
  });
}
