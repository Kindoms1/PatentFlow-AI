import test from "node:test";
import assert from "node:assert/strict";
import { SPEC_STYLE_GUIDE, formalizePendingMarks, hasInternalMarkers, isInternalMark, stripInternalMarkers } from "./draft-polish.ts";
import { parseApplication } from "./cnipa-format.ts";
import { INVENTION_SYSTEM, buildDraftPrompt } from "./invention-draft.ts";
import { EXPAND_SYSTEM } from "./draft-expand.ts";

test("stripInternalMarkers removes a trailing retrieval placeholder and keeps the sentence", () => {
  const out = stripInternalMarkers("当温度超过固定阈值时报警。【待检索补充对比文件】");
  assert.equal(out.text, "当温度超过固定阈值时报警。");
  assert.deepEqual(out.removed, ["【待检索补充对比文件】"]);
});

test("stripInternalMarkers tidies punctuation around a removed marker", () => {
  assert.equal(stripInternalMarkers("现有做法依赖人工清掐【待检索补充对比文件】。").text, "现有做法依赖人工清掐。");
  assert.equal(stripInternalMarkers("一是效率低，【待检索】，二是成本高。").text, "一是效率低，二是成本高。");
  assert.equal(stripInternalMarkers("常见管卡采用螺栓紧固（待检索）。").text, "常见管卡采用螺栓紧固。");
  assert.equal(stripInternalMarkers("现有方案存在滞后，【待补充对比文件】。").text, "现有方案存在滞后。");
});

test("stripInternalMarkers drops a line that held only a marker", () => {
  const out = stripInternalMarkers("## 背景技术\n现有方案存在滞后。\n【待检索补充对比文件】\n## 发明内容");
  assert.equal(out.text, "## 背景技术\n现有方案存在滞后。\n## 发明内容");
  assert.equal(out.removed.length, 1);
});

test("stripInternalMarkers keeps inventor-confirmation marks, ordinary brackets and code blocks", () => {
  const text = [
    "阈值取【待发明人确认：土壤含水率下限】。",
    "【待发明人确认：检索窗口长度】",
    "【技术要点】采用分区控制。",
    "```附图",
    '{"title":"【待检索补充对比文件】"}',
    "```",
  ].join("\n");
  const out = stripInternalMarkers(text);
  assert.equal(out.text, text);
  assert.deepEqual(out.removed, []);
  assert.equal(hasInternalMarkers(text), false);
  assert.equal(isInternalMark("待发明人确认：检索窗口长度"), false);
  assert.equal(isInternalMark("待检索补充"), true);
});

test("stripInternalMarkers returns the same string when nothing is removed and preserves CRLF", () => {
  const clean = "本发明涉及灌溉领域。\n具体地，控制器30按分区启停。";
  assert.equal(stripInternalMarkers(clean).text, clean);
  const crlf = stripInternalMarkers("第一段。\r\n第二段。【待检索补充对比文件】\r\n第三段。");
  assert.equal(crlf.text, "第一段。\r\n第二段。\r\n第三段。");
});

test("drafting prompts no longer ask for retrieval placeholders and carry the style guide", () => {
  assert.ok(INVENTION_SYSTEM.includes(SPEC_STYLE_GUIDE));
  assert.ok(EXPAND_SYSTEM.includes(SPEC_STYLE_GUIDE));
  assert.doesNotMatch(INVENTION_SYSTEM, /【待检索/);
  assert.doesNotMatch(EXPAND_SYSTEM, /【待检索/);
  const prompt = buildDraftPrompt({ material: "一种灌溉控制方法" });
  assert.doesNotMatch(prompt, /【待检索/);
  assert.match(prompt, /说明书行文规范/);
  for (const phrase of ["具体地", "进一步地", "优选地", "在一些实施方式中", "数据流或控制流"]) assert.ok(SPEC_STYLE_GUIDE.includes(phrase), phrase);
});

test("parseApplication never hands a retrieval placeholder to export or preview", () => {
  const draft = [
    "# 发明名称：一种雨水井自动清掐装置",
    "## 说明书摘要",
    "本发明公开了一种雨水井自动清掐装置。",
    "## 权利要求书",
    "1. 一种雨水井自动清掐装置，其特征在于，包括抓斗。",
    "## 技术领域",
    "本发明涉及市政排水领域。",
    "## 背景技术",
    "现有雨水井依赖人工清掐。【待检索补充对比文件】",
    "## 发明内容",
    "### 要解决的技术问题",
    "人工清掐效率低。",
    "## 具体实施方式",
    "### 实施例1",
    "具体地，抓斗由电机驱动。",
  ].join("\n");
  const app = parseApplication(draft);
  assert.doesNotMatch(JSON.stringify(app), /待检索/);
  assert.match(JSON.stringify(app.description), /现有雨水井依赖人工清掐。/);
});

test("plain-text formalization preserves simulated outcomes as explicitly non-measured and retains the original mark", () => {
  const raw = "示例计算的累计水量为3.32 m³（模拟值，待实验验证）。";
  const out = formalizePendingMarks(raw);
  assert.equal(out.text, "示例计算的累计水量为3.32 m³（示例性设定，非实测数据，尚需实验核验）。");
  assert.deepEqual(out.marks, ["（模拟值，待实验验证）"]);
  assert.deepEqual(formalizePendingMarks(out.text), { text: out.text, marks: [] });
});

test("pending experimental verification is rephrased rather than silently removed", () => {
  const raw = "控制效果（待实验验证）不能视为已验证结论。";
  const out = formalizePendingMarks(raw);
  assert.equal(out.text, "控制效果（尚需实验核验）不能视为已验证结论。");
  assert.deepEqual(out.marks, ["（待实验验证）"]);
});

test("plain-text formalization keeps mixed definitions and records marks in their original order", () => {
  const raw = "周期为【待填写】；下限（取设计流量的60%～70%，本例取65%，即1.43 m³/h，模拟值，待实验验证）用于判定。";
  const out = formalizePendingMarks(raw);
  assert.ok(out.text.includes("取设计流量的60%～70%，本例取65%，即1.43 m³/h"));
  assert.match(out.text, /非实测数据，尚需实验核验/);
  assert.deepEqual(out.marks, ["【待填写】", "（取设计流量的60%～70%，本例取65%，即1.43 m³/h，模拟值，待实验验证）"]);
});

test("formalization preserves fenced audit JSON, formulas, CRLF and already qualified values", () => {
  const fence = ['```json', '{"pending":["模拟值，待实验验证"]}', '```'].join("\r\n");
  const raw = "数值为模拟值。\r\n" + fence + "\r\n公式 $x_{\\text{模拟值}}$ 保持原样。";
  const out = formalizePendingMarks(raw);
  assert.ok(out.text.includes("数值为示例性设定（非实测数据）。\r\n"));
  assert.ok(out.text.includes(fence));
  assert.ok(out.text.includes("$x_{\\text{模拟值}}$"));
  const qualified = "数值为示例性设定（非实测数据），其效果尚需实验核验。";
  assert.deepEqual(formalizePendingMarks(qualified), { text: qualified, marks: [] });
});

test("negated simulation statements are not relabelled as synthetic observations", () => {
  const raw = "这些读数不是模拟值。算法并非模拟值生成算法。";
  assert.deepEqual(formalizePendingMarks(raw), { text: raw, marks: [] });
});

test("the drafting guide requires visible non-measured qualification as well as original review metadata", () => {
  assert.match(SPEC_STYLE_GUIDE, /非实测数据/);
  assert.match(SPEC_STYLE_GUIDE, /原始标注.*内部审核单/);
});
