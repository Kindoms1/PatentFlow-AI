import test from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { Packer } from "docx";
import { formalCheck, parseApplication } from "./cnipa-format.ts";
import { buildApplicationDocument } from "./export-docx.ts";
import { auditInvention } from "./invention-draft.ts";
import type { InventionDraftState } from "./model.ts";

/** One entry of a zip archive (read through the central directory, so data descriptors do not matter). */
function zipEntry(buffer: Buffer, name: string): string {
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  assert.ok(eocd >= 0, "zip end-of-central-directory record");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let index = 0; index < count; index += 1) {
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const entry = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (entry === name) {
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(start, start + size);
      return (method === 8 ? inflateRawSync(data) : data).toString("utf8");
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`${name} is not in the archive`);
}

const DRAFT = String.raw`# 发明名称：一种土壤水分预测方法
## 说明书摘要
本发明公开了一种土壤水分预测方法，按分层缺水量计算灌水量 $V_{\mathrm{req}}$，提高了灌水量的准确性。
摘要附图：图1
## 权利要求书
1. 一种土壤水分预测方法，其特征在于，包括：
S1、按下式计算灌水量：
$$ V_{\mathrm{req}} = \frac{A}{\eta}\sum_{i=1}^{N}\max\left(0, \theta_{\mathrm{min},i} - \theta_{\mathrm{pred},i}\right) d_{i} $$
其中，$A$为灌溉面积，$\eta$为灌溉水利用系数，$N$为土层数，$d_{i}$为第$i$层厚度。
2. 根据权利要求1所述的方法，其特征在于，$\eta$的取值范围为0.7～0.95。
## 技术领域
本发明涉及农业灌溉技术领域。
## 背景技术
现有方法见CN104521699A和CN110012825A（待核实）。
## 发明内容
### 要解决的技术问题
灌水量不准。
### 技术方案
按式（1）计算灌水量。
### 有益效果
灌水量准确。
## 附图说明
图1为本发明实施例提供的方法流程图。
## 具体实施方式
### 符号说明
| 符号 | 含义 | 单位 |
|---|---|---|
| $\theta_{\mathrm{min},i}$ | 第 i 层目标含水量下限 | m³/m³ |
| $\theta_{\mathrm{pred},i}$ | 第 i 层预测含水量 | m³/m³ |
| $V_{\mathrm{req}}$ | 灌水量 | m³ |
如图1所示，灌水量按下式计算：
$$
V_{\mathrm{req}} = \frac{A}{\eta}\sum_{i=1}^{N}\max\left(0, \theta_{\mathrm{min},i} - \theta_{\mathrm{pred},i}\right) d_{i}
$$（1）
式中，$A$为灌溉面积（m²），$\eta$为灌溉水利用系数，$N$为土层数，$d_{i}$为第$i$层厚度（m）。本实施例中 $\eta = 0.85$。`;

test("parseApplication keeps LaTeX intact and marks display formulas", () => {
  const app = parseApplication(DRAFT);
  const claim = app.claims[0];
  assert.ok(claim.lines.some((line) => line.startsWith("$$ V_{\\mathrm{req}}")), "claim formula survives the markdown clean-up");
  const embodiment = app.description.find((part) => part.heading === "具体实施方式");
  const formula = embodiment?.paragraphs.find((item) => item.formula);
  assert.equal(formula?.formula?.label, "1", "a multi-line $$ block becomes one numbered formula");
  assert.ok(embodiment?.paragraphs.some((item) => item.raw?.startsWith("| $\\theta")), "table rows keep their markdown for the symbol audit");
});

test("formalCheck runs the formula checks and passes a consistent draft", () => {
  const report = formalCheck(parseApplication(DRAFT));
  const formulaChecks = report.checks.filter((check) => check.id.startsWith("formula-"));
  assert.ok(formulaChecks.length >= 9, "every formula check is listed");
  assert.deepEqual(formulaChecks.filter((check) => check.level !== "ok").map((check) => `${check.id}: ${check.detail}`), []);
  assert.ok(report.formulas?.applicable);
});

