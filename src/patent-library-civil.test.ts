import { test } from "node:test";
import assert from "node:assert/strict";
import { detectDomain } from "./patent-library.ts";

test("drainage and municipal disclosures are recognised as civil and municipal engineering", () => {
  const text = "技术领域：市政排水设施，具体是一种带自清洁刮板的雨水井截污装置及清污方法。雨水井井口下方设截污格栅，下泄水流冲击叶轮，叶轮通过曲柄连杆带动刮板沿格栅往复摆动，刮下的杂物落入集污斗。";
  const result = detectDomain(text);
  assert.equal(result.domain.id, "civil-municipal");
  assert.equal(result.domain.usesReferenceNumerals, true);
  assert.ok(result.score >= 4);
});

test("remote-sensing building extraction stays in image processing", () => {
  const result = detectDomain("基于边界细化的遥感影像建筑物分割方法：对遥感图像提取特征图，进行实例分割并细化建筑物边界。");
  assert.equal(result.domain.id, "image-vision");
});
