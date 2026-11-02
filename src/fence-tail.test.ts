import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFigureSpecs, looksLikeFigureJson, stripDraftJsonTail } from "./figure-spec.ts";
import { draftBody, parseDraftTail } from "./draft-run.ts";
import { parseApplication } from "./cnipa-format.ts";
import { FIGURE_SAMPLE } from "./figure-sample.ts";

const FLOW = `{"no":2,"kind":"flow","steps":[{"id":"S1","text":"S1 采集各土层体积含水率"},{"id":"S2","text":"S2 计算补水量并下发灌溉指令"}],"edges":[["S1","S2"]]}`;
const BLOCK = `{"no":1,"kind":"block","nodes":[{"id":"a","text":"土壤壒情监测单元","ref":"10"},{"id":"b","text":"决策控制器","ref":"30"}],"edges":[{"from":"a","to":"b"}]}`;
const TAIL = `{"distinguishing":[{"feature":"分层壒情反馈","problem":"灌水量不准","effect":"节水"}],"pending":["待确认参数"],"closestArt":"CN000000000A"}`;

const fence = (label: string, body: string): string => "```" + label + "\n" + body + "\n```";

const BODY = [
  "## 附图说明",
  "图1为系统框图。",
  fence("json", '{"example":true}'),
  "## 具体实施方式",
  "保留到文末的正文。",
].join("\n");

test("stripDraftJsonTail 只去掉紧贴文末的 json 尾块", () => {
  const text = BODY + "\n" + fence("json", TAIL) + "\n\n";
  assert.equal(stripDraftJsonTail(text), BODY + "\n");
  assert.equal(stripDraftJsonTail(BODY), BODY);
  assert.equal(stripDraftJsonTail("正文。"), "正文。");
});

test("误标成 json 的附图块位于文末时不被当作尾块删除", () => {
  const text = BODY + "\n" + fence("json", FLOW);
  assert.equal(stripDraftJsonTail(text), text);
});

test("draftBody 不再连同正文中间的 json 块删掉后续正文", () => {
  const text = BODY + "\n" + fence("json", TAIL) + "\n";
  const body = draftBody(text);
  assert.equal(body, BODY);
  assert.match(body, /保留到文末的正文/);
  assert.match(body, /"example":true/);
  assert.doesNotMatch(body, /"pending"/);
  assert.deepEqual(parseDraftTail(text).pending, ["待确认参数"]);
  assert.equal(parseDraftTail(text).distinguishing[0].feature, "分层壒情反馈");
});

test("looksLikeFigureJson 只认带图号和可识别 kind 的对象", () => {
  for (const yes of [BLOCK, FLOW, `[${BLOCK},${FLOW}]`, '{"no":"3","kind":"flowchart"}', '  {"no":4,"kind":"structure"}  ']) {
    assert.equal(looksLikeFigureJson(yes), true, yes);
  }
  for (const no of [TAIL, "{not json}", "[]", '"flow"', "null", '{"kind":"flow"}', '{"no":1,"kind":"pie"}', '{"no":1,"kind":"constructor"}', '{"no":1,"kind":"__proto__"}', '{"no":"图","kind":"flow"}', `[${BLOCK},${TAIL}]`]) {
    assert.equal(looksLikeFigureJson(no), false, no);
  }
});

test("extractFigureSpecs 收下误标为 json 的附图块，其他 json 块原样保留", () => {
  const markdown = ["## 附图说明", "图1、图2。", fence("json", BLOCK), fence("附图", FLOW), fence("json", '{"example":true}'), "## 具体实施方式", "正文。"].join("\n");
  const { specs, issues, text } = extractFigureSpecs(markdown);
  assert.deepEqual(specs.map((spec) => spec.no), [1, 2]);
  assert.equal(issues.some((issue) => /JSON|闭合/.test(issue.message)), false);
  assert.doesNotMatch(text, /"nodes"|"steps"/);
  assert.equal(text.split("```json").length - 1, 1);
  assert.match(text, /\{"example":true\}/);
  assert.match(text, /正文。$/);
});

test("未闭合或被其他围栏打断的 json 块不当作附图", () => {
  const unclosed = "```json\n" + BLOCK;
  const first = extractFigureSpecs(unclosed);
  assert.equal(first.specs.length, 0);
  assert.equal(first.text, unclosed);

  const interrupted = ["```json", BLOCK, "```附图", FLOW, "```"].join("\n");
  const second = extractFigureSpecs(interrupted);
  assert.deepEqual(second.specs.map((spec) => spec.no), [2]);
  assert.equal(second.text, "```json\n" + BLOCK);
});

test("parseApplication：附图围栏写成 json 与写成 附图 结果一致，尾块不吞正文", () => {
  const original = [FIGURE_SAMPLE].flat().join("\n");
  assert.match(original, /^```附图[ \t]*$/m);
  assert.doesNotMatch(original, /```json/i);
  const relabelled = original.replace(/^```附图[ \t]*$/gm, "```json");
  assert.doesNotMatch(relabelled, /^```附图/m);
  const withTail = relabelled.replace(/\s*$/, "\n") + fence("json", TAIL) + "\n";
  const base = parseApplication(original);
  assert.ok((base.figureSpecs ?? []).length >= 1);
  for (const variant of [relabelled, withTail]) {
    assert.deepEqual(parseApplication(variant), base);
  }
});