test("formalCheck reports an embodiment value outside the claimed range", () => {
  const report = formalCheck(parseApplication(DRAFT.replace("$\\eta = 0.85$", "$\\eta = 0.60$")));
  const range = report.checks.find((check) => check.id === "formula-range");
  assert.equal(range?.level, "error");
  assert.match(range?.detail ?? "", /0\.60/);
});

test("the Word export carries native equations with their numbers", async () => {
  const app = parseApplication(DRAFT);
  const buffer = Buffer.from(await Packer.toBuffer(buildApplicationDocument(app, formalCheck(app))));
  const xml = zipEntry(buffer, "word/document.xml");
  const equations = xml.match(/<m:oMath>/g)?.length ?? 0;
  assert.ok(equations >= 10, `expected native equations, found ${equations}`);
  assert.match(xml, /<m:nary>/, "the sum is a real n-ary operator");
  assert.match(xml, /（1）/, "the display formula keeps its number");
  assert.doesNotMatch(xml, /\$\$/, "no raw $$ delimiters leak into the document");
  assert.doesNotMatch(xml, /\\mathrm/, "no raw LaTeX commands leak into the document");
});

test("the review sheet does not count unverified publication numbers as prior art", async () => {
  const app = parseApplication(DRAFT);
  const draft: InventionDraftState = {
    text: DRAFT,
    score: 90,
    at: "2026-10-23T00:00:00.000Z",
    model: "test",
    revised: false,
    pendingMarks: 0,
    claimCount: 2,
    priorArt: [{ pn: "CN104521699A", title: "一种灌溉方法", url: "https://patents.google.com/patent/CN104521699A/zh" }],
    checks: [{ label: "背景技术引用对比文件", ok: true, detail: "引用 CN104521699A、CN110012825A" }],
    distinguishing: [],
    pending: [],
    mathReview: { accepted: true, applied: [{ find: "(∂ψ/∂z + 1)", replace: "(∂ψ/∂z − 1)", reason: "z 向下为正时重力项为 −1" }], skipped: [], notes: ["请确认下边界条件"] },
  };
  // 默认（正式合订稿）不带审核节，审核信息一律不进入申请文件
  const formal = zipEntry(Buffer.from(await Packer.toBuffer(buildApplicationDocument(app, formalCheck(app), { draft }))), "word/document.xml");
  assert.doesNotMatch(formal, /不在本次检索结果中|请确认下边界条件|z 向下为正时重力项为 −1/);
  // 显式要求审核节时（内部审核用途）才写入
  const buffer = Buffer.from(await Packer.toBuffer(buildApplicationDocument(app, formalCheck(app), { draft, includeReview: true })));
  const xml = zipEntry(buffer, "word/document.xml");
  assert.match(xml, /引用 CN104521699A；CN110012825A 不在本次检索结果中/);
  assert.match(xml, /背景技术中的 CN110012825A 不在本次检索结果中/);
  assert.match(xml, /z 向下为正时重力项为 −1/);
  assert.match(xml, /请确认下边界条件/);
});

test("auditInvention only counts retrieved publication numbers and scores formulas", () => {
  const withSearch = auditInvention(DRAFT, { priorArt: ["CN104521699A"] });
  const art = withSearch.checks.find((check) => check.id === "background-art");
  assert.equal(art?.ok, true);
  assert.match(art?.detail ?? "", /CN110012825A 不在本次检索结果中/);
  const onlyUnknown = auditInvention(DRAFT, { priorArt: ["CN999999999A"] });
  assert.equal(onlyUnknown.checks.find((check) => check.id === "background-art")?.ok, false);
  const consistency = withSearch.checks.find((check) => check.id === "formula-consistency");
  assert.equal(consistency?.ok, true, consistency?.detail);
  const broken = auditInvention(DRAFT.replace("$\\eta = 0.85$", "$\\eta = 0.60$"), { priorArt: ["CN104521699A"] });
  assert.equal(broken.checks.find((check) => check.id === "formula-consistency")?.ok, false);
});

