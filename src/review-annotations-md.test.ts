import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewAnnotationsOf, stripStrayEmphasis } from "./cnipa-format.ts";

test("加粗小标题后的标注句：断句落在加粗内部时不残留闭合 **", () => {
  const text = "**步骤S1：数据采集。** 田间布设12个传感器节点（201），以间距约40 m（模拟值，待实验验证）的方式呈网格状布置。";
  const notes = reviewAnnotationsOf(text);
  assert.equal(notes.length, 1);
  assert.equal(notes[0], "田间布设12个传感器节点（201），以间距约40 m（模拟值，待实验验证）");
  assert.ok(!notes[0].includes("*"));
});

test("80 字窗口截断在加粗中间时不残留落单 **", () => {
  const text = `说明。**${"甲".repeat(30)}**${"乙".repeat(60)}（推断，待确认）。`;
  const notes = reviewAnnotationsOf(text);
  assert.equal(notes.length, 1);
  assert.equal(notes[0], `${"甲".repeat(18)}${"乙".repeat(60)}（推断，待确认）`);
});

test("句首“待确认：”截断在加粗中间时不残留落单 **", () => {
  const text = `待确认：**${"丙".repeat(130)}**。`;
  const notes = reviewAnnotationsOf(text);
  assert.equal(notes.length, 1);
  assert.ok(!notes[0].includes("*"), notes[0]);
  assert.match(notes[0], /^待确认：丙+$/);
});

test("成对加粗和下划线强调照常去掉", () => {
  const notes = reviewAnnotationsOf("阀门采用**电动球阀**，响应__不超过5 s__（模拟值，待实验验证）。");
  assert.deepEqual(notes, ["阀门采用电动球阀，响应不超过5 s（模拟值，待实验验证）"]);
});

test("公式内的 ** 与 __ 原样保留", () => {
  const notes = reviewAnnotationsOf("** 设置阈值$\\delta^{**}_{a__b}$为常数（推断，待确认）。");
  assert.equal(notes.length, 1);
  assert.ok(notes[0].includes("$\\delta^{**}_{a__b}$"), notes[0]);
  assert.ok(notes[0].startsWith("设置阈值"), notes[0]);
});

test("stripStrayEmphasis 不改动单个下划线下标和普通星号以外的文字", () => {
  assert.equal(stripStrayEmphasis("  ** 目标浓度C_target,i与Q_i  "), "目标浓度C_target,i与Q_i");
  assert.equal(stripStrayEmphasis("无标记文本"), "无标记文本");
});
