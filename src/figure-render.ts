/**
 * 附图的确定性排版与 SVG 绘制。
 *
 * 只用黑色线条（stroke #000，线宽 0.3 mm）、白底、宋体中文标签，不着色、不加灰度、不加图框，
 * 满足《专利审查指南》第一部分第一章 4.3 及专利法实施细则第二十一条对说明书附图的形式要求。
 * 坐标单位为 0.1 mm；整图超过 165 mm × 245 mm（电子申请附图图幅上限）时等比缩小，并报告缩小后的字高，
 * 供 figure-audit.ts 判断“缩小到三分之二时仍能清晰分辨”。
 */
import type { BlockNode, ChartMark, FigureChart, FigureEdge, FigureSpec, FlowStep, StructureShape } from "./figure-spec.ts";
import {
  Canvas,
  FONT,
  FONT_FAMILY,
  LINE_H,
  MARGIN,
  MAX_HEIGHT_MM,
  MAX_WIDTH_MM,
  PAD_X,
  PAD_Y,
  STROKE,
  UNIT_PER_MM,
  boxesOverlap,
  esc,
  fmt,
  labelOnPath,
  placeLeaders,
  placeNearLeaders,
  segmentHitsBox,
  textWidth,
  wrapText,
} from "./figure-draw.ts";
import type { LeaderRequest, OwnedLeader, Point } from "./figure-draw.ts";

export { FONT_FAMILY, MAX_HEIGHT_MM, MAX_WIDTH_MM, richRuns, textWidth, visibleText, wrapText } from "./figure-draw.ts";

export interface RenderedFigure {
  no: number;
  kind: FigureSpec["kind"];
  svg: string;
  widthMm: number;
  heightMm: number;
  /** 缩放后的实际字高（mm）。 */
  fontMm: number;
  /** 图中实际画出的附图标记。 */
  refs: string[];
  /** 图中实际画出的文字（不含附图标记）。 */
  texts: string[];
  /** 排版中发现的问题（如引出线无法避开其他部件）。 */
  warnings: string[];
}

// ───────────────────────────── 流程图 ─────────────────────────────

interface FlowBox {
  step: FlowStep;
  lines: string[];
  w: number;
  h: number;
  cx: number;
  top: number;
}

/** Layout options for the legibility relayout fallback; the defaults reproduce the original layout. */
export interface FlowLayout {
  /** Vertical gap between consecutive steps (0.1 mm). */
  gap?: number;
  /** Wrap width of process-box text (0.1 mm). */
  processWrap?: number;
  /** 2 splits the steps into two side-by-side columns (only when flowColumnSplit allows it). */
  columns?: 1 | 2;
}

export interface BlockLayout {
  /** Split any rank with more nodes than this into stacked rows. */
  maxPerRow?: number;
  /** Wrap width of node text (0.1 mm). */
  wrapWidth?: number;
  /** Minimum node width (0.1 mm). */
  minNodeWidth?: number;
}

export interface LayoutVariant {
  flow?: FlowLayout;
  block?: BlockLayout;
}

function flowBoxes(steps: FlowStep[], processWrap = 600): FlowBox[] {
  const processLines = steps.map((step) => wrapText(step.text, step.shape === "decision" ? 440 : processWrap));
  const widest = Math.max(...steps.map((step, index) => (step.shape === "decision" ? 0 : Math.max(...processLines[index].map((line) => textWidth(line))))));
  const processW = Math.min(1000, Math.max(560, widest + PAD_X * 2));
  return steps.map((step, index) => {
    const lines = processLines[index];
    const textH = lines.length * LINE_H - (LINE_H - FONT);
    if (step.shape === "decision") {
      const textW = Math.max(...lines.map((line) => textWidth(line)));
      const halfW = Math.max(processW / 2, textW / 2 + 140);
      const ratio = Math.min(0.8, textW / 2 / halfW + 0.08);
      const halfH = Math.max(90, (textH / 2 + 10) / (1 - ratio));
      return { step, lines, w: halfW * 2, h: halfH * 2, cx: 0, top: 0 };
    }
    return { step, lines, w: step.shape === "terminal" ? Math.max(360, Math.min(processW, Math.max(...lines.map((line) => textWidth(line))) + PAD_X * 4)) : processW, h: textH + PAD_Y * 2, cx: 0, top: 0 };
  });
}

function flowEdges(spec: FigureSpec): FigureEdge[] {
  return spec.edges.length ? spec.edges : spec.steps.slice(1).map((step, position) => ({ from: spec.steps[position].id, to: step.id }));
}

/**
 * Index of the first step of the second column, or null when a two-column layout is not possible:
 * fewer than six steps, or a non-sequential edge (loop or skip) that would cross between the columns.
 */
export function flowColumnSplit(spec: FigureSpec): number | null {
  if (spec.steps.length < 6) return null;
  const split = Math.ceil(spec.steps.length / 2);
  const index = new Map(spec.steps.map((step, position) => [step.id, position]));
  for (const edge of flowEdges(spec)) {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    if (from === undefined || to === undefined || to === from + 1) continue;
    if ((from < split) !== (to < split)) return null;
  }
  return split;
}

