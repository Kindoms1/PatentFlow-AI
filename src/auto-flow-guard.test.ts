import { test } from "node:test";
import assert from "node:assert/strict";
import { draftTitle, parseAutoReply, proseCandidates, unverifiedPatentNumbers } from "./auto-flow.ts";

test("选题回复没有 json 时，从编号列表认出候选题目和推荐项", () => {
  const text = [
    "## 现有做法与缺陷",
    "现有灌溉多按经验进行。",
    "",
    "## 候选题目",
    "1. **一种基于土壤墒情预测的分区灌溉控制方法** —— 解决灌溉不均",
    "2. 一种面向小农户的智慧农业轻量化决策系统及方法（推荐）",
    "3. 题目：一种病虫害图像识别预警装置",
    "一种常见做法是人工巡田。",
  ].join("\n");
  const parsed = parseAutoReply(text);
  assert.deepEqual(
    parsed.points.map((point) => point.title),
    ["一种基于土壤墒情预测的分区灌溉控制方法", "一种面向小农户的智慧农业轻量化决策系统及方法", "一种病虫害图像识别预警装置"],
  );
  assert.equal(parsed.recommended, 1);
});

test("没有题目式条目时仍返回空候选，json 优先", () => {
  assert.equal(proseCandidates("这里只是一段分析，没有列出题目。").points.length, 0);
  const json = parseAutoReply('说明\n1. 一种丙系统\n```json\n{"patentPoints":[{"title":"一种甲装置"},{"title":"一种乙方法"}],"recommended":2}\n```');
  assert.deepEqual(json.points.map((point) => point.title), ["一种甲装置", "一种乙方法"]);
  assert.equal(json.recommended, 1);
});

test("从稿子首行取发明名称，模板占位不算", () => {
  assert.equal(draftTitle("# 发明名称：一种面向小农户的智慧农业轻量化决策系统及方法\n\n## 权利要求书\n1. ……"), "一种面向小农户的智慧农业轻量化决策系统及方法");
  assert.equal(draftTitle("## 权利要求书\n1. 一种甲装置"), "");
  assert.equal(draftTitle("# 发明名称：一种……"), "");
});

test("稿子里不在检索结果中的专利号会被挑出来", () => {
  const draft = {
    text: "最接近的现有技术为 CN110111000A，另参考 CN 000000001 B 和 CN110111000A。",
    priorArt: [{ pn: "CN110111000A", title: "农业专利大数据创新决策支持系统", url: "" }],
  };
  assert.deepEqual(unverifiedPatentNumbers(draft), ["CN000000001B"]);
  assert.deepEqual(unverifiedPatentNumbers({ ...draft, priorArt: [] }), ["CN110111000A", "CN000000001B"]);
});