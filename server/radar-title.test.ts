import test from "node:test";
import assert from "node:assert/strict";
import { radarTitle } from "./patent-radar.ts";

test("radarTitle keeps a real Google Patents title, minus number prefix and site suffix", () => {
  assert.equal(
    radarTitle("CN112084859B - 一种基于稠密边界块和注意力机制的建筑物分割方法 - Google Patents", "", "CN112084859B"),
    "一种基于稠密边界块和注意力机制的建筑物分割方法",
  );
});

test("radarTitle recovers the invention name from (54) when the title is a PDF header", () => {
  const snippet = "(19)中华人民共和国国家知识产权局 (12)发明专利 (54)发明名称 一种基于深度学习的遥感影像建筑物提取方法 (57)摘要 本发明公开了……";
  assert.equal(radarTitle("(12)发明专利", snippet, "CN110176005B"), "一种基于深度学习的遥感影像建筑物提取方法");
});

test("radarTitle falls back to the publication number when no name can be recovered", () => {
  assert.equal(radarTitle("(12) 发明专利", "权利要求书 1.一种……", "CN110176005B"), "CN110176005B");
  assert.equal(radarTitle("", "", "CN110176005B"), "CN110176005B");
});

test("radarTitle treats the CNIPA header and application header as non-titles", () => {
  assert.equal(radarTitle("中华人民共和国国家知识产权局", "", "CN114708513A"), "CN114708513A");
  assert.equal(radarTitle("（12）发明专利申请", "", "CN114708513A"), "CN114708513A");
});

test("radarTitle does not reject real titles that merely contain the word 发明专利", () => {
  assert.equal(radarTitle("一种发明专利文本的自动审查方法", "", "CN1"), "一种发明专利文本的自动审查方法");
});
