import { test } from "node:test";
import assert from "node:assert/strict";
import { CHART_CAPTION, extractFigureSpecs, figureSpecBlock, figureSpecRefs, normalizeFigureSpec } from "./figure-spec.ts";
import type { FigureSpecIssue } from "./figure-spec.ts";
import { renderFigure, MAX_HEIGHT_MM, MAX_WIDTH_MM } from "./figure-render.ts";

const CHART = `{"no":4,"kind":"chart","xLabel":"生育期/d","yLabel":"日需水量/mm",
"series":[{"points":[[0,1.2],[30,3.5],[60,5.8],[90,4.1],[120,2.0]],"markers":true}],
"marks":[{"x":60,"y":5.8,"label":"需水高峰","guide":true,"xText":"t_2"}],
"xTicks":[0,30,60,90,120]}`;

function draft(blocks: string[]): string {
  return ["## 附图说明", "图4为作物需水曲线示意图。", ...blocks.map((block) => "```附图\n" + block + "\n```"), "## 具体实施方式", "正文。"].join("\n");
}

function chartSpec(raw: Record<string, unknown>, issues: FigureSpecIssue[] = []) {
  const spec = normalizeFigureSpec({ no: 1, kind: "chart", ...raw }, issues);
  assert.ok(spec);
  return spec;
}

test("曲线图代码块被取出并规范化", () => {
  const { specs, issues, text } = extractFigureSpecs(draft([CHART]));
  assert.deepEqual(issues, []);
  assert.equal(specs.length, 1);
  const [spec] = specs;
  assert.equal(spec.kind, "chart");
  assert.ok(spec.chart);
  assert.equal(spec.chart.xLabel, "生育期/d");
  assert.equal(spec.chart.yLabel, "日需水量/mm");
  assert.equal(spec.chart.series.length, 1);
  assert.deepEqual(spec.chart.series[0].points, [[0, 1.2], [30, 3.5], [60, 5.8], [90, 4.1], [120, 2]]);
  assert.equal(spec.chart.series[0].markers, true);
  assert.equal(spec.chart.series[0].smooth, undefined);
  assert.deepEqual(spec.chart.marks, [{ x: 60, y: 5.8, label: "需水高峰", guide: true, xText: "t_2" }]);
  assert.deepEqual(spec.chart.xTicks.map((tick) => tick.label), ["0", "30", "60", "90", "120"]);
  assert.deepEqual(spec.chart.yTicks, []);
  assert.ok(!text.includes("```") && !text.includes('"kind"'));
});

test("曲线图写回代码块再读取，数据不变", () => {
  const { specs } = extractFigureSpecs(draft([CHART]));
  const again = extractFigureSpecs(specs.map(figureSpecBlock).join("\n")).specs;
  assert.deepEqual(again, specs);
  const multi = chartSpec({
    xLabel: "时间/h",
    yLabel: "含水率/%",
    series: [
      { points: [[0, 30], [12, 24], [24, 18]], label: "灌溉前", smooth: false, dashed: true },
      { points: [[0, 32], [12, 30], [24, 28]], label: "灌溉后", ref: "61" },
    ],
    marks: [{ x: 24, y: 18, ref: "62", yText: "θ_min" }],
    yTicks: [{ value: 18, label: "θ_l" }, 30],
  });
  const back = extractFigureSpecs(figureSpecBlock(multi)).specs;
  assert.deepEqual(back, [multi]);
});

test("曲线图类型别名都能识别", () => {
  for (const kind of ["chart", "curve", "line-chart", "曲线图", "曲线示意图", "折线图", "趋势图"]) {
    const issues: FigureSpecIssue[] = [];
    const spec = normalizeFigureSpec({ no: 2, kind, xLabel: "x", yLabel: "y", points: [[0, 0], [1, 1]] }, issues);
    assert.equal(spec?.kind, "chart", kind);
  }
});

test("曲线图接受常见的简写写法", () => {
  const issues: FigureSpecIssue[] = [];
  const fromAxes = chartSpec({ axes: ["生育期/d", { label: "需水量/mm", ticks: [0, 2, 4] }], points: [{ x: 0, y: 1 }, { x: 10, y: 3 }, { x: 20, y: 2 }], smooth: false }, issues);
  assert.ok(fromAxes.chart);
  assert.equal(fromAxes.chart.xLabel, "生育期/d");
  assert.equal(fromAxes.chart.yLabel, "需水量/mm");
  assert.deepEqual(fromAxes.chart.yTicks.map((tick) => tick.value), [0, 2, 4]);
  assert.deepEqual(fromAxes.chart.series[0].points, [[0, 1], [10, 3], [20, 2]]);
  assert.equal(fromAxes.chart.series[0].smooth, false);

  const fromObject = chartSpec({ axes: { x: { title: "温度/℃" }, y: "速率" }, series: [[0, 0], [1, 2], [2, 3]] }, issues);
  assert.ok(fromObject.chart);
  assert.equal(fromObject.chart.xLabel, "温度/℃");
  assert.equal(fromObject.chart.yLabel, "速率");
  assert.equal(fromObject.chart.series.length, 1);
  assert.equal(fromObject.chart.series[0].points.length, 3);

  const xAxisObject = chartSpec({ xAxis: { name: "压力/kPa" }, y_label: "流量", series: { points: [[1, 1], [2, 4]], name: "实测" } }, issues);
  assert.ok(xAxisObject.chart);
  assert.equal(xAxisObject.chart.xLabel, "压力/kPa");
  assert.equal(xAxisObject.chart.yLabel, "流量");
  assert.equal(xAxisObject.chart.series[0].label, "实测");
  assert.deepEqual(issues, []);
});

