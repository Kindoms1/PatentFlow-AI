import { test } from "node:test";
import assert from "node:assert/strict";
import { countChars } from "./cnipa-format.ts";
import { UNVERIFIED_MARK, abstractOverflow, cleanAbstractReply, fitAbstract, guardCitations, locateAbstract, replaceAbstract } from "./draft-guards.ts";

const longAbstract = `本发明公开了一种作物水肥智能决策方法，属于智慧农业技术领域。${"方法包括采集土壤水分、养分、气象和作物长势数据并进行时序融合。".repeat(10)}本发明可提升水肥利用效率。`;
const draft = [
  "# 发明名称：一种作物水肥智能决策方法",
  "",
  "## 说明书摘要",
  longAbstract,
  "摘要附图：图1",
  "",
  "## 权利要求书",
  "1. 一种作物水肥智能决策方法，其特征在于，包括：采集数据。",
  "",
  "```json",
  '{"closestArt": "CN106707767A"}',
  "```",
].join("\n");

test("an overlong abstract is detected, fitted by whole sentences and replaced in place", () => {
  assert.ok(abstractOverflow(draft) > 0);
  const block = locateAbstract(draft);
  assert.ok(block);
  assert.equal(block.figureLines[0], "摘要附图：图1");
  const fitted = fitAbstract(block.text);
  assert.ok(countChars(fitted) <= 300, `${countChars(fitted)} chars`);
  assert.ok(fitted.startsWith("本发明公开了"));
  assert.ok(fitted.endsWith("。"));
  const next = replaceAbstract(draft, fitted);
  assert.equal(abstractOverflow(next), 0);
  assert.match(next, /摘要附图：图1\n\n## 权利要求书\n1\. 一种作物水肥智能决策方法/);
  assert.ok(next.endsWith("```"));
});

test("a single overlong sentence is cut at a clause boundary", () => {
  const fitted = fitAbstract(`本发明${"采集数据，".repeat(80)}`);
  assert.ok(countChars(fitted) <= 300);
  assert.ok(fitted.endsWith("。"));
  assert.ok(!fitted.endsWith("，。"));
});

test("citations outside the search results are marked once, known ones untouched", () => {
  const text = "CN106707767A公开了一种系统。CN999888777A公开了另一种系统。";
  const out = guardCitations(text, ["CN106707767A"]);
  assert.deepEqual(out.unknown, ["CN999888777A"]);
  assert.ok(out.text.includes(`CN999888777A${UNVERIFIED_MARK}`));
  assert.ok(!out.text.includes(`CN106707767A${UNVERIFIED_MARK}`));
  assert.equal(guardCitations(out.text, ["CN106707767A"]).text, out.text);
});

test("compression replies are cleaned to one paragraph", () => {
  assert.equal(cleanAbstractReply("## 说明书摘要\n**本发明**公开了一种方法。\n"), "本发明公开了一种方法。");
  assert.equal(cleanAbstractReply("摘要：本发明公开了一种方法。"), "本发明公开了一种方法。");
});