function renderFlow(spec: FigureSpec, canvas: Canvas, layout: FlowLayout = {}): void {
  const boxes = flowBoxes(spec.steps, layout.processWrap);
  const gap = layout.gap ?? 130;
  const split = layout.columns === 2 ? flowColumnSplit(spec) : null;
  const columnOf = (position: number): number => (split !== null && position >= split ? 1 : 0);
  const index = new Map(boxes.map((box, position) => [box.step.id, position]));
  const edges = flowEdges(spec);
  const halfMax = Math.max(...boxes.map((box) => box.w / 2));
  const longEdges = edges.filter((edge) => {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    return from !== undefined && to !== undefined && to !== from + 1;
  }).length;
  // The second column sits past every side lane of both columns, with a clear corridor for the column-break connector.
  const columnX = split === null ? 0 : halfMax * 2 + (90 + longEdges * 70) * 2 + 160;
  let y = 0;
  boxes.forEach((box, position) => {
    if (position === split) y = 0;
    box.cx = columnOf(position) * columnX;
    box.top = y;
    y += box.h + gap;
  });
  for (const box of boxes) {
    const left = box.cx - box.w / 2;
    if (box.step.shape === "decision") {
      canvas.polygon([[box.cx, box.top], [box.cx + box.w / 2, box.top + box.h / 2], [box.cx, box.top + box.h], [box.cx - box.w / 2, box.top + box.h / 2]]);
    } else {
      canvas.rect(left, box.top, box.w, box.h, box.step.shape === "terminal" ? box.h / 2 : 0);
    }
    const textH = box.lines.length * LINE_H - (LINE_H - FONT);
    canvas.text(box.lines, box.cx, box.top + (box.h - textH) / 2);
  }
  const lanes = [{ right: 0, left: 0 }, { right: 0, left: 0 }];
  const usedExit = new Map<string, Set<"right" | "left">>();
  const enterCount = new Map<string, number>();
  for (const edge of edges) {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    if (from === undefined || to === undefined) continue;
    const a = boxes[from];
    const b = boxes[to];
    if (to === from + 1) {
      if (columnOf(from) === columnOf(to)) {
        const start: Point = [a.cx, a.top + a.h];
        const end: Point = [b.cx, b.top];
        canvas.arrow([start, end], edge.both);
      } else {
        const midX = columnX / 2;
        const dropY = a.top + a.h + gap / 2;
        const riseY = b.top - gap / 2;
        canvas.arrow([[a.cx, a.top + a.h], [a.cx, dropY], [midX, dropY], [midX, riseY], [b.cx, riseY], [b.cx, b.top]], edge.both);
      }
      if (edge.label) canvas.text([edge.label], a.cx + 16, a.top + a.h + 14, "start");
      continue;
    }
    const used = usedExit.get(edge.from) ?? new Set<"right" | "left">();
    let side: "right" | "left" = to <= from ? "right" : "left";
    if (used.has(side)) side = side === "right" ? "left" : "right";
    used.add(side);
    usedExit.set(edge.from, used);
    const sign = side === "right" ? 1 : -1;
    const column = lanes[columnOf(from)];
    const lane = side === "right" ? column.right++ : column.left++;
    const laneX = a.cx + sign * (halfMax + 90 + lane * 70);
    const exit: Point = [a.cx + sign * (a.w / 2), a.top + a.h / 2];
    const entries = enterCount.get(edge.to) ?? 0;
    enterCount.set(edge.to, entries + 1);
    const entryY = b.top + b.h / 2 + (entries ? (entries % 2 ? -1 : 1) * Math.ceil(entries / 2) * 18 : 0);
    const entryX = b.step.shape === "decision" ? b.cx + sign * (b.w / 2) * (1 - Math.abs(entryY - (b.top + b.h / 2)) / (b.h / 2)) : b.cx + sign * (b.w / 2);
    canvas.arrow([exit, [laneX, exit[1]], [laneX, entryY], [entryX, entryY]], edge.both);
    if (edge.label) canvas.text([edge.label], exit[0] + sign * 14, exit[1] - FONT - 8, side === "right" ? "start" : "end");
  }
}

// ───────────────────────────── 框图 ─────────────────────────────

