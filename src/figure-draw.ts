/**
 * 附图绘制底层：字宽估算、换行、下标、SVG 图元收集、附图标记引出线的排布与避让。
 * 坐标单位为 0.1 mm。figure-render.ts 在此之上按图的类型做排版。
 */
/** 0.1 mm 为 1 个单位。 */
export const UNIT_PER_MM = 10;
export const MAX_WIDTH_MM = 165;
export const MAX_HEIGHT_MM = 245;
export const FONT = 35; // 3.5 mm 字高
export const LINE_H = 50;
export const STROKE = 3; // 0.3 mm
export const PAD_X = 30;
export const PAD_Y = 24;
const ARROW_LEN = 22;
const ARROW_HALF = 8;
export const MARGIN = 40;
export const FONT_FAMILY = "SimSun, 宋体, 'Songti SC', 'Noto Serif CJK SC', serif";

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type Point = [number, number];

export function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (ch === " ") return 0.33;
  if (code >= 0x2e80 || (code >= 0xff00 && code <= 0xffef)) return 1;
  if (/[A-Z]/.test(ch)) return 0.68;
  if (/[a-z0-9]/.test(ch)) return 0.56;
  if (/[α-ωΑ-Ωθ]/.test(ch)) return 0.6;
  return 0.6;
}

export const SUB_SCALE = 0.72;

export interface RichRun {
  text: string;
  sub: boolean;
  /** 上标段：由 ⁻¹、² 之类的 Unicode 上标字符换写而来，按缩小字号上移绘制。 */
  sup?: true;
  /** 由 Unicode 上下标字符换写而来时的原文，供 visibleText 还原。 */
  raw?: string;
}

/**
 * Unicode 上标、下标字符 → 普通字符。宋体等中文字体常常没有 ⁻、⁴ 等字形，栅格化时会留空；
 * 换写成普通字符后按上下标排版，只依赖字体里一定有的数字和 ASCII 符号。
 */
const SUPERSCRIPT = new Map<string, string>([
  ["⁰", "0"], ["¹", "1"], ["²", "2"], ["³", "3"], ["⁴", "4"], ["⁵", "5"], ["⁶", "6"], ["⁷", "7"], ["⁸", "8"], ["⁹", "9"],
  ["⁺", "+"], ["⁻", "-"], ["⁼", "="], ["⁽", "("], ["⁾", ")"], ["ⁿ", "n"], ["ⁱ", "i"],
]);
const SUBSCRIPT = new Map<string, string>([
  ["₀", "0"], ["₁", "1"], ["₂", "2"], ["₃", "3"], ["₄", "4"], ["₅", "5"], ["₆", "6"], ["₇", "7"], ["₈", "8"], ["₉", "9"],
  ["₊", "+"], ["₋", "-"], ["₌", "="], ["₍", "("], ["₎", ")"],
]);

/** 把一段里的 Unicode 上下标字符拆成上标段、下标段；没有这类字符时原样返回。 */
function scriptRuns(run: RichRun): RichRun[] {
  const chars = [...run.text];
  if (!chars.some((ch) => SUPERSCRIPT.has(ch) || SUBSCRIPT.has(ch))) return [run];
  // 已是下标段（R_{₁}）：整段仍按下标画，只换写字符。
  if (run.sub) return [{ text: chars.map((ch) => SUBSCRIPT.get(ch) ?? SUPERSCRIPT.get(ch) ?? ch).join(""), sub: true, raw: run.text }];
  const out: RichRun[] = [];
  let kind: "plain" | "sup" | "sub" = "plain";
  let text = "";
  let raw = "";
  const flush = () => {
    if (!raw) return;
    if (kind === "plain") out.push({ text: raw, sub: false });
    else if (kind === "sup") out.push({ text, sub: false, sup: true, raw });
    else out.push({ text, sub: true, raw });
    text = "";
    raw = "";
  };
  for (const ch of chars) {
    const next = SUPERSCRIPT.has(ch) ? "sup" : SUBSCRIPT.has(ch) ? "sub" : "plain";
    if (next !== kind) {
      flush();
      kind = next;
    }
    raw += ch;
    text += next === "sup" ? (SUPERSCRIPT.get(ch) ?? ch) : next === "sub" ? (SUBSCRIPT.get(ch) ?? ch) : ch;
  }
  flush();
  return out;
}

/** 把 θ_i、R_{i}、ET_0 之类的下标写法拆成正文段和下标段，再把 cm⁻¹、H₂O 里的 Unicode 上下标拆成上标段、下标段。 */
export function richRuns(text: string): RichRun[] {
  const runs: RichRun[] = [];
  const pattern = /_\{([^{}]*)\}|_([A-Za-z0-9]{1,3})/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) runs.push({ text: text.slice(last, index), sub: false });
    runs.push({ text: match[1] ?? match[2] ?? "", sub: true });
    last = index + match[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), sub: false });
  return runs.filter((run) => run.text).flatMap(scriptRuns);
}

