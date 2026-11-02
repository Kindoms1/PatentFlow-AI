import { test } from "node:test";
import assert from "node:assert/strict";
import { featureCoverage, matrixRisk, noveltyQueries, noveltyReport, parseNoveltyReply, runNoveltyCheck } from "./novelty-check.ts";
import type { NoveltyPoint } from "./novelty-check.ts";

const point: NoveltyPoint = {
  title: "一种基于土壤水分与气象耦合的智能灌溉控制方法",
  problem: "现有灌溉按固定周期执行，水分利用率低",
  feature: "采集多层土壤含水率，融合气象预报计算作物蒸散量，按根区水分亏缺动态决策灌水量",
  effect: "节水并稳定根区水分",
  pending: "",
};

const refs = [
  { pn: "CN112345678A", title: "一种智能灌溉控制方法", url: "https://patents.google.com/patent/CN112345678A/zh", note: "根据土壤含水率阈值开启灌溉阀门" },
  { pn: "CN113456789B", title: "一种基于气象数据的灌溉系统", url: "https://patents.google.com/patent/CN113456789B/zh", note: "利用气象站数据计算参考蒸散量" },
];

function hits(query: string) {
  return {
    ok: true,
    detail: "",
    results: [
      { title: `一种智能灌溉控制方法 ${query}`.slice(0, 30), url: "https://patents.google.com/patent/CN112345678A/zh", snippet: "根据土壤含水率阈值开启灌溉阀门的智能灌溉控制方法" },
      { title: "一种基于气象数据的灌溉系统", url: "https://patents.google.com/patent/CN113456789B/zh", snippet: "利用气象站数据计算参考蒸散量进行灌溉" },
    ],
  };
}

const lowReply = "```json\n" + JSON.stringify({
  features: [{ id: "F1", text: "采集多层土壤含水率" }, { id: "F2", text: "融合气象预报计算蒸散量" }, { id: "F3", text: "按根区水分亏缺决策灌水量" }],
  rows: [{ pn: "D1", disclosed: ["F1"], partial: [], note: "公开了阈值灌溉" }, { pn: "CN113456789", disclosed: ["F2"], partial: ["F3"], note: "公开了蒸散量计算" }],
  closest: "CN112345678A",
  distinguishing: [{ feature: "按根区水分亏缺动态决策灌水量", problem: "固定阈值灌溉滞后", effect: "节水" }],
  innovations: [{ point: "根区水分亏缺动态决策", analysis: "两篇文献均未公开亏缺量与预报蒸散量联合决策" }],
  risk: "低",
  reason: "区别特征未被公开",
  improved: null,
}) + "\n```";

test("noveltyQueries builds several distinct queries", () => {
  const queries = noveltyQueries(point);
  assert.ok(queries.length >= 3, queries.join("|"));
  assert.equal(new Set(queries).size, queries.length);
});

test("parseNoveltyReply maps D-labels and base numbers to refs", () => {
  const parsed = parseNoveltyReply(lowReply, refs, point);
  assert.ok(parsed);
  assert.equal(parsed.features.length, 3);
  assert.deepEqual(parsed.rows[0].disclosed, ["F1"]);
  assert.deepEqual(parsed.rows[1].partial, ["F3"]);
  assert.equal(parsed.closest, "CN112345678A");
  assert.equal(parsed.risk, "低");
  assert.equal(parsed.improved, null);
});

test("matrixRisk escalates when one document discloses every feature", () => {
  const parsed = parseNoveltyReply(lowReply, refs, point);
  assert.ok(parsed);
  parsed.rows[0].disclosed = ["F1", "F2", "F3"];
  assert.equal(matrixRisk(parsed), "高");
});

test("featureCoverage is between 0 and 1", () => {
  const value = featureCoverage(point, refs[0]);
  assert.ok(value >= 0 && value <= 1);
});

test("runNoveltyCheck accepts a low-risk scheme in one round and reports the matrix", async () => {
  const traces: string[] = [];
  const outcome = await runNoveltyCheck(
    { point, alternatives: [], allowRewrite: true, trace: (text) => traces.push(text) },
    { search: async (query) => hits(query), ask: async () => ({ ok: true, text: lowReply }) },
  );
  assert.equal(outcome.aborted, false);
  assert.equal(outcome.rounds.length, 1);
  assert.equal(outcome.risk, "低");
  assert.equal(outcome.changed, false);
  assert.ok(outcome.refs.length >= 1);
  assert.match(outcome.report, /特征对比矩阵/);
  assert.match(outcome.report, /创新点分析/);
});