function blockRanks(nodes: BlockNode[], edges: FigureEdge[]): { rank: Map<string, number>; back: Set<FigureEdge> } {
  const ids = nodes.map((node) => node.id);
  const out = new Map<string, FigureEdge[]>(ids.map((id) => [id, []]));
  edges.forEach((edge) => out.get(edge.from)?.push(edge));
  const state = new Map<string, 0 | 1 | 2>();
  const back = new Set<FigureEdge>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const edge of out.get(id) ?? []) {
      const next = state.get(edge.to) ?? 0;
      if (next === 1 || edge.to === id) back.add(edge);
      else if (next === 0) visit(edge.to);
    }
    state.set(id, 2);
  };
  ids.forEach((id) => {
    if (!state.get(id)) visit(id);
  });
  const rank = new Map<string, number>(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      if (back.has(edge)) continue;
      const next = (rank.get(edge.from) ?? 0) + 1;
      if (next > (rank.get(edge.to) ?? 0)) {
        rank.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { rank, back };
}

/**
 * Split every rank wider than maxPerRow into stacked rows (virtual ranks). Nodes fed by the previous rank go to the
 * upper rows and nodes feeding the next rank to the lower rows, so most edges stay between adjacent rows; the rest
 * are routed through the existing side lanes. Without maxPerRow the original ranks are returned unchanged.
 */
function splitWideRanks(nodes: BlockNode[], edges: FigureEdge[], rank: Map<string, number>, back: Set<FigureEdge>, maxPerRow?: number): Map<string, number> {
  if (!maxPerRow || maxPerRow < 1) return rank;
  const maxRank = Math.max(0, ...rank.values());
  const forward = edges.filter((edge) => !back.has(edge));
  const result = new Map<string, number>();
  let offset = 0;
  for (let r = 0; r <= maxRank; r += 1) {
    const row = nodes.filter((node) => (rank.get(node.id) ?? 0) === r).map((node) => node.id);
    if (row.length <= maxPerRow) {
      row.forEach((id) => result.set(id, r + offset));
      continue;
    }
    const feedsNext = (id: string) => forward.some((edge) => edge.from === id && rank.get(edge.to) === r + 1);
    const fedByPrev = (id: string) => forward.some((edge) => edge.to === id && rank.get(edge.from) === r - 1);
    const ordered = row
      .map((id, position) => ({ id, position, weight: (feedsNext(id) ? 1 : 0) - (fedByPrev(id) ? 1 : 0) }))
      .sort((a, b) => a.weight - b.weight || a.position - b.position)
      .map((entry) => entry.id);
    const chunks = Math.ceil(ordered.length / maxPerRow);
    const base = Math.floor(ordered.length / chunks);
    const extra = ordered.length % chunks;
    let cursor = 0;
    for (let chunk = 0; chunk < chunks; chunk += 1) {
      const size = base + (chunk >= chunks - extra ? 1 : 0);
      ordered.slice(cursor, cursor + size).forEach((id) => result.set(id, r + offset + chunk));
      cursor += size;
    }
    offset += chunks - 1;
  }
  for (const node of nodes) if (!result.has(node.id)) result.set(node.id, (rank.get(node.id) ?? 0) + offset);
  return result;
}

function renderBlock(spec: FigureSpec, canvas: Canvas, layout: BlockLayout = {}): void {
  const { nodes, edges } = spec;
  const { rank: baseRank, back } = blockRanks(nodes, edges);
  const rank = splitWideRanks(nodes, edges, baseRank, back, layout.maxPerRow);
  const maxRank = Math.max(0, ...rank.values());
  const rows: string[][] = Array.from({ length: maxRank + 1 }, () => []);
  nodes.forEach((node) => rows[rank.get(node.id) ?? 0].push(node.id));
  const order = new Map<string, number>();
  const reindex = () => rows.forEach((row) => row.forEach((id, position) => order.set(id, position)));
  reindex();
  const neighbors = (id: string, upward: boolean) =>
    edges.filter((edge) => !back.has(edge) && (upward ? edge.to === id : edge.from === id)).map((edge) => (upward ? edge.from : edge.to));
  for (let sweep = 0; sweep < 4; sweep += 1) {
    const upward = sweep % 2 === 0;
    const sequence = upward ? rows.slice(1) : rows.slice(0, -1).reverse();
    for (const row of sequence) {
      const score = new Map(row.map((id) => {
        const linked = neighbors(id, upward);
        return [id, linked.length ? linked.reduce((sum, other) => sum + (order.get(other) ?? 0), 0) / linked.length : (order.get(id) ?? 0)];
      }));
      row.sort((a, b) => (score.get(a) ?? 0) - (score.get(b) ?? 0));
      reindex();
    }
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const lines = new Map(nodes.map((node) => [node.id, wrapText(node.text, layout.wrapWidth ?? 380)]));
  const widest = Math.max(...nodes.map((node) => Math.max(...(lines.get(node.id) ?? [""]).map((line) => textWidth(line)))));
  const nodeW = Math.min(560, Math.max(layout.minNodeWidth ?? 380, widest + PAD_X * 2));
  const maxLines = Math.max(...[...lines.values()].map((value) => value.length));
  const nodeH = maxLines * LINE_H - (LINE_H - FONT) + PAD_Y * 2;
  const hasRefs = nodes.some((node) => node.ref);
  const hGap = hasRefs ? 270 : 170;
  const channel = 220;
  const pos = new Map<string, { x: number; y: number }>();
  rows.forEach((row, r) => {
    const total = row.length * nodeW + (row.length - 1) * hGap;
    row.forEach((id, position) => pos.set(id, { x: -total / 2 + position * (nodeW + hGap), y: r * (nodeH + channel) }));
  });
  for (const node of nodes) {
    const p = pos.get(node.id);
    if (!p) continue;
    canvas.rect(p.x, p.y, nodeW, nodeH);
    const nodeLines = lines.get(node.id) ?? [node.text];
    const textH = nodeLines.length * LINE_H - (LINE_H - FONT);
    canvas.text(nodeLines, p.x + nodeW / 2, p.y + (nodeH - textH) / 2);
  }
  const allLeft = Math.min(...[...pos.values()].map((p) => p.x));
  const allRight = Math.max(...[...pos.values()].map((p) => p.x + nodeW)) + (hasRefs ? 160 : 0);
  // 端口：每个方框的底边出线、顶边进线按对端的横坐标排序后均分。
  const forward = edges.filter((edge) => !back.has(edge) && byId.has(edge.from) && byId.has(edge.to));
  const backward = edges.filter((edge) => back.has(edge) && byId.has(edge.from) && byId.has(edge.to));
  const centerX = (id: string) => (pos.get(id)?.x ?? 0) + nodeW / 2;
  const outPorts = new Map<FigureEdge, number>();
  const inPorts = new Map<FigureEdge, number>();
  for (const node of nodes) {
    const outs = edges.filter((edge) => edge.from === node.id && byId.has(edge.to)).sort((a, b) => centerX(a.to) - centerX(b.to));
    outs.forEach((edge, k) => outPorts.set(edge, (pos.get(node.id)?.x ?? 0) + (nodeW * (k + 1)) / (outs.length + 1)));
    const ins = edges.filter((edge) => edge.to === node.id && byId.has(edge.from)).sort((a, b) => centerX(a.from) - centerX(b.from));
    ins.forEach((edge, k) => inPorts.set(edge, (pos.get(node.id)?.x ?? 0) + (nodeW * (k + 1)) / (ins.length + 1)));
  }
  const tracks = new Map<number, number>();
  const trackY = (r: number) => {
    const used = tracks.get(r) ?? 0;
    tracks.set(r, used + 1);
    const base = r * (nodeH + channel) + nodeH;
    const slot = 1 + (used % 5);
    return base + (channel * slot) / 6;
  };
  let leftLane = 0;
  let rightLane = 0;
  const pendingLabels: { points: Point[]; label: string }[] = [];
  const route = (edge: FigureEdge, viaSide: "left" | "right" | null) => {
    const a = pos.get(edge.from);
    const b = pos.get(edge.to);
    if (!a || !b) return;
    const ra = rank.get(edge.from) ?? 0;
    const rb = rank.get(edge.to) ?? 0;
    const sx = outPorts.get(edge) ?? a.x + nodeW / 2;
    const tx = inPorts.get(edge) ?? b.x + nodeW / 2;
    const start: Point = [sx, a.y + nodeH];
    const end: Point = [tx, b.y];
    let points: Point[];
    if (!viaSide && rb === ra + 1) {
      if (Math.abs(sx - tx) < 1) points = [start, end];
      else {
        const ty = trackY(ra);
        points = [start, [sx, ty], [tx, ty], end];
      }
    } else {
      const rowA = rows[ra];
      const rowB = rows[rb];
      const leftmost = (row: string[], id: string) => row[0] === id;
      const rightmost = (row: string[], id: string) => row[row.length - 1] === id;
      let side: "left" | "right";
      if (leftmost(rowA, edge.from) && leftmost(rowB, edge.to)) side = "left";
      else if (rightmost(rowA, edge.from) && rightmost(rowB, edge.to)) side = "right";
      else side = viaSide ?? ((sx + tx) / 2 < (allLeft + allRight) / 2 ? "left" : "right");
      const laneX = side === "left" ? allLeft - 90 - leftLane++ * 60 : allRight + 90 + rightLane++ * 60;
      const exitSide = side === "left" ? leftmost(rowA, edge.from) : rightmost(rowA, edge.from);
      const enterSide = side === "left" ? leftmost(rowB, edge.to) : rightmost(rowB, edge.to);
      const sideX = (p: { x: number }) => (side === "left" ? p.x : p.x + nodeW);
      const head: Point[] = exitSide ? [[sideX(a), a.y + nodeH * 0.62]] : [start, [sx, trackY(ra)]];
      const tail: Point[] = enterSide ? [[sideX(b), b.y + nodeH * 0.38]] : [[tx, rb === 0 ? b.y - channel / 2 : trackY(rb - 1)], end];
      const headY = head[head.length - 1][1];
      const tailY = tail[0][1];
      points = [...head, [laneX, headY], [laneX, tailY], ...tail];
    }
    canvas.arrow(points, edge.both);
    if (edge.label) pendingLabels.push({ points, label: edge.label });
  };
  forward.forEach((edge) => route(edge, null));
  backward.forEach((edge) => route(edge, "right"));
  for (const node of nodes) {
    const p = pos.get(node.id);
    if (!p || !node.ref) continue;
    const anchor: Point = [p.x + nodeW, p.y + nodeH * 0.3];
    canvas.ref(node.ref, anchor, [p.x + nodeW + 80, p.y + nodeH * 0.3 - 45], "right");
  }
  // 连线全部画完、附图标记也已就位后再写分支词语，标签才能避开后画的连线和引出线。
  for (const pending of pendingLabels) labelOnPath(canvas, pending.points, pending.label);
}

// ───────────────────────────── 分层剖面图 ─────────────────────────────

function renderLayers(spec: FigureSpec, canvas: Canvas): void {
  const width = 1100;
  const total = spec.layers.reduce((sum, layer) => sum + layer.thickness, 0);
  const above = Math.max(0, ...spec.items.map((item) => -item.depth));
  const scale = 1300 / (total + above * 1.3);
  const ground = above > 0 ? above * scale * 1.3 : 0;
  const yOf = (depth: number) => ground + depth * scale;
  // 地表线及地面符号（斜短线）。
  canvas.line([[-30, ground], [width + 30, ground]]);
  for (let x = 0; x <= width; x += 60) canvas.line([[x, ground], [x + 26, ground - 26]]);
  let depth = 0;
  const leaders: LeaderRequest[] = [];
  spec.layers.forEach((layer, index) => {
    const top = yOf(depth);
    depth += layer.thickness;
    const bottom = yOf(depth);
    canvas.line([[0, top], [0, bottom]]);
    canvas.line([[width, top], [width, bottom]]);
    canvas.line([[0, bottom], [width, bottom]], index === spec.layers.length - 1 ? false : true);
    if (layer.ref) leaders.push({ ref: layer.ref, anchor: [width - 50, top + (bottom - top) * 0.72] });
    if (layer.dim) {
      const x = -90;
      canvas.line([[x, top], [x, bottom]]);
      canvas.line([[x - 14, top], [x + 14, top]]);
      canvas.line([[x - 14, bottom], [x + 14, bottom]]);
      canvas.text([layer.dim], x - 16, (top + bottom) / 2 - FONT / 2, "end");
    }
  });
  // 底面以下不再延伸：剖面以最后一层底边封闭。
  for (const item of spec.items) {
    const cx = item.x * width;
    const cy = yOf(item.depth);
    let anchor: Point;
    let topY: number;
    if (item.shape === "box") {
      canvas.rect(cx - 80, cy - 45, 160, 90);
      anchor = [cx + 80, cy - 20];
      topY = cy + 45;
    } else if (item.shape === "pipe") {
      canvas.circle(cx, cy, 22);
      canvas.circle(cx, cy, 12);
      anchor = [cx + 16, cy - 16];
      topY = cy - 22;
    } else {
      canvas.rect(cx - 18, cy - 40, 36, 80);
      canvas.polygon([[cx - 18, cy + 40], [cx + 18, cy + 40], [cx, cy + 66]]);
      anchor = [cx + 18, cy - 10];
      topY = cy - 40;
    }
    if (item.lead && item.depth > 0) {
      const box = spec.items.find((other) => other.shape === "box" && other.depth < 0 && Math.abs(other.x - item.x) < 0.2);
      const endY = box ? yOf(box.depth) + 45 : ground;
      const endX = box ? box.x * width : cx;
      canvas.line(endX === cx ? [[cx, topY], [cx, endY]] : [[cx, topY], [cx, ground - 20], [endX, ground - 20], [endX, endY]]);
    }
    leaders.push({ ref: item.ref, anchor });
  }
  placeLeaders(canvas, leaders, "right", width + 150, -Infinity, yOf(total) + 40);
}

// ───────────────────────────── 结构示意图 ─────────────────────────────

function renderStructure(spec: FigureSpec, canvas: Canvas): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const shape of spec.shapes) {
    if (shape.kind === "rect") {
      grow(shape.x, shape.y);
      grow(shape.x + shape.w, shape.y + shape.h);
    } else if (shape.kind === "circle") {
      grow(shape.cx - shape.r, shape.cy - shape.r);
      grow(shape.cx + shape.r, shape.cy + shape.r);
    } else {
      shape.points.forEach(([x, y]) => grow(x, y));
    }
  }
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const scale = Math.min(1150 / spanX, 1700 / spanY);
  const tx = (x: number) => (x - minX) * scale;
  const ty = (y: number) => (y - minY) * scale;
  const leaders: OwnedLeader[] = [];
  const anchorOf = (shape: StructureShape): Point => {
    if (shape.kind === "rect") {
      const inset = Math.min(shape.w * scale * 0.15, shape.h * scale * 0.15, 30);
      return [tx(shape.x + shape.w) - inset, ty(shape.y) + inset];
    }
    if (shape.kind === "circle") return [tx(shape.cx + shape.r * 0.7071), ty(shape.cy - shape.r * 0.7071)];
    let best = 0;
    let longest = -1;
    for (let k = 0; k + 1 < shape.points.length; k += 1) {
      const length = Math.hypot(shape.points[k + 1][0] - shape.points[k][0], shape.points[k + 1][1] - shape.points[k][1]);
      if (length > longest) {
        longest = length;
        best = k;
      }
    }
    const [a, b] = [shape.points[best], shape.points[best + 1]];
    const insideOther = (x: number, y: number) =>
      spec.shapes.some((other) => other !== shape && (other.kind === "rect" ? x > other.x && x < other.x + other.w && y > other.y && y < other.y + other.h : other.kind === "circle" ? Math.hypot(x - other.cx, y - other.cy) < other.r : false));
    for (const t of [0.5, 0.3, 0.7, 0.15, 0.85]) {
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t;
      if (!insideOther(x, y)) return [tx(x), ty(y)];
    }
    return [tx((a[0] + b[0]) / 2), ty((a[1] + b[1]) / 2)];
  };
  spec.shapes.forEach((shape, owner) => {
    canvas.owner = owner;
    if (shape.kind === "rect") canvas.rect(tx(shape.x), ty(shape.y), shape.w * scale, shape.h * scale, 0, shape.dashed);
    else if (shape.kind === "circle") canvas.circle(tx(shape.cx), ty(shape.cy), shape.r * scale, shape.dashed);
    else {
      const points = shape.points.map(([x, y]): Point => [tx(x), ty(y)]);
      if (shape.arrow) {
        canvas.line(points, shape.dashed);
        canvas.arrowHead(points[points.length - 2], points[points.length - 1]);
      } else canvas.line(points, shape.dashed);
    }
    if (shape.ref) leaders.push({ ref: shape.ref, anchor: anchorOf(shape), owner });
  });
  canvas.owner = -1;
  const unique = new Map<string, OwnedLeader>();
  for (const leader of leaders) if (!unique.has(leader.ref)) unique.set(leader.ref, leader);
  placeNearLeaders(canvas, [...unique.values()]);
}

