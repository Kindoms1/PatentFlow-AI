import assert from "node:assert/strict";
import test from "node:test";
import { formalCheck, parseApplication } from "./cnipa-format.ts";
import {
  LIBRARY_SAMPLES,
  REAL_REFERENCES,
  TECH_DOMAINS,
  allIpcCodes,
  claimKindOf,
  detectDomain,
  domainGuide,
  domainHint,
  findSample,
  getDomain,
  libraryDoc,
  libraryEntries,
  searchLibrary,
  subjectCoverage,
} from "./patent-library.ts";

test("every domain carries IPC codes, subjects and drafting points", () => {
  for (const domain of TECH_DOMAINS) {
    assert.ok(domain.name);
    assert.ok(domain.subjects.length > 0, domain.id);
    assert.ok(domain.claimPlan.length > 0, domain.id);
    assert.ok(domain.claimKinds.length >= domain.minClaimKinds, domain.id);
    if (domain.id !== "general") {
      assert.ok(domain.ipc.length >= 3, domain.id);
      assert.ok(domain.keywords.length >= 10, domain.id);
      for (const item of domain.ipc) assert.match(item.code, /^[A-H]\d{2}[A-Z]$/, `${domain.id} ${item.code}`);
    }
  }
  assert.ok(allIpcCodes().length >= 25);
});

test("detectDomain recognises typical disclosures and falls back to general", () => {
  assert.equal(detectDomain("一种车辆压缩空气制动装置，继电器阀与制动缸通过压力管路连接，行车制动回路冗余").domain.id, "vehicle");
  assert.equal(detectDomain("通式化合物或其药学上可接受的盐，作为EGFR降解剂用于治疗肿瘤，IC50").domain.id, "bio-pharma");
  assert.equal(detectDomain("组合物以质量份计包括树脂、固化剂和溶剂，制备方法为搅拌后固化").domain.id, "chem-materials");
  assert.equal(detectDomain("底座与壳体固定连接，转轴上套设弹簧，滑块沿导轨滑动").domain.id, "mechanical");
  const unknown = detectDomain("我们想改进一下现在的做法");
  assert.equal(unknown.domain.id, "general");
  assert.equal(unknown.confident, false);
});

test("IPC codes in the text count towards the domain", () => {
  const result = detectDomain("分类号 A61B 5/22，A61N 1/36");
  assert.equal(result.domain.id, "medical-device");
  assert.ok(result.hits.includes("A61B"));
});

test("claimKindOf and subjectCoverage judge claim layout per domain", () => {
  assert.equal(claimKindOf("一种输送带托辊故障预警方法，其特征在于"), "方法");
  assert.equal(claimKindOf("一种电子设备，包括处理器和存储器"), "设备");
  assert.equal(claimKindOf("一种计算机可读存储介质"), "介质");
  assert.equal(claimKindOf("一种权利要求1所述涂料的制备方法"), "制备方法");
  assert.equal(claimKindOf("一种水性环氧防腐涂料，包括A组分"), "组合物");
  assert.equal(claimKindOf("一种快拆式管道夹持装置"), "装置");

  const mechanical = subjectCoverage(getDomain("mechanical"), ["一种快拆式管道夹持装置，包括底座(1)", "一种管道支架"]);
  assert.equal(mechanical.ok, true, mechanical.detail);
  const software = subjectCoverage(getDomain("software-ai"), ["一种快拆式管道夹持装置"]);
  assert.equal(software.ok, false);
  const chemistry = subjectCoverage(getDomain("chem-materials"), ["一种水性环氧防腐涂料", "一种权利要求1所述水性环氧防腐涂料的制备方法"]);
  assert.equal(chemistry.ok, true, chemistry.detail);
});

test("domainGuide carries IPC, claim layout and reference-numeral rule for structural domains", () => {
  const guide = domainGuide(getDomain("mechanical"), detectDomain("底座 转轴 弹簧 滑块 支架"));
  assert.match(guide, /F16B/);
  assert.match(guide, /权利要求布局/);
  assert.match(guide, /附图标记/);
  assert.match(guide, /不要写进申请文件正文/);
  assert.doesNotMatch(domainGuide(getDomain("software-ai")), /【附图标记】/);
  assert.equal(domainHint(detectDomain("随便聊聊")), "");
});

test("fictional samples are labelled and pass the CNIPA formal check without errors", () => {
  assert.ok(LIBRARY_SAMPLES.length >= 3);
  for (const sample of LIBRARY_SAMPLES) {
    assert.equal(sample.fictional, true);
    assert.match(sample.title, /虚构示范/);
    assert.doesNotMatch(sample.markdown, /\bCN\d{7,}/, `${sample.id} must not cite publication numbers`);
    const app = parseApplication(sample.markdown, sample.title);
    const report = formalCheck(app);
    const errors = report.checks.filter((check) => check.level === "error");
    assert.deepEqual(errors, [], `${sample.id}: ${errors.map((item) => `${item.label} ${item.detail}`).join("; ")}`);
    assert.ok(app.claims.length >= 5, sample.id);
    const doc = libraryDoc(`lib-${sample.id}`);
    assert.ok(doc);
    assert.match(doc.text, /^> 【虚构示范样例】/);
    assert.match(doc.name, /^虚构示范-/);
  }
  assert.ok(findSample("lib-sample-mech-pipe-clamp"));
});

test("real references keep publication number, source and purpose", () => {
  const grants = REAL_REFERENCES.filter((ref) => ref.kind === "授权发明");
  assert.equal(grants.length, 3);
  for (const ref of grants) {
    assert.match(ref.pn, /^CN\d{9}B$/);
    assert.ok(ref.url.startsWith("https://patents.google.com/patent/"));
    assert.ok(ref.use.length > 10);
    assert.ok(ref.localPath.startsWith("docs/references/"));
  }
  assert.deepEqual(REAL_REFERENCES.find((ref) => ref.pn === "CN117860254B")?.ipc, ["A61B 5/22", "A61B 5/11", "A61N 1/36"]);
});

test("searchLibrary filters by keyword, domain, IPC and kind", () => {
  assert.equal(libraryEntries().length, TECH_DOMAINS.length - 1 + LIBRARY_SAMPLES.length + REAL_REFERENCES.length);
  assert.ok(searchLibrary("管道").some((entry) => entry.id === "lib-sample-mech-pipe-clamp"));
  assert.ok(searchLibrary("", { ipc: "A61B" }).every((entry) => entry.ipc.some((code) => code.startsWith("A61B"))));
  assert.ok(searchLibrary("", { ipc: "a61b" }).length > 0);
  assert.ok(searchLibrary("", { domainId: "vehicle" }).some((entry) => entry.id === "lib-ref-cn107438544b"));
  assert.ok(searchLibrary("", { kind: "sample" }).every((entry) => entry.kind === "sample" && entry.fictional));
  assert.deepEqual(searchLibrary("这个词不存在于知识库xyz"), []);
  assert.equal(libraryDoc("no-such-entry"), null);
});

test("Latin keywords only count as whole words, and a weak guess yields no domain hint", () => {
  const paper = "Contrastive mask fidelity for remote sensing segmentation. The associated losses and the social context are discussed. ".repeat(5);
  const detection = detectDomain(paper);
  assert.ok(!detection.hits.includes("SOC"), detection.hits.join(","));
  assert.equal(domainHint(detection), "");
  const bms = detectDomain("电池管理系统 BMS 根据 SOC 估计结果对电芯进行均衡，充电和放电过程中监测电压与电流。");
  assert.equal(bms.domain.id, "power-electronics");
  assert.ok(bms.hits.includes("SOC"));
});
