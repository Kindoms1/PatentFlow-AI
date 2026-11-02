import test from "node:test";
import assert from "node:assert/strict";
import { formalCheck, parseApplication, reviewAnnotationsOf, stripReviewAnnotations } from "./cnipa-format.ts";

const SAMPLE = [
  "采样周期为15分钟（模拟值，待实验验证）。降噪采用滑动平均（推断，待确认），然后归一化。",
  "待确认：阈值取0.8。",
  "- 待确认: 窗口长度",
  "核宽取【待发明人确认：核宽】。",
].join("\n");

test("formal text retains the non-measured status of simulated values and keeps pending facts", () => {
  assert.equal(
    stripReviewAnnotations(SAMPLE),
    ["采样周期为15分钟（示例性设定，非实测数据，尚需实验核验）。降噪采用滑动平均，然后归一化。", "阈值取0.8。", "- 窗口长度", "核宽取【待发明人确认：核宽】。"].join("\n"),
  );
  assert.equal(stripReviewAnnotations("温度上限为40℃(推断, 待确认)，下限取环境温度（待确认）。"), "温度上限为40℃，下限取环境温度。");
  assert.equal(stripReviewAnnotations("本发明无需待确认的参数。"), "本发明无需待确认的参数。");
});

test("review annotations are collected once each, with the sentence they qualify", () => {
  assert.deepEqual(reviewAnnotationsOf(SAMPLE), [
    "采样周期为15分钟（模拟值，待实验验证）",
    "降噪采用滑动平均（推断，待确认）",
    "待确认：阈值取0.8。",
    "待确认: 窗口长度",
  ]);
  // 句首“待确认：”与句中“（推断，待确认）”在同一句时只列一条
  assert.deepEqual(reviewAnnotationsOf("待确认：降噪采用小波去噪（推断，待确认）。"), ["待确认：降噪采用小波去噪（推断，待确认）"]);
  assert.deepEqual(reviewAnnotationsOf("没有任何标注。"), []);
});

test("parsed application text is clean and the formal check points to the review sheet", () => {
  const draft = [
    "# 发明名称：一种灌溉控制方法",
    "",
    "## 说明书摘要",
    "",
    "本发明公开了一种灌溉控制方法，按预测含水率控制电磁阀。",
    "",
    "## 权利要求书",
    "",
    "1. 一种灌溉控制方法，其特征在于，包括：采集土壤含水率；按预测含水率控制电磁阀。",
    "",
    "## 说明书",
    "",
    "### 技术领域",
    "",
    "本发明涉及灌溉控制技术领域。",
    "",
    "### 具体实施方式",
    "",
    "采样周期为15分钟（模拟值，待实验验证），降噪采用滑动平均（推断，待确认）。",
  ].join("\n");
  const app = parseApplication(draft, "灌溉");
  const formal = JSON.stringify({ abstract: app.abstract, claims: app.claims, description: app.description });
  assert.doesNotMatch(formal, /模拟值，待实验验证|推断，待确认/);
  assert.match(formal, /采样周期为15分钟（示例性设定，非实测数据，尚需实验核验），降噪采用滑动平均。/);
  assert.equal(app.reviewAnnotations?.length, 2);
  const check = formalCheck(app).checks.find((item) => item.id === "review-annotations");
  assert.ok(check);
  assert.equal(check.level, "warn");
  assert.match(check.detail, /2 处/);
});

test("standalone simulation prose is formalized without losing its scientific qualification or audit context", () => {
  const raw = "以下实施例中的具体数值为模拟值，用于说明方案的实现方式，不作为对保护范围的限定。";
  assert.equal(stripReviewAnnotations(raw), "以下实施例中的具体数值为示例性设定（非实测数据），用于说明方案的实现方式，不作为对保护范围的限定。");
  assert.deepEqual(reviewAnnotationsOf(raw), [raw]);
});

test("mixed parameter parentheticals retain definitions, ranges and original review metadata", () => {
  const raw = "连续周期数（$N$ 取 2～3，本实施例取 2，模拟值，待实验验证）用于失效判定。";
  assert.equal(stripReviewAnnotations(raw), "连续周期数（$N$ 取 2～3，本实施例取 2，示例性设定，非实测数据，尚需实验核验）用于失效判定。");
  assert.deepEqual(reviewAnnotationsOf(raw), ["连续周期数（$N$ 取 2～3，本实施例取 2，模拟值，待实验验证）"]);
});

test("mixed simulation labels no longer block parsing while numerical content and audit metadata remain", () => {
  const narrative = "以下实施例中的具体数值为模拟值，用于说明方案的实现方式。";
  const mixed = "流态指数 $x$（无量纲，可在 0.4～0.7 范围内按灌水器型号选取，模拟值，待实验验证）用于压力归一化。";
  const draft = [
    "# 发明名称：一种分区控制方法",
    "## 权利要求书",
    "1. 一种分区控制方法，其特征在于，包括根据流量控制分区阀门。",
    "## 具体实施方式", narrative, mixed,
    "示例计算的水量为3.32 m³（模拟值，待实验验证）。",
  ].join("\n");
  const app = parseApplication(draft);
  const text = app.description.flatMap((part) => part.paragraphs.map((item) => item.text)).join("\n");
  assert.doesNotMatch(text, /模拟值|待实验验证/);
  assert.match(text, /非实测数据/);
  assert.ok(text.includes("无量纲，可在 0.4～0.7 范围内按灌水器型号选取"));
  assert.ok(text.includes("3.32 m³"));
  assert.equal(app.reviewAnnotations?.length, 3);
  assert.ok(app.reviewAnnotations?.includes(narrative));
  assert.equal(formalCheck(app).checks.some((check) => check.id === "forbidden-marks"), false);
});

test("formalizing simulated values does not disable the gate for unresolved internal work instructions", () => {
  const draft = [
    "# 发明名称：一种分区控制方法",
    "## 权利要求书",
    "1. 一种分区控制方法，其特征在于，包括根据流量控制分区阀门。",
    "## 具体实施方式",
    "数值为模拟值，验证资料待检索。",
  ].join("\n");
  const report = formalCheck(parseApplication(draft));
  assert.equal(report.exportable, false);
  assert.match(report.fatal, /待检索/);
  assert.equal(report.checks.find((check) => check.id === "forbidden-marks")?.level, "error");
});