// ───────────────────────────── 曲线图 ─────────────────────────────

/** 绘图区宽、高（0.1 mm）。 */
const CHART_W = 1100;
const CHART_H = 760;
/** 坐标轴越过绘图区、画箭头的长度。 */
const AXIS_OVER = 70;
const TICK_LEN = 14;
/** 数据点节点、特征点小圆圈的半径。 */
const NODE_R = 9;
const MARK_R = 11;
/** 平滑曲线每段的取样数。 */
const SMOOTH_STEPS = 16;
const AXIS_LABEL_WIDTH = 520;

type ChartTextSpot = { x: number; top: number; anchor: "start" | "middle" | "end" };

/** 坐标轴取值范围：非负数据且离零不远时从 0 起画（原点 O），上端留出余量。 */
function chartRange(values: number[]): { lo: number; hi: number } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min > 0 ? max - min : Math.abs(max) || 1;
  const lo = min >= 0 && min <= span ? 0 : min - span * 0.06;
  const hi = max + span * 0.1;
  return { lo, hi: hi > lo ? hi : lo + 1 };
}

/**
 * 横坐标严格递增时按单调三次 Hermite 插值（Fritsch–Butland 斜率）取样：曲线光滑，且不会越过相邻数据点形成假峰谷。
 * 横坐标不递增（回线、封闭曲线）时原样返回，按折线绘制。
 */
