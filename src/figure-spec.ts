/**
 * 附图的结构化描述（中间表示）。
 *
 * 模型不直接画图，只在草稿里写结构化的 ```附图 代码块（JSON）；本模块负责解析、规范化和基本校验，
 * figure-render.ts 再按图的类型做确定性排版并输出黑白线条 SVG。
 *
 * 五类图覆盖发明专利最常见的附图：
 * - flow：方法流程图（步骤框、判断框、起止框，带“是/否”分支）；
 * - block：系统框图、硬件连接图、数据流/控制流图（方框 + 箭头 + 附图标记引出线）；
 * - layers：分层剖面图（地层、涂层、叠层结构等按厚度分层，层内可布置传感器、管路等部件）；
 * - structure：结构示意图、局部放大图（矩形、圆、折线等基本图元 + 附图标记引出线）；
 * - chart：曲线图（带箭头的坐标轴、轴名、可选刻度 + 一条或多条数据曲线及特征点），如作物需水曲线、含水率随时间变化曲线。
 */

export type FigureKind = "flow" | "block" | "layers" | "structure" | "chart";

export const FIGURE_KIND_LABEL: Record<FigureKind, string> = {
  flow: "方法流程图",
  block: "系统框图",
  layers: "分层剖面图",
  structure: "结构示意图",
  chart: "曲线图",
};

export type FlowShape = "process" | "decision" | "terminal";

export interface FlowStep {
  id: string;
  text: string;
  shape: FlowShape;
}

export interface FigureEdge {
  from: string;
  to: string;
  /** 判断分支上的“是/否”等必要词语。 */
  label?: string;
  /** 双向箭头（如控制器与执行机构之间的指令/反馈）。 */
  both?: boolean;
}

export interface BlockNode {
  id: string;
  text: string;
  /** 附图标记（阿拉伯数字）。 */
  ref?: string;
}

export interface FigureLayer {
  ref?: string;
  /** 层厚（任意统一单位，按比例绘制）。 */
  thickness: number;
  /** 层厚标注，如“15 cm”；为空则不画尺寸线。 */
  dim?: string;
}

export type LayerItemShape = "probe" | "box" | "pipe";

export interface LayerItem {
  ref: string;
  /** 从地表（顶面）起算的深度，与层厚同一单位；地表以上为负值。 */
  depth: number;
  /** 水平位置，0–1 表示占剖面宽度的比例。 */
  x: number;
  shape: LayerItemShape;
  /** 是否画一根引线连到顶面（传感器线缆、竖管等）。 */
  lead?: boolean;
}

export type StructureShape =
  | { kind: "rect"; x: number; y: number; w: number; h: number; ref?: string; dashed?: boolean }
  | { kind: "circle"; cx: number; cy: number; r: number; ref?: string; dashed?: boolean }
  | { kind: "line"; points: Array<[number, number]>; ref?: string; dashed?: boolean; arrow?: boolean };

/** 曲线图中的一条曲线。 */
export interface ChartSeries {
  /** 数据点 [横坐标, 纵坐标]，按绘制顺序排列。 */
  points: Array<[number, number]>;
  /** 曲线旁的简短名称（多条曲线时区分用），只写必要的词语。 */
  label?: string;
  /** 附图标记（阿拉伯数字）。 */
  ref?: string;
  dashed?: boolean;
  /** 为 false 时画成折线；缺省按单调三次插值画成平滑曲线。 */
  smooth?: false;
  /** 在数据点处画节点（小圆圈）。 */
  markers?: boolean;
}

/** 坐标轴刻度。 */
export interface ChartTick {
  value: number;
  label: string;
}

/** 曲线图上需要标注的特征点（峰值、拐点、阈值点等）。 */
export interface ChartMark {
  x: number;
  y: number;
  label?: string;
  ref?: string;
  /** 是否从该点向横轴、纵轴画虚线引线。 */
  guide?: boolean;
  /** 引线在横轴、纵轴上的符号（如 t_1、θ_fc）。 */
  xText?: string;
  yText?: string;
}

export interface FigureChart {
  /** 横轴名称（可带单位，如“生育期/d”）。 */
  xLabel: string;
  /** 纵轴名称。 */
  yLabel: string;
  series: ChartSeries[];
  marks: ChartMark[];
  xTicks: ChartTick[];
  yTicks: ChartTick[];
}

export interface FigureSpec {
  no: number;
  kind: FigureKind;
  steps: FlowStep[];
  nodes: BlockNode[];
  edges: FigureEdge[];
  layers: FigureLayer[];
  items: LayerItem[];
  shapes: StructureShape[];
  /** 曲线图数据，仅 kind 为 chart 时存在。 */
  chart?: FigureChart;
}

export interface FigureSpecIssue {
  no: number | null;
  message: string;
}

export interface ParsedFigureSpecs {
  specs: FigureSpec[];
  issues: FigureSpecIssue[];
}

