// Regression tests for the legibility relayout fallback in figure-render.ts.
// ROUND6_FIG1 is figure 1 of the real round-6 end-to-end draft: the default layout put five source nodes in one row
// and had to shrink the text to 1.67 mm, which blocked the export.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FigureSpec } from "./figure-spec.ts";
import { COMFORT_FONT_MM, MAX_HEIGHT_MM, MAX_WIDTH_MM, MIN_FONT_MM, flowColumnSplit, relayoutVariants, renderFigure, textWidth } from "./figure-render.ts";
import type { RenderedFigure } from "./figure-render.ts";

const ROUND6_FIG1: FigureSpec = {"no":1,"kind":"block","steps":[],"nodes":[{"id":"s1","text":"多点位土壤传感器阵列","ref":"1"},{"id":"s2","text":"变量施肥泵组","ref":"2"},{"id":"s3","text":"混合稀释腔体","ref":"3"},{"id":"s4","text":"流量调节阀组","ref":"4"},{"id":"s5","text":"中央控制器","ref":"5"},{"id":"s6","text":"肥液储罐","ref":"6"},{"id":"s7","text":"浓度传感器","ref":"32"},{"id":"s8","text":"搅拌装置","ref":"31"},{"id":"s9","text":"气象数据源","ref":"7"}],"edges":[{"from":"s1","to":"s5"},{"from":"s9","to":"s5"},{"from":"s5","to":"s2","label":"施肥指令"},{"from":"s5","to":"s4","label":"分配指令"},{"from":"s2","to":"s3"},{"from":"s7","to":"s5","label":"浓度反馈","both":true},{"from":"s6","to":"s2"}],"layers":[],"items":[],"shapes":[]};
const WIDE_BLOCK: FigureSpec = {"steps":[],"nodes":[{"id":"s0","text":"多点位土壤传感器阵列","ref":"11"},{"id":"s1","text":"变量施肥泵组","ref":"12"},{"id":"s2","text":"混合稀释腔体","ref":"13"},{"id":"s3","text":"流量调节阀组","ref":"14"},{"id":"s4","text":"中央控制器","ref":"15"},{"id":"s5","text":"肥液储罐","ref":"16"},{"id":"s6","text":"浓度传感器","ref":"17"},{"id":"s7","text":"搅拌装置","ref":"18"},{"id":"c","text":"中央控制器","ref":"20"},{"id":"a1","text":"变量施肥泵组","ref":"21"},{"id":"a2","text":"流量调节阀组","ref":"22"}],"edges":[{"from":"s0","to":"c"},{"from":"s1","to":"c"},{"from":"s2","to":"c"},{"from":"s3","to":"c"},{"from":"s4","to":"c"},{"from":"s5","to":"c"},{"from":"s6","to":"c"},{"from":"s7","to":"c"},{"from":"c","to":"a1","label":"施肥指令"},{"from":"c","to":"a2"}],"layers":[],"items":[],"shapes":[],"no":2,"kind":"block"};
const TALL_FLOW: FigureSpec = {"steps":[{"id":"p0","text":"多点位土壤传感器阵列1","shape":"terminal"},{"id":"p1","text":"变量施肥泵组2","shape":"process"},{"id":"p2","text":"混合稀释腔体3","shape":"process"},{"id":"p3","text":"流量调节阀组4","shape":"process"},{"id":"p4","text":"中央控制器5","shape":"process"},{"id":"p5","text":"肥液储罐6","shape":"process"},{"id":"p6","text":"浓度传感器7","shape":"process"},{"id":"p7","text":"搅拌装置8","shape":"process"},{"id":"p8","text":"气象数据源9","shape":"process"},{"id":"p9","text":"多点位土壤传感器阵列10","shape":"process"},{"id":"p10","text":"变量施肥泵组11","shape":"process"},{"id":"p11","text":"混合稀释腔体12","shape":"process"},{"id":"p12","text":"流量调节阀组13","shape":"process"},{"id":"p13","text":"中央控制器14","shape":"process"},{"id":"p14","text":"肥液储罐15","shape":"process"},{"id":"p15","text":"浓度传感器16","shape":"process"},{"id":"p16","text":"搅拌装置17","shape":"process"},{"id":"p17","text":"气象数据源18","shape":"terminal"}],"nodes":[],"edges":[],"layers":[],"items":[],"shapes":[],"no":3,"kind":"flow"};
const CROSS_LOOP_FLOW: FigureSpec = {"steps":[{"id":"p0","text":"多点位土壤传感器阵列1","shape":"terminal"},{"id":"p1","text":"变量施肥泵组2","shape":"process"},{"id":"p2","text":"混合稀释腔体3","shape":"process"},{"id":"p3","text":"流量调节阀组4","shape":"process"},{"id":"p4","text":"中央控制器5","shape":"process"},{"id":"p5","text":"肥液储罐6","shape":"process"},{"id":"p6","text":"浓度传感器7","shape":"process"},{"id":"p7","text":"搅拌装置8","shape":"process"},{"id":"p8","text":"气象数据源9","shape":"process"},{"id":"p9","text":"多点位土壤传感器阵列10","shape":"process"},{"id":"p10","text":"变量施肥泵组11","shape":"process"},{"id":"p11","text":"混合稀释腔体12","shape":"process"},{"id":"p12","text":"流量调节阀组13","shape":"process"},{"id":"p13","text":"中央控制器14","shape":"process"},{"id":"p14","text":"肥液储罐15","shape":"process"},{"id":"p15","text":"浓度传感器16","shape":"decision"},{"id":"p16","text":"搅拌装置17","shape":"process"},{"id":"p17","text":"气象数据源18","shape":"terminal"}],"nodes":[],"edges":[{"from":"p0","to":"p1"},{"from":"p1","to":"p2"},{"from":"p2","to":"p3"},{"from":"p3","to":"p4"},{"from":"p4","to":"p5"},{"from":"p5","to":"p6"},{"from":"p6","to":"p7"},{"from":"p7","to":"p8"},{"from":"p8","to":"p9"},{"from":"p9","to":"p10"},{"from":"p10","to":"p11"},{"from":"p11","to":"p12"},{"from":"p12","to":"p13"},{"from":"p13","to":"p14"},{"from":"p14","to":"p15"},{"from":"p15","to":"p16"},{"from":"p16","to":"p17"},{"from":"p15","to":"p3","label":"施肥指令"}],"layers":[],"items":[],"shapes":[],"no":4,"kind":"flow"};
const COLUMN_LOOP_FLOW: FigureSpec = {"steps":[{"id":"p0","text":"多点位土壤传感器阵列1","shape":"terminal"},{"id":"p1","text":"变量施肥泵组2","shape":"process"},{"id":"p2","text":"混合稀释腔体3","shape":"process"},{"id":"p3","text":"流量调节阀组4","shape":"process"},{"id":"p4","text":"中央控制器5","shape":"process"},{"id":"p5","text":"肥液储罐6","shape":"process"},{"id":"p6","text":"浓度传感器7","shape":"process"},{"id":"p7","text":"搅拌装置8","shape":"process"},{"id":"p8","text":"气象数据源9","shape":"process"},{"id":"p9","text":"多点位土壤传感器阵列10","shape":"process"},{"id":"p10","text":"变量施肥泵组11","shape":"process"},{"id":"p11","text":"混合稀释腔体12","shape":"process"},{"id":"p12","text":"流量调节阀组13","shape":"process"},{"id":"p13","text":"中央控制器14","shape":"process"},{"id":"p14","text":"肥液储罐15","shape":"process"},{"id":"p15","text":"浓度传感器16","shape":"decision"},{"id":"p16","text":"搅拌装置17","shape":"process"},{"id":"p17","text":"气象数据源18","shape":"terminal"}],"nodes":[],"edges":[{"from":"p0","to":"p1"},{"from":"p1","to":"p2"},{"from":"p2","to":"p3"},{"from":"p3","to":"p4"},{"from":"p4","to":"p5"},{"from":"p5","to":"p6"},{"from":"p6","to":"p7"},{"from":"p7","to":"p8"},{"from":"p8","to":"p9"},{"from":"p9","to":"p10"},{"from":"p10","to":"p11"},{"from":"p11","to":"p12"},{"from":"p12","to":"p13"},{"from":"p13","to":"p14"},{"from":"p14","to":"p15"},{"from":"p15","to":"p16"},{"from":"p16","to":"p17"},{"from":"p15","to":"p11","label":"施肥指令"}],"layers":[],"items":[],"shapes":[],"no":5,"kind":"flow"};
const SMALL_BLOCK: FigureSpec = {"steps":[],"nodes":[{"id":"s1","text":"多点位土壤传感器阵列","ref":"1"},{"id":"s2","text":"变量施肥泵组","ref":"2"},{"id":"s3","text":"混合稀释腔体","ref":"3"}],"edges":[{"from":"s1","to":"s2"},{"from":"s2","to":"s3"}],"layers":[],"items":[],"shapes":[],"no":6,"kind":"block"};