function smoothSamples(points: Point[]): Point[] {
  const n = points.length;
  if (n < 3) return points;
  for (let k = 0; k + 1 < n; k += 1) if (!(points[k + 1][0] > points[k][0])) return points;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let k = 0; k + 1 < n; k += 1) {
    dx.push(points[k + 1][0] - points[k][0]);
    slope.push((points[k + 1][1] - points[k][1]) / dx[k]);
  }
  const tangent: number[] = new Array<number>(n).fill(0);
  tangent[0] = slope[0];
  tangent[n - 1] = slope[n - 2];
  for (let k = 1; k + 1 < n; k += 1) {
    if (slope[k - 1] * slope[k] <= 0) continue;
    const w1 = 2 * dx[k] + dx[k - 1];
    const w2 = dx[k] + 2 * dx[k - 1];
    tangent[k] = (w1 + w2) / (w1 / slope[k - 1] + w2 / slope[k]);
  }
  const out: Point[] = [];
  for (let k = 0; k + 1 < n; k += 1) {
    const [x0, y0] = points[k];
    const y1 = points[k + 1][1];
    const h = dx[k];
    for (let step = 0; step < SMOOTH_STEPS; step += 1) {
      const t = step / SMOOTH_STEPS;
      const t2 = t * t;
      const t3 = t2 * t;
      const y = (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * tangent[k] + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * tangent[k + 1];
      out.push([x0 + t * h, y]);
    }
  }
  out.push(points[n - 1]);
  return out;
}

