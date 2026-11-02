/**
 * 附图确定性核查。
 *
 * 依据《专利审查指南》第一部分第一章 4.3、专利法实施细则第二十一条：
 * - 附图按“图1、图2……”连续编号，附图说明与实际附图一一对应，并指定摘要附图；
 * - 说明书文字部分中未提及的附图标记不得在附图中出现，附图中未出现的附图标记不得在说明书文字部分中提及；
 *   申请文件中表示同一组成部分的附图标记应当一致；
 * - 附图中除必需的词语外不得含有其他注释，词语使用中文；流程图、框图的框内写必要的文字和符号；
 * - 黑色线条，不着色，缩小到三分之二时仍能清晰分辨。
 */
import type { ChartMark, ChartSeries, FigureChart, FigureSpec, FigureSpecIssue } from "./figure-spec.ts";
import { CHART_CAPTION, FIGURE_KIND_LABEL, figureSpecRefs } from "./figure-spec.ts";
import type { RenderedFigure } from "./figure-render.ts";

export type FigureCheckLevel = "error" | "warn" | "ok";

export interface FigureCheck {
  id: string;
  label: string;
  level: FigureCheckLevel;
  detail: string;
}

export interface FigureAuditInput {
  /** 附图说明里逐幅列出的图号和图名。 */
  figures: Array<{ no: number; caption: string }>;
  abstractFigure: number | null;
  specs: FigureSpec[];
  rendered: RenderedFigure[];
  specIssues: FigureSpecIssue[];
  /** 附图标记列表：标记 → 名称。 */
  referenceList: ReferenceEntry[];
  /** 说明书正文（技术领域至具体实施方式，不含附图标记列表本身）。 */
  descriptionText: string;
  claimsText: string;
}

export interface ReferenceEntry {
  ref: string;
  name: string;
  /** 合写条目（“52、53、54—作物个体”）展开后，同组的全部标记；逐条写的条目没有。 */
  group?: string[];
}

export interface FigureAuditResult {
  checks: FigureCheck[];
  /** 可以导出真实附图的图号。 */
  drawable: number[];
  /** 仍需占位（没有附图数据）的图号。 */
  missing: number[];
  errorCount: number;
  warnCount: number;
}

/**
 * 附图标记列表里的部件名称：允许夹带字母、数字、半角连字符和加号（HLA-DR、CD4+T、RNA-seq、IL-2、第1传感器），
 * 遇到列表分隔符，或遇到下一条“标记+分隔符”（标记前不是字母数字，如“单元 11—”）时结束。
 * 旧写法把数字和连字符一律当作名称结束，生物、软件类部件名会被截断或整条丢弃，导致“列表里没有”的假报。
 */
const REF_NAME = "(?:(?![\\s、]*(?<![A-Za-z0-9.+\\-])\\d{1,4}[a-z]?\\s*(?:[—–\\-－~～:：.．]|\\s))[^；;，,。\\n\\r—–－、:：]){1,40}";
const REF_ENTRY = new RegExp("(?<![A-Za-z0-9.+\\-])(\\d{1,4}[a-z]?)\\s*(?:[—–\\-－~～、:：.．]|\\s)\\s*(" + REF_NAME + ")", "g");

/** 解析“附图标记”列表：“10—土壤墒情监测单元；11—第一传感器”或逐行“10、xxx”。 */
/** 合写的附图标记条目：两个以上标记用“、”或逗号连写，再接破折号或冒号和同一个部件名（“52、53、54—作物个体”）。 */
const REF_GROUP = new RegExp("(?<![A-Za-z0-9.+\\-])(\\d{1,4}[a-z]?(?:\\s*[、,，]\\s*\\d{1,4}[a-z]?)+)(\\s*[—–\\-－~～:：]\\s*" + REF_NAME + ")", "g");

/**
 * 解析附图标记列表。合写条目展开为同名的多个条目（带 group），部件名按“最后一个标记+名称”交给逐条解析器清洗；
 * 其余文字按原顺序交给逐条解析器，逐条写法的结果不变。
 */