/** 草稿里结构化附图块的围栏标识。 */
export const FIGURE_FENCE = /^```\s*(?:附图|patent-figure|figure)\s*$/;

const KINDS: FigureKind[] = ["flow", "block", "layers", "structure", "chart"];
const KIND_ALIASES: Record<string, FigureKind> = {
  flow: "flow",
  flowchart: "flow",
  流程图: "flow",
  方法流程图: "flow",
  block: "block",
  框图: "block",
  系统框图: "block",
  dataflow: "block",
  数据流图: "block",
  控制流图: "block",
  hardware: "block",
  硬件连接图: "block",
  layers: "layers",
  section: "layers",
  剖面图: "layers",
  分层剖面图: "layers",
  structure: "structure",
  结构示意图: "structure",
  detail: "structure",
  局部放大图: "structure",
  chart: "chart",
  curve: "chart",
  graph: "chart",
  plot: "chart",
  linechart: "chart",
  "line-chart": "chart",
  line_chart: "chart",
  曲线图: "chart",
  曲线示意图: "chart",
  折线图: "chart",
  趋势图: "chart",
  变化曲线图: "chart",
  关系曲线图: "chart",
};

const REF_PATTERN = /^\d{1,4}[a-z]?$/;

/**
 * 图名表明是“一个量随另一个量变化”的曲线图（附图核查与补绘提示共用，优先于“示意图”规则）。
 * “弯曲线”“曲线形”“曲线导轨”一类描述形状或部件的写法不算。
 */
export const CHART_CAPTION = /(?<!弯)曲线(?![形型状导轨管槽段])|趋势图|折线图|波形图|变化图|特性图|随.{1,12}变化/;

function asText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : typeof value === "number" ? String(value) : "";
}

function asNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function asRef(value: unknown): string | undefined {
  const text = asText(value);
  return text ? text : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** 去掉标签里的 LaTeX 外壳：$K_s$ → K_s，\theta → θ 之类的常见符号。 */
export function plainLabel(text: string): string {
  const greek: Record<string, string> = {
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", Delta: "Δ", theta: "θ", lambda: "λ", mu: "μ",
    sigma: "σ", Sigma: "Σ", tau: "τ", phi: "φ", omega: "ω", eta: "η", rho: "ρ", varepsilon: "ε", epsilon: "ε",
  };
  return text
    .replace(/\$/g, "")
    .replace(/\\(?:mathrm|text|operatorname)\{([^{}]*)\}/g, "$1")
    .replace(/\\([A-Za-z]+)/g, (whole, name: string) => greek[name] ?? (name === "le" || name === "leq" ? "≤" : name === "ge" || name === "geq" ? "≥" : name === "times" ? "×" : whole.slice(1)))
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSteps(raw: unknown, no: number, issues: FigureSpecIssue[]): FlowStep[] {
  const steps: FlowStep[] = [];
  asArray(raw).forEach((entry, index) => {
    const item = record(entry);
    const text = plainLabel(item ? asText(item.text ?? item.label) : asText(entry));
    if (!text) {
      issues.push({ no, message: `图${no}第${index + 1}个步骤没有文字。` });
      return;
    }
    const shapeText = item ? asText(item.shape ?? item.type) : "";
    const shape: FlowShape = /decision|判断|菱形/.test(shapeText) ? "decision" : /terminal|start|end|开始|结束/.test(shapeText) ? "terminal" : "process";
    const id = (item && asText(item.id)) || stepIdFromText(text) || `n${index + 1}`;
    steps.push({ id, text, shape });
  });
  return steps;
}

function stepIdFromText(text: string): string {
  const match = /^(S\d{1,3}[a-z]?)/i.exec(text);
  return match ? match[1].toUpperCase() : "";
}

function parseEdges(raw: unknown, no: number, issues: FigureSpecIssue[]): FigureEdge[] {
  const edges: FigureEdge[] = [];
  asArray(raw).forEach((entry, index) => {
    if (Array.isArray(entry) && entry.length >= 2) {
      edges.push({ from: asText(entry[0]), to: asText(entry[1]), ...(entry[2] ? { label: plainLabel(asText(entry[2])) } : {}) });
      return;
    }
    const item = record(entry);
    const from = item ? asText(item.from) : "";
    const to = item ? asText(item.to) : "";
    if (!from || !to) {
      issues.push({ no, message: `图${no}第${index + 1}条连线缺少起点或终点。` });
      return;
    }
    const label = item ? plainLabel(asText(item.label)) : "";
    edges.push({ from, to, ...(label ? { label } : {}), ...(item && item.both === true ? { both: true } : {}) });
  });
  return edges;
}

function parseNodes(raw: unknown, no: number, issues: FigureSpecIssue[]): BlockNode[] {
  const nodes: BlockNode[] = [];
  asArray(raw).forEach((entry, index) => {
    const item = record(entry);
    const text = plainLabel(item ? asText(item.text ?? item.label ?? item.name) : asText(entry));
    if (!text) {
      issues.push({ no, message: `图${no}第${index + 1}个方框没有文字。` });
      return;
    }
    const ref = item ? asRef(item.ref) : undefined;
    const id = (item && asText(item.id)) || ref || `n${index + 1}`;
    nodes.push({ id, text, ...(ref ? { ref } : {}) });
  });
  return nodes;
}

function parseLayers(raw: unknown, no: number, issues: FigureSpecIssue[]): FigureLayer[] {
  const layers: FigureLayer[] = [];
  asArray(raw).forEach((entry, index) => {
    const item = record(entry);
    const thickness = item ? asNumber(item.thickness ?? item.h) : null;
    if (thickness === null || thickness <= 0) {
      issues.push({ no, message: `图${no}第${index + 1}层的厚度不是正数。` });
      return;
    }
    const ref = item ? asRef(item.ref) : undefined;
    const dim = item ? plainLabel(asText(item.dim)) : "";
    layers.push({ thickness, ...(ref ? { ref } : {}), ...(dim ? { dim } : {}) });
  });
  return layers;
}

function parseItems(raw: unknown, no: number, issues: FigureSpecIssue[]): LayerItem[] {
  const items: LayerItem[] = [];
  asArray(raw).forEach((entry, index) => {
    const item = record(entry);
    const ref = item ? asRef(item.ref) : undefined;
    const depth = item ? asNumber(item.depth) : null;
    const x = item ? asNumber(item.x) : null;
    if (!ref || depth === null || x === null) {
      issues.push({ no, message: `图${no}第${index + 1}个部件缺少附图标记、深度或水平位置。` });
      return;
    }
    const shapeText = asText(item?.shape);
    const shape: LayerItemShape = shapeText === "box" ? "box" : shapeText === "pipe" ? "pipe" : "probe";
    items.push({ ref, depth, x: Math.min(1, Math.max(0, x)), shape, ...(item?.lead === true ? { lead: true } : {}) });
  });
  return items;
}

function point(value: unknown): [number, number] | null {
  if (Array.isArray(value) && value.length >= 2) {
    const x = asNumber(value[0]);
    const y = asNumber(value[1]);
    return x === null || y === null ? null : [x, y];
  }
  const item = record(value);
  if (!item) return null;
  const x = asNumber(item.x);
  const y = asNumber(item.y);
  return x === null || y === null ? null : [x, y];
}

function parseShapes(raw: unknown, no: number, issues: FigureSpecIssue[]): StructureShape[] {
  const shapes: StructureShape[] = [];
  asArray(raw).forEach((entry, index) => {
    const item = record(entry);
    if (!item) return;
    const kind = asText(item.kind ?? item.type);
    const ref = asRef(item.ref);
    const dashed = item.dashed === true;
    const extra = { ...(ref ? { ref } : {}), ...(dashed ? { dashed } : {}) };
    if (kind === "rect") {
      const [x, y, w, h] = [asNumber(item.x), asNumber(item.y), asNumber(item.w), asNumber(item.h)];
      if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) {
        issues.push({ no, message: `图${no}第${index + 1}个矩形的位置或尺寸无效。` });
        return;
      }
      shapes.push({ kind: "rect", x, y, w, h, ...extra });
    } else if (kind === "circle") {
      const [cx, cy, r] = [asNumber(item.cx), asNumber(item.cy), asNumber(item.r)];
      if (cx === null || cy === null || r === null || r <= 0) {
        issues.push({ no, message: `图${no}第${index + 1}个圆的位置或半径无效。` });
        return;
      }
      shapes.push({ kind: "circle", cx, cy, r, ...extra });
    } else if (kind === "line" || kind === "polyline") {
      const points = asArray(item.points).map(point).filter((value): value is [number, number] => value !== null);
      if (points.length < 2) {
        issues.push({ no, message: `图${no}第${index + 1}条折线少于两个点。` });
        return;
      }
      shapes.push({ kind: "line", points, ...extra, ...(item.arrow === true ? { arrow: true } : {}) });
    } else {
      issues.push({ no, message: `图${no}第${index + 1}个图元类型“${kind || "空"}”不支持，只支持 rect、circle、line。` });
    }
  });
  return shapes;
}

/** 坐标轴原始数据：axes 可以是 [横轴, 纵轴] 数组，也可以是 {x, y} 对象。 */
function axisRaw(item: Record<string, unknown>, axis: "x" | "y"): unknown {
  const axes = item.axes;
  if (Array.isArray(axes)) return axes[axis === "x" ? 0 : 1];
  return record(axes)?.[axis];
}

/** 文字，或 {label/name/title/text} 对象中的文字。 */
function labelText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return asText(value);
  const item = record(value);
  return item ? asText(item.label ?? item.name ?? item.title ?? item.text) : "";
}

function axisLabel(item: Record<string, unknown>, axis: "x" | "y"): string {
  const candidates = [item[`${axis}Label`], item[`${axis}_label`], item[`${axis}label`], item[`${axis}Axis`], item[`${axis}_axis`], axisRaw(item, axis)];
  for (const candidate of candidates) {
    const text = labelText(candidate);
    if (text) return text;
  }
  return "";
}

function formatTick(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function tickOf(entry: unknown): { value: number | null; text: string } {
  if (Array.isArray(entry)) return { value: asNumber(entry[0]), text: asText(entry[1]) };
  const item = record(entry);
  if (item) return { value: asNumber(item.value ?? item.at ?? item.v), text: asText(item.label ?? item.text) };
  return { value: asNumber(entry), text: "" };
}

function parseTicks(raw: unknown, axisName: string, no: number, issues: FigureSpecIssue[]): ChartTick[] {
  const ticks: ChartTick[] = [];
  asArray(raw).forEach((entry, index) => {
    const { value, text } = tickOf(entry);
    if (value === null) {
      issues.push({ no, message: `图${no}${axisName}第${index + 1}个刻度不是数值。` });
      return;
    }
    if (ticks.some((tick) => tick.value === value)) return;
    ticks.push({ value, label: text || formatTick(value) });
  });
  return ticks.sort((a, b) => a.value - b.value);
}

function parsePointList(raw: unknown): Array<[number, number]> {
  return asArray(raw).map(point).filter((value): value is [number, number] => value !== null);
}

function parseSeries(item: Record<string, unknown>, no: number, issues: FigureSpecIssue[]): ChartSeries[] {
  const listed = item.series ?? item.curves ?? item.lines;
  let entries: unknown[];
  if (Array.isArray(listed) && listed.length >= 2 && listed.every((entry) => point(entry) !== null)) entries = [{ points: listed }];
  else if (Array.isArray(listed)) entries = listed;
  else if (record(listed)) entries = [listed];
  else if (item.points !== undefined || item.data !== undefined) {
    entries = [{ points: item.points ?? item.data, smooth: item.smooth, dashed: item.dashed, markers: item.markers ?? item.nodes }];
  } else entries = [];
  const series: ChartSeries[] = [];
  entries.forEach((entry, index) => {
    const row = Array.isArray(entry) ? ({ points: entry } as Record<string, unknown>) : record(entry);
    if (!row) return;
    const rawPoints = row.points ?? row.data ?? row.values;
    const points = parsePointList(rawPoints);
    const total = asArray(rawPoints).length;
    if (points.length < 2) {
      issues.push({ no, message: `图${no}第${index + 1}条曲线少于两个有效数据点。` });
      return;
    }
    if (points.length < total) issues.push({ no, message: `图${no}第${index + 1}条曲线有 ${total - points.length} 个数据点无效，已略去。` });
    const label = asText(row.label ?? row.name ?? row.text);
    const ref = asRef(row.ref);
    const polyline = row.smooth === false || row.type === "line" || row.shape === "line";
    const markers = row.markers === true || row.nodes === true || row.dots === true;
    series.push({
      points,
      ...(label ? { label } : {}),
      ...(ref ? { ref } : {}),
      ...(row.dashed === true ? { dashed: true } : {}),
      ...(polyline ? { smooth: false as const } : {}),
      ...(markers ? { markers: true } : {}),
    });
  });
  return series;
}

function parseMarks(raw: unknown, no: number, issues: FigureSpecIssue[]): ChartMark[] {
  const marks: ChartMark[] = [];
  asArray(raw).forEach((entry, index) => {
    const item = record(entry);
    const at = item ? point(item.at ?? item.point ?? item) : point(entry);
    if (!at) {
      issues.push({ no, message: `图${no}第${index + 1}个特征点缺少有效坐标 x、y。` });
      return;
    }
    const label = item ? asText(item.label ?? item.text ?? item.name) : "";
    const ref = item ? asRef(item.ref) : undefined;
    const xText = item ? asText(item.xText ?? item.x_text) : "";
    const yText = item ? asText(item.yText ?? item.y_text) : "";
    const guide = item?.guide === true || !!xText || !!yText;
    marks.push({
      x: at[0],
      y: at[1],
      ...(label ? { label } : {}),
      ...(ref ? { ref } : {}),
      ...(guide ? { guide: true } : {}),
      ...(xText ? { xText } : {}),
      ...(yText ? { yText } : {}),
    });
  });
  return marks;
}

function parseChart(item: Record<string, unknown>, no: number, issues: FigureSpecIssue[]): FigureChart {
  return {
    xLabel: axisLabel(item, "x"),
    yLabel: axisLabel(item, "y"),
    series: parseSeries(item, no, issues),
    marks: parseMarks(item.marks ?? item.annotations ?? item.keyPoints ?? item.key_points, no, issues),
    xTicks: parseTicks(item.xTicks ?? item.x_ticks ?? record(axisRaw(item, "x"))?.ticks, "横轴", no, issues),
    yTicks: parseTicks(item.yTicks ?? item.y_ticks ?? record(axisRaw(item, "y"))?.ticks, "纵轴", no, issues),
  };
}

/** 规范化一个 JSON 对象为 FigureSpec；无法识别时返回 null 并记录原因。 */
export function normalizeFigureSpec(raw: unknown, issues: FigureSpecIssue[]): FigureSpec | null {
  const item = record(raw);
  if (!item) {
    issues.push({ no: null, message: "附图数据不是 JSON 对象。" });
    return null;
  }
  const no = asNumber(item.no ?? item.figure ?? item.figureNumber);
  if (no === null || !Number.isInteger(no) || no < 1) {
    issues.push({ no: null, message: "附图数据缺少有效图号 no。" });
    return null;
  }
  const kindText = asText(item.kind ?? item.type);
  const kind = KIND_ALIASES[kindText] ?? figureKindKey(kindText) ?? (KINDS.includes(kindText as FigureKind) ? (kindText as FigureKind) : null);
  if (!kind) {
    issues.push({ no, message: `图${no}的类型“${kindText || "空"}”无法识别，应为 flow、block、layers、structure 或 chart。` });
    return null;
  }
  const spec: FigureSpec = {
    no,
    kind,
    steps: kind === "flow" ? parseSteps(item.steps ?? item.nodes, no, issues) : [],
    nodes: kind === "block" ? parseNodes(item.nodes, no, issues) : [],
    edges: kind === "flow" || kind === "block" ? parseEdges(item.edges, no, issues) : [],
    layers: kind === "layers" ? parseLayers(item.layers, no, issues) : [],
    items: kind === "layers" ? parseItems(item.items, no, issues) : [],
    shapes: kind === "structure" ? parseShapes(item.shapes, no, issues) : [],
    ...(kind === "chart" ? { chart: parseChart(item, no, issues) } : {}),
  };
  validateSpec(spec, issues);
  return spec;
}

function validateSpec(spec: FigureSpec, issues: FigureSpecIssue[]): void {
  const { no } = spec;
  if (spec.kind === "flow") {
    if (spec.steps.length < 2) issues.push({ no, message: `图${no}流程图少于两个步骤。` });
    const ids = new Set(spec.steps.map((step) => step.id));
    if (ids.size !== spec.steps.length) issues.push({ no, message: `图${no}流程图有重复的步骤编号。` });
    for (const edge of spec.edges) {
      if (!ids.has(edge.from) || !ids.has(edge.to)) issues.push({ no, message: `图${no}连线 ${edge.from}→${edge.to} 指向不存在的步骤。` });
    }
    for (const step of spec.steps.filter((entry) => entry.shape === "decision")) {
      const out = spec.edges.filter((edge) => edge.from === step.id);
      if (out.length && out.length < 2) issues.push({ no, message: `图${no}判断框“${step.text}”只有一个出口，应有“是/否”两个分支。` });
    }
  }
  if (spec.kind === "block") {
    if (!spec.nodes.length) issues.push({ no, message: `图${no}框图没有方框。` });
    const ids = new Set(spec.nodes.map((node) => node.id));
    if (ids.size !== spec.nodes.length) issues.push({ no, message: `图${no}框图有重复的方框编号。` });
    for (const edge of spec.edges) {
      if (!ids.has(edge.from) || !ids.has(edge.to)) issues.push({ no, message: `图${no}连线 ${edge.from}→${edge.to} 指向不存在的方框。` });
    }
  }
  if (spec.kind === "layers" && !spec.layers.length) issues.push({ no, message: `图${no}剖面图没有分层。` });
  if (spec.kind === "structure" && !spec.shapes.length) issues.push({ no, message: `图${no}结构图没有图元。` });
  if (spec.kind === "chart") {
    const chart = spec.chart;
    if (!chart || !chart.series.length) issues.push({ no, message: `图${no}曲线图没有有效曲线（series 至少一条、每条至少两个数据点）。` });
    const missingAxis = [!chart?.xLabel ? "横轴" : "", !chart?.yLabel ? "纵轴" : ""].filter(Boolean);
    if (missingAxis.length) issues.push({ no, message: `图${no}曲线图缺少${missingAxis.join("和")}名称（xLabel、yLabel）。` });
    if (chart && chart.series.length > 6) issues.push({ no, message: `图${no}曲线图有 ${chart.series.length} 条曲线，超过 6 条，应拆成两幅图。` });
    if (chart && chart.series.length > 1) {
      const unnamed = chart.series.filter((series) => !series.label && !series.ref).length;
      if (unnamed) issues.push({ no, message: `图${no}曲线图有多条曲线，其中 ${unnamed} 条没有名称 label 或附图标记 ref，无法区分。` });
    }
  }
  for (const ref of figureSpecRefs(spec)) {
    if (!REF_PATTERN.test(ref)) issues.push({ no, message: `图${no}的附图标记“${ref}”不是阿拉伯数字。` });
  }
}

/** 一幅图里出现的全部附图标记（去重，保持出现顺序）。 */
export function figureSpecRefs(spec: FigureSpec): string[] {
  const refs: string[] = [];
  const push = (ref: string | undefined) => {
    if (ref && !refs.includes(ref)) refs.push(ref);
  };
  spec.nodes.forEach((node) => push(node.ref));
  spec.layers.forEach((layer) => push(layer.ref));
  spec.items.forEach((item) => push(item.ref));
  spec.shapes.forEach((shape) => push(shape.ref));
  spec.chart?.series.forEach((series) => push(series.ref));
  spec.chart?.marks.forEach((mark) => push(mark.ref));
  return refs;
}

/** 模型有时把附图块的围栏误写成 ```json；内容确为附图数据时同样按附图处理。 */
const JSON_FENCE = /^```\s*json\s*$/i;
const CLOSE_FENCE = /^```\s*$/;