/** 在候选位置中依次找一个既不压已有文字、也不压线条的位置写一行字；都不行时只避开文字，再不行用第一个候选。 */
function placeChartText(canvas: Canvas, text: string, spots: ChartTextSpot[], record = true): void {
  const width = textWidth(text);
  const boxAt = (spot: ChartTextSpot) => {
    const left = spot.anchor === "middle" ? spot.x - width / 2 : spot.anchor === "end" ? spot.x - width : spot.x;
    return { minX: left - 6, minY: spot.top - 6, maxX: left + width + 6, maxY: spot.top + FONT + 6 };
  };
  const clearOfText = (spot: ChartTextSpot) => !canvas.textBoxes.some((box) => boxesOverlap(box, boxAt(spot)));
  const clearOfLines = (spot: ChartTextSpot) => {
    const box = boxAt(spot);
    return !canvas.segments.some((segment) => segmentHitsBox(segment.a, segment.b, box));
  };
  const spot = spots.find((candidate) => clearOfText(candidate) && clearOfLines(candidate)) ?? spots.find(clearOfText) ?? spots[0];
  canvas.text([text], spot.x, spot.top, spot.anchor, FONT, record);
}

/**
 * 曲线图：横轴向右、纵轴向上的 L 形坐标轴（末端实心箭头），轴名写在箭头旁，可选刻度；
 * 曲线按数据等比例映射，特征点画小圆圈并可向两轴引虚线，附图标记按结构图同样的方式引出。
 */
