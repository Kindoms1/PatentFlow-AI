import test from "node:test";
import assert from "node:assert/strict";
import { reduce, seed } from "./model.ts";
import type { DraftRevisionRecord, InventionDraftState } from "./model.ts";

function draftOf(text: string, extra: Partial<InventionDraftState> = {}): InventionDraftState {
  return {
    text,
    score: 80,
    at: "2026-10-26T00:00:00.000Z",
    model: "test-model",
    revised: false,
    pendingMarks: 0,
    claimCount: 2,
    priorArt: [],
    checks: [],
    distinguishing: [],
    pending: [],
    ...extra,
  };
}

const RECORD: DraftRevisionRecord = {
  at: "2026-10-26T01:00:00.000Z",
  instruction: "把权利要求1放宽",
  summary: "阈值改为范围",
  applied: [{ find: "0.35", replace: "0.30～0.40", reason: "放宽阈值" }],
  skipped: [],
  notes: [],
  scoreBefore: 80,
  scoreAfter: 82,
  model: "test-model",
};

test("revise-invention-draft replaces the draft and undo-invention-draft restores the previous version", () => {
  let state = reduce(seed(), { type: "create-case", id: "case-revise", title: "修改测试", text: "", fileName: "对话.md", skill: true, materials: [] });
  const original = draftOf("原稿全文");
  state = reduce(state, { type: "set-invention-draft", caseId: "case-revise", draft: original });

  const revised = draftOf("修改后全文", { score: 82, revisions: [RECORD], undo: [original] });
  state = reduce(state, { type: "revise-invention-draft", caseId: "case-revise", draft: revised });
  let target = state.cases.find((item) => item.id === "case-revise");
  assert.equal(target?.inventionDraft?.text, "修改后全文");
  assert.equal(target?.disclosure, "修改后全文");
  assert.equal(target?.inventionDraft?.revisions?.length, 1);

  state = reduce(state, { type: "undo-invention-draft", caseId: "case-revise" });
  target = state.cases.find((item) => item.id === "case-revise");
  assert.equal(target?.inventionDraft?.text, "原稿全文");
  assert.equal(target?.disclosure, "原稿全文");
  assert.deepEqual(target?.inventionDraft?.undo, []);
  assert.equal(target?.inventionDraft?.revisions, undefined);

  const unchanged = reduce(state, { type: "undo-invention-draft", caseId: "case-revise" });
  assert.equal(unchanged, state);
  assert.equal(reduce(state, { type: "undo-invention-draft", caseId: "no-such-case" }), state);
});