test("display formulas: unnumbered ones are Word display equations, numbered ones keep their number", async () => {
  const app = parseApplication(DRAFT);
  const buffer = Buffer.from(await Packer.toBuffer(buildApplicationDocument(app, formalCheck(app))));
  const xml = zipEntry(buffer, "word/document.xml");
  const paragraphs = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
  const display = paragraphs.filter((paragraph) => paragraph.includes("<m:oMathPara>"));
  assert.ok(display.length >= 1, "the claim's unnumbered formula is an m:oMathPara");
  assert.ok(display.every((paragraph) => !/（\d+）/.test(paragraph)), "a display equation carries no number");
  const numbered = paragraphs.find((paragraph) => paragraph.includes("（1）") && paragraph.includes("<m:oMath>"));
  assert.ok(numbered, "the numbered formula sits with its number in one paragraph");
  assert.doesNotMatch(numbered, /<m:oMathPara>/, "a numbered formula keeps the tab-stop layout");
  assert.match(numbered, /<m:limLoc m:val="undOvr"\s*\/>/, "the sum keeps its limits above and below");
});

test("the plain-text formula warning names the delimiter in words, so Word does not read it as a formula", async () => {
  const text = DRAFT.replace("本实施例中 $\\eta = 0.85$。", "本实施例中 $\\eta = 0.85$。\n太阳辐射日均值按1 W/m² = 0.0864 MJ/(m²·d)换算后用于净辐射计算。");
  assert.notEqual(text, DRAFT, "the plain-text formula was inserted");
  const app = parseApplication(text);
  const report = formalCheck(app);
  const plain = report.checks.find((check) => check.id === "formula-plain");
  assert.equal(plain?.level, "warn", plain?.detail);
  assert.match(plain?.detail ?? "", /未用公式定界符标记/);
  assert.doesNotMatch(plain?.detail ?? "", /\$/);
  const buffer = Buffer.from(await Packer.toBuffer(buildApplicationDocument(app, report, { includeReview: true })));
  assert.match(zipEntry(buffer, "word/document.xml"), /未用公式定界符标记/);
  const formal = Buffer.from(await Packer.toBuffer(buildApplicationDocument(app, report)));
  assert.doesNotMatch(zipEntry(formal, "word/document.xml"), /未用公式定界符标记/);
});

import { test as reviewTest } from "node:test";
import reviewAssert from "node:assert/strict";

reviewTest("review sheet text carries no bare LaTeX commands", async () => {
  const { reviewPlain } = await import("./export-docx.ts");
  const samples = [
    "自由排水条件\\partial h / \\partial z = 0",
    "空间步长\\Delta z取1 cm，各土壤分层的分界面与网格节点重合",
    "K_{\\mathrm{w}} = \\min\\left\\{1, \\max\\left[0, \\frac{\\theta_{\\mathrm{root}} - \\theta_{\\mathrm{wp}}}{\\theta_{\\mathrm{fc}} - \\theta_{\\mathrm{wp}}}\\right]\\right\\}",
    "\\theta_{\\mathrm{root}} = \\frac{\\sum_{i=1}^{N} \\theta_{i} d_{i}}{\\sum_{i=1}^{N} d_{i}}",
    "$\\theta_{\\mathrm{fc}}$为田间持水量",
    "\\frac{\\partial \\theta}{\\partial t} = \\frac{\\partial}{\\partial z}\\left[K(h)",
  ];
  for (const sample of samples) {
    const out = reviewPlain(sample);
    reviewAssert.doesNotMatch(out, /\\[A-Za-z]/, `${sample} -> ${out}`);
    reviewAssert.doesNotMatch(out, /\$/, `${sample} -> ${out}`);
    reviewAssert.ok(out.trim().length > 0);
  }
  reviewAssert.match(reviewPlain("自由排水条件\\partial h / \\partial z = 0"), /^自由排水条件.*∂/);
  reviewAssert.match(reviewPlain("空间步长\\Delta z取1 cm，各土壤分层的分界面与网格节点重合"), /Δ.*取1 cm，各土壤分层/);
  reviewAssert.match(reviewPlain("$\\theta_{\\mathrm{fc}}$为田间持水量"), /θ.*为田间持水量/);
  reviewAssert.equal(reviewPlain("无需修改。"), "无需修改。");
});