function renderChart(no: number, chart: FigureChart, canvas: Canvas): void {
  const xr = chartRange([...chart.series.flatMap((series) => series.points.map(([x]) => x)), ...chart.marks.map((mark) => mark.x), ...chart.xTicks.map((tick) => tick.value)]);
  const yr = chartRange([...chart.series.flatMap((series) => series.points.map(([, y]) => y)), ...chart.marks.map((mark) => mark.y), ...chart.yTicks.map((tick) => tick.value)]);
  const px = (x: number) => ((x - xr.lo) / (xr.hi - xr.lo)) * CHART_W;
  const py = (y: number) => CHART_H - ((y - yr.lo) / (yr.hi - yr.lo)) * CHART_H;

  // 坐标轴、刻度、原点和轴名。
  canvas.owner = -1;
  canvas.arrow([[0, CHART_H], [CHART_W + AXIS_OVER, CHART_H]]);
  canvas.arrow([[0, CHART_H], [0, -AXIS_OVER]]);
  for (const tick of chart.xTicks) {
    const x = px(tick.value);
    if (x > 1) canvas.line([[x, CHART_H], [x, CHART_H - TICK_LEN]]);
    canvas.text([tick.label], x, CHART_H + 10, "middle", FONT, false);
  }
  for (const tick of chart.yTicks) {
    const y = py(tick.value);
    if (CHART_H - y > 1) canvas.line([[0, y], [TICK_LEN, y]]);
    canvas.text([tick.label], -14, y - FONT / 2, "end", FONT, false);
  }
  const tickAtOrigin = chart.xTicks.some((tick) => px(tick.value) <= 1) || chart.yTicks.some((tick) => CHART_H - py(tick.value) <= 1);
  if (xr.lo === 0 && yr.lo === 0 && !tickAtOrigin) canvas.text(["O"], -14, CHART_H + 8, "end", FONT, false);
  if (chart.xLabel) {
    canvas.text(wrapText(chart.xLabel, AXIS_LABEL_WIDTH), CHART_W + AXIS_OVER, CHART_H + 14 + (chart.xTicks.length ? FONT + 12 : 0), "end");
  }
  if (chart.yLabel) {
    const lines = wrapText(chart.yLabel, AXIS_LABEL_WIDTH);
    canvas.text(lines, 26, -AXIS_OVER - FONT / 2 - (lines.length - 1) * LINE_H, "start");
  }

  // 曲线与数据点节点。
  const drawn: Point[][] = [];
  chart.series.forEach((series, owner) => {
    canvas.owner = owner;
    const mapped = series.points.map(([x, y]): Point => [px(x), py(y)]);
    let line = mapped;
    if (series.smooth !== false && mapped.length >= 3) {
      line = smoothSamples(mapped);
      if (line === mapped) canvas.warnings.push(`图${no}第${owner + 1}条曲线的横坐标不是逐点递增，已按折线绘制。`);
    }
    canvas.line(line, series.dashed === true);
    if (series.markers) for (const [x, y] of mapped) canvas.circle(x, y, NODE_R);
    drawn.push(line);
  });

  // 特征点及其向两轴的虚线引线。
  const leaders: OwnedLeader[] = [];
  const spots: Array<{ mark: ChartMark; x: number; y: number }> = [];
  chart.marks.forEach((mark, index) => {
    const owner = chart.series.length + index;
    canvas.owner = owner;
    const x = px(mark.x);
    const y = py(mark.y);
    canvas.circle(x, y, MARK_R);
    if (mark.guide) {
      if (x - MARK_R > 0) canvas.line([[x - MARK_R, y], [0, y]], true);
      if (CHART_H - (y + MARK_R) > 0) canvas.line([[x, y + MARK_R], [x, CHART_H]], true);
    }
    spots.push({ mark, x, y });
    if (mark.ref) leaders.push({ ref: mark.ref, anchor: [x + MARK_R * 0.7071, y - MARK_R * 0.7071], owner });
  });
  canvas.owner = -1;

  // 文字在全部线条画完后布置，以便避让：先曲线名称，再特征点标签和轴上符号。
  chart.series.forEach((series, owner) => {
    const line = drawn[owner];
    if (series.label) {
      const [x, y] = line[line.length - 1];
      placeChartText(canvas, series.label, [
        { x: x + 16, top: y - FONT / 2, anchor: "start" },
        { x: x + 16, top: y - FONT - 16, anchor: "start" },
        { x: x + 16, top: y + 16, anchor: "start" },
        { x: x - 16, top: y - FONT - 16, anchor: "end" },
        { x: x - 16, top: y + 16, anchor: "end" },
      ]);
    }
    if (series.ref) leaders.push({ ref: series.ref, anchor: line[Math.floor(line.length / 2)], owner });
  });
  for (const { mark, x, y } of spots) {
    if (mark.xText) {
      placeChartText(canvas, mark.xText, [
        { x, top: CHART_H + 10, anchor: "middle" },
        { x, top: CHART_H + 10 + LINE_H, anchor: "middle" },
      ]);
    }
    if (mark.yText) {
      placeChartText(canvas, mark.yText, [
        { x: -14, top: y - FONT / 2, anchor: "end" },
        { x: -14, top: y - FONT - 8, anchor: "end" },
        { x: -14, top: y + 8, anchor: "end" },
      ]);
    }
    if (mark.label) {
      const gap = MARK_R + 8;
      placeChartText(canvas, mark.label, [
        { x: x + gap, top: y - gap - FONT, anchor: "start" },
        { x: x - gap, top: y - gap - FONT, anchor: "end" },
        { x, top: y - gap - FONT - 10, anchor: "middle" },
        { x: x + gap, top: y + gap, anchor: "start" },
        { x: x - gap, top: y + gap, anchor: "end" },
        { x: x + gap + 6, top: y - FONT / 2, anchor: "start" },
      ]);
    }
  }

  const unique = new Map<string, OwnedLeader>();
  for (const leader of leaders) if (!unique.has(leader.ref)) unique.set(leader.ref, leader);
  if (unique.size) placeNearLeaders(canvas, [...unique.values()]);
}