function assertFits(figure: RenderedFigure): void {
  assert.ok(figure.widthMm <= MAX_WIDTH_MM, "width " + figure.widthMm);
  assert.ok(figure.heightMm <= MAX_HEIGHT_MM, "height " + figure.heightMm);
}

function assertComplete(spec: FigureSpec, figure: RenderedFigure): void {
  const drawn = figure.texts.join("");
  for (const node of spec.nodes) {
    assert.ok(drawn.includes(node.text), "missing node text " + node.text);
    if (node.ref) assert.ok(figure.refs.includes(node.ref), "missing reference sign " + node.ref);
  }
  for (const step of spec.steps) assert.ok(drawn.includes(step.text), "missing step " + step.text);
  for (const edge of spec.edges) if (edge.label) assert.ok(drawn.includes(edge.label), "missing edge label " + edge.label);
}

test("round-6 figure 1 is re-laid out to legible text instead of shrinking to 1.67 mm", () => {
  const figure = renderFigure(ROUND6_FIG1);
  assert.ok(figure.fontMm >= COMFORT_FONT_MM, "font " + figure.fontMm);
  assertFits(figure);
  assertComplete(ROUND6_FIG1, figure);
  assert.deepEqual(figure.warnings, []);
});

test("an already legible figure keeps its full-size default layout", () => {
  const figure = renderFigure(SMALL_BLOCK);
  assert.equal(figure.fontMm, 3.5);
  assertComplete(SMALL_BLOCK, figure);
});

