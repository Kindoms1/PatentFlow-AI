import { test } from "node:test";
import assert from "node:assert/strict";
import { chartMarkProblems } from "./figure-audit.ts";
import type { ChartMark, ChartSeries, FigureChart } from "./figure-spec.ts";

function chart(series: ChartSeries[], marks: ChartMark[]): FigureChart {
  return { xLabel: "测试横坐标", yLabel: "无量纲测试值", series, marks, xTicks: [], yTicks: [] };
}

/** Synthetic peak-detection fixture; no experimental or private invention data. */
const RUN4: Array<[number, number]> = [
  [0, 2],
  [1, 4],
  [2, 7],
  [3, 10],
  [4, 6],
];

test("标为峰值但不在局部极大值处的特征点给出提示，并指出真实峰值位置", () => {
  const problems = chartMarkProblems(chart([{ points: RUN4 }], [{ x: 2, y: 7, label: "测试峰值", guide: true }]));
  assert.equal(problems.length, 1, problems.join("|"));
  assert.match(problems[0], /测试峰值/);
  assert.match(problems[0], /\(2, 7\)/);
  assert.match(problems[0], /局部极大值/);
  assert.match(problems[0], /最近的峰值在\(3, 10\)/);
});

test("峰值点落在极大值处或 5% 容差以内时不提示", () => {
  const marks: ChartMark[] = [
    { x: 3, y: 10, label: "峰值" },
    { x: 3.1, y: 9.8, label: "最大值" },
    { x: 3, y: 10, label: "需水高峰", guide: true, xText: "t_2" },
  ];
  assert.deepEqual(chartMarkProblems(chart([{ points: RUN4 }], marks)), []);
});

test("超出 5% 容差的峰值点给出提示", () => {
  const problems = chartMarkProblems(chart([{ points: RUN4 }], [{ x: 3, y: 8, label: "峰值" }]));
  assert.equal(problems.length, 1, problems.join("|"));
  assert.match(problems[0], /最近的峰值在\(3, 10\)/);
});

test("标为谷值、最低的特征点按局部极小值核对", () => {
  const points: Array<[number, number]> = [
    [0, 3],
    [1, 1],
    [2, 2.5],
    [3, 0.5],
    [4, 2],
  ];
  const problems = chartMarkProblems(
    chart([{ points }], [
      { x: 1, y: 1, label: "第一谷值" },
      { x: 3, y: 0.5, label: "最小值" },
      { x: 2, y: 2.5, label: "最低点" },
    ]),
  );
  assert.equal(problems.length, 1, problems.join("|"));
  assert.match(problems[0], /最低点/);
  assert.match(problems[0], /局部极小值/);
  assert.match(problems[0], /最近的谷值在\(1, 1\)/);
});

test("单调曲线的端点算作极值", () => {
  const points: Array<[number, number]> = [
    [0, 0],
    [1, 1],
    [2, 3],
  ];
  assert.deepEqual(
    chartMarkProblems(chart([{ points }], [
      { x: 2, y: 3, label: "最高值" },
      { x: 0, y: 0, label: "最低值" },
    ])),
    [],
  );
});

test("阈值、拐点、峰谷差和无标签的特征点不做极值核对", () => {
  const marks: ChartMark[] = [
    { x: 2, y: 7, label: "最高允许值" },
    { x: 2, y: 7, label: "阈值上限" },
    { x: 2, y: 7, label: "拐点" },
    { x: 2, y: 7, label: "峰谷差" },
    { x: 2, y: 7 },
    { x: 2, y: 7, label: "  " },
  ];
  assert.deepEqual(chartMarkProblems(chart([{ points: RUN4 }], marks)), []);
});

test("多条曲线时按特征点所在的曲线核对，提示中写出曲线名称", () => {
  const control: Array<[number, number]> = [
    [0, 0.5],
    [1, 0.8],
    [2, 2.0],
    [3, 1.2],
    [4, 1.0],
  ];
  const series: ChartSeries[] = [
    { points: RUN4, label: "处理组" },
    { points: control, label: "对照组", dashed: true },
  ];
  assert.deepEqual(chartMarkProblems(chart(series, [{ x: 2, y: 2.0, label: "对照组峰值" }])), [], "(2, 2.0) is the peak of 对照组");
  const problems = chartMarkProblems(chart(series, [{ x: 2, y: 7, label: "峰值" }]));
  assert.equal(problems.length, 1, problems.join("|"));
  assert.match(problems[0], /曲线“处理组”/);
  assert.match(problems[0], /最近的峰值在\(3, 10\)/);
});

test("特征点横坐标不在任何曲线范围内时不核对", () => {
  assert.deepEqual(chartMarkProblems(chart([{ points: RUN4 }], [{ x: 9, y: 2, label: "峰值" }])), []);
});

test("横坐标不递增的折线也能找到极值", () => {
  const loop: Array<[number, number]> = [
    [0, 0],
    [2, 1],
    [4, 4],
    [2, 2],
    [1, 0.5],
  ];
  assert.deepEqual(chartMarkProblems(chart([{ points: loop, smooth: false }], [{ x: 4, y: 4, label: "峰值" }])), []);
  const problems = chartMarkProblems(chart([{ points: loop, smooth: false }], [{ x: 2, y: 2, label: "峰值" }]));
  assert.equal(problems.length, 1, problems.join("|"));
  assert.match(problems[0], /最近的峰值在\(4, 4\)/);
});
