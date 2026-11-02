import { test } from "node:test";
import assert from "node:assert/strict";
import { FONT, SUB_SCALE, charWidth, richRuns, textWidth, visibleText, wrapText } from "./figure-draw.ts";
import { normalizeFigureSpec } from "./figure-spec.ts";
import type { FigureSpecIssue } from "./figure-spec.ts";
import { renderFigure } from "./figure-render.ts";

test("Unicode 上标拆成上标段，换写成普通字符并保留原文", () => {
  assert.deepEqual(richRuns("EC值/(mS·cm⁻¹)"), [
    { text: "EC值/(mS·cm", sub: false },
    { text: "-1", sub: false, sup: true, raw: "⁻¹" },
    { text: ")", sub: false },
  ]);
  assert.deepEqual(richRuns("m²"), [
    { text: "m", sub: false },
    { text: "2", sub: false, sup: true, raw: "²" },
  ]);
  assert.deepEqual(richRuns("流量/(m³·h⁻¹)"), [
    { text: "流量/(m", sub: false },
    { text: "3", sub: false, sup: true, raw: "³" },
    { text: "·h", sub: false },
    { text: "-1", sub: false, sup: true, raw: "⁻¹" },
    { text: ")", sub: false },
  ]);
});

test("Unicode 下标拆成下标段，下划线写法保持原有输出", () => {
  assert.deepEqual(richRuns("H₂O"), [
    { text: "H", sub: false },
    { text: "2", sub: true, raw: "₂" },
    { text: "O", sub: false },
  ]);
  assert.deepEqual(richRuns("R_{₁}"), [
    { text: "R", sub: false },
    { text: "1", sub: true, raw: "₁" },
  ]);
  assert.deepEqual(richRuns("θ_i和R_{i}"), [
    { text: "θ", sub: false },
    { text: "i", sub: true },
    { text: "和R", sub: false },
    { text: "i", sub: true },
  ]);
  assert.deepEqual(richRuns("生育期/d"), [{ text: "生育期/d", sub: false }]);
});

test("visibleText 还原 Unicode 上下标原文，只去掉下划线标记", () => {
  for (const text of ["EC值/(mS·cm⁻¹)", "m²", "流量/(m³·h⁻¹)", "H₂O", "10⁶个"]) assert.equal(visibleText(text), text);
  assert.equal(visibleText("R_{₁}与ET_0"), "R₁与ET0");
});

test("上标按缩小字号计宽", () => {
  const expected = (charWidth("c") + charWidth("m")) * FONT + (charWidth("-") + charWidth("1")) * SUB_SCALE * FONT;
  assert.ok(Math.abs(textWidth("cm⁻¹") - expected) < 1e-9, `${textWidth("cm⁻¹")} vs ${expected}`);
  assert.ok(textWidth("m²") < textWidth("m2"));
});

test("换行不在上标前断开单位", () => {
  const lines = wrapText("土壤溶液电导率EC值/(mS·cm⁻¹)", textWidth("土壤溶液电导率"));
  assert.ok(lines.length > 1, lines.join("|"));
  assert.ok(lines.some((line) => line.includes("mS·cm⁻¹")), lines.join("|"));
  assert.ok(lines.every((line) => !/^[⁻¹²³⁰-₟]/.test(line)), lines.join("|"));
});

test("曲线图单位里的上标用上移的 tspan 绘制，不依赖字体的上标字形", () => {
  const issues: FigureSpecIssue[] = [];
  const spec = normalizeFigureSpec(
    { no: 3, kind: "chart", xLabel: "生长阶段", yLabel: "EC值/(mS·cm⁻¹)", points: [[0, 1.2], [1, 1.8], [2, 2.1], [3, 3.0], [4, 2.2]], xTicks: [0, 1, 2, 3, 4] },
    issues,
  );
  assert.ok(spec);
  const figure = renderFigure(spec);
  assert.ok(!/[⁻¹²³⁰-₟]/.test(figure.svg), "SVG 里不应再有 Unicode 上下标字符");
  const sup = /<tspan dy="-(\d+)" font-size="(\d+)">-1<\/tspan>(?:<tspan dy="(\d+)">\)<\/tspan>)?/.exec(figure.svg);
  assert.ok(sup, figure.svg);
  assert.equal(Number(sup[2]), Math.round(FONT * SUB_SCALE));
  assert.ok(Number(sup[1]) >= 9 && Number(sup[1]) <= 12, sup[0]);
  if (sup[3] !== undefined) assert.equal(sup[3], sup[1], "上标后的文字应回到基线");
  assert.ok(figure.texts.some((text) => text.includes("mS·cm⁻¹")), figure.texts.join("|"));
});