test("runNoveltyCheck strengthens a high-risk scheme and re-checks it", async () => {
  const high = lowReply.replace('"risk":"低"', '"risk":"高"').replace('"improved":null', '"improved":{"title":"一种基于根区水分亏缺预测与气象耦合的分区变量灌溉控制方法","feature":"按土层权重计算亏缺量并结合未来72小时蒸散预测分区决策"}');
  let calls = 0;
  const outcome = await runNoveltyCheck(
    { point, alternatives: [], allowRewrite: true, trace: () => {} },
    { search: async (query) => hits(query), ask: async () => ({ ok: true, text: calls++ === 0 ? high : lowReply }) },
  );
  assert.equal(outcome.rounds.length, 2);
  assert.equal(outcome.changed, true);
  assert.match(outcome.point.title, /分区变量灌溉/);
  assert.equal(outcome.risk, "低");
  assert.match(outcome.report, /强化方案后复查/);
});

test("runNoveltyCheck keeps the inventor's own scheme and records the suggestion", async () => {
  const high = lowReply.replace('"risk":"低"', '"risk":"高"').replace('"improved":null', '"improved":{"title":"一种改进的灌溉控制方法","feature":"增加分区"}');
  const outcome = await runNoveltyCheck(
    { point, alternatives: [], allowRewrite: false, trace: () => {} },
    { search: async (query) => hits(query), ask: async () => ({ ok: true, text: high }) },
  );
  assert.equal(outcome.changed, false);
  assert.equal(outcome.rounds.length, 1);
  assert.match(outcome.report, /改进建议/);
});

test("runNoveltyCheck switches to the next candidate when no strengthened scheme is given", async () => {
  const high = lowReply.replace('"risk":"低"', '"risk":"高"');
  let calls = 0;
  const other: NoveltyPoint = { title: "一种灌溉管网压力自适应调节装置", problem: "", feature: "按管网压力调节阀门开度", effect: "", pending: "" };
  const outcome = await runNoveltyCheck(
    { point, alternatives: [other], allowRewrite: true, trace: () => {} },
    { search: async (query) => hits(query), ask: async () => ({ ok: true, text: calls++ === 0 ? high : lowReply }) },
  );
  assert.equal(outcome.point.title, other.title);
  assert.equal(outcome.rounds.length, 2);
});

test("runNoveltyCheck without any document still returns a report", async () => {
  const outcome = await runNoveltyCheck(
    { point, alternatives: [], allowRewrite: true, trace: () => {} },
    { search: async () => ({ ok: true, detail: "", results: [] }), ask: async () => ({ ok: true, text: lowReply }) },
  );
  assert.equal(outcome.risk, null);
  assert.equal(outcome.refs.length, 0);
  assert.match(outcome.report, /没有检到/);
});

test("unparsed novelty assessment never turns low lexical overlap into low patent risk", async () => {
  const outcome = await runNoveltyCheck(
    { point, alternatives: [], allowRewrite: true, trace: () => {} },
    { search: async query => hits(query), ask: async () => ({ ok: true, text: "not a comparison matrix" }) },
  );
  assert.ok(outcome.refs.length > 0);
  assert.equal(outcome.risk, null);
  assert.match(outcome.report, /特征比对未完成/);
  assert.doesNotMatch(outcome.report, /风险评级：\*\*低/);
});

test("noveltyReport has no empty matrix when the reply cannot be parsed", () => {
  const report = noveltyReport({ point, refs, assessment: null, risk: "中", overlap: 0.6, rounds: [{ round: 1, title: point.title, queries: ["a"], docs: 2, risk: "中", action: "x" }], queries: ["a"] });
  assert.doesNotMatch(report, /特征对比矩阵/);
  assert.match(report, /风险评级：\*\*中\*\*/);
});

test("runNoveltyCheck stops when aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const outcome = await runNoveltyCheck({ point, alternatives: [], allowRewrite: true, trace: () => {}, signal: controller.signal }, { search: async (query) => hits(query), ask: async () => ({ ok: true, text: lowReply }) });
  assert.equal(outcome.aborted, true);
});
