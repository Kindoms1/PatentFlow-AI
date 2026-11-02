import { test } from "node:test";
import assert from "node:assert/strict";
import { numberDescriptionFormulas } from "./formula-number.ts";
import { auditFormulas, draftFormulaSources } from "./formula-audit.ts";
import { parseDisplayLine } from "./formula.ts";

const BASE = [
  "## 权利要求书",
  "1. 一种方法，包括按下式计算功率：",
  "$$P=UI$$",
  "## 具体实施方式",
  "功率按下式计算：",
  "$$P=UI$$",
  "式中，$P$为功率，$U$为电压，$I$为电流。",
  "能量按下式计算：",
  "$$E=Pt$$，",
  "式中，$E$为能量，$t$为时间。",
].join("\n");

const numberingIssues = (text: string) => auditFormulas(draftFormulaSources(text)).issues.filter((item) => item.id === "formula-numbering");

test("description formulas are numbered in order; claim formulas are left alone", () => {
  const result = numberDescriptionFormulas(BASE);
  assert.equal(result.numbered, 2);
  assert.equal(result.skipped, null);
  const lines = result.text.split("\n");
  assert.equal(lines[2], "$$P=UI$$");
  assert.equal(lines[5], "$$P=UI$$（1）");
  assert.equal(lines[8], "$$E=Pt$$（2），");
  assert.equal(parseDisplayLine(lines[5])?.label, "1");
  assert.equal(parseDisplayLine(lines[8])?.label, "2");
  assert.equal(parseDisplayLine(lines[8])?.tex.trim(), "E=Pt");
});

test("numbering clears the formula-numbering issue", () => {
  assert.ok(numberingIssues(BASE).length > 0);
  assert.equal(numberingIssues(numberDescriptionFormulas(BASE).text).length, 0);
});

test("existing numbers are never rewritten, and numbering is idempotent", () => {
  const partial = BASE.replace("$$E=Pt$$，", () => "$$E=Pt$$（2），");
  assert.deepEqual(numberDescriptionFormulas(partial), { text: partial, numbered: 0, skipped: "说明书公式已有编号" });
  const once = numberDescriptionFormulas(BASE).text;
  assert.equal(numberDescriptionFormulas(once).text, once);
});

test("a text that already cites 式（n） is left for review", () => {
  const cited = `${BASE}\n由式（1）可知功率与电流成正比。`;
  const result = numberDescriptionFormulas(cited);
  assert.equal(result.text, cited);
  assert.equal(result.skipped, "正文已引用式号");
});

test("multi-line $$ blocks and trailing prose are left alone", () => {
  const block = BASE.replace("$$E=Pt$$，", () => "$$\nE=Pt\n$$");
  assert.equal(numberDescriptionFormulas(block).text, block);
  const prose = BASE.replace("$$E=Pt$$，", () => "$$E=Pt$$其中时间取秒");
  assert.equal(numberDescriptionFormulas(prose).text, prose);
});

test("CRLF line endings are preserved", () => {
  const crlf = BASE.replace(/\n/g, "\r\n");
  const result = numberDescriptionFormulas(crlf);
  assert.equal(result.numbered, 2);
  assert.ok(!/[^\r]\n/.test(result.text));
  assert.ok(result.text.includes("$$P=UI$$（1）\r\n"));
});