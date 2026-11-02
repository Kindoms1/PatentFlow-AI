import test from "node:test";
import assert from "node:assert/strict";
import {
  claimNumerals,
  extractNumericRanges,
  figuresOptional,
  isStructuralClaim,
  numeralList,
  rangeCoverage,
  referenceNumeralCheck,
  resolveDomain,
} from "./draft-domain-audit.ts";
import { auditInvention, buildDraftPrompt } from "./invention-draft.ts";
import { LIBRARY_SAMPLES, domainGuide, getDomain } from "./patent-library.ts";

const sample = (id: string) => {
  const found = LIBRARY_SAMPLES.find((item) => item.id === id);
  assert.ok(found, `missing sample ${id}`);
  return found;
};

test("extractNumericRanges keeps ranges with units and skips claim references, step labels and ratios", () => {
  const ranges = extractNumericRanges("温度为20-80℃，见权利要求1-3，执行S1-S3，比例4:1～6:1，压力0.5至1.5 MPa，转速300～500 r/min，径厚比20～60。");
  assert.deepEqual(
    ranges.map((item) => item.text),
    ["20-80℃", "0.5至1.5MPa", "300～500r/min"],
  );
  assert.equal(ranges[1].low, 0.5);
  assert.equal(ranges[1].high, 1.5);
});

test("rangeCoverage needs both end values and a middle value", () => {
  const [range] = extractNumericRanges("加入40～60份乳液");
  assert.equal(rangeCoverage([range], "实施例1用40份，实施例3用60份。").ok, false);
  assert.match(rangeCoverage([range], "实施例1用40份，实施例3用60份。").problems[0], /中间值/);
  assert.equal(rangeCoverage([range], "实施例1用40份，实施例2用50份，实施例3用60份。").ok, true);
  assert.match(rangeCoverage([range], "实施例2用50份。").problems[0], /端值40、端值60/);
});

test("reference numerals must appear in the claims and in the numeral list", () => {
  const claims = "1. 一种夹持装置，包括底座(1)和夹臂（2），其特征在于：所述夹臂(2)转动连接于所述底座(1)。";
  assert.deepEqual(claimNumerals(claims), ["1", "2"]);
  assert.equal(referenceNumeralCheck(claims, "### 实施例1\n底座1与夹臂2转动连接。\n### 附图标记\n1底座；2夹臂。").ok, true);
  assert.match(referenceNumeralCheck(claims, "### 实施例1\n底座1与夹臂2转动连接。").detail, /没有“### 附图标记”列表/);
  assert.match(referenceNumeralCheck(claims, "### 附图标记\n1底座。").detail, /缺少：2/);
  assert.match(referenceNumeralCheck("1. 一种夹持装置，包括底座和夹臂。", "### 附图标记\n1底座。").detail, /没有附图标记/);
  assert.equal(numeralList("### 实施例1\n正文\n### 附图标记\n1底座；2夹臂。\n"), "1底座；2夹臂。");
});

test("virtual devices made of modules are not treated as structural claims", () => {
  assert.equal(isStructuralClaim("一种快拆式管道夹持装置，包括底座(1)"), true);
  assert.equal(isStructuralClaim("一种故障预警装置，其特征在于，包括：数据获取模块，用于获取振动信号"), false);
  assert.equal(isStructuralClaim("一种故障预警方法，其特征在于，包括"), false);
});

test("resolveDomain accepts an object, an id or detects from text", () => {
  assert.equal(resolveDomain(getDomain("mechanical"), "").id, "mechanical");
  assert.equal(resolveDomain("chem-materials", "").id, "chem-materials");
  assert.equal(resolveDomain(undefined, "").id, "general");
  assert.equal(figuresOptional(getDomain("bio-pharma")), true);
  assert.equal(figuresOptional(getDomain("mechanical")), false);
});

test("a mechanical draft is not forced to add method, device, equipment and medium claims", () => {
  const audit = auditInvention(sample("sample-mech-pipe-clamp").markdown, { domain: "mechanical" });
  const byId = new Map(audit.checks.map((item) => [item.id, item]));
  assert.equal(audit.domainId, "mechanical");
  assert.equal(byId.get("claim-subjects")?.ok, true);
  assert.equal(byId.get("reference-numerals")?.ok, true);
  assert.equal(byId.get("sections")?.ok, true);
  assert.equal(byId.get("abstract")?.ok, true, byId.get("abstract")?.detail);
});

test("a software-style domain still expects the multi-subject layout", () => {
  const methodOnly = [
    "# 发明名称：一种图像分割方法",
    "## 权利要求书\n1. 一种图像分割方法，其特征在于，包括：\nS1、获取图像；\nS2、分割图像。\n2. 根据权利要求1所述的方法，其特征在于，限定A。",
  ].join("\n\n");
  const audit = auditInvention(methodOnly, { domain: "image-vision" });
  const subjects = audit.checks.find((item) => item.id === "claim-subjects");
  assert.equal(subjects?.ok, false);
  assert.match(subjects?.detail ?? "", /已覆盖：方法/);
});

test("a chemistry draft may have no figures and must cover the claimed ranges", () => {
  const audit = auditInvention(sample("sample-chem-coating").markdown, { domain: "chem-materials" });
  const byId = new Map(audit.checks.map((item) => [item.id, item]));
  assert.equal(byId.get("sections")?.ok, true, byId.get("sections")?.detail);
  assert.equal(byId.get("figures")?.ok, true, byId.get("figures")?.detail);
  assert.equal(byId.get("claim-subjects")?.ok, true, byId.get("claim-subjects")?.detail);
  assert.equal(byId.get("numeric-range")?.ok, true, byId.get("numeric-range")?.detail);
  assert.equal(byId.has("reference-numerals"), false);

  const thinned = sample("sample-chem-coating").markdown.replace(/### 实施例2[\s\S]*?### 对比例1/, "### 对比例1");
  const weak = auditInvention(thinned, { domain: "chem-materials" }).checks.find((item) => item.id === "numeric-range");
  assert.equal(weak?.ok, false);
  assert.match(weak?.detail ?? "", /中间值/);
});

test("a structural domain without figures is still asked for them", () => {
  const text = sample("sample-mech-pipe-clamp").markdown.replace(/## 附图说明[\s\S]*?(?=## 具体实施方式)/, "");
  const audit = auditInvention(text, { domain: "mechanical" });
  assert.equal(audit.checks.find((item) => item.id === "sections")?.ok, false);
  assert.equal(audit.checks.find((item) => item.id === "figures")?.ok, false);
});

test("buildDraftPrompt carries the domain guide when given", () => {
  const guide = domainGuide(getDomain("mechanical"));
  const prompt = buildDraftPrompt({ material: "一种管道夹", domainGuide: guide });
  assert.match(prompt, /【领域撰写指引】/);
  assert.match(prompt, /附图标记/);
  assert.doesNotMatch(buildDraftPrompt({ material: "材料" }), /领域撰写指引/);
});
