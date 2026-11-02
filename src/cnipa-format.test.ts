import test from "node:test";
import assert from "node:assert/strict";
import { Packer } from "docx";
import { figureRefs, formalCheck, parseApplication, reportSummary } from "./cnipa-format.ts";
import { buildApplicationDocument, looksLikeApplication } from "./export-docx.ts";

const GOOD = [
  "# 发明名称：一种遥感影像云检测方法",
  "## 说明书摘要",
  "本发明公开了一种遥感影像云检测方法，包括获取遥感影像、提取多尺度特征并输出云掩膜，提高了薄云边界的识别准确性。",
  "摘要附图：图1",
  "## 权利要求书",
  "1. 一种遥感影像云检测方法，其特征在于，包括：",
  "S1、获取遥感影像；",
  "S2、通过多尺度特征提取模块提取特征，得到云掩膜。",
  "2. 根据权利要求1所述的方法，其特征在于，所述多尺度特征提取模块包括三个卷积分支。",
  "3. 一种遥感影像云检测装置，其特征在于，包括获取模块和多尺度特征提取模块。",
  "## 技术领域",
  "本发明涉及遥感图像处理技术领域，具体涉及一种遥感影像云检测方法。",
  "## 背景技术",
  "现有云检测方法通常基于固定阈值，对**薄云边界**识别不准。",
  "## 发明内容",
  "### 要解决的技术问题",
  "薄云边界识别不准。",
  "### 技术方案",
  "获取影像并提取多尺度特征。",
  "### 有益效果",
  "边界更准确。",
  "## 附图说明",
  "图1为本发明实施例提供的云检测方法的流程示意图；",
  "图2为本发明实施例提供的云检测装置的结构示意图。",
  "## 具体实施方式",
  "### 实施例1",
  "如图1所示，方法包括步骤S1和S2。",
  "如图2所示，装置包括获取模块。【待发明人确认：卷积核尺寸】",
  "```json",
  '{"distinguishing":[],"pending":[],"closestArt":""}',
  "```",
].join("\n");

test("parseApplication splits a draft into the parts of a CNIPA filing", () => {
  const app = parseApplication(GOOD);
  assert.equal(app.title, "一种遥感影像云检测方法");
  assert.equal(app.abstract.length, 1, "the 摘要附图 line is not abstract text");
  assert.equal(app.abstractFigure, 1);
  assert.equal(app.claims.length, 3);
  assert.equal(app.claims[0].lines.length, 3);
  assert.deepEqual(app.claims[1].refs, [1]);
  assert.deepEqual(app.figures.map((figure) => figure.no), [1, 2]);
  assert.match(app.figures[0].caption, /流程示意图/);
  const background = app.description.find((part) => part.heading === "背景技术");
  assert.equal(background?.paragraphs[0].text, "现有云检测方法通常基于固定阈值，对薄云边界识别不准。", "markdown emphasis is stripped");
  const summary = app.description.find((part) => part.heading === "发明内容");
  assert.equal(summary?.paragraphs[0].sub, true);
  assert.equal(summary?.paragraphs[1].sub, false);
  assert.deepEqual(app.pendingMarks, ["【待发明人确认：卷积核尺寸】"]);
  const embodiment = app.description.find((part) => part.heading === "具体实施方式");
  assert.ok(embodiment?.paragraphs.every((item) => !item.text.includes("distinguishing")), "the json tail is dropped");
});

test("formalCheck passes a well-formed draft and keeps warnings for thin parts", () => {
  const report = formalCheck(parseApplication(GOOD));
  assert.equal(report.exportable, true);
  assert.deepEqual(report.checks.filter((check) => check.level === "error").map((check) => check.id), []);
  const warned = report.checks.filter((check) => check.level === "warn").map((check) => check.id);
  assert.ok(warned.includes("embodiment-depth"));
  assert.ok(warned.includes("pending"));
  assert.equal(report.stats.claimCount, 3);
  assert.equal(report.stats.independentCount, 2);
  assert.match(reportSummary(report), /需注意/);
});

test("formalCheck flags figure references in claims, unlisted figures and long titles", () => {
  const bad = GOOD.replace("# 发明名称：一种遥感影像云检测方法", "# 发明名称：一种基于多尺度特征融合与注意力机制的高分辨率遥感影像薄云及云阴影检测方法")
    .replace("所述多尺度特征提取模块包括三个卷积分支。", "如图1所示，所述模块包括三个卷积分支。")
    .replace("装置包括获取模块。", "装置包括获取模块，参见图3。");
  const report = formalCheck(parseApplication(bad));
  const level = (id: string) => report.checks.find((check) => check.id === id)?.level;
  assert.equal(level("title"), "warn");
  assert.equal(level("claim-figure"), "error");
  assert.equal(level("figures"), "error");
  assert.ok(report.errors >= 2);
});

test("formalCheck refuses to export a draft with no claims", () => {
  const report = formalCheck(parseApplication("# 发明名称：一种装置\n## 技术领域\n本发明涉及机械。"));
  assert.equal(report.exportable, false);
  assert.match(report.fatal, /权利要求书/);
});

test("figureRefs expands ranges", () => {
  assert.deepEqual(figureRefs("见图1至图3以及图5，图像不计。"), [1, 2, 3, 5]);
});

test("buildApplicationDocument packs a docx with every filing part", async () => {
  const app = parseApplication(GOOD);
  const document = buildApplicationDocument(app, formalCheck(app), { sample: true });
  const buffer = await Packer.toBuffer(document);
  assert.equal(buffer.subarray(0, 2).toString(), "PK");
  assert.ok(buffer.length > 4000);
  assert.equal(looksLikeApplication(GOOD), true);
  assert.equal(looksLikeApplication("## 技术方案\n一些交底内容"), false);
});