export function parseReferenceList(text: string): ReferenceEntry[] {
  const entries: ReferenceEntry[] = [];
  let last = 0;
  for (const match of text.matchAll(REF_GROUP)) {
    const at = match.index ?? 0;
    const refs = match[1].split(/\s*[、,，]\s*/);
    const tail = parseSimpleReferenceList(`${refs[refs.length - 1]}${match[2]}`);
    if (new Set(refs).size !== refs.length || tail.length !== 1 || tail[0].ref !== refs[refs.length - 1]) continue;
    entries.push(...parseSimpleReferenceList(text.slice(last, at)));
    for (const ref of refs) entries.push({ ref, name: tail[0].name, group: refs });
    last = at + match[0].length;
  }
  entries.push(...parseSimpleReferenceList(text.slice(last)));
  return entries;
}

function parseSimpleReferenceList(text: string): ReferenceEntry[] {
  const entries: ReferenceEntry[] = [];
  for (const match of text.matchAll(REF_ENTRY)) {
    const name = match[2].replace(/[\s（）()【】]/g, "").trim();
    if (!name || !/[\u4e00-\u9fa5]/.test(name)) continue;
    entries.push({ ref: match[1], name });
  }
  return entries;
}

/** 从 Markdown 草稿里取“附图标记”小节的正文。 */
export function referenceSection(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{2,4}\s*附图标记/.test(line.trim()) || /^附图标记[:：]?\s*$/.test(line.trim()));
  if (start < 0) {
    const inline = /附图标记[:：]\s*([^\n]+)/.exec(markdown);
    return inline ? inline[1] : "";
  }
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,4}\s/.test(line.trim())) break;
    out.push(line);
  }
  return out.join("\n");
}

const PART_SUFFIX = "(?:器|单元|模块|装置|机构|传感器|探头|阀|泵|管路|管道|管|板|件|座|架|支架|外壳|壳体|腔|孔|槽|口|层|平台|终端|网关|电路|接口|组件|主机|控制柜|喷头|滴头|水箱|过滤器|电机)";
const PART_WITH_REF = new RegExp(`([\\u4e00-\\u9fa5]{1,12}${PART_SUFFIX})\\s*[（(]?(\\d{2,4}[a-z]?)[）)]?(?![\\d.]|\\s*(?:cm|mm|m|km|%|℃|°|h|min|s|个|次|层|天|亩|L|kPa|MPa|V|A|W|Hz|节点|神经元|维(?![持护修])|像素|帧|通道|样本|字节|bit|dB))`, "g");

/** 正文里“部件名 + 数字”形式的附图标记引用。 */
export function textReferences(text: string): ReferenceEntry[] {
  const found: ReferenceEntry[] = [];
  for (const match of text.matchAll(PART_WITH_REF)) {
    // “隐藏层（512节点）”：括号里是数值加单位，不是附图标记；标记写在括号里时括号内只有数字。
    if (/[（(]\d/.test(match[0]) && !/[）)]$/.test(match[0])) continue;
    found.push({ ref: match[2], name: match[1] });
  }
  return found;
}

const ALLOWED_LATIN = new Set([
  "richards", "penman", "monteith", "lora", "lorawan", "zigbee", "modbus", "mqtt", "gprs", "wifi", "bluetooth", "nb-iot", "rs485", "rs232",
  "can", "plc", "pid", "mcu", "cpu", "gpu", "fpga", "gps", "gnss", "rtk", "pwm", "adc", "dac", "usb", "iot", "api",
  // 通用的模型、算法和遥感指数名称（本领域公知的外文缩写）
  "lstm", "bilstm", "gru", "bert", "resnet", "yolo", "unet", "relu", "softmax", "sigmoid", "tanh", "transformer", "ndvi", "ndwi", "savi", "lidar",
]);

function latinWords(text: string): string[] {
  return (text.match(/[A-Za-z][A-Za-z-]{3,}/g) ?? []).filter((word) => !ALLOWED_LATIN.has(word.toLowerCase()));
}

