import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDraftFailure, draftBackoff, draftFailureNote, isTransientDetail } from "./draft-run.ts";

test("gateway failure texts are sorted into actionable kinds", () => {
  const cases: Array<[string, string, boolean]> = [
    ["没有连上模型：fetch failed（ECONNRESET）", "network", true],
    ["服务端没有连上模型。", "network", true],
    ["模型响应超时。", "timeout", true],
    ["上游响应超时", "timeout", true],
    ["上游限流或额度不足，请稍后再试", "rate-limit", true],
    ["上游服务暂时故障", "upstream", true],
    ["上游额度不足", "quota", false],
    ["密钥无效、过期或没有这个模型的权限", "auth", false],
    ["当前模型没有服务端密钥。", "auth", false],
    ["模型返回了空回答", "empty", true],
    ["", "empty", true],
    ["未知错误", "other", false],
  ];
  for (const [detail, kind, retryable] of cases) {
    const failure = classifyDraftFailure(detail);
    assert.equal(failure.kind, kind, detail);
    assert.equal(failure.retryable, retryable, detail);
    assert.ok(failure.label && failure.advice, detail);
  }
});

test("only transport-level failures trigger the automatic draft retry", () => {
  assert.equal(isTransientDetail("没有连上模型：fetch failed"), true);
  assert.equal(isTransientDetail("上游限流或额度不足，请稍后再试"), true);
  assert.equal(isTransientDetail("上游额度不足"), false, "an exhausted quota is not retried");
  assert.equal(isTransientDetail("密钥无效、过期或没有这个模型的权限"), false, "a bad key is not retried");
  assert.equal(isTransientDetail("模型返回了空回答"), false, "an empty answer goes through the completeness path, not the transport retry");
});

test("draft retries back off 3 s, 15 s, 45 s by default and collapse to zero in tests", () => {
  assert.deepEqual(draftBackoff(3000), [3000, 15000, 45000]);
  assert.deepEqual(draftBackoff(0), [0, 0, 0]);
  assert.deepEqual(draftBackoff(-5), [0, 0, 0]);
});

test("the failure note names the stage, the attempts, what was kept and the next step", () => {
  const note = draftFailureNote("没有连上模型：fetch failed", 4, "气象-土壤多源融合智慧灌溉", []);
  assert.match(note, /^发明稿没有写成/);
  assert.match(note, /撰写全文/);
  assert.match(note, /共尝试 4 次/);
  assert.match(note, /选题「气象-土壤多源融合智慧灌溉」/);
  assert.match(note, /不会导出/);
  assert.match(note, /网络|代理/);
  const auth = draftFailureNote("密钥无效、过期或没有这个模型的权限", 1, "", []);
  assert.match(auth, /共尝试 1 次/);
  assert.match(auth, /密钥/);
});
