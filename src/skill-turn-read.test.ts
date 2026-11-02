import test from 'node:test';
import assert from 'node:assert/strict';
import { detectReadRequest, parseSlash } from './skill-turn.ts';
import { detectAutoRequest } from './auto-flow.ts';

const uploadedPdfRequest = '只阅读附件，用两句话概述其中的技术内容。不要联网检索，也不要生成专利全文。';

test('the uploaded-PDF request reaches the existing read routing branch', () => {
  const slash = parseSlash(uploadedPdfRequest);
  assert.equal(Boolean(slash.command), false);
  assert.equal(detectAutoRequest(slash.rest), false);
  assert.equal(detectReadRequest(slash.rest), true);
});

for (const text of [
  '请阅读附件。',
  '请概述这份PDF的技术内容。',
  '阅读附件，不要撰写交底书，也不必生成申请文件。',
  '概述附件，暂不需要帮我写交底书。',
  '只总结附件，不要生成专利全文或起草权利要求书。',
  '解读附件，不写交底书、不生成发明稿。',
  '概述附件，无需交底书和申请文件。',
]) {
  test('read-only wording stays read-only: ' + text, () => {
    assert.equal(detectReadRequest(text), true);
  });
}

for (const text of [
  '概述附件并生成专利全文。',
  '阅读附件，不需要生成全文，但是请起草权利要求书。',
  '概述附件，不要联网检索，然后生成专利全文。',
  '概述附件，不要联网检索并生成专利全文。',
  '概述附件，生成专利全文但不要起草权利要求书。',
  '阅读附件，不要生成专利全文，先写交底书。',
  '概述附件，不能不生成专利全文。',
  '总结附件并写一份交底书。',
  'Draft claims from this summary',
  '/解读 阅读并概述附件',
]) {
  test('positive writing or explicit slash routing is not read-only: ' + text, () => {
    assert.equal(detectReadRequest(text), false);
  });
}
