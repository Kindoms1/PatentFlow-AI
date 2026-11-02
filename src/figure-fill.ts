/**
 * 附图数据补绘：附图说明列出了图，但草稿没有这些图的 ```附图 结构化绘图数据（模型漏写，或写成了程序无法识别的格式）时，
 * 导出的说明书附图只能是空白虚线框。这里提供补绘所需的纯函数：
 *
 *   figureFillPlan     找出附图说明中有、绘图数据中没有的图，以及已绘制的图号和附图标记列表
 *   figureFillPrompt   只请模型补写这些图的 ```附图 代码块，不重写全文
 *   parseFigureFill    从模型回复中取出缺图的绘图数据（经 extractFigureSpecs 解析、规范化）
 *   insertFigureBlocks 把规范化后的代码块插回附图说明末尾
 *
 * 是否调用模型、补绘结果是否采用，由 draft-run.ts 结合形式核查决定。
 */
import { parseApplication } from "./cnipa-format.ts";
import type { AppFigure, ParsedApplication } from "./cnipa-format.ts";
import { FIGURE_SPEC_GUIDE } from "./figure-prompt.ts";
import { CHART_CAPTION, extractFigureSpecs, figureSpecBlock } from "./figure-spec.ts";
import type { FigureSpec } from "./figure-spec.ts";

export type FigureReferenceList = NonNullable<ParsedApplication["references"]>;

/** 补绘请求的开头标记（也便于测试中的模拟模型按请求分流）。 */
export const FIGURE_FILL_MARKER = "【补绘附图数据】";

/** 随补绘请求附上的草稿上限（字符）。 */
const DRAFT_LIMIT = 30_000;

export const FIGURE_FILL_SYSTEM = [
  "你是中国发明专利申请文件的附图数据撰写助手。",
  "你根据申请文件草稿，为指定的附图编写结构化绘图数据，程序据此自动绘制符合专利审查要求的黑白线条附图。",
  "只输出按要求书写的 ```附图 代码块（每个代码块内是一个 JSON 对象）；不写说明书正文，不提问，不解释，不输出其他代码块。",
].join("\n");

export interface FigureFillPlan {
  /** 附图说明中列出、但没有绘图数据的图（按图号排序）。 */
  missing: AppFigure[];
  /** 已有绘图数据的图号。 */
  drawn: number[];
  /** 草稿中的“附图标记”列表。 */
  references: FigureReferenceList;
}

export interface FigureFillResult {
  /** 回复中属于缺图的、已规范化的绘图数据。 */
  specs: FigureSpec[];
  /** 解析中发现的问题和未采用的内容。 */
  notes: string[];
}

/** 缺绘图数据的图：附图说明里有、```附图 数据里没有。草稿没有附图说明时 missing 为空。 */
export function figureFillPlan(draft: string): FigureFillPlan {
  const app = parseApplication(draft);
  const drawn = [...new Set((app.figureSpecs ?? []).map((spec) => spec.no))].sort((a, b) => a - b);
  const seen = new Set<number>();
  const missing = [...app.figures]
    .sort((a, b) => a.no - b.no)
    .filter((figure) => {
      if (drawn.includes(figure.no) || seen.has(figure.no)) return false;
      seen.add(figure.no);
      return true;
    });
  return { missing, drawn, references: app.references ?? [] };
}

/** 按图名提示图的类型，口径与附图核查（figure-audit.ts 的图名与类型对应）一致。 */
function kindHint(caption: string): string {
  if (/流程/.test(caption)) return "flow（流程图）";
  if (CHART_CAPTION.test(caption)) return "chart（曲线图）";
  if (/框图|原理图|连接图|数据流|控制流|架构/.test(caption)) return "block（框图）";
  if (/剖面|截面|分层|布置/.test(caption)) return "layers（分层图）或 structure（结构图）";
  if (/结构|放大|示意图|主视|俯视|侧视|立体/.test(caption)) return "structure（结构图）、layers（分层图）或 block（框图）";
  return "按图名从 flow、block、layers、structure、chart 中选择";
}

function clipDraft(draft: string): string {
  return draft.length > DRAFT_LIMIT ? `${draft.slice(0, DRAFT_LIMIT)}\n……（草稿较长，以下从略）` : draft;
}

