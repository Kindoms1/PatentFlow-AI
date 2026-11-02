import test from "node:test";
import assert from "node:assert/strict";
import { auditInvention, buildDraftPrompt, extractCnNumbers, kindLabel, parseClaims, patentUrl } from "./invention-draft.ts";

test("extractCnNumbers normalises and dedupes CN numbers", () => {
  const text = "见 CN114494821A 与 CN 113033448 B，另有 CN114494821A 和 cn1234567c。";
  assert.deepEqual(extractCnNumbers(text), ["CN114494821A", "CN113033448B", "CN1234567C"]);
});

test("patentUrl links Google Patents only with a kind code", () => {
  assert.equal(patentUrl("CN114494821A"), "https://patents.google.com/patent/CN114494821A/zh");
  assert.equal(patentUrl("CN114494821"), "https://patents.google.com/?q=CN114494821");
  assert.equal(kindLabel("CN113033448B"), "发明授权公告");
  assert.equal(kindLabel("CN114494821A"), "发明申请公开");
});

test("parseClaims reads dependencies and ranges", () => {
  const claims = parseClaims("1. 一种方法，其特征在于，包括：\nS1、获取影像；\n2. 根据权利要求1所述的方法，其特征在于，A。\n3. 根据权利要求1-2任一项所述的方法，其特征在于，B。");
  assert.equal(claims.length, 3);
  assert.equal(claims[0].independent, true);
  assert.deepEqual(claims[2].refs, [1, 2]);
  assert.match(claims[0].text, /S1/);
});

test("auditInvention flags a thin draft and rewards a complete one", () => {
  const thin = auditInvention("# 发明名称：一种方法\n\n## 权利要求书\n1. 一种方法，包括例如步骤A。\n");
  assert.ok(thin.score < 30);
  assert.equal(thin.checks.find((c) => c.id === "claim-clarity")?.ok, false);

  const claims = [
    "1. 一种遥感影像云检测方法，其特征在于，包括：\nS1、获取遥感影像；\nS2、通过多尺度特征提取模块提取特征；",
    ...Array.from({ length: 6 }, (_, i) => `${i + 2}. 根据权利要求${i + 1}所述的方法，其特征在于，限定${i}。`),
    "8. 一种遥感影像云检测装置，其特征在于，包括多尺度特征提取模块。",
    "9. 一种电子设备，其特征在于，包括处理器和存储器。",
    "10. 一种计算机可读存储介质，其特征在于，存储有程序。",
  ].join("\n");
  const body = "多尺度特征提取模块".concat("对影像逐层处理并输出云掩膜。".repeat(120));
  const full = [
    "# 发明名称：一种遥感影像云检测方法",
    "## 说明书摘要\n本发明公开一种云检测方法。",
    `## 权利要求书\n${claims}`,
    "## 技术领域\n本发明涉及遥感。",
    "## 背景技术\nCN114494821A 公开了一种方法，但边界不准。",
    "## 发明内容\n### 要解决的技术问题\n边界。\n### 技术方案\n多尺度特征提取模块。\n### 有益效果\n更准。",
    "## 附图说明\n图1为流程图。",
    `## 具体实施方式\n### 实施例1\n${body}【待发明人确认：阈值】`,
  ].join("\n\n");
  const audit = auditInvention(full);
  const failed = audit.checks.filter((c) => !c.ok).map((c) => c.id);
  assert.deepEqual(failed, []);
  assert.equal(audit.score, 100);
  assert.equal(audit.pendingMarks, 1);
});

test("buildDraftPrompt only lists supplied prior art", () => {
  const prompt = buildDraftPrompt({ material: "材料", priorArt: [{ pn: "CN114494821A", title: "云检测", url: patentUrl("CN114494821A") }] });
  assert.match(prompt, /CN114494821A/);
  assert.match(buildDraftPrompt({ material: "" }), /不写公开号/);
  assert.doesNotMatch(buildDraftPrompt({ material: "" }), /【待检索/);
});