test("a block diagram with eight inputs in one rank is stacked into legible rows", () => {
  const figure = renderFigure(WIDE_BLOCK);
  assert.ok(figure.fontMm >= COMFORT_FONT_MM, "font " + figure.fontMm);
  assertFits(figure);
  assertComplete(WIDE_BLOCK, figure);
  assert.deepEqual(figure.warnings, []);
});

test("an 18-step flow chart is split into two columns at full legibility", () => {
  assert.equal(flowColumnSplit(TALL_FLOW), 9);
  const figure = renderFigure(TALL_FLOW);
  assert.ok(figure.fontMm >= COMFORT_FONT_MM, "font " + figure.fontMm);
  assertFits(figure);
  assertComplete(TALL_FLOW, figure);
});

test("a loop inside the second column still allows the two-column layout", () => {
  assert.equal(flowColumnSplit(COLUMN_LOOP_FLOW), 9);
  const figure = renderFigure(COLUMN_LOOP_FLOW);
  assert.ok(figure.fontMm >= COMFORT_FONT_MM, "font " + figure.fontMm);
  assertFits(figure);
  assertComplete(COLUMN_LOOP_FLOW, figure);
});

test("a loop crossing the column break keeps a single column but still stays above the export minimum", () => {
  assert.equal(flowColumnSplit(CROSS_LOOP_FLOW), null);
  assert.ok(relayoutVariants(CROSS_LOOP_FLOW).every((variant) => variant.flow?.columns !== 2));
  const figure = renderFigure(CROSS_LOOP_FLOW);
  assert.ok(figure.fontMm >= MIN_FONT_MM, "font " + figure.fontMm);
  assertFits(figure);
  assertComplete(CROSS_LOOP_FLOW, figure);
});