/** 只请模型补写缺图的 ```附图 代码块的提示词。 */
export function figureFillPrompt(draft: string, plan: FigureFillPlan, guide = ""): string {
  const nos = plan.missing.map((figure) => figure.no);
  const drawnNote = plan.drawn.length ? `（图${plan.drawn.join("、图")}已有绘图数据，其中已画出的标记不必重复）` : "";
  const refRule = plan.references.length
    ? `- 附图标记 ref 只使用下面【附图标记】中的编号，部件名称与列表一致；列表中的每个标记都要画在某一幅图中${drawnNote}，不得画出列表以外的标记；`
    : "- 草稿没有附图标记列表：方框和图元不写 ref；";
  return [
    `${FIGURE_FILL_MARKER}下面这份发明专利申请文件草稿的附图说明列出了附图，但以下 ${nos.length} 幅图没有结构化绘图数据，导出 Word 时只能留空白框，请补写：`,
    ...plan.missing.map((figure) => `- 图${figure.no}：${figure.caption}（kind：${kindHint(figure.caption)}）`),
    "",
    "【要求】",
    "- 只为图" + nos.join("、图") + "各写一个 ```附图 代码块，按图号顺序输出；不输出说明书正文、解释、标题或其他代码块；",
    "- 每个代码块里是一个 JSON 对象：no 写图号（与上面一致），kind 与图名相符，其余字段按【附图数据规范】书写；",
    "- 流程图的步骤编号和文字与具体实施方式中的步骤一致；判断框（shape 为 decision）必须有“是”“否”两个出口，只有一个出口的步骤写成普通处理框；",
    "- 框图、结构图中的部件名称与权利要求书和具体实施方式中的名称一致；",
    "- 图名含“曲线”“趋势”“随……变化”等表示数量关系的图用 chart（曲线图）：写明横轴、纵轴名称 xLabel、yLabel，用 series 给出数据点，不要用 structure 的折线和圆拼画；示意曲线的数值只需体现变化趋势；",
    refRule,
    "- 图中文字使用中文，只写必要的词语和技术符号；每幅图方框或步骤不超过 12 个；不画照片、不着色、不加图框和图题。",
    plan.references.length ? `\n【附图标记】\n${plan.references.map((entry) => `${entry.ref}—${entry.name}`).join("；")}` : "",
    `\n【附图数据规范】\n${FIGURE_SPEC_GUIDE}`,
    guide ? `\n【领域撰写指引】\n${guide}` : "",
    `\n【申请文件草稿】\n${clipDraft(draft)}`,
  ].join("\n");
}

/** 从模型回复中取出缺图的绘图数据：只收下需补绘的图号，其余内容和解析问题记入 notes。 */
export function parseFigureFill(reply: string, missing: AppFigure[]): FigureFillResult {
  const wanted = new Set(missing.map((figure) => figure.no));
  const parsed = extractFigureSpecs(reply);
  const specs = parsed.specs.filter((spec) => wanted.has(spec.no));
  const notes = parsed.issues.map((issue) => issue.message);
  const extra = parsed.specs.filter((spec) => !wanted.has(spec.no)).map((spec) => spec.no);
  if (extra.length) notes.push(`回复中的图${extra.join("、图")}不在需补绘之列，未采用`);
  return { specs, notes };
}

/**
 * 把绘图数据以规范的 ```附图 代码块插回草稿：放在“## 附图说明”一节末尾（下一个二级标题或末尾 json 块之前）；
 * 没有附图说明一节时放在“## 具体实施方式”之前，再没有就放在文末。代码块内的文字不参与标题判断。
 */
export function insertFigureBlocks(text: string, specs: FigureSpec[]): string {
  if (!specs.length) return text;
  const lines = text.split(/\r?\n/);
  let inFence = false;
  let start = -1;
  let end = -1;
  let embodiment = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith("```")) {
      if (!inFence && start >= 0 && end < 0 && /^```json\s*$/i.test(trimmed)) end = index;
      inFence = !inFence;
      continue;
    }
    if (inFence || !/^##(?!#)/.test(trimmed)) continue;
    if (start >= 0 && end < 0) end = index;
    if (start < 0 && /^##\s*附图说明/.test(trimmed)) start = index;
    if (embodiment < 0 && /^##\s*具体实施方式/.test(trimmed)) embodiment = index;
  }
  let at = start >= 0 ? (end >= 0 ? end : lines.length) : embodiment >= 0 ? embodiment : lines.length;
  const floor = start >= 0 ? start + 1 : 0;
  while (at > floor && lines[at - 1].trim() === "") at -= 1;
  const sorted = [...specs].sort((a, b) => a.no - b.no);
  const blocks = sorted.flatMap((spec, index) => (index ? ["", figureSpecBlock(spec)] : [figureSpecBlock(spec)]));
  lines.splice(at, 0, "", ...blocks, "");
  return lines.join("\n");
}