/** 排版并绘制一幅附图。 */
function drawFigure(spec: FigureSpec, variant: LayoutVariant): RenderedFigure {
  const canvas = new Canvas();
  if (spec.kind === "flow" && spec.steps.length) renderFlow(spec, canvas, variant.flow);
  else if (spec.kind === "block" && spec.nodes.length) renderBlock(spec, canvas, variant.block);
  else if (spec.kind === "layers" && spec.layers.length) renderLayers(spec, canvas);
  else if (spec.kind === "structure" && spec.shapes.length) renderStructure(spec, canvas);
  else if (spec.kind === "chart" && spec.chart && spec.chart.series.length) renderChart(spec.no, spec.chart, canvas);
  else canvas.warnings.push(`图${spec.no}没有可绘制的内容。`);
  const box = canvas.bounds();
  if (!Number.isFinite(box.minX)) {
    box.minX = 0;
    box.minY = 0;
    box.maxX = 100;
    box.maxY = 100;
  }
  const vx = box.minX - MARGIN;
  const vy = box.minY - MARGIN;
  const vw = box.maxX - box.minX + MARGIN * 2;
  const vh = box.maxY - box.minY + MARGIN * 2;
  const fit = Math.min(1, (MAX_WIDTH_MM * UNIT_PER_MM) / vw, (MAX_HEIGHT_MM * UNIT_PER_MM) / vh);
  const widthMm = Math.round((vw * fit) / UNIT_PER_MM * 10) / 10;
  const heightMm = Math.round((vh * fit) / UNIT_PER_MM * 10) / 10;
  const fontMm = Math.round((FONT / UNIT_PER_MM) * fit * 100) / 100;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm}mm" height="${heightMm}mm" viewBox="${fmt(vx)} ${fmt(vy)} ${fmt(vw)} ${fmt(vh)}">`,
    `<rect x="${fmt(vx)}" y="${fmt(vy)}" width="${fmt(vw)}" height="${fmt(vh)}" fill="#fff" stroke="none"/>`,
    `<g fill="none" stroke="#000" stroke-width="${STROKE}" stroke-linecap="butt" stroke-linejoin="miter">`,
    ...canvas.parts.filter((part) => !part.startsWith("<text")),
    `</g>`,
    `<g fill="#000" stroke="none" font-family="${esc(FONT_FAMILY)}">`,
    ...canvas.parts.filter((part) => part.startsWith("<text")),
    `</g>`,
    `</svg>`,
  ].join("\n");
  return { no: spec.no, kind: spec.kind, svg, widthMm, heightMm, fontMm, refs: canvas.refs, texts: canvas.texts, warnings: canvas.warnings };
}

/** Text height (mm) at which a figure still reads clearly after the two-thirds reduction check in figure-audit.ts. */
export const COMFORT_FONT_MM = 2.8;
/** Text height (mm) below which figure-audit.ts blocks the export. */
export const MIN_FONT_MM = 2.0;

function longestBlockRow(spec: FigureSpec): number {
  const { rank } = blockRanks(spec.nodes, spec.edges);
  const counts = new Map<number, number>();
  for (const value of rank.values()) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Math.max(0, ...counts.values());
}

/** Alternative layouts, least invasive first, tried when the default layout must shrink below COMFORT_FONT_MM. */
export function relayoutVariants(spec: FigureSpec): LayoutVariant[] {
  if (spec.kind === "block" && spec.nodes.length) {
    const narrow: BlockLayout = { wrapWidth: 260, minNodeWidth: 300 };
    const variants: LayoutVariant[] = [{ block: narrow }];
    for (let perRow = longestBlockRow(spec) - 1; perRow >= 2; perRow -= 1) {
      variants.push({ block: { maxPerRow: perRow } }, { block: { ...narrow, maxPerRow: perRow } });
    }
    return variants;
  }
  if (spec.kind === "flow" && spec.steps.length) {
    const variants: LayoutVariant[] = [{ flow: { gap: 90 } }, { flow: { processWrap: 400 } }, { flow: { gap: 90, processWrap: 900 } }];
    if (flowColumnSplit(spec) !== null) {
      variants.push({ flow: { columns: 2 } }, { flow: { columns: 2, processWrap: 400 } }, { flow: { columns: 2, processWrap: 400, gap: 90 } });
    }
    return variants;
  }
  return [];
}

function legibilityTier(figure: RenderedFigure): number {
  if (figure.fontMm >= COMFORT_FONT_MM) return 2;
  return figure.fontMm >= MIN_FONT_MM ? 1 : 0;
}

function preferable(candidate: RenderedFigure, current: RenderedFigure): boolean {
  const a = legibilityTier(candidate);
  const b = legibilityTier(current);
  if (a !== b) return a > b;
  if (a < 2 && candidate.fontMm !== current.fontMm) return candidate.fontMm > current.fontMm;
  return candidate.warnings.length < current.warnings.length;
}

/**
 * Lay out and draw one figure. When the default layout only fits the 165 x 245 mm sheet by shrinking the text below
 * COMFORT_FONT_MM, deterministic alternative layouts (stacked rows, narrower boxes, tighter gaps, two flow columns) are
 * tried and the most legible one is kept. Nodes, steps, edges, labels and reference signs are identical in every layout.
 */
export function renderFigure(spec: FigureSpec): RenderedFigure {
  const original = drawFigure(spec, {});
  if (original.fontMm >= COMFORT_FONT_MM) return original;
  let best = original;
  for (const variant of relayoutVariants(spec)) {
    const candidate = drawFigure(spec, variant);
    if (preferable(candidate, best)) best = candidate;
  }
  return best;
}

/** 毫米 → docx 尺寸（docx 按 96 dpi 的像素换算 EMU）。 */
export function mmToDocxPixels(mm: number): number {
  return Math.round((mm / 25.4) * 96);
}

/** 栅格化时的像素尺寸（默认 300 dpi，满足电子申请附图清晰度）。 */
export function rasterSize(figure: RenderedFigure, dpi = 300): { width: number; height: number } {
  return { width: Math.round((figure.widthMm / 25.4) * dpi), height: Math.round((figure.heightMm / 25.4) * dpi) };
}