test("relayout is deterministic", () => {
  assert.equal(renderFigure(ROUND6_FIG1).svg, renderFigure(ROUND6_FIG1).svg);
  assert.equal(renderFigure(TALL_FLOW).svg, renderFigure(TALL_FLOW).svg);
});

// ---------- geometry of the rendered SVG, read back independently of the renderer's own bookkeeping ----------

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
type Seg = [number, number, number, number];
interface DrawnText {
  content: string;
  box: Box;
}

function svgSegments(svg: string): Seg[] {
  const segments: Seg[] = [];
  for (const m of svg.matchAll(/<line x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)"/g)) {
    segments.push([Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]);
  }
  for (const m of svg.matchAll(/<polyline points="([^"]+)"/g)) {
    const points = m[1].trim().split(/\s+/).map((pair) => pair.split(",").map(Number));
    for (let k = 0; k + 1 < points.length; k += 1) segments.push([points[k][0], points[k][1], points[k + 1][0], points[k + 1][1]]);
  }
  for (const m of svg.matchAll(/<rect x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)) {
    const [x, y, w, h] = [m[1], m[2], m[3], m[4]].map(Number);
    segments.push([x, y, x + w, y], [x + w, y, x + w, y + h], [x + w, y + h, x, y + h], [x, y + h, x, y]);
  }
  return segments;
}

/** Text boxes as Canvas.text lays them out: baseline = top + 0.86 × font size. Shrunk by 1 unit so mere touching is not a hit. */
function svgTexts(svg: string): DrawnText[] {
  const texts: DrawnText[] = [];
  for (const m of svg.matchAll(/<text x="([-\d.]+)" y="([-\d.]+)" text-anchor="(start|middle|end)" font-size="([\d.]+)"[^>]*>([^<]*)/g)) {
    const content = m[5].trim();
    if (!content) continue;
    const size = Number(m[4]);
    const width = textWidth(content, size);
    const x = Number(m[1]);
    const left = m[3] === "middle" ? x - width / 2 : m[3] === "end" ? x - width : x;
    const top = Number(m[2]) - size * 0.86;
    texts.push({ content, box: { minX: left + 1, minY: top + 1, maxX: left + width - 1, maxY: top + size - 1 } });
  }
  return texts;
}

/** Liang–Barsky clip: does the segment touch the box at all (including lying inside it)? */
function segmentHits([x1, y1, x2, y2]: Seg, box: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const clips: [number, number][] = [[-dx, x1 - box.minX], [dx, box.maxX - x1], [-dy, y1 - box.minY], [dy, box.maxY - y1]];
  for (const [p, q] of clips) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  return true;
}

function overlaps(a: Box, b: Box): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

test("edge labels in block diagrams stay clear of every line, box outline and other text", () => {
  for (const spec of [ROUND6_FIG1, WIDE_BLOCK, SMALL_BLOCK]) {
    const figure = renderFigure(spec);
    const segments = svgSegments(figure.svg);
    const texts = svgTexts(figure.svg);
    assert.ok(segments.length > 0, "no segments parsed for figure " + spec.no);
    for (const edge of spec.edges) {
      if (!edge.label) continue;
      const drawn = texts.filter((item) => item.content === edge.label);
      assert.ok(drawn.length > 0, "figure " + spec.no + ": label " + edge.label + " not found in SVG");
      for (const label of drawn) {
        for (const segment of segments) {
          assert.ok(!segmentHits(segment, label.box), "figure " + spec.no + ": label " + edge.label + " is crossed by segment " + segment.join(","));
        }
        for (const other of texts) {
          if (other === label) continue;
          assert.ok(!overlaps(other.box, label.box), "figure " + spec.no + ": label " + edge.label + " overlaps text " + other.content);
        }
      }
    }
  }
});
