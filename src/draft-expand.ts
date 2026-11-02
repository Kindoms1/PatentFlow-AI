/**
 * 成稿后的分节扩写：让说明书详细、具体、完整。
 *
 * 一次模型调用的输出上限装不下“完整申请文件 + 7 幅以上附图数据 + 上万字说明书”。主稿写完并通过形式核查后，
 * 这里按节单独补写，每次只让模型输出要新增的那一节，再由程序插回原稿的固定位置：
 *
 *   1. 创新点分析：发明内容缺少“创新点”小节时补写“### 创新点分析”，插在“### 有益效果”之前；
 *   2. 背景技术：不足 BACKGROUND_TARGET 字时整节重写（逐篇评述对比文件 → 共性缺陷及成因）；
 *   3. 具体实施方式：不足 EMBODIMENT_TARGET 字时补写替代实施例、应用场景实施例、参数选取依据、
 *      效果分析等小节（最多两次，第二次换一组内容），插在“### 附图标记”之前。
 *
 * 每一步都经 evaluate 复核：申请文件结构必须完整、附图致命问题不能增加、原本可导出的稿子必须仍可导出、
 * 自检分不能明显下降，否则放弃这一步、保留原稿。模型调用通过参数注入。
 */
import type { PriorArtRef } from "./invention-draft.ts";
import { SPEC_STYLE_GUIDE } from "./draft-polish.ts";

export const BACKGROUND_TARGET = 1200;
export const EMBODIMENT_TARGET = 18000;
export const INNOVATION_HEADING = "### 创新点分析";
/** 扩写后自检分允许的最大降幅。 */
export const EXPAND_SCORE_TOLERANCE = 3;

export interface ExpandEvaluation {
  complete: boolean;
  score: number;
  exportable: boolean;
  figureErrors: number;
}

type ModelMessage = { role: "system" | "user" | "assistant"; content: string };

export interface ExpandReply {
  ok: boolean;
  text: string;
  detail?: string;
  aborted?: boolean;
}

export interface ExpandDeps {
  ask: (messages: ModelMessage[], onTrace: (text: string) => void, signal?: AbortSignal) => Promise<ExpandReply>;
}

export interface ExpandInput {
  text: string;
  priorArt: PriorArtRef[];
  /** 《查新对比报告》全文（有时）。 */
  novelty?: string;
  /** 全自动模式：材料中没有的数值写合理模拟值并标注。 */
  auto: boolean;
  trace: (text: string) => void;
  signal?: AbortSignal;
  evaluate: (text: string) => ExpandEvaluation;
}

export interface ExpandOutcome {
  text: string;
  changed: boolean;
  aborted: boolean;
  /** 采用了的扩写步骤。 */
  added: string[];
}

// ───────────────────────────── 章节定位 ─────────────────────────────

export interface SectionSpan {
  /** “## 名称”所在行。 */
  head: number;
  /** 下一个一级（##）标题所在行，或全文行数。 */
  end: number;
}

const FENCE = /^\s*```/;

export function findSection(lines: string[], name: string): SectionSpan | null {
  const pattern = new RegExp(`^##\\s*${name}\\s*$`);
  let inFence = false;
  let head = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (head < 0) {
      if (pattern.test(line.trim())) head = index;
      continue;
    }
    if (/^##\s/.test(line.trim())) return { head, end: index };
  }
  return head < 0 ? null : { head, end: lines.length };
}

/** 一节正文的字数（不含空白和代码块）。 */
export function sectionChars(lines: string[], span: SectionSpan | null): number {
  if (!span) return 0;
  let inFence = false;
  let count = 0;
  for (const line of lines.slice(span.head + 1, span.end)) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) count += line.replace(/\s+/g, "").length;
  }
  return count;
}

function sectionText(lines: string[], span: SectionSpan | null): string {
  return span ? lines.slice(span.head + 1, span.end).join("\n") : "";
}

