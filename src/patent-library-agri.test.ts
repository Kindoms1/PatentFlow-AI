import { test } from "node:test";
import assert from "node:assert/strict";
import { detectDomain, getDomain } from "./patent-library.ts";

test("a smart-irrigation title alone is recognised as agriculture", () => {
  const result = detectDomain("气象-土壤多源融合智慧灌溉");
  assert.equal(result.domain.id, "agriculture");
  assert.equal(result.confident, true);
});

test("smart irrigation that uses prediction models stays in agriculture, not software", () => {
  const text =
    "气象-土壤多源融合智慧灌溉方法：融合气象预报与土壤壒情传感器数据，利用预测模型和算法计算作物需水量，控制滴灌电磁阀开启时长。";
  const result = detectDomain(text);
  assert.equal(result.domain.id, "agriculture");
  assert.ok(result.domain.ipc.some((item) => item.code === "A01G"), "agriculture offers A01G as an IPC reference");
  assert.ok(result.hits.includes("灌溉"));
});

test("greenhouse pest recognition with deep learning is agriculture first, AI second", () => {
  const text = "基于深度学习的温室作物病虫害识别方法：采集温室作物叶片图像，构建卷积神经网络模型进行训练，识别病虫害类别。";
  const result = detectDomain(text);
  assert.equal(result.domain.id, "agriculture");
  assert.equal(result.runnerUp?.domain.id, "software-ai");
});

test("a generic image segmentation algorithm is not pulled into agriculture", () => {
  const result = detectDomain("一种通用图像分割算法：对输入图像提取多尺度特征图，进行语义分割并输出像素级掩膜。");
  assert.equal(result.domain.id, "image-vision");
});

test("software-heavy wording does not outrank an explicit farming application", () => {
  const text = "利用大模型、知识图谱和神经网络算法训练推理模型，部署在服务器上，为农田灌溉提供决策。";
  const result = detectDomain(text);
  assert.equal(result.domain.id, "agriculture");
});

test("pure software text without a farming application stays software", () => {
  const result = detectDomain("基于大语言模型的代码生成方法：在服务器上训练模型，利用注意力机制和知识图谱推理。");
  assert.equal(result.domain.id, "software-ai");
});

test("the agriculture domain carries a complete writing guide", () => {
  const domain = getDomain("agriculture");
  assert.equal(domain.name, "农业与智慧农业");
  for (const code of ["A01G", "A01B", "A01C"]) assert.ok(domain.ipc.some((item) => item.code === code), code);
  assert.ok(domain.claimPlan.length >= 3);
  assert.ok(domain.claimKinds.includes("方法"));
});