test("曲线图缺轴名、缺数据点、多条曲线无名称时给出中文原因", () => {
  const issues: FigureSpecIssue[] = [];
  chartSpec({ series: [{ points: [[0, 1], [1, 2]] }] }, issues);
  assert.ok(issues.some((issue) => /缺少横轴和纵轴名称/.test(issue.message)));

  const onlyY: FigureSpecIssue[] = [];
  chartSpec({ xLabel: "时间", series: [{ points: [[0, 1], [1, 2]] }] }, onlyY);
  assert.ok(onlyY.some((issue) => /缺少纵轴名称/.test(issue.message)));

  const sparse: FigureSpecIssue[] = [];
  chartSpec({ xLabel: "x", yLabel: "y", series: [{ points: [[0, 1]] }] }, sparse);
  assert.ok(sparse.some((issue) => /少于两个有效数据点/.test(issue.message)));
  assert.ok(sparse.some((issue) => /没有有效曲线/.test(issue.message)));

  const invalid: FigureSpecIssue[] = [];
  const kept = chartSpec({ xLabel: "x", yLabel: "y", series: [{ points: [[0, 1], ["a", 2], [2, 3]] }] }, invalid);
  assert.equal(kept.chart?.series[0].points.length, 2);
  assert.ok(invalid.some((issue) => /1 个数据点无效/.test(issue.message)));

  const unnamed: FigureSpecIssue[] = [];
  chartSpec({ xLabel: "x", yLabel: "y", series: [{ points: [[0, 1], [1, 2]] }, { points: [[0, 2], [1, 3]] }] }, unnamed);
  assert.ok(unnamed.some((issue) => /无法区分/.test(issue.message)));

  const badMark: FigureSpecIssue[] = [];
  chartSpec({ xLabel: "x", yLabel: "y", points: [[0, 1], [1, 2]], marks: [{ label: "峰值" }] }, badMark);
  assert.ok(badMark.some((issue) => /特征点缺少有效坐标/.test(issue.message)));
});

test("曲线图输出带坐标轴、轴名的黑白 SVG", () => {
  const { specs } = extractFigureSpecs(draft([CHART]));
  const figure = renderFigure(specs[0]);
  assert.equal(figure.kind, "chart");
  assert.ok(figure.svg.startsWith("<svg"));
  assert.ok(figure.widthMm > 20 && figure.widthMm <= MAX_WIDTH_MM && figure.heightMm > 20 && figure.heightMm <= MAX_HEIGHT_MM, `${figure.widthMm}×${figure.heightMm}`);
  const colors = [...figure.svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(colors.every((color) => ["#000", "#fff", "none"].includes(color)), colors.join(","));
  assert.ok(!/<image|rgb\(|opacity/.test(figure.svg));
  assert.ok(figure.texts.includes("生育期/d"), figure.texts.join("|"));
  assert.ok(figure.texts.includes("日需水量/mm"), figure.texts.join("|"));
  assert.ok(figure.texts.includes("需水高峰"), figure.texts.join("|"));
  assert.ok((figure.svg.match(/<polygon[^>]*fill="#000"/g) ?? []).length >= 2, "两条坐标轴各有一个实心箭头");
  assert.ok(figure.fontMm >= 2.8);
  assert.deepEqual(figure.warnings, [], figure.warnings.join(";"));
  assert.deepEqual([...figure.refs], []);
});

test("曲线图的附图标记全部引出", () => {
  const spec = chartSpec({
    xLabel: "时间/h",
    yLabel: "含水率/%",
    series: [
      { points: [[0, 30], [12, 24], [24, 18], [36, 15]], label: "灌溉前", ref: "61" },
      { points: [[0, 32], [12, 30], [24, 28], [36, 27]], label: "灌溉后", ref: "63", dashed: true },
    ],
    marks: [{ x: 24, y: 18, ref: "62", label: "灌溉阈值", guide: true, yText: "θ_l" }],
  });
  const figure = renderFigure(spec);
  assert.deepEqual([...figure.refs].sort(), [...figureSpecRefs(spec)].sort());
  assert.deepEqual([...figureSpecRefs(spec)].sort(), ["61", "62", "63"]);
  assert.ok(figure.texts.includes("灌溉前") && figure.texts.includes("灌溉后") && figure.texts.includes("灌溉阈值"));
  assert.ok(figure.svg.includes("stroke-dasharray"), "虚线曲线与引线");
  assert.deepEqual(figure.warnings, [], figure.warnings.join(";"));
});

test("横坐标不递增的曲线按折线绘制并提示", () => {
  const spec = chartSpec({ xLabel: "应变", yLabel: "应力/MPa", points: [[0, 0], [2, 3], [1, 4], [3, 5]] });
  const figure = renderFigure(spec);
  assert.ok(figure.warnings.some((warning) => /按折线绘制/.test(warning)), figure.warnings.join(";"));
  const straight = renderFigure(chartSpec({ xLabel: "应变", yLabel: "应力/MPa", points: [[0, 0], [2, 3], [1, 4], [3, 5]], smooth: false }));
  assert.ok(!straight.warnings.some((warning) => /按折线绘制/.test(warning)));
});

test("图名识别曲线图，不误伤描述形状的“曲线”", () => {
  for (const caption of ["作物需水曲线示意图", "土壤含水率随深度变化示意图", "灌溉量趋势图", "流量-压力特性图", "含水率变化曲线"]) {
    assert.ok(CHART_CAPTION.test(caption), caption);
  }
  for (const caption of ["曲线导轨结构示意图", "弯曲线缆布置图", "曲线形管道剖面图", "系统框图", "灌溉决策方法流程图"]) {
    assert.ok(!CHART_CAPTION.test(caption), caption);
  }
});