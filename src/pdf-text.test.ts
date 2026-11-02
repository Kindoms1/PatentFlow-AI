import assert from "node:assert/strict";
import test from "node:test";
import { joinPages, pageText } from "./pdf-text.ts";

const run = (str: string, x: number, y: number, width: number, size = 10, hasEOL = false) => ({
  str,
  transform: [size, 0, 0, size, x, y],
  width,
  height: size,
  hasEOL,
});

test("pageText keeps the space between words in separate runs", () => {
  assert.equal(pageText([run("Contrastive", 72, 700, 50), run("Mask", 125, 700, 22)]), "Contrastive Mask");
});

test("pageText does not split a word whose runs touch", () => {
  assert.equal(pageText([run("Seg", 72, 700, 15), run("mentation", 87.5, 700, 40)]), "Segmentation");
});

test("pageText breaks the line when the baseline moves down one line", () => {
  assert.equal(pageText([run("in", 72, 700, 8), run("Remote", 72, 688, 30)]), "in\nRemote");
});

test("pageText starts a paragraph on a large drop or a jump to the next column", () => {
  assert.equal(pageText([run("Abstract", 72, 700, 40), run("Semantic", 72, 670, 40)]), "Abstract\n\nSemantic");
  assert.equal(pageText([run("end.", 72, 100, 18), run("Top", 320, 700, 15)]), "end.\n\nTop");
});

test("pageText honours hasEOL carried by an empty run", () => {
  assert.equal(pageText([run("first", 72, 700, 20), run("", 92, 700, 0, 10, true), run("second", 95, 700, 25)]), "first\nsecond");
});

test("pageText rejoins a word hyphenated across lines but keeps capitalised compounds", () => {
  assert.equal(pageText([run("seg-", 72, 700, 18), run("mentation", 72, 688, 40)]), "segmentation");
  assert.equal(pageText([run("Reference-", 72, 700, 45), run("Free", 72, 688, 20)]), "Reference-\nFree");
});

test("pageText adds no spaces between CJK runs", () => {
  assert.equal(pageText([run("一种专利", 72, 700, 40), run("挖掘方法", 115, 700, 40)]), "一种专利挖掘方法");
});

test("pageText does not double explicit space runs", () => {
  assert.equal(pageText([run("a", 72, 700, 5), run(" ", 77, 700, 2.5), run("b", 82, 700, 5)]), "a b");
});

test("pageText falls back to hasEOL when runs have no position and skips marked content", () => {
  assert.equal(pageText([{ type: "beginMarkedContent" }, { str: "x", hasEOL: true }, { str: "y" }]), "x\ny");
});

test("joinPages labels pages with text and returns empty text for a scan", () => {
  assert.equal(joinPages([{ page: 1, text: "A" }, { page: 2, text: "  " }, { page: 3, text: "B" }]), "【第 1 页】\nA\n\n【第 3 页】\nB");
  assert.equal(joinPages([{ page: 1, text: "" }, { page: 2, text: "\n" }]), "");
});