function figureKindKey(value: unknown): FigureKind | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  for (const candidate of [key, key.toLowerCase()]) {
    if (Object.prototype.hasOwnProperty.call(KIND_ALIASES, candidate)) return KIND_ALIASES[candidate];
  }
  return null;
}

/**
 * 一段 JSON 文本是否是附图数据：对象或非空对象数组，每个对象都有图号 no（数字，或含数字的字符串）和可识别的 kind。
 * 用于区分误标成 ```json 的附图块和草稿末尾供程序读取的 json 尾块。
 */
export function looksLikeFigureJson(block: string): boolean {
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch {
    return false;
  }
  const entries = Array.isArray(raw) ? raw : [raw];
  if (!entries.length) return false;
  return entries.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const row = entry as Record<string, unknown>;
    const no = row.no;
    const numbered = (typeof no === "number" && Number.isFinite(no)) || (typeof no === "string" && /\d/.test(no));
    return numbered && figureKindKey(row.kind) !== null;
  });
}

/** 成稿提示词要求的尾部元数据字段。 */
const DRAFT_TAIL_KEYS = ["distinguishing", "pending", "closestArt"];

/** 内容是否为成稿供程序读取的元数据对象（distinguishing / pending / closestArt），而不是附图数据或其他示例。 */
export function isDraftTailJson(block: string): boolean {
  let raw: unknown;
  try {
    raw = JSON.parse(block.trim());
  } catch {
    return false;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const row = raw as Record<string, unknown>;
  if (!DRAFT_TAIL_KEYS.some((key) => Object.prototype.hasOwnProperty.call(row, key))) return false;
  return !looksLikeFigureJson(block);
}

/**
 * 提示词回显：模型把“最后另起一个 json 代码块，给出：”一类撰写要求原样写进了正文。
 * 申请文件正文不会出现“json”与“代码块”紧邻的写法，只在短行中识别，避免误删正常段落。
 */
const PROMPT_ECHO = /json.{0,12}代码块|代码块.{0,12}json|程序读取的尾块/i;
const PROMPT_ECHO_MAX = 200;

/**
 * 去掉正文任意位置残留的尾部元数据：内容确为元数据的 ```json 块（只删该块本身）、不加围栏单独成行的元数据对象、
 * 提示词回显行。其他代码块（附图、普通示例）整块原样保留，块内文字不参与判断；没有可删内容时原样返回。
 */
function stripTailLeftovers(text: string): string {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let changed = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      let close = -1;
      for (let at = index + 1; at < lines.length; at += 1) {
        const inner = lines[at].trim();
        if (inner.startsWith("```")) {
          close = /^```\s*$/.test(inner) ? at : -1;
          break;
        }
      }
      if (close === -1) {
        kept.push(line);
        continue;
      }
      if (/^```json\s*$/i.test(trimmed) && isDraftTailJson(lines.slice(index + 1, close).join("\n"))) {
        changed = true;
      } else {
        kept.push(...lines.slice(index, close + 1));
      }
      index = close;
      continue;
    }
    if ((trimmed.length <= PROMPT_ECHO_MAX && PROMPT_ECHO.test(trimmed)) || (trimmed.startsWith("{") && isDraftTailJson(trimmed))) {
      changed = true;
      continue;
    }
    kept.push(line);
  }
  if (!changed) return text;
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * 去掉草稿中供程序读取的尾部元数据，得到可以进入正式申请文件的正文：
 * 1. 紧贴文末的最后一个 ```json 块（匹配不跨越任何其他围栏，内容是附图数据时不动）；
 * 2. 正文中间内容确为 distinguishing / pending / closestArt 元数据的 ```json 块、不加围栏的元数据行，以及“最后另起一个 json 代码块”一类提示词回显行。
 * 正文中间的其他 ```json 块（误标的附图、示例）及其后的正文一律保留。
 */
export function stripDraftJsonTail(text: string): string {
  const match = /```json((?:(?!```)[\s\S])*)```\s*$/i.exec(text);
  const head = match && !looksLikeFigureJson(match[1]) ? text.slice(0, match.index) : text;
  return stripTailLeftovers(head);
}

/** 附图对象里写明的图号：no / figure / figureNumber / 图号，接受数字或“图3”之类含数字的字符串。 */
function explicitFigureNo(item: Record<string, unknown>): number | null {
  const value = item.no ?? item.figure ?? item.figureNumber ?? item["图号"];
  if (typeof value === "string") {
    const match = /\d{1,3}/.exec(value);
    return match ? Number(match[0]) : null;
  }
  const parsed = asNumber(value);
  return parsed !== null && Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

/** 附图说明里“图N为……”的图题，用于核对推定图号时图的类型。 */
export function figureCaptions(markdown: string): Map<number, string> {
  const captions = new Map<number, string>();
  for (const match of markdown.matchAll(/^\s*(?:[-*]\s*)?图\s*(\d{1,3})\s*(?:为|是|[:：])\s*(.+)$/gm)) {
    const no = Number(match[1]);
    if (!captions.has(no)) captions.set(no, match[2].trim());
  }
  return captions;
}

/** 图的类型与图题是否相容：流程图只配“流程/步骤”图题，其他类型不配流程图题。 */
function captionFits(kind: FigureKind | null, caption: string | undefined): boolean {
  if (!kind || caption === undefined) return true;
  const flowish = /流程|步骤/.test(caption);
  return kind === "flow" ? flowish : !flowish;
}

export interface FigureNumberingOptions {
  /** 每个附图对象在草稿中的位置序号（解析失败的代码块也占一个序号），缺省为数组下标 + 1。 */
  ordinals?: number[];
  /** 图号 → 图题。 */
  captions?: Map<number, string>;
}

/**
 * 模型常把附图代码块的图号 no 漏掉（代码块紧跟在“图1为……图2为……”之后，顺序即图号）。
 * 写了图号的保持不变；没写的按代码块在草稿中的位置推定，并用图题核对类型：位置对应的图号已被占用或图题类型不符时，
 * 取距离最近、未被占用且图题相容的图号；每次推定都记一条核对提示。
 */
export function assignMissingFigureNumbers(entries: unknown[], issues: FigureSpecIssue[], options: FigureNumberingOptions = {}): unknown[] {
  const captions = options.captions ?? new Map<number, string>();
  const used = new Set<number>();
  for (const entry of entries) {
    const item = record(entry);
    const no = item ? explicitFigureNo(item) : null;
    if (no !== null) used.add(no);
  }
  return entries.map((entry, index) => {
    const item = record(entry);
    if (!item) return entry;
    const no = explicitFigureNo(item);
    if (no !== null) return item.no === no ? entry : { ...item, no };
    const ordinal = options.ordinals?.[index] ?? index + 1;
    const kind = figureKindKey(item.kind ?? item.type);
    const fits = (candidate: number) => captionFits(kind, captions.get(candidate));
    let guess: number | null = null;
    if (!used.has(ordinal) && fits(ordinal)) {
      guess = ordinal;
    } else {
      const pool = [...captions.keys()]
        .filter((candidate) => !used.has(candidate) && fits(candidate))
        .sort((a, b) => Math.abs(a - ordinal) - Math.abs(b - ordinal) || a - b);
      guess = pool[0] ?? (used.has(ordinal) ? null : ordinal);
      if (guess === null) {
        guess = 1;
        while (used.has(guess)) guess += 1;
      }
    }
    used.add(guess);
    issues.push({ no: guess, message: `第${ordinal}个附图代码块没有写图号 no，已按代码块位置和图题推定为图${guess}，请核对与附图说明是否一致。` });
    return { ...item, no: guess };
  });
}

/** JSON.parse 报错里的字符位置（“at position N”或“line L column C”）。 */
function jsonErrorPosition(error: unknown, text: string): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const position = /position\s+(\d+)/.exec(message);
  if (position) return Number(position[1]);
  const lineColumn = /line\s+(\d+)\s+column\s+(\d+)/.exec(message);
  if (!lineColumn) return null;
  const lines = text.split("\n");
  const line = Number(lineColumn[1]) - 1;
  if (line < 0 || line >= lines.length) return null;
  return lines.slice(0, line).reduce((sum, item) => sum + item.length + 1, 0) + Number(lineColumn[2]) - 1;
}

/** 出错位置所在的最内层数组元素对象 {…} 的起止（包含其后的逗号）；不在数组元素里时返回 null。 */
function enclosingArrayElement(text: string, position: number): [number, number] | null {
  const stack: Array<{ char: string; at: number }> = [];
  let inString = false;
  for (let at = 0; at < Math.min(position, text.length); at += 1) {
    const char = text[at];
    if (inString) {
      if (char === "\\") at += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") stack.push({ char, at });
    else if ((char === "}" || char === "]") && stack.length) stack.pop();
  }
  for (let depth = stack.length - 1; depth >= 1; depth -= 1) {
    if (stack[depth].char !== "{" || stack[depth - 1].char !== "[") continue;
    const start = stack[depth].at;
    let level = 0;
    inString = false;
    for (let at = start; at < text.length; at += 1) {
      const char = text[at];
      if (inString) {
        if (char === "\\") at += 1;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") level += 1;
      else if (char === "}") {
        level -= 1;
        if (level === 0) {
          let end = at + 1;
          const tail = /^\s*,/.exec(text.slice(end));
          if (tail) end += tail[0].length;
          return [start, end];
        }
      } else if (char === "\n" && level === 1 && at > position) {
        // 元素没有闭合：删到出错行末
        return [start, at];
      }
    }
    return null;
  }
  return null;
}

/**
 * 附图数据的宽松解析。先按标准 JSON；失败时修正模型常见笔误（中文引号、尾逗号、"cx": "170, cy": 130 这类引号错位），
 * 仍失败则按报错位置逐个删去出错的数组元素（一个图元、一个步骤），其余内容照常绘制；都不行时抛出原始错误。
 */
export function parseFigureJson(block: string, issues: FigureSpecIssue[]): unknown {
  let firstError: unknown;
  try {
    return JSON.parse(block);
  } catch (error) {
    firstError = error;
  }
  let text = block
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/"([A-Za-z_]\w*)"\s*:\s*"(-?\d+(?:\.\d+)?)\s*,\s*([A-Za-z_]\w*)"\s*:/g, '"$1": $2, "$3":')
    .replace(/,(\s*[}\]])/g, "$1");
  let dropped = 0;
  for (let attempt = 0; attempt <= 30; attempt += 1) {
    try {
      const value = JSON.parse(text);
      issues.push({
        no: null,
        message: dropped
          ? `附图代码块有 ${dropped} 个图元或步骤无法解析，已跳过，其余内容照常绘制。`
          : "附图代码块有格式笔误（引号错位、尾逗号等），已自动修正后绘制。",
      });
      return value;
    } catch (error) {
      const position = jsonErrorPosition(error, text);
      const cut = position === null ? null : enclosingArrayElement(text, position);
      if (!cut) break;
      text = (text.slice(0, cut[0]) + text.slice(cut[1])).replace(/,(\s*[}\]])/g, "$1");
      dropped += 1;
    }
  }
  throw firstError;
}

