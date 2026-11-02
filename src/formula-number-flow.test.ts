import test from "node:test";
import assert from "node:assert/strict";
import { FORMULA_NUMBER_FIX, evaluateRevision } from "./draft-revise.ts";

const BASE = "## 权利要求书\n1. 一种方法，包括按下式计算功率：\n$$P=UI$$\n## 具体实施方式\n功率按下式计算：\n$$P=UI$$\n式中，$P$为功率，$U$为电压，$I$为电流。\n能量按下式计算：\n$$E=Pt$$\n式中，$E$为能量，$t$为时间。";
const CLAIMS = BASE.slice(0, BASE.indexOf("## 具体实施方式"));

test("修订复核时为说明书未编号独立公式补编号，权利要求不动", () => {
  const check = evaluateRevision(BASE, BASE, { priorArt: [] });
  assert.ok(check.text.includes("$$P=UI$$（1）"), check.text);
  assert.ok(check.text.includes("$$E=Pt$$（2）"), check.text);
  assert.ok(check.text.startsWith(CLAIMS));
  assert.equal(check.fixes.filter((fix) => fix.startsWith(FORMULA_NUMBER_FIX)).length, 1);
});

test("已编号稿件再次复核不重复编号", () => {
  const once = evaluateRevision(BASE, BASE, { priorArt: [] }).text;
  const twice = evaluateRevision(once, once, { priorArt: [] });
  assert.equal(twice.text, once);
  assert.equal(twice.fixes.filter((fix) => fix.startsWith(FORMULA_NUMBER_FIX)).length, 0);
});