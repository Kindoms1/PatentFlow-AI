import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));

// Run the actual CLI body in an isolated process. Only its imports and I/O are
// supplied by the fixture; the script's checks, capture handling and report run
// unchanged. No local configuration, live service or output directory is used.
async function runFixture(scenario) {
  const { seed, reduce } = await import('../src/model.ts');
  const { formalCheck, parseApplication } = await import('../src/cnipa-format.ts');
  const { FIGURE_SAMPLE } = await import('../src/figure-sample.ts');
  const source = fs.readFileSync(new URL('./live-pipeline.mjs', import.meta.url), 'utf8')
    .replace(/^import .+;\r?$/gm, '');
  const saved = new Map();
  const logs = [];
  const code = 'synthetic-fixture-invite';
  const cookie = 'pf_session=synthetic-fixture-cookie';
  const hiddenDetail = 'synthetic-private-upstream-detail';
  const fixtureFs = {
    existsSync: () => false,
    readFileSync: () => { throw new Error('Private configuration reads are prohibited in this fixture.'); },
    mkdirSync: () => {},
    writeFileSync: (name, value) => {
      if (scenario === 'capture-write-failure' && name.endsWith('-response.txt')) throw new Error(hiddenDetail);
      saved.set(path.basename(name), value);
    },
  };
  const draft = {
    text: FIGURE_SAMPLE, score: 100, claimCount: 2, priorArt: [], checks: [],
    distinguishing: [], pending: [], pendingMarks: 0, revised: false, revisions: [],
    model: 'synthetic-model', at: '2026-11-03T00:00:00.000Z',
  };
  const nativeFetch = async url => {
    if (String(url).endsWith('/__access')) {
      return new Response(null, { status: 303, headers: { 'set-cookie': cookie + '; HttpOnly' } });
    }
    if (scenario === 'capture-reject') {
      return new Response(new ReadableStream({
        start(controller) { queueMicrotask(() => controller.error(new Error(hiddenDetail))); },
      }));
    }
    if (scenario === 'capture-clone-failure') {
      return { clone() { throw new Error(hiddenDetail); }, text: async () => 'synthetic response' };
    }
    return new Response('synthetic response');
  };
  const fixtureGlobal = { fetch: nativeFetch };
  const runPatentTurn = async input => {
    if (input.intent === 'auto') {
      const response = await fixtureGlobal.fetch('/api/agent', { method: 'POST', body: '{}' });
      await response.text().catch(() => {});
      // A failed background capture must already be handled while work continues.
      await delay(10);
      input.dispatch({ type: 'set-invention-draft', caseId: input.caseId, draft });
      return;
    }
    if (scenario === 'failed-revision') {
      input.dispatch({ type: 'chat-note', caseId: input.caseId, role: 'assistant', text: 'Synthetic revision failed; original draft retained.' });
      return;
    }
    const revised = {
      ...draft,
      text: draft.text.replace('现有的定时灌溉按固定时长供水', '现有的定时灌溉通常按固定时长供水'),
      revisions: [{
        id: 'synthetic-revision', at: draft.at, instruction: input.userText, summary: 'Synthetic wording edit',
        applied: [{ find: 'synthetic original', replace: 'synthetic revision', reason: 'wording', count: 1 }],
        skipped: [], scoreBefore: 100, scoreAfter: 100, model: draft.model,
      }],
    };
    if (scenario === 'unchanged-revision') revised.text = draft.text;
    if (scenario === 'invalid-revision') revised.text = 'Synthetic incomplete draft';
    input.dispatch({
      type: scenario === 'changed-without-revision' ? 'set-invention-draft' : 'revise-invention-draft',
      caseId: input.caseId, draft: revised,
    });
  };
  // Export correctness has its own product tests. This fixture isolates the
  // integration script's reporting without writing real application documents.
  const zip = Uint8Array.of(0);
  const preparePackageZip = async () => ({ zip, figureCount: 5 });
  const readZip = async bytes => bytes[0] === 0
    ? new Map(Array.from({ length: 7 }, (_, index) => [index + '.docx', Uint8Array.of(1)]))
    : new Map([['word/document.xml', new Uint8Array()], ['[Content_Types].xml', new Uint8Array()], ['word/media/image.png', new Uint8Array()]]);
  const fixtureProcess = { env: { CODE: code }, exitCode: undefined };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction(
    'fs', 'path', 'parseEnv', 'seed', 'reduce', 'runPatentTurn', 'preparePackageZip',
    'readZip', 'formalCheck', 'parseApplication', 'process', 'globalThis', 'console', source,
  );
  await execute(fixtureFs, path, () => ({}), seed, reduce, runPatentTurn, preparePackageZip,
    readZip, formalCheck, parseApplication, fixtureProcess, fixtureGlobal, { log: value => logs.push(String(value)) });
  const reportText = saved.get('report.json');
  return {
    report: reportText ? JSON.parse(reportText) : null,
    exitCode: fixtureProcess.exitCode,
    fetchRestored: fixtureGlobal.fetch === nativeFetch,
    responseSaved: saved.has('001-response.txt'),
    diagnosticsRedacted: ![code, cookie, hiddenDetail].some(value => String(reportText).includes(value) || logs.some(line => line.includes(value))),
  };
}

function fixture(scenario) {
  const inherited = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => inherited.has(name.toUpperCase())));
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--live-fixture', scenario], {
    cwd: root, env, encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
  assert.equal(result.error, undefined, 'isolated script fixture must start');
  assert.equal(result.status, 0, 'script fixture exited before saving its failure report');
  const output = JSON.parse(result.stdout);
  assert.ok(output.report?.finishedAt, 'a completed report must be retained');
  assert.equal(output.fetchRestored, true);
  return output;
}

if (process.argv[2] === '--live-fixture') {
  console.log(JSON.stringify(await runFixture(process.argv[3])));
} else {
  test('live pipeline fails when revision retains the original exportable draft', () => {
    const result = fixture('failed-revision');
    assert.equal(result.report.checks.find(item => item.name.startsWith('revision '))?.ok, false);
    assert.equal(result.exitCode, 1);
  });
  test('live pipeline requires an applied revision action, not only changed draft text', () => {
    const result = fixture('changed-without-revision');
    assert.equal(result.report.checks.find(item => item.name.startsWith('revision '))?.ok, false);
    assert.equal(result.exitCode, 1);
  });
  test('live pipeline rejects a revision action that does not change text', () => {
    const result = fixture('unchanged-revision');
    assert.equal(result.report.checks.find(item => item.name.startsWith('revision '))?.ok, false);
    assert.equal(result.exitCode, 1);
  });
  test('live pipeline still requires revised content to pass the formal export gate', () => {
    const result = fixture('invalid-revision');
    assert.equal(result.report.checks.find(item => item.name.startsWith('revision '))?.ok, false);
    assert.equal(result.exitCode, 1);
  });
  test('live pipeline succeeds after a saved revision and valid formal gate', () => {
    const result = fixture('success');
    assert.equal(result.report.checks.find(item => item.name.startsWith('revision '))?.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.responseSaved, true);
    assert.equal(result.diagnosticsRedacted, true);
  });
  for (const scenario of ['capture-reject', 'capture-write-failure', 'capture-clone-failure']) {
    test('live pipeline retains a redacted failure report for ' + scenario, () => {
      const result = fixture(scenario);
      assert.equal(result.exitCode, 1);
      assert.ok(result.report.checks.some(item => !item.ok && item.name.includes('response capture')));
      assert.equal(result.diagnosticsRedacted, true);
    });
  }
}