/** 具体实施方式中补写内容的插入行：“### 附图标记”之前；没有时在末尾 json 尾块之前；再没有时在节末。 */
function embodimentAnchor(lines: string[], span: SectionSpan): number {
  for (let index = span.head + 1; index < span.end; index += 1) {
    if (/^###\s*附图标记/.test(lines[index].trim())) return index;
  }
  for (let index = span.head + 1; index < span.end; index += 1) {
    if (/^\s*```\s*json\s*$/i.test(lines[index])) return index;
  }
  let end = span.end;
  while (end > span.head + 1 && !lines[end - 1].trim()) end -= 1;
  return end;
}

/** 发明内容中“### 有益效果”所在行；没有时为节末。 */
function innovationAnchor(lines: string[], span: SectionSpan): number {
  for (let index = span.head + 1; index < span.end; index += 1) {
    if (/^###\s*有益效果/.test(lines[index].trim())) return index;
  }
  let end = span.end;
  while (end > span.head + 1 && !lines[end - 1].trim()) end -= 1;
  return end;
}

function insertAt(lines: string[], at: number, block: string): string[] {
  const body = block.trim().split("\n");
  const before = lines.slice(0, at);
  const after = lines.slice(at);
  while (before.length && !before[before.length - 1].trim()) before.pop();
  return [...before, "", ...body, "", ...after];
}

export function hasInnovationSection(lines: string[]): boolean {
  const span = findSection(lines, "发明内容");
  if (!span) return false;
  return lines.slice(span.head + 1, span.end).some((line) => /^###\s*.*(?:创新点|创新之处)/.test(line.trim()));
}

/** 已有的附图图号（按“## 附图说明”中的“图N为”）。 */
export function existingFigures(lines: string[]): number[] {
  const span = findSection(lines, "附图说明");
  const numbers = new Set<number>();
  for (const match of sectionText(lines, span).matchAll(/图\s*(\d{1,2})\s*(?:为|是|示出)/g)) numbers.add(Number(match[1]));
  return [...numbers].sort((a, b) => a - b);
}

/** “### 附图标记”列表原文（没有时为空串）。 */
export function referenceList(lines: string[]): string {
  const start = lines.findIndex((line) => /^###\s*附图标记/.test(line.trim()));
  if (start < 0) return "";
  const out: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^#{2,3}\s/.test(line.trim()) || FENCE.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

/** 说明书里独立公式的最大编号。 */
export function maxFormulaNo(text: string): number {
  let max = 0;
  for (const match of text.matchAll(/[（(]\s*(\d{1,3})\s*[）)]\s*$/gm)) {
    const line = text.slice(text.lastIndexOf("\n", match.index ?? 0) + 1, (match.index ?? 0) + match[0].length);
    if (/\$\$|\\\]|\\tag/.test(line)) max = Math.max(max, Number(match[1]));
  }
  return max;
}

function subheadings(lines: string[], span: SectionSpan | null): string[] {
  if (!span) return [];
  return lines
    .slice(span.head + 1, span.end)
    .map((line) => /^###\s*(.+)$/.exec(line.trim())?.[1]?.trim() ?? "")
    .filter(Boolean);
}

// ───────────────────────────── 输出清洗 ─────────────────────────────

/**
 * 模型补写的小节：去掉代码块和引导语，“# / ##”标题降为“###”，正文从第一个“### ”开始。
 * 引用了不存在的附图（“如图9所示”）时去掉该引用短语。
 */
export function sanitizeSections(reply: string, figures: number[]): string {
  let text = reply.replace(/```[\s\S]*?```/g, "").replace(/```[\s\S]*$/, "");
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .map((line) => (/^#{1,2}\s+/.test(line) ? line.replace(/^#{1,2}\s+/, "### ") : line))
    .map((line) => (/^#{4,}\s+/.test(line) ? line.replace(/^#{4,}\s+/, "#### ") : line));
  const first = lines.findIndex((line) => /^###\s+\S/.test(line));
  text = (first >= 0 ? lines.slice(first) : lines)
    .filter((line) => !/^(?:以下|下面|如下)(?:是|为).{0,30}[:：]?$/.test(line.trim()))
    .join("\n");
  return dropMissingFigureRefs(text, figures).replace(/\n{3,}/g, "\n\n").trim();
}

/** 背景技术重写稿：去掉所有标题、代码块和引导语，只留段落。 */
export function sanitizeParagraphs(reply: string, figures: number[]): string {
  const text = reply
    .replace(/```[\s\S]*?```/g, "")
    .replace(/```[\s\S]*$/, "")
    .split(/\r?\n/)
    .filter((line) => !/^#{1,6}\s/.test(line.trim()))
    .filter((line) => !/^(?:以下|下面|如下)(?:是|为).{0,30}[:：]?$/.test(line.trim()))
    .join("\n");
  return dropMissingFigureRefs(text, figures).replace(/\n{3,}/g, "\n\n").trim();
}

function dropMissingFigureRefs(text: string, figures: number[]): string {
  const known = new Set(figures);
  return text
    .replace(/(?:如|参见|参照|结合)?图\s*(\d{1,2})\s*(?:所示|中)?[，,]?/g, (whole, no: string) => (known.has(Number(no)) ? whole : ""))
    .replace(/[（(]\s*[）)]/g, "");
}

// ───────────────────────────── 提示词 ─────────────────────────────

export const EXPAND_SYSTEM = `你是资深中国专利代理师。一份发明专利申请文件草稿已经写好并通过了形式核查，现在需要你按要求补写其中的某一节，使说明书详细、具体、完整，达到所属技术领域技术人员能够实现的程度（《专利法》第26条第3款）。

【必须遵守】
- 只输出要补写的内容本身，不要重复草稿已有段落，不要输出整篇申请文件，不要解释，不要写“以下是……”之类的引导语。
- 术语、部件名称、步骤编号（S1、S2……）、模块名称与草稿完全一致；不得改动或否定权利要求的内容，只做细化和展开。
- 附图标记只能使用草稿“### 附图标记”列表中已有的标记，写成“部件名称+标记”（如“控制器30”）；不得新增附图标记，不得引用草稿中不存在的附图。
- 新增独立公式用 LaTeX 写成单独一行 $$ … $$，按草稿已有编号顺延，公式后用“式中，$X$为……（单位）”说明全部符号。
- 对比文件只能使用给出的公开号；不得编造公开号、网址、实验数据、测试报告或精度提升百分比。
- 权利要求中不得出现的“例如”“优选”等词语在说明书中可以使用；不写“如图X所示”以外的附图描述。
- 正文不得出现任何内部工作提示或占位标记（例如“待检索”“待补充对比文件”“此处补充”“略”）。

${SPEC_STYLE_GUIDE}`;

function stripFigureBlocks(text: string): string {
  return text.replace(/```\s*(?:附图|patent-figure|figure)\s*\n[\s\S]*?```/g, "（附图数据略）");
}

function clipDraft(text: string, max = 40000): string {
  const value = stripFigureBlocks(text);
  if (value.length <= max) return value;
  const head = Math.floor(max * 0.7);
  return `${value.slice(0, head)}\n……（中间略）……\n${value.slice(-(max - head))}`;
}

function artLines(priorArt: PriorArtRef[]): string {
  if (!priorArt.length) return "（没有可引用的对比文件：背景技术概括所属领域通行的 2 到 3 种现有技术路线并逐一分析其缺陷，不写公开号，不加任何占位标记）";
  return priorArt.map((ref, index) => `[${index + 1}] ${ref.pn}《${ref.title}》${ref.note ? `：${ref.note.slice(0, 260)}` : ""}`).join("\n");
}

function numberRule(auto: boolean): string {
  return auto
    ? "- 【全自动模式】材料中没有的参数、阈值、尺寸、配比等数值给出所属领域合理的模拟值，每个模拟数值后紧跟“（模拟值，待实验验证）”；技术效果写定性描述或“预期……（模拟值，待实验验证）”，不得写成实测结论。"
    : "- 材料中没有的具体数值写成所属领域常规的取值范围及其确定方法（例如“可根据……在……范围内选取”），不得写成实测结论，正文不写任何【待……】占位。";
}

function contextBlock(input: ExpandInput, lines: string[]): string {
  const figures = existingFigures(lines);
  const references = referenceList(lines);
  return [
    `【草稿全文】\n${clipDraft(lines.join("\n"))}`,
    `【对比文件】\n${artLines(input.priorArt)}`,
    input.novelty ? `【查新对比报告（节选）】\n${input.novelty.slice(0, 6000)}` : "",
    `【可引用的附图】${figures.length ? figures.map((no) => `图${no}`).join("、") : "无"}`,
    `【可使用的附图标记】${references || "无（不要写附图标记）"}`,
    `【已有公式最大编号】${maxFormulaNo(lines.join("\n")) || "无公式"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function innovationPrompt(input: ExpandInput, lines: string[]): string {
  return [
    contextBlock(input, lines),
    "【本次任务】补写发明内容中的“创新点分析”小节。",
    `- 以“${INNOVATION_HEADING}”开头，后面用“（1）创新点名称”“（2）……”分条写 3 到 5 个创新点，全文 1500 到 2500 字；`,
    "- 每个创新点依次写清：对应的区别技术特征（注明对应的权利要求编号）；最接近的现有技术怎样做、为什么做不到（引用对比文件公开号）；本发明采用的具体技术手段和作用原理（可配合公式和参数）；解决的技术问题；带来的技术效果；为什么对本领域技术人员不是显而易见的（现有文献是否给出结合启示、是否属于公知常识）；",
    "- 创新点之间要有层次：核心创新点在前，配套改进在后，并与“有益效果”逐条对应；",
    numberRule(input.auto),
    "只输出这一小节。",
  ].join("\n");
}

export function backgroundPrompt(input: ExpandInput, lines: string[]): string {
  return [
    contextBlock(input, lines),
    "【本次任务】重写“背景技术”一节的全部正文（不要写“## 背景技术”标题，不要分小标题），1300 到 2000 字。",
    "- 依次写：所属领域的现状和需求 → 逐篇评述对比文件（用“公开号+名称”指代，写清其技术方案要点和存在的具体缺陷）→ 归纳现有技术的共性技术问题及其产生原因 → 引出本发明要解决的问题（不写本发明的技术方案）；",
    "- 每篇对比文件单独成段；没有对比文件时，以“现有技术中，……”概括所属领域通行的 2 到 3 种技术路线，每种单独成段，写清其技术手段、具体缺陷及产生原因，不写公开号，不加“待检索”“待补充”之类的任何标记；",
    "- 原背景技术中的有效内容要保留并展开，不得遗漏原文引用过的公开号；",
    "只输出背景技术正文段落。",
  ].join("\n");
}

const ROUND3_FOCUS = [
  "- 补写“### 关键技术特征的具体实现”：按权利要求1及主要从属权利要求中技术特征的顺序逐个展开，每个步骤或部件先用“具体地，”写实现方式，再用“进一步地，”写对该特征的细化限定，用“优选地，”给出优选参数或结构及其选取理由，用“在另一些实施方式中，”写可替代的实现；方法步骤拆分为子步骤（如S11、S12……），写清每个子步骤的输入、处理、输出以及与前后步骤之间的数据流或控制流；结构部件写清形状、相对位置、连接方式、配合关系和动作过程；",
  "- 补写“### 异常工况与边界条件的处理”：说明输入数据缺失或异常、参数越界、部件失效、工况或环境变化时方法或装置的判断逻辑和处理措施，以及这些措施如何保证有益效果的实现；",
  "- 两个小节都不得重复已有实施例的原句，要在已有内容的基础上补充更深一层的实现细节和技术依据；",
];

export function embodimentPrompt(input: ExpandInput, lines: string[], round: 1 | 2 | 3): string {
  const span = findSection(lines, "具体实施方式");
  const existing = subheadings(lines, span);
  const focus =
    round === 3
      ? ROUND3_FOCUS
      : round === 1
      ? [
          "- 补写 2 到 3 个与已有实施例不同的完整实施例（如“### 实施例2：……”“### 实施例3：……”，编号顺延，不得与已有小节重名），每个实施例写清应用对象、全部步骤或部件配合、每步的输入/处理/输出和原理、关键参数取值，以及与实施例1的区别；",
          "- 再补写一个“### 应用场景实施例”：结合一个具体工况或场景，按时间顺序完整走一遍方法或装置的工作过程，写出中间结果；",
        ]
      : [
          "- 补写“### 关键参数选取依据”：逐个说明权利要求和实施例中关键参数、阈值的物理含义、取值范围、端值和中间值的选取理由，以及超出范围会出现的问题；",
          "- 补写“### 技术效果分析”：与最接近的现有技术逐项对比，说明效果产生的机理（可以用表格对比方案差异），不得写成实测结论；",
          "- 补写“### 变形实施方式”：列举可替换的实现方式（等同替换的算法、部件、通信方式、部署方式等）并说明仍落入保护范围的理由；",
        ];
  return [
    contextBlock(input, lines),
    `【本次任务】为“具体实施方式”补写新的小节，插在“### 附图标记”之前。已有小节：${existing.join("、") || "无"}。`,
    ...focus,
    "- 每个小节以“### ”开头，每个小节不少于 1500 字，本次合计 5000 到 8000 字；按【说明书行文规范】递进展开，与权利要求和已有实施例前后衔接，不重复已有段落；结合已有附图用“如图N所示”说明，部件写“名称+附图标记”；",
    numberRule(input.auto),
    "只输出新增的小节。",
  ].join("\n");
}

// ───────────────────────────── 流程 ─────────────────────────────

function acceptable(before: ExpandEvaluation, after: ExpandEvaluation): string {
  if (!after.complete) return "会破坏申请文件结构";
  if (after.figureErrors > before.figureErrors) return `会使附图问题从 ${before.figureErrors} 项增加到 ${after.figureErrors} 项`;
  if (before.exportable && !after.exportable) return "会使申请文件无法通过导出前形式核查";
  if (after.score < before.score - EXPAND_SCORE_TOLERANCE) return `会使自检分从 ${before.score} 降到 ${after.score}`;
  return "";
}

function charCount(text: string): number {
  return text.replace(/\s+/g, "").length;
}

/** 回复是否回显了整篇申请文件（发明名称、摘要、权利要求书等一级章节，或成串的权利要求条目）；这种回复不能当作某一节插入。 */
export function echoesDocument(reply: string): boolean {
  const text = reply.replace(/```[\s\S]*?```/g, "");
  if (/^\s*#{1,3}\s*(?:发明名称|说明书摘要|摘要附图|权利要求书|技术领域|说明书附图)\s*[:：]?/m.test(text)) return true;
  const claims = text.match(/^\s*\d{1,2}\s*[.．、]\s*(?:一种|根据权利要求\s*\d)/gm) ?? [];
  return claims.length >= 2;
}

/** 回复里逐字照搬原稿的句子超过这个比例，就视为回显而不是补写。 */
export const MAX_REPEATED_RATIO = 0.5;

/** 回复中（12 字以上的）句子有多大比例已逐字出现在原稿中。 */
export function repeatedRatio(reply: string, original: string): number {
  const flat = original.replace(/\s+/g, "");
  const sentences = reply
    .replace(/```[\s\S]*?```/g, "")
    .split(/[。；！？\n]/)
    .map((sentence) => sentence.replace(/\s+/g, ""))
    .filter((sentence) => sentence.length >= 12 && !sentence.startsWith("#"));
  if (!sentences.length) return 0;
  return sentences.filter((sentence) => flat.includes(sentence)).length / sentences.length;
}

export async function expandDraft(input: ExpandInput, deps: ExpandDeps): Promise<ExpandOutcome> {
  const { trace, signal } = input;
  let lines = input.text.split(/\r?\n/);
  let state = input.evaluate(input.text);
  const added: string[] = [];
  const done = (aborted = false): ExpandOutcome => ({ text: lines.join("\n"), changed: added.length > 0, aborted, added });

  const attempt = async (label: string, prompt: string, build: (reply: string) => string[] | null): Promise<boolean> => {
    trace(`分节扩写：${label}。`);
    const reply = await deps.ask(
      [
        { role: "system", content: EXPAND_SYSTEM },
        { role: "user", content: prompt },
      ],
      trace,
      signal,
    );
    if (signal?.aborted || reply.aborted) return false;
    if (!reply.ok || !reply.text.trim()) {
      trace(`${label}没有完成（${reply.detail || "无返回"}），保留原稿。`);
      return true;
    }
    if (echoesDocument(reply.text) || repeatedRatio(reply.text, lines.join("\n")) > MAX_REPEATED_RATIO) {
      trace(`${label}的回复回显了原稿而不是补写新内容，保留原稿。`);
      return true;
    }
    const next = build(reply.text);
    if (!next) {
      trace(`${label}的回复内容过短或格式不符，保留原稿。`);
      return true;
    }
    const candidate = next.join("\n");
    const evaluation = input.evaluate(candidate);
    const reason = acceptable(state, evaluation);
    if (reason) {
      trace(`${label}${reason}，放弃这一步，保留原稿。`);
      return true;
    }
    const gained = charCount(candidate) - charCount(lines.join("\n"));
    lines = next;
    state = evaluation;
    added.push(label);
    trace(`${label}已采用，正文增加约 ${gained} 字，自检 ${evaluation.score} 分。`);
    return true;
  };

  // ① 创新点分析
  if (!hasInnovationSection(lines) && findSection(lines, "发明内容")) {
    const ok = await attempt("补写创新点分析", innovationPrompt(input, lines), (reply) => {
      const figures = existingFigures(lines);
      let block = sanitizeSections(reply, figures);
      if (!block.startsWith(INNOVATION_HEADING)) block = `${INNOVATION_HEADING}\n${block.replace(/^###\s*[^\n]*创新[^\n]*\n/, "")}`;
      // 只保留创新点分析这一个小节，模型顺带写的其他小节不插入发明内容。
      const cut = block.indexOf("\n### ", INNOVATION_HEADING.length);
      if (cut > 0) block = block.slice(0, cut).trim();
      if (charCount(block) < 400) return null;
      const span = findSection(lines, "发明内容");
      return span ? insertAt(lines, innovationAnchor(lines, span), block) : null;
    });
    if (!ok) return done(true);
  }

  // ② 背景技术
  const background = findSection(lines, "背景技术");
  if (background && sectionChars(lines, background) < BACKGROUND_TARGET) {
    const oldText = sectionText(lines, background);
    const oldNumbers = new Set([...oldText.matchAll(/CN\s?\d{7,10}[A-Z]?\d?/gi)].map((match) => match[0].replace(/\s+/g, "").toUpperCase()));
    const ok = await attempt("重写背景技术", backgroundPrompt(input, lines), (reply) => {
      const body = sanitizeParagraphs(reply, existingFigures(lines));
      if (charCount(body) <= sectionChars(lines, background) || charCount(body) < 500) return null;
      const upper = body.replace(/\s+/g, "").toUpperCase();
      for (const pn of oldNumbers) if (!upper.includes(pn)) return null;
      const span = findSection(lines, "背景技术");
      if (!span) return null;
      return [...lines.slice(0, span.head + 1), ...body.split("\n"), "", ...lines.slice(span.end)];
    });
    if (!ok) return done(true);
  }

  // ③ 具体实施方式（最多三次）
  for (const round of [1, 2, 3] as const) {
    const span = findSection(lines, "具体实施方式");
    if (!span || sectionChars(lines, span) >= EMBODIMENT_TARGET) break;
    const ok = await attempt(
      round === 1 ? "补写替代实施例和应用场景实施例" : round === 2
          ? "补写参数选取依据、技术效果分析和变形实施方式"
          : "补写关键技术特征的具体实现和边界条件处理",
      embodimentPrompt(input, lines, round),
      (reply) => {
        const existing = new Set(subheadings(lines, findSection(lines, "具体实施方式")).map((title) => title.replace(/\s+/g, "")));
        const block = sanitizeSections(reply, existingFigures(lines))
          .split(/\n(?=###\s)/)
          .filter((part) => {
            const title = /^###\s*(.+)$/m.exec(part)?.[1]?.replace(/\s+/g, "") ?? "";
            return title && !existing.has(title) && !/^附图标记/.test(title);
          })
          .join("\n\n");
        if (charCount(block) < 800) return null;
        const current = findSection(lines, "具体实施方式");
        return current ? insertAt(lines, embodimentAnchor(lines, current), block) : null;
      },
    );
    if (!ok) return done(true);
  }

  return done();
}