/** 去掉下标标记后的可见文字；Unicode 上下标字符保持原样。 */
export function visibleText(text: string): string {
  return richRuns(text).map((run) => run.raw ?? run.text).join("");
}

export function textWidth(text: string, size = FONT): number {
  let total = 0;
  for (const run of richRuns(text)) {
    let width = 0;
    for (const ch of run.text) width += charWidth(ch);
    total += width * (run.sub || run.sup ? SUB_SCALE : 1);
  }
  return total * size;
}

const NO_LINE_START = /^[，。、；：！？）》」』”’%,.;:!?)\]]/;

/** 按宽度换行：中文逐字可断，连续的字母数字（如 ET0、S1、K_s）不拆开，避头点号挂在上一行行尾。 */
export function wrapText(text: string, maxWidth: number, size = FONT): string[] {
  const tokens = text.match(/[A-Za-z0-9_.+\-≤≥=×/%θα-ω·\u00B9\u00B2\u00B3\u2070-\u209F]+|\s+|./gu) ?? [];
  const lines: string[] = [];
  let line = "";
  for (const token of tokens) {
    if (/^\s+$/.test(token)) {
      if (line) line += " ";
      continue;
    }
    const candidate = line + token;
    if (!line || textWidth(candidate, size) <= maxWidth || NO_LINE_START.test(token)) {
      line = candidate;
      continue;
    }
    lines.push(line.trimEnd());
    line = token;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.length ? lines : [""];
}

export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export interface Segment {
  a: Point;
  b: Point;
  owner: number;
}

/** 收集 SVG 元素，跟踪外包框、已画线段和文字区域。 */
export class Canvas {
  readonly parts: string[] = [];
  /** 已画线段（用于引出线避让），owner 为所属图元序号，-1 表示连线或引出线。 */
  readonly segments: Segment[] = [];
  /** 已占用的文字区域。 */
  readonly textBoxes: Box[] = [];
  owner = -1;
  readonly refs: string[] = [];
  readonly texts: string[] = [];
  readonly warnings: string[] = [];
  private box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

  private grow(x: number, y: number): void {
    this.box.minX = Math.min(this.box.minX, x);
    this.box.minY = Math.min(this.box.minY, y);
    this.box.maxX = Math.max(this.box.maxX, x);
    this.box.maxY = Math.max(this.box.maxY, y);
  }

  bounds(): Box {
    return { ...this.box };
  }

  private track(points: Point[], closed = false): void {
    for (let k = 0; k + 1 < points.length; k += 1) this.segments.push({ a: points[k], b: points[k + 1], owner: this.owner });
    if (closed && points.length > 2) this.segments.push({ a: points[points.length - 1], b: points[0], owner: this.owner });
  }

  line(points: Point[], dashed = false): void {
    if (points.length < 2) return;
    points.forEach(([x, y]) => this.grow(x, y));
    this.track(points);
    const dash = dashed ? ` stroke-dasharray="24 14"` : "";
    if (points.length === 2) {
      const [[x1, y1], [x2, y2]] = points;
      this.parts.push(`<line x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}"${dash}/>`);
    } else {
      this.parts.push(`<polyline points="${points.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ")}"${dash}/>`);
    }
  }

  rect(x: number, y: number, w: number, h: number, rx = 0, dashed = false): void {
    this.grow(x, y);
    this.grow(x + w, y + h);
    this.track([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true);
    const round = rx ? ` rx="${fmt(rx)}" ry="${fmt(rx)}"` : "";
    const dash = dashed ? ` stroke-dasharray="24 14"` : "";
    this.parts.push(`<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}"${round}${dash}/>`);
  }

  circle(cx: number, cy: number, r: number, dashed = false): void {
    this.grow(cx - r, cy - r);
    this.grow(cx + r, cy + r);
    this.track(Array.from({ length: 16 }, (_, k): Point => [cx + r * Math.cos((k * Math.PI) / 8), cy + r * Math.sin((k * Math.PI) / 8)]), true);
    const dash = dashed ? ` stroke-dasharray="24 14"` : "";
    this.parts.push(`<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}"${dash}/>`);
  }

  polygon(points: Point[], filled = false): void {
    points.forEach(([x, y]) => this.grow(x, y));
    if (!filled) this.track(points, true);
    const fill = filled ? ` fill="#000"` : "";
    this.parts.push(`<polygon points="${points.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ")}"${fill}/>`);
  }

  /** 实心箭头，尖端在 tip，方向由 from 指向 tip。 */
  arrowHead(from: Point, tip: Point): void {
    const dx = tip[0] - from[0];
    const dy = tip[1] - from[1];
    const length = Math.hypot(dx, dy) || 1;
    const ux = dx / length;
    const uy = dy / length;
    const baseX = tip[0] - ux * ARROW_LEN;
    const baseY = tip[1] - uy * ARROW_LEN;
    this.polygon([tip, [baseX - uy * ARROW_HALF, baseY + ux * ARROW_HALF], [baseX + uy * ARROW_HALF, baseY - ux * ARROW_HALF]], true);
  }

  /** 带箭头的折线；both 为真时两端都画箭头。 */
  arrow(points: Point[], both = false): void {
    this.line(points);
    const n = points.length;
    this.arrowHead(points[n - 2], points[n - 1]);
    if (both) this.arrowHead(points[1], points[0]);
  }

  /** 多行文字：anchor 为 middle 时 (x, top) 是首行的水平中心和顶边。 */
  text(lines: string[], x: number, top: number, anchor: "start" | "middle" | "end" = "middle", size = FONT, record = true): void {
    lines.forEach((content, index) => {
      const width = textWidth(content, size);
      const left = anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x;
      const lineTop = top + index * (size + (LINE_H - FONT));
      this.grow(left, lineTop);
      this.grow(left + width, lineTop + size);
      this.textBoxes.push({ minX: left, minY: lineTop, maxX: left + width, maxY: lineTop + size });
      const baseline = lineTop + size * 0.86;
      const shift = Math.round(size * 0.26);
      const lift = Math.round(size * 0.3);
      let offset = 0;
      const spans = richRuns(content).map((run) => {
        const target = run.sub ? shift : run.sup ? -lift : 0;
        const dy = target - offset;
        offset = target;
        const attrs = `${dy ? ` dy="${dy}"` : ""}${run.sub || run.sup ? ` font-size="${fmt(Math.round(size * SUB_SCALE))}"` : ""}`;
        return attrs ? `<tspan${attrs}>${esc(run.text)}</tspan>` : esc(run.text);
      });
      this.parts.push(`<text x="${fmt(x)}" y="${fmt(baseline)}" text-anchor="${anchor}" font-size="${fmt(size)}">${spans.join("")}</text>`);
    });
    if (record) this.texts.push(visibleText(lines.join("")));
  }

  /** 附图标记：引出线 + 阿拉伯数字。 */
  ref(ref: string, anchor: Point, label: Point, side: "left" | "right"): void {
    const owner = this.owner;
    this.owner = -1;
    this.line([anchor, label]);
    this.owner = owner;
    const gap = 8;
    const top = label[1] - FONT / 2;
    if (side === "right") this.text([ref], label[0] + gap, top, "start", FONT, false);
    else this.text([ref], label[0] - gap, top, "end", FONT, false);
    if (!this.refs.includes(ref)) this.refs.push(ref);
  }
}

export interface LeaderRequest {
  ref: string;
  anchor: Point;
}

/** 在左右页边排附图标记：按锚点纵坐标排序、保持最小间距，避免引出线交叉。 */
export function placeLeaders(canvas: Canvas, requests: LeaderRequest[], side: "left" | "right", labelX: number, minY: number, maxY: number): void {
  if (!requests.length) return;
  const sorted = [...requests].sort((a, b) => a.anchor[1] - b.anchor[1]);
  const spacing = FONT + 22;
  const ys: number[] = [];
  sorted.forEach((request, index) => {
    const wanted = Math.max(request.anchor[1], minY);
    ys.push(index === 0 ? wanted : Math.max(wanted, ys[index - 1] + spacing));
  });
  const overflow = ys[ys.length - 1] - maxY;
  if (overflow > 0) {
    for (let index = ys.length - 1; index >= 0; index -= 1) {
      const limit = index === ys.length - 1 ? maxY : ys[index + 1] - spacing;
      ys[index] = Math.min(ys[index], limit);
    }
  }
  sorted.forEach((request, index) => canvas.ref(request.ref, request.anchor, [labelX, ys[index]], side));
}

export function segmentsCross(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export function segmentHitsBox(a: Point, b: Point, box: Box): boolean {
  const inside = (p: Point) => p[0] >= box.minX && p[0] <= box.maxX && p[1] >= box.minY && p[1] <= box.maxY;
  if (inside(a) || inside(b)) return true;
  const corners: Point[] = [[box.minX, box.minY], [box.maxX, box.minY], [box.maxX, box.maxY], [box.minX, box.maxY]];
  return corners.some((corner, k) => segmentsCross(a, b, corner, corners[(k + 1) % 4]));
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

/**
 * 在连线旁写分支词语。
 *
 * 按“较长的段优先、段中部优先”依次试放：竖段写在右侧或左侧，其余段写在上方或下方。取第一个既不压任何已画线段
 * （部件轮廓、其他连线、引出线）也不压已有文字的位置，四周留 0.8 mm 间隙；第一个候选即旧版位置，无碰撞时结果不变。
 * 找不到无碰撞位置时取碰撞最少者并给出警告。
 */
export function labelOnPath(canvas: Canvas, points: Point[], label: string): void {
  const gap = 14;
  const clearance = 8;
  const width = textWidth(label, FONT);
  const segments = points
    .slice(0, -1)
    .map((a, k) => ({ a, b: points[k + 1], length: Math.hypot(points[k + 1][0] - a[0], points[k + 1][1] - a[1]) }))
    .filter((segment) => segment.length >= 1)
    .sort((p, q) => q.length - p.length);
  const spots: { left: number; top: number }[] = [];
  for (const segment of segments) {
    const vertical = Math.abs(segment.a[0] - segment.b[0]) < 1;
    for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) {
      const x = segment.a[0] + (segment.b[0] - segment.a[0]) * t;
      const y = segment.a[1] + (segment.b[1] - segment.a[1]) * t;
      if (vertical) {
        spots.push({ left: x + gap, top: y - FONT / 2 });
        spots.push({ left: x - gap - width, top: y - FONT / 2 });
      } else {
        spots.push({ left: x - width / 2, top: y - FONT - 10 });
        spots.push({ left: x - width / 2, top: y + 10 });
      }
    }
  }
  if (!spots.length && points.length) spots.push({ left: points[0][0] + gap, top: points[0][1] - FONT / 2 });
  if (!spots.length) return;
  let best = spots[0];
  let bestHits = Infinity;
  for (const spot of spots) {
    const box: Box = {
      minX: spot.left - clearance,
      minY: spot.top - clearance,
      maxX: spot.left + width + clearance,
      maxY: spot.top + FONT + clearance,
    };
    let hits = 0;
    for (const segment of canvas.segments) if (segmentHitsBox(segment.a, segment.b, box)) hits += 1;
    for (const taken of canvas.textBoxes) if (boxesOverlap(taken, box)) hits += 1;
    if (hits < bestHits) {
      bestHits = hits;
      best = spot;
      if (hits === 0) break;
    }
  }
  if (bestHits > 0) canvas.warnings.push(`连线标注“${label}”无法完全避开其他图元。`);
  canvas.text([label], best.left, best.top, "start");
}

export interface OwnedLeader extends LeaderRequest {
  owner: number;
}

/**
 * 就近放置附图标记：在锚点周围按 10 个方向、3 种长度试放，
 * 选引出线和数字既不穿过其他部件、也不压住已有文字和引出线的位置。
 */
export function placeNearLeaders(canvas: Canvas, requests: OwnedLeader[]): void {
  const directions = [-30, 30, -150, 150, -60, 60, -120, 120, 0, 180];
  const lengths = [120, 180, 260];
  for (const request of requests) {
    let bestScore = Infinity;
    let bestEnd: Point = [request.anchor[0] + 120, request.anchor[1] - 60];
    let bestSide: "left" | "right" = "right";
    for (const length of lengths) {
      for (const degrees of directions) {
        const radians = (degrees * Math.PI) / 180;
        const end: Point = [request.anchor[0] + Math.cos(radians) * length, request.anchor[1] + Math.sin(radians) * length];
        const side: "left" | "right" = Math.cos(radians) >= -0.01 ? "right" : "left";
        const width = textWidth(request.ref) + 12;
        const label: Box = side === "right"
          ? { minX: end[0] + 4, minY: end[1] - FONT / 2 - 6, maxX: end[0] + 8 + width, maxY: end[1] + FONT / 2 + 6 }
          : { minX: end[0] - 8 - width, minY: end[1] - FONT / 2 - 6, maxX: end[0] - 4, maxY: end[1] + FONT / 2 + 6 };
        let crossings = 0;
        let labelHits = 0;
        for (const segment of canvas.segments) {
          const own = segment.owner === request.owner && segment.owner >= 0;
          if (!own && segmentsCross(request.anchor, end, segment.a, segment.b)) crossings += 1;
          if (segmentHitsBox(segment.a, segment.b, label)) labelHits += 1;
        }
        for (const box of canvas.textBoxes) {
          if (boxesOverlap(box, label)) labelHits += 2;
          if (segmentHitsBox(request.anchor, end, box)) crossings += 2;
        }
        const score = crossings * 10 + labelHits * 25 + length / 100 + (Math.abs(degrees) === 90 ? 1 : 0);
        if (score < bestScore) {
          bestScore = score;
          bestEnd = end;
          bestSide = side;
        }
      }
    }
    if (bestScore >= 10) canvas.warnings.push(`附图标记 ${request.ref} 的引出线无法完全避开其他部件。`);
    canvas.ref(request.ref, request.anchor, bestEnd, bestSide);
  }
}

