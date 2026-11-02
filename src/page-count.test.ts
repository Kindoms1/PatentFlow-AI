import test from "node:test";
import assert from "node:assert/strict";
import { pageCount, sizeLabel } from "./page-count.ts";

test("pageCount reads the highest page marker", () => {
  assert.equal(pageCount(""), 0);
  assert.equal(pageCount("没有页码的文本"), 0);
  assert.equal(pageCount("【第 1 页】\na\n\n【第 2 页】\nb\n\n【第 9 页】\nc"), 9);
  assert.equal(pageCount("【第3页】x【第 12 页】y"), 12);
});

test("sizeLabel shows pages before characters when known", () => {
  assert.equal(sizeLabel({ chars: 5 }), "5 字");
  assert.equal(sizeLabel({ chars: 40813, pages: 9 }), "9 页 · 40813 字");
  assert.equal(sizeLabel({ chars: 20, text: "【第 1 页】\nab\n\n【第 2 页】\ncd" }), "2 页 · 20 字");
  assert.equal(sizeLabel({ chars: 3, pages: 0, text: "【第 4 页】" }), "3 字");
});