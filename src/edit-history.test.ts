import { test } from "node:test";
import assert from "node:assert/strict";
import { HISTORY_LIMIT, createHistory, recordEdit, redoEdit, undoEdit } from "./edit-history.ts";

test("undo brings back a question that was deleted in one go, redo removes it again", () => {
  let history = createHistory("");
  history = recordEdit(history, "一种雨水井截污装置", 1000);
  history = recordEdit(history, "", 6000);
  const back = undoEdit(history);
  assert.ok(back);
  assert.equal(back.value, "一种雨水井截污装置");
  const again = redoEdit(back.history);
  assert.equal(again?.value, "");
});

test("quick single-character typing is one undo step", () => {
  let history = createHistory("");
  history = recordEdit(history, "a", 1000);
  history = recordEdit(history, "ab", 1100);
  history = recordEdit(history, "abc", 1200);
  assert.equal(undoEdit(history)?.value, "");
});

test("a pause in typing starts a new undo step", () => {
  let history = createHistory("");
  history = recordEdit(history, "a", 1000);
  history = recordEdit(history, "ab", 1100);
  history = recordEdit(history, "abc", 3000);
  assert.equal(undoEdit(history)?.value, "ab");
});

test("a new edit after undo drops the redo branch", () => {
  let history = createHistory("");
  history = recordEdit(history, "第一版描述", 1000);
  history = recordEdit(history, "第二版描述更长一些", 5000);
  const back = undoEdit(history);
  assert.ok(back);
  history = recordEdit(back.history, "另一版", 9000);
  assert.equal(redoEdit(history), null);
  assert.equal(undoEdit(history)?.value, "第一版描述");
});

test("undo at the start returns null and history stays capped", () => {
  let history = createHistory("");
  assert.equal(undoEdit(history), null);
  for (let i = 1; i <= HISTORY_LIMIT + 50; i += 1) history = recordEdit(history, "x".repeat(i * 2), i * 1000);
  assert.equal(history.stack.length, HISTORY_LIMIT);
  assert.equal(history.index, HISTORY_LIMIT - 1);
});