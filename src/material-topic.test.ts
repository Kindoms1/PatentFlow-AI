import { test } from "node:test";
import assert from "node:assert/strict";
import { relevanceHits, topicTerms } from "./prior-art.ts";
import { titleFromMaterials, topicFromFileName } from "./skill-turn.ts";

const MATERIAL = "本发明涉及高分辨率遥感影像处理。现有方法在建筑物边界处容易粘连。本方法先提取多尺度特征，再用边界细化模块逐像素修正掩膜，输出建筑物轮廓。";
type Materials = Parameters<typeof titleFromMaterials>[0];

test("topicFromFileName drops document-type labels, versions and extensions", () => {
  assert.equal(topicFromFileName("交底.md"), "");
  assert.equal(topicFromFileName("技术交底书-v2.docx"), "");
  assert.equal(topicFromFileName("新建文档 (3).txt"), "");
  assert.equal(topicFromFileName("untitled.md"), "");
  assert.equal(topicFromFileName("雨水井截污装置交底书_v2.docx"), "雨水井截污装置");
  assert.equal(topicFromFileName("一种遥感影像建筑物提取方法.md"), "一种遥感影像建筑物提取方法");
});

test("a generic file name does not become the draft topic; the text does", () => {
  const materials = [{ name: "交底.md", kind: "text", text: MATERIAL }] as unknown as Materials;
  const topic = titleFromMaterials(materials, MATERIAL);
  assert.notEqual(topic, "交底");
  assert.ok(topicTerms(topic).includes("遥感"), `topic was ${topic}`);
  const named = [{ name: "一种遥感影像建筑物提取方法.docx", kind: "text", text: MATERIAL }] as unknown as Materials;
  assert.equal(titleFromMaterials(named, MATERIAL), "一种遥感影像建筑物提取方法");
});

test("abstract boilerplate does not count as topic relevance", () => {
  const terms = topicTerms("本发明涉及高分辨率遥感影像处理");
  assert.ok(!terms.includes("本发") && !terms.includes("明涉"), terms.join(","));
  assert.ok(terms.includes("遥感"));
  assert.ok(relevanceHits(terms, "本发明涉及一种洗衣机控制方法，本发明公开了一种滚筒") < 2);
  assert.ok(relevanceHits(terms, "本发明公开了一种遥感影像建筑物提取方法") >= 2);
});