/** 从 Markdown 里取出全部 ```附图 代码块（以及内容确为附图数据的 ```json 块），返回解析结果和去掉代码块后的正文。 */
export function extractFigureSpecs(markdown: string): ParsedFigureSpecs & { text: string } {
  const lines = markdown.split(/\r?\n/);
  const kept: string[] = [];
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (current) {
      if (CLOSE_FENCE.test(line.trim())) {
        blocks.push(current.join("\n"));
        current = null;
      } else {
        current.push(line);
      }
      continue;
    }
    const fence = line.trim();
    if (FIGURE_FENCE.test(fence)) {
      current = [];
      continue;
    }
    if (JSON_FENCE.test(fence)) {
      // 误标成 ```json 的附图块：整块闭合且内容是附图数据才收下，其他 json 块（如末尾元数据）原样保留。
      let close = -1;
      for (let at = index + 1; at < lines.length; at += 1) {
        const inner = lines[at].trim();
        if (inner.startsWith("```")) {
          close = CLOSE_FENCE.test(inner) ? at : -1;
          break;
        }
      }
      if (close !== -1) {
        const body = lines.slice(index + 1, close).join("\n");
        if (looksLikeFigureJson(body)) {
          blocks.push(body);
          index = close;
          continue;
        }
      }
    }
    kept.push(line);
  }
  const issues: FigureSpecIssue[] = [];
  if (current) {
    blocks.push(current.join("\n"));
    issues.push({ no: null, message: "附图代码块没有闭合的 ```。" });
  }
  const entries: unknown[] = [];
  const ordinals: number[] = [];
  let ordinal = 0;
  for (const block of blocks) {
    let raw: unknown;
    try {
      raw = parseFigureJson(block, issues);
    } catch (error) {
      ordinal += 1;
      issues.push({ no: null, message: `附图代码块不是合法 JSON：${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    for (const entry of Array.isArray(raw) ? raw : [raw]) {
      ordinal += 1;
      entries.push(entry);
      ordinals.push(ordinal);
    }
  }
  const specs: FigureSpec[] = [];
  for (const entry of assignMissingFigureNumbers(entries, issues, { ordinals, captions: figureCaptions(markdown) })) {
    const spec = normalizeFigureSpec(entry, issues);
    if (!spec) continue;
    const existing = specs.findIndex((item) => item.no === spec.no);
    if (existing >= 0) {
      issues.push({ no: spec.no, message: `图${spec.no}有两份附图数据，采用后一份。` });
      specs[existing] = spec;
    } else {
      specs.push(spec);
    }
  }
  specs.sort((a, b) => a.no - b.no);
  return { specs, issues, text: kept.join("\n") };
}

/** 把 FigureSpec 写回草稿用的代码块（章节修改、模型补图后保存时使用）。 */
export function figureSpecBlock(spec: FigureSpec): string {
  const body: Record<string, unknown> = { no: spec.no, kind: spec.kind };
  if (spec.kind === "flow") {
    body.steps = spec.steps.map((step) => ({ id: step.id, text: step.text, ...(step.shape === "process" ? {} : { shape: step.shape }) }));
    if (spec.edges.length) body.edges = spec.edges;
  }
  if (spec.kind === "block") {
    body.nodes = spec.nodes;
    body.edges = spec.edges;
  }
  if (spec.kind === "layers") {
    body.layers = spec.layers;
    body.items = spec.items;
  }
  if (spec.kind === "structure") body.shapes = spec.shapes;
  if (spec.kind === "chart" && spec.chart) {
    const { xLabel, yLabel, series, marks, xTicks, yTicks } = spec.chart;
    body.xLabel = xLabel;
    body.yLabel = yLabel;
    body.series = series;
    if (marks.length) body.marks = marks;
    if (xTicks.length) body.xTicks = xTicks;
    if (yTicks.length) body.yTicks = yTicks;
  }
  return ["```附图", JSON.stringify(body), "```"].join("\n");
}
