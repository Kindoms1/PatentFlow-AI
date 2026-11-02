import { test } from "node:test";
import assert from "node:assert/strict";
import { existingFigures, expandDraft, findSection, hasInnovationSection, maxFormulaNo, referenceList, sanitizeSections, sectionChars } from "./draft-expand.ts";
import type { ExpandEvaluation } from "./draft-expand.ts";

const draft = [
  "# 发明名称：一种智能灌溉控制方法",
  "",
  "## 说明书摘要",
  "本发明公开了一种智能灌溉控制方法。",
  "摘要附图：图1",
  "",
  "## 权利要求书",
  "1. 一种智能灌溉控制方法，其特征在于，包括：S1、采集；S2、决策。",
  "",
  "## 技术领域",
  "本发明涉及农业灌溉领域。",
  "",
  "## 背景技术",
  "现有灌溉按固定周期执行。CN112345678A公开了阈值灌溉。",
  "",
  "## 发明内容",
  "### 要解决的技术问题",
  "水分利用率低。",
  "### 技术方案",
  "采集并决策。",
  "### 有益效果",
  "节水。",
  "",
  "## 附图说明",
  "图1为本发明实施例提供的方法流程图；",
  "图2为本发明实施例提供的系统框图。",
  "```附图",
  '{"no":1,"kind":"flow","steps":[{"id":"S1","text":"S1 采集"},{"id":"S2","text":"S2 决策"}]}',
  "```",
  "",
  "## 具体实施方式",
  "### 实施例1",
  "如图1所示，控制器30执行步骤。",
  "$$ W = a + b $$ （1）",
  "### 附图标记",
  "10—传感器；30—控制器",
  "",
  "```json",
  '{"distinguishing":[],"pending":[],"closestArt":""}',
  "```",
].join("\n");

const lines = draft.split("\n");

test("section helpers find spans, figures, references and formula numbers", () => {
  const span = findSection(lines, "具体实施方式");
  assert.ok(span);
  assert.equal(span.end, lines.length);
  assert.deepEqual(existingFigures(lines), [1, 2]);
  assert.match(referenceList(lines), /30—控制器/);
  assert.equal(maxFormulaNo(draft), 1);
  assert.equal(hasInnovationSection(lines), false);
  assert.ok(sectionChars(lines, findSection(lines, "附图说明")) < 60, "code blocks are not counted");
});

test("sanitizeSections demotes headings, drops preambles, code and missing figure refs", () => {
  const out = sanitizeSections("以下是补写内容：\n## 实施例2：变量灌溉\n如图9所示，控制器30动作。如图1所示，开始。\n```json\n{}\n```", [1, 2]);
  assert.match(out, /^### 实施例2：变量灌溉/);
  assert.doesNotMatch(out, /图9/);
  assert.match(out, /如图1所示/);
  assert.doesNotMatch(out, /```/);
});

const long = (label: string, n: number) => `${label}${"细化步骤说明。".repeat(n)}`;

test("expandDraft inserts innovation, background and embodiments at the right places", async () => {
  const replies = [
    `### 创新点分析\n（1）根区亏缺决策\n${long("", 120)}`,
    `${long("灌溉领域现状。CN112345678A公开了阈值灌溉，存在滞后。", 120)}`,
    `### 实施例2：分区灌溉\n${long("", 400)}\n### 应用场景实施例\n${long("", 400)}`,
    `### 关键参数选取依据\n${long("", 400)}\n### 技术效果分析\n${long("", 400)}\n### 附图标记\n不应插入`,
  ];
  const evaluate = (text: string): ExpandEvaluation => ({ complete: text.includes("## 具体实施方式"), score: 90, exportable: true, figureErrors: 0 });
  const outcome = await expandDraft(
    { text: draft, priorArt: [], auto: true, trace: () => {}, evaluate },
    { ask: async () => ({ ok: true, text: replies.shift() ?? "" }) },
  );
  assert.equal(outcome.changed, true);
  assert.equal(outcome.added.length, 4);
  const out = outcome.text.split("\n");
  const innovation = out.findIndex((line) => line === "### 创新点分析");
  const benefit = out.findIndex((line) => line === "### 有益效果");
  assert.ok(innovation > 0 && innovation < benefit);
  const embodiment = out.findIndex((line) => line.startsWith("### 实施例2"));
  const references = out.findIndex((line) => line.startsWith("### 附图标记"));
  assert.ok(embodiment > 0 && embodiment < references);
  assert.equal(out.filter((line) => line.startsWith("### 附图标记")).length, 1);
  assert.ok(out.findIndex((line) => line.startsWith("### 技术效果分析")) < references);
  assert.match(outcome.text, /CN112345678A公开了阈值灌溉，存在滞后/);
  assert.ok(outcome.text.trimEnd().endsWith("```"), "tail json stays last");
});

test("expandDraft rejects a step that breaks export", async () => {
  let call = 0;
  const evaluate = (text: string): ExpandEvaluation => ({ complete: true, score: 90, exportable: call === 0 || !text.includes("创新点分析"), figureErrors: 0 });
  const outcome = await expandDraft(
    { text: draft, priorArt: [], auto: false, trace: () => {}, evaluate },
    {
      ask: async () => {
        call += 1;
        return { ok: true, text: call === 1 ? `### 创新点分析\n${long("", 120)}` : "" };
      },
    },
  );
  assert.equal(outcome.added.includes("补写创新点分析"), false);
  assert.doesNotMatch(outcome.text, /创新点分析/);
});

test("background rewrite that drops a cited number is not used", async () => {
  const replies = ["", `${long("灌溉领域现状，没有引用任何公开号。", 120)}`, "", ""];
  const outcome = await expandDraft(
    { text: draft, priorArt: [], auto: false, trace: () => {}, evaluate: () => ({ complete: true, score: 90, exportable: true, figureErrors: 0 }) },
    { ask: async () => ({ ok: true, text: replies.shift() ?? "" }) },
  );
  assert.equal(outcome.added.includes("重写背景技术"), false);
});

test("expandDraft stops on abort", async () => {
  const outcome = await expandDraft(
    { text: draft, priorArt: [], auto: false, trace: () => {}, evaluate: () => ({ complete: true, score: 90, exportable: true, figureErrors: 0 }) },
    { ask: async () => ({ ok: false, text: "", aborted: true }) },
  );
  assert.equal(outcome.aborted, true);
  assert.equal(outcome.changed, false);
});