function nameMatches(a: string, b: string): boolean {
  const clean = (value: string) => value.replace(/[\s（）()]/g, "");
  const x = clean(a);
  const y = clean(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

/**
 * 只有处理框、没有判断框和起止框、也没有 S1/S2 步骤号的“流程图”：renderFlow 不会自动加起止框或步骤号，
 * 画出来就是方框加箭头，与框图、模型结构示意图在图面上没有区别，不按类型不符提示。
 */
function plainChainFlow(spec: FigureSpec): boolean {
  return spec.kind === "flow" && spec.steps.length > 0 && spec.steps.every((step) => step.shape === "process" && !/^S\d{1,3}/i.test(step.text.trim()));
}

function captionKindHint(caption: string): FigureSpec["kind"][] | null {
  if (/流程/.test(caption)) return ["flow"];
  if (CHART_CAPTION.test(caption)) return ["chart"];
  if (/框图|原理图|连接图|数据流|控制流|架构/.test(caption)) return ["block"];
  if (/剖面|截面|分层|布置/.test(caption)) return ["layers", "structure"];
  if (/结构|放大|示意图|主视|俯视|侧视|立体/.test(caption)) return ["structure", "layers", "block"];
  return null;
}

/** 汇总一份申请的附图核查结果。 */
/** 特征点标签说它是峰值一类：应落在所在曲线的局部极大值处。 */
const PEAK_LABEL = /峰|最大|最高|极大/;
/** 特征点标签说它是谷值一类：应落在所在曲线的局部极小值处。 */
const VALLEY_LABEL = /谷|最小|最低|极小/;
/** 阈值、限值、设定值一类标注只是曲线上的某个水平（如“最高允许值”），不要求落在极值处。 */
const LEVEL_LABEL = /阈|限|允许|设定|目标|临界/;
/** 特征点与极值数据点在横、纵方向上允许的偏差，占该曲线横、纵数据范围的比例。 */
const EXTREMUM_TOLERANCE = 0.05;

type Extremum = "max" | "min";

/** 特征点标签要求的极值方向；不是峰谷类、是阈值类或同时含峰谷两类词（如“峰谷差”）时返回 null。 */
function markExtremum(label: string): Extremum | null {
  if (LEVEL_LABEL.test(label)) return null;
  const peak = PEAK_LABEL.test(label);
  const valley = VALLEY_LABEL.test(label);
  if (peak === valley) return null;
  return peak ? "max" : "min";
}

function formatChartNumber(value: number): string {
  return String(Number(value.toFixed(3)));
}

/** 折线在横坐标 x 处的全部纵坐标（横坐标不递增的曲线可能有多个）；x 不在任何一段内时为空。 */
function chartYsAt(points: Array<[number, number]>, x: number): number[] {
  const ys: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const [x0, y0] = points[index - 1];
    const [x1, y1] = points[index];
    if (x < Math.min(x0, x1) || x > Math.max(x0, x1)) continue;
    if (x0 === x1) ys.push(y0, y1);
    else ys.push(y0 + ((y1 - y0) * (x - x0)) / (x1 - x0));
  }
  return ys;
}

/**
 * 曲线的局部极大（或极小）数据点，端点和平台也算。
 * 曲线按单调三次插值或折线绘制，都不会越过相邻数据点，所以极值一定在数据点上。
 */
function chartLocalExtrema(points: Array<[number, number]>, want: Extremum): Array<[number, number]> {
  const atLeast = (a: number, b: number) => (want === "max" ? a >= b : a <= b);
  return points.filter(
    ([, y], index) =>
      (index === 0 || atLeast(y, points[index - 1][1])) && (index === points.length - 1 || atLeast(y, points[index + 1][1])),
  );
}

/** 特征点所在的曲线：横坐标覆盖该点、在该处纵向距离最近的一条；没有曲线覆盖时为 null。 */
function markOwner(chart: FigureChart, mark: ChartMark): ChartSeries | null {
  let owner: ChartSeries | null = null;
  let gap = Infinity;
  for (const series of chart.series) {
    if (series.points.length < 2) continue;
    for (const y of chartYsAt(series.points, mark.x)) {
      const distance = Math.abs(y - mark.y);
      if (distance < gap) {
        gap = distance;
        owner = series;
      }
    }
  }
  return owner;
}

/**
 * 曲线图特征点的语义核对：标为“峰值、最大、最高”的点应接近所在曲线的局部极大值，
 * 标为“谷值、最小、最低”的点应接近局部极小值；返回不符的特征点说明（只作提示，不阻塞导出）。
 */
export function chartMarkProblems(chart: FigureChart): string[] {
  const problems: string[] = [];
  for (const mark of chart.marks) {
    const label = mark.label?.trim();
    if (!label || !Number.isFinite(mark.x) || !Number.isFinite(mark.y)) continue;
    const want = markExtremum(label);
    if (!want) continue;
    const owner = markOwner(chart, mark);
    if (!owner) continue;
    const xs = owner.points.map(([x]) => x);
    const ys = owner.points.map(([, y]) => y);
    const xRange = Math.max(...xs) - Math.min(...xs) || 1;
    const yRange = Math.max(...ys) - Math.min(...ys) || 1;
    const extrema = chartLocalExtrema(owner.points, want);
    if (!extrema.length) continue;
    const near = extrema.some(
      ([x, y]) => Math.abs(x - mark.x) <= EXTREMUM_TOLERANCE * xRange && Math.abs(y - mark.y) <= EXTREMUM_TOLERANCE * yRange,
    );
    if (near) continue;
    const distance = ([x, y]: [number, number]) => Math.hypot((x - mark.x) / xRange, (y - mark.y) / yRange);
    const closest = extrema.reduce((best, point) => (distance(point) < distance(best) ? point : best));
    const curve = owner.label ? `曲线“${owner.label}”` : "曲线";
    const kind = want === "max" ? "局部极大值（峰）" : "局部极小值（谷）";
    const nearest = want === "max" ? "峰值" : "谷值";
    problems.push(
      `特征点“${label}”位于(${formatChartNumber(mark.x)}, ${formatChartNumber(mark.y)})，不在${curve}的${kind}处；` +
        `该曲线最近的${nearest}在(${formatChartNumber(closest[0])}, ${formatChartNumber(closest[1])})`,
    );
  }
  return problems;
}

export function auditFigures(input: FigureAuditInput): FigureAuditResult {
  const checks: FigureCheck[] = [];
  const add = (id: string, label: string, level: FigureCheckLevel, detail: string) => checks.push({ id, label, level, detail });
  const listed = [...input.figures].sort((a, b) => a.no - b.no);
  const specByNo = new Map(input.specs.map((spec) => [spec.no, spec]));
  const renderedByNo = new Map(input.rendered.map((figure) => [figure.no, figure]));

  // 1. 图号连续、唯一。
  if (listed.length) {
    const numbers = listed.map((figure) => figure.no);
    const duplicate = numbers.filter((no, index) => numbers.indexOf(no) !== index);
    const gaps: number[] = [];
    for (let no = 1; no <= Math.max(...numbers); no += 1) if (!numbers.includes(no)) gaps.push(no);
    if (duplicate.length) add("figure-numbering", "附图编号", "error", `附图说明中图${[...new Set(duplicate)].join("、图")}重复出现。`);
    else if (gaps.length) add("figure-numbering", "附图编号", "error", `图号不连续，缺少图${gaps.join("、图")}；应按图1、图2……顺序编号。`);
    else add("figure-numbering", "附图编号", "ok", `图1至图${numbers.length}连续编号。`);
  }

  // 2. 每幅图都有绘图数据，且附图数据不多出附图说明里没有的图。
  const missing = listed.filter((figure) => !specByNo.has(figure.no)).map((figure) => figure.no);
  const orphan = input.specs.filter((spec) => !listed.some((figure) => figure.no === spec.no)).map((spec) => spec.no);
  if (missing.length) add("figure-data", "附图绘制数据", "error", `图${missing.join("、图")}没有结构化绘图数据，导出时仍为占位，需补充后才能提交。`);
  else if (listed.length) add("figure-data", "附图绘制数据", "ok", `${listed.length} 幅附图均已按数据绘制。`);
  if (orphan.length) add("figure-orphan", "附图说明与附图对应", "error", `绘图数据里有图${orphan.join("、图")}，但附图说明没有对应的说明。`);

  // 3. 图的类型与附图说明的图名一致。
  for (const figure of listed) {
    const spec = specByNo.get(figure.no);
    const hint = captionKindHint(figure.caption);
    if (spec && hint && !hint.includes(spec.kind) && !(hint.includes("block") && plainChainFlow(spec))) {
      add(`figure-kind-${figure.no}`, `图${figure.no}类型`, "warn", `附图说明称“${figure.caption}”，但绘图数据是${FIGURE_KIND_LABEL[spec.kind]}。`);
    }
  }

  // 3b. 曲线图特征点的语义：标为“峰值、最大、最高”的点应落在所在曲线的局部极大值处，
  //     标为“谷值、最小、最低”的点应落在局部极小值处。只提示（warn），进入模型修正提示，不阻塞导出。
  for (const spec of input.specs) {
    if (spec.kind !== "chart" || !spec.chart) continue;
    const problems = chartMarkProblems(spec.chart);
    if (problems.length) {
      add(`chart-mark-${spec.no}`, `图${spec.no}特征点`, "warn", `${problems.join("；")}。请核对特征点坐标、标签与曲线数据点，使三者一致。`);
    }
  }

  // 4. 摘要附图有真实图。
  if (listed.length) {
    const abstractNo = input.abstractFigure ?? listed[0].no;
    if (!listed.some((figure) => figure.no === abstractNo)) add("figure-abstract", "摘要附图", "error", `摘要附图指定为图${abstractNo}，但说明书附图中没有这幅图。`);
    else if (!specByNo.has(abstractNo)) add("figure-abstract", "摘要附图", "error", `摘要附图图${abstractNo}还没有绘图数据。`);
    else add("figure-abstract", "摘要附图", "ok", `摘要附图为图${abstractNo}，与说明书附图中的图${abstractNo}相同。`);
  }

  // 5. 附图标记：图、标记列表、正文三方一致。
  const figureRefs = new Map<string, number[]>();
  for (const spec of input.specs) {
    for (const ref of figureSpecRefs(spec)) figureRefs.set(ref, [...(figureRefs.get(ref) ?? []), spec.no]);
  }
  const listByRef = new Map<string, string>();
  const conflicts: string[] = [];
  for (const entry of input.referenceList) {
    const existing = listByRef.get(entry.ref);
    if (existing && !nameMatches(existing, entry.name)) conflicts.push(`${entry.ref}（${existing}／${entry.name}）`);
    else if (!existing) listByRef.set(entry.ref, entry.name);
  }
  if (conflicts.length) add("ref-conflict", "附图标记唯一", "error", `同一标记指代不同部件：${conflicts.join("；")}。`);
  const nameToRefs = new Map<string, string[]>();
  for (const [ref, name] of listByRef) nameToRefs.set(name, [...(nameToRefs.get(name) ?? []), ref]);
  // 合写条目是同一部件的多个实例，同组标记同名不提示；只有来自不同条目的同名标记才提示。
  const groupOf = new Map(input.referenceList.map((entry) => [entry.ref, entry.group?.join("、") ?? entry.ref]));
  const doubleNamed = [...nameToRefs].filter(([, refs]) => new Set(refs.map((ref) => groupOf.get(ref) ?? ref)).size > 1);
  if (doubleNamed.length) add("ref-double", "同一部件同一标记", "warn", doubleNamed.map(([name, refs]) => `“${name}”有 ${refs.join("、")} 多个标记`).join("；") + "。");

  if (figureRefs.size || listByRef.size) {
    // 同一部件的多个实例：图中写 31a、31b，而附图标记列表只列 31 时，按 31 的实例核对，不当作未说明的标记。
    const instanceOf = new Map<string, string>();
    for (const ref of figureRefs.keys()) {
      const base = /^(\d{1,4})[a-z]$/.exec(ref)?.[1];
      if (base && !listByRef.has(ref) && listByRef.has(base)) instanceOf.set(ref, base);
    }
    const drawnRefs = new Set([...figureRefs.keys()].map((ref) => instanceOf.get(ref) ?? ref));
    const notListed = [...figureRefs.keys()].filter((ref) => !listByRef.has(ref) && !instanceOf.has(ref));
    if (notListed.length) add("ref-figure-unlisted", "图中标记均在附图标记中说明", "error", notListed.map((ref) => `${ref}（图${figureRefs.get(ref)?.join("、图")}）`).join("、") + " 出现在附图中，但附图标记列表里没有。");
    if (instanceOf.size) {
      const byBase = new Map<string, string[]>();
      for (const [ref, base] of instanceOf) byBase.set(base, [...(byBase.get(base) ?? []), ref]);
      const parts = [...byBase].map(([base, refs]) => {
        const figures = [...new Set(refs.flatMap((ref) => figureRefs.get(ref) ?? []))].sort((a, b) => a - b);
        return `${refs.join("、")}（图${figures.join("、图")}）按“${base}${listByRef.get(base)}”的多个实例核对`;
      });
      add("ref-instance", "同一部件的多个实例", "warn", `${parts.join("；")}。附图标记宜只用阿拉伯数字，建议在附图标记列表中补列这些标记，或改为不同的数字标记。`);
    }
    const notDrawn = [...listByRef.keys()].filter((ref) => !drawnRefs.has(ref));
    if (notDrawn.length && input.specs.length) add("ref-list-undrawn", "说明书中的标记均在附图中出现", "error", notDrawn.map((ref) => `${ref}${listByRef.get(ref)}`).join("、") + " 列在附图标记中，但没有任何附图画出。");
    const body = input.descriptionText.replace(/\s+/g, "");
    const unmentioned = [...listByRef].filter(([ref, name]) => !new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[（(]?(?:\\d{1,4}[a-z]?[、，,和及]){0,8}${ref}(?!\\d)`).test(body));
    if (unmentioned.length) add("ref-text-unmentioned", "附图标记在正文中引用", "warn", unmentioned.map(([ref, name]) => `${name}${ref}`).join("、") + " 只在附图标记列表中出现，具体实施方式没有结合附图写到它。");
    const stray = textReferences(input.descriptionText).filter((entry) => !listByRef.has(entry.ref));
    const strayUnique = [...new Map(stray.map((entry) => [entry.ref, entry])).values()];
    if (strayUnique.length && listByRef.size) add("ref-text-unlisted", "正文标记均有说明", "warn", strayUnique.map((entry) => `${entry.name}${entry.ref}`).join("、") + " 在正文中以附图标记形式出现，但附图标记列表和附图里都没有。");
    const renamed: string[] = [];
    for (const spec of input.specs) {
      for (const node of spec.nodes) {
        const listedName = node.ref ? listByRef.get(node.ref) : undefined;
        if (node.ref && listedName && !nameMatches(node.text, listedName)) renamed.push(`图${spec.no}中 ${node.ref} 写作“${node.text}”，列表为“${listedName}”`);
      }
    }
    if (renamed.length) add("ref-name", "同一标记同一名称", "warn", renamed.join("；") + "。");
    if (!notListed.length && !notDrawn.length && !conflicts.length) add("ref-consistency", "附图标记一致", "ok", `${listByRef.size} 个附图标记在列表和附图之间一一对应。`);
  }

  // 6. 方法步骤都在流程图中出现。
  const flowSteps = new Set(input.specs.filter((spec) => spec.kind === "flow").flatMap((spec) => spec.steps.map((step) => /^(S\d{1,3})/i.exec(step.text)?.[1]?.toUpperCase() ?? step.id.toUpperCase())));
  if (flowSteps.size) {
    const textSteps = new Set([...`${input.claimsText}\n${input.descriptionText}`.matchAll(/(?<![A-Za-z])S(\d{1,3})(?=\s*[、：:.．，,）)\u4e00-\u9fa5])/g)].map((match) => `S${match[1]}`));
    const absent = [...textSteps].filter((step) => !flowSteps.has(step)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    if (absent.length) add("figure-steps", "流程图覆盖方法步骤", "warn", `正文中的步骤 ${absent.join("、")} 没有出现在任何流程图中。`);
    else add("figure-steps", "流程图覆盖方法步骤", "ok", `流程图覆盖正文中的 ${textSteps.size} 个步骤。`);
  }

  // 7. 图中文字：中文、必要词语、长度。
  const latin: string[] = [];
  const longText: string[] = [];
  for (const figure of input.rendered) {
    for (const text of figure.texts) {
      latinWords(text).forEach((word) => latin.push(`图${figure.no}“${word}”`));
      if ((figure.kind === "flow" || figure.kind === "block") && text.length > 60) longText.push(`图${figure.no}“${text.slice(0, 16)}……”`);
    }
  }
  if (latin.length) add("figure-language", "图中文字使用中文", "warn", `${[...new Set(latin)].join("、")} 不是中文；除通用技术符号外，图中词语应使用中文。`);
  if (longText.length) add("figure-wordy", "框内只写必要文字", "warn", `${longText.join("、")} 框内文字过长，应只保留必要的文字和符号，详细说明放在说明书中。`);

  // 8. 绘制形式：黑白、无照片、尺寸与字高。
  for (const figure of input.rendered) {
    const colors = [...figure.svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map((match) => match[1].toLowerCase()).filter((value) => !["#000", "#000000", "#fff", "#ffffff", "none", "black", "white"].includes(value));
    if (colors.length || /<image\b|rgb\(|opacity=/.test(figure.svg)) add(`figure-color-${figure.no}`, `图${figure.no}黑白线条`, "error", `图${figure.no}含有彩色、灰度或位图内容。`);
    if (figure.widthMm > 165.05 || figure.heightMm > 245.05) add(`figure-size-${figure.no}`, `图${figure.no}图幅`, "error", `图${figure.no}为 ${figure.widthMm}×${figure.heightMm} mm，超过 165×245 mm。`);
    if (figure.fontMm < 2.0) add(`figure-legible-${figure.no}`, `图${figure.no}清晰度`, "error", `图${figure.no}字高仅 ${figure.fontMm} mm，缩小到三分之二后无法辨认，应拆分为多幅图或减少内容。`);
    else if (figure.fontMm < 2.8) add(`figure-legible-${figure.no}`, `图${figure.no}清晰度`, "warn", `图${figure.no}为适应图幅缩小后字高 ${figure.fontMm} mm，缩小到三分之二时约 ${Math.round(figure.fontMm * 2 / 3 * 100) / 100} mm，建议拆图。`);
    figure.warnings.forEach((warning, index) => add(`figure-layout-${figure.no}-${index}`, `图${figure.no}排版`, "warn", warning));
  }
  if (input.rendered.length && !checks.some((check) => /^figure-(color|size|legible)/.test(check.id))) {
    add("figure-form", "附图绘制形式", "ok", `黑色线条、无着色，图幅不超过 165×245 mm，字高不小于 ${Math.min(...input.rendered.map((figure) => figure.fontMm))} mm。`);
  }

  // 9. 绘图数据本身的问题。
  input.specIssues.forEach((issue, index) => add(`figure-spec-${index}`, issue.no ? `图${issue.no}绘图数据` : "附图绘图数据", "warn", issue.message));
  const drawable = listed.filter((figure) => renderedByNo.has(figure.no)).map((figure) => figure.no);
  return {
    checks,
    drawable,
    missing,
    errorCount: checks.filter((check) => check.level === "error").length,
    warnCount: checks.filter((check) => check.level === "warn").length,
  };
}
