import assert from "node:assert/strict";
import test from "node:test";
import { parseAutoReply } from "./auto-flow.ts";

const fence = "```";

test("json block with comments and trailing commas still yields candidates", () => {
  const text = [
    `${fence}json`,
    "{",
    "  // 候选题目",
    '  "patentPoints": [',
    '    { "title": "一种基于能量收集的农田传感网络系统", "problem": "野外供电难", },',
    '    { "title": "一种温室土壤墒情预测方法", },',
    "  ],",
    '  "recommended": 2,',
    "}",
    fence,
  ].join("\n");
  const parsed = parseAutoReply(text);
  assert.equal(parsed.points.length, 2);
  assert.equal(parsed.points[0].problem, "野外供电难");
  assert.equal(parsed.recommended, 1);
  assert.equal(parsed.visible, "");
});

test("chinese and unfamiliar list keys are recognised, questions are not", () => {
  const chinese = parseAutoReply(`${fence}json\n{"候选题目":[{"题目":"一种农机作业路径规划方法","技术问题":"重漏播"}],"推荐":1}\n${fence}`);
  assert.deepEqual(chinese.points.map((point) => point.title), ["一种农机作业路径规划方法"]);
  assert.equal(chinese.points[0].problem, "重漏播");
  const other = parseAutoReply(`${fence}json\n{"questions":["一种什么方法？"],"inventions":[{"name":"一种果园虫情识别装置"}]}\n${fence}`);
  assert.deepEqual(other.points.map((point) => point.title), ["一种果园虫情识别装置"]);
  const onlyQuestions = parseAutoReply(`${fence}json\n{"questions":["一种什么方法？"]}\n${fence}`);
  assert.equal(onlyQuestions.points.length, 0);
});

test("a string array of titles counts as candidates", () => {
  const parsed = parseAutoReply(`${fence}json\n{"candidates":["一种精准灌溉决策方法","一种田间气象采集终端"],"recommended":2}\n${fence}`);
  assert.deepEqual(parsed.points.map((point) => point.title), ["一种精准灌溉决策方法", "一种田间气象采集终端"]);
  assert.equal(parsed.recommended, 1);
});

test("truncated json still gives titles and is not shown to the inventor", () => {
  const text = `检索归纳如下。\n${fence}json\n{"patentPoints":[{"title":"一种农田边缘计算节点","problem":"延迟高"},{"title":"一种作物产量预测方法","effe`;
  const parsed = parseAutoReply(text);
  assert.deepEqual(parsed.points.map((point) => point.title), ["一种农田边缘计算节点", "一种作物产量预测方法"]);
  assert.equal(parsed.visible, "检索归纳如下。");
});

test("bare json without a fence is parsed instead of displayed", () => {
  const parsed = parseAutoReply('{"reply":"已归纳现有做法。","patentPoints":[{"title":"一种智能温室环境调控系统"}]}');
  assert.equal(parsed.visible, "已归纳现有做法。");
  assert.equal(parsed.points[0].title, "一种智能温室环境调控系统");
});

test("plain prose without titles still yields nothing", () => {
  const parsed = parseAutoReply("智慧农业领域专利较多，建议从传感与决策入手。");
  assert.equal(parsed.points.length, 0);
  assert.equal(parsed.visible, "智慧农业领域专利较多，建议从传感与决策入手。");
});