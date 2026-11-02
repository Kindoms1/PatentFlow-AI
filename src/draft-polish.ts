/**
 * 成稿清洗与说明书行文规范（成稿、分节扩写、预览和导出共用）。
 *
 * - stripInternalMarkers：去掉模型偶发写进申请文件正文的内部检索/审核提示，例如“【待检索补充对比文件】”
 *   “（待检索）”。这些标记只对撰写流程有意义，出现在交给用户审阅的稿件和 Word 中属于缺陷。
 * - formalizePendingMarks：把“【待发明人确认：……】”“【待填写】”一类缺项占位改写为正式表述
 *   （“……根据实际应用需求确定”“……以实际测试记录为准”），不编造任何数值；被改写的占位原文逐条返回，
 *   由调用方列入内部审核单，缺失的事实不会被静默丢弃。
 *   模拟与未验证数值保留明确的示例性、非实测与仍需实验核验的限定，不得仅删除其不确定性。
 * - findForbiddenMarkers：导出前的最后一道拦截，列出仍然残留的禁用标记。
 * 代码块（附图绘图数据、结尾 json）在清洗和改写时都原样保留。
 * - SPEC_STYLE_GUIDE：说明书递进式行文规范，注入成稿和分节扩写的系统提示词。
 */

import { formalizeSimulationAnnotations } from "./review-annotations.ts";

/** 方括号内含这些字样的是内部工作提示，不是申请文件内容。 */
const INTERNAL_KEYWORDS = /检索|对比文件|查新|内部审核|占位/;
const BRACKET_MARK = /【([^】\n]{1,40})】/g;
const PAREN_MARK = /[（(]\s*待(?:检索|补充对比文件|补充检索)[^）)\n]{0,20}\s*[)）]/g;
const FENCE = /^\s*```/;

/** 缺项占位：任何【待……】（内部检索提示已由 stripInternalMarkers 先行去掉），如【待发明人确认：……】【待填写】【待定】。 */
const PENDING_MARK = /【\s*待[^】\n]*】/g;
/** 缺项括注：（待实验验证）（待补充）（待填写）（待定）。“（推断，待确认）”“（模拟值，待实验验证）”由审核标注规则处理。 */
const PENDING_PAREN = /[（(][ \t]*待(?:实验验证|补充|填写|定)[ \t]*[)）]/g;
/** 占位前面紧挨的取值动词：改写时一并去掉，“采样频率为【……】”写成“采样频率根据实际应用需求确定”。 */
const LEAD_VERB = /(?:设定为|设置为|设为|选为|定为|取为|(?<![作成称认因较以分变分别])为|取|是|采用|选用)[ \t]*[：:]?[ \t]*$/;
/** 属于实验或测试数据的缺项：只能以真实记录为准。 */
const DATA_SUBJECT = /数据|结果|实验|试验|测试|测定|实测|记录/;
const DECIDED = "根据实际应用需求确定";
const MEASURED = "以实际测试记录为准";

/**
 * 正式文件中绝不允许出现的标记：任何【待……】，以及待检索、待确认、待实验验证、模拟值、待填写、待补充等内部审核字样。
 * 只用于正式文件的内容（不含代码块和内部审核单）。
 */
export const FORBIDDEN_MARKER = /【\s*待[^】\n]*】|待检索|待发明人确认|待实验验证|模拟值|待填写|待补充对比文件|[（(]\s*(?:推断\s*[，,、]\s*)?待确认\s*[)）]/g;

export interface PolishResult {
  /** 清洗后的全文；没有可去掉的标记时与输入完全相同。 */
  text: string;
  /** 被去掉的标记原文，按出现顺序。 */
  removed: string[];
}

export interface FormalizeResult {
  /** 改写后的全文；没有占位时与输入完全相同。 */
  text: string;
  /** 被改写或去掉的占位原文，按出现顺序（不去重）。 */
  marks: string[];
}

/** 去掉标记后整理本行标点：空括号、重复或错位的句读、行首残留的标点和行尾空白。 */
function tidyLine(line: string): string {
  return line
    .replace(/[（(]\s*[)）]/g, "")
    .replace(/[，、；：]\s*(?=[。！？])/g, "")
    .replace(/([。！？；])\s*[，、；。]+/g, "$1")
    .replace(/，\s*，+/g, "，")
    .replace(/^(\s*(?:[-*]\s+|#{1,6}\s+)?)[，、；。]+\s*/, "$1")
    .replace(/[ \t]+$/, "");
}

/** 逐行处理正文（代码块原样保留），each 返回新行；返回 null 表示本行未改动，返回空串表示删去该行。 */
function mapBodyLines(text: string, each: (line: string) => string | null): { text: string; changed: boolean } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const out: string[] = [];
  let fenced = false;
  let changed = false;
  for (const line of text.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      out.push(line);
      continue;
    }
    if (fenced) {
      out.push(line);
      continue;
    }
    const next = each(line);
    if (next === null) {
      out.push(line);
      continue;
    }
    changed = true;
    const tidied = tidyLine(next);
    // 整行只有标记（或只剩列表符号）时删去该行，不留下空段落。
    if (!tidied.replace(/^\s*(?:[-*]\s*)?/, "").trim()) continue;
    out.push(tidied);
  }
  return { text: changed ? out.join(eol) : text, changed };
}

export function isInternalMark(inner: string): boolean {
  const value = inner.trim();
  if (/^待发明人确认/.test(value)) return false;
  return INTERNAL_KEYWORDS.test(value);
}

/** 去掉正文中的内部检索/审核提示标记（代码块除外），并整理受影响行的标点。 */
export function stripInternalMarkers(text: string): PolishResult {
  const removed: string[] = [];
  const result = mapBodyLines(text, (line) => {
    let changed = false;
    let next = line.replace(BRACKET_MARK, (whole: string, inner: string) => {
      if (!isInternalMark(inner)) return whole;
      removed.push(whole);
      changed = true;
      return "";
    });
    next = next.replace(PAREN_MARK, (whole: string) => {
      removed.push(whole.trim());
      changed = true;
      return "";
    });
    return changed ? next : null;
  });
  return { text: removed.length ? result.text : text, removed };
}

export function hasInternalMarkers(text: string): boolean {
  return stripInternalMarkers(text).removed.length > 0;
}

/** 占位里要发明人补充的事项：取冒号后的部分，去掉“，需来自……”一类说明和省略号。没有冒号时占位不指明事项。 */
export function pendingSubject(mark: string): string {
  const inner = mark.replace(/^【\s*/, "").replace(/\s*】$/, "");
  const colon = /^待[^：:]*[：:]\s*([\s\S]*)$/.exec(inner);
  if (!colon) return "";
  return colon[1]
    .split(/[，,；;（(]/)[0]
    .replace(/^[….。\s]+|[….。\s]+$/g, "")
    .trim();
}

/** 内部审核单里列出的待补充事项（不带方括号）。 */
export function pendingItemText(mark: string): string {
  const inner = mark.replace(/^【\s*/, "").replace(/\s*】$/, "").trim();
  return pendingSubject(mark) || inner.replace(/^待(?:发明人)?(?:确认|补充|填写|定|查)?\s*/, "").trim() || "未指明的事项";
}

/** 改写一行里的占位。 */
function formalizeLine(line: string, marks: string[]): string | null {
  const simulation = formalizeSimulationAnnotations(line);
  const originals = [
    ...simulation.annotations,
    ...[...line.matchAll(PENDING_MARK), ...line.matchAll(PENDING_PAREN)].map((match) => ({ index: match.index, raw: match[0] })),
  ].sort((a, b) => a.index - b.index);
  if (!originals.length) return null;
  for (const [i, original] of originals.entries()) {
    if (i && originals[i - 1].index === original.index && originals[i - 1].raw === original.raw) continue;
    marks.push(original.raw);
  }
  line = simulation.text;
  let out = "";
  let last = 0;
  for (const match of line.matchAll(PENDING_MARK)) {
    const at = match.index ?? 0;
    out += line.slice(last, at);
    last = at + match[0].length;
    const subject = pendingSubject(match[0]);
    const suffix = subject && DATA_SUBJECT.test(subject) ? MEASURED : DECIDED;
    const rest = line.slice(last);
    if (/^\s*的/.test(rest)) {
      // 定语位置（“作为【……：驱动元件】的电机”）：只写事项名称；没有事项时写“根据实际应用需求确定的……”
      out += subject || DECIDED;
      continue;
    }
    const verb = LEAD_VERB.exec(out);
    if (verb) {
      // “X为【……】”：去掉取值动词，写成“X根据实际应用需求确定”
      out = out.slice(0, verb.index) + suffix;
    } else if (subject) {
      // 独立的占位：写成“事项 + 确定方式”；单独成句时补上句号
      const standalone = !out.trim() || /[。！？；]\s*$/.test(out) || /^\s*(?:[-*+]\s+|\d+[.、）)]\s*)$/.test(out);
      out += subject + suffix;
      if (standalone && !/^\s*[，。；！？、：]/.test(rest)) out += "。";
    }
    // 没有事项、也没有可以承接的取值动词时（如单独的“【待填写】”），占位直接去掉
  }
  out += line.slice(last);
  out = out.replace(PENDING_PAREN, "");
  return out;
}

/**
 * 把正文里的缺项占位改写为正式表述（代码块除外）：
 * “采样频率为【待发明人确认：采样频率】”→“采样频率根据实际应用需求确定”；
 * “测试结果为：【待发明人确认：各实施例的测试数据】”→“测试结果以实际测试记录为准”；
 * “，【待发明人确认：窗口长度】。”→“，窗口长度根据实际应用需求确定。”。
 * 不写入任何数值；模拟数值保留“非实测数据”限定，未验证内容保留核验要求。
 * 被改写的占位、混合括注或叙述原文在 marks 中返回。
 */
export function formalizePendingMarks(text: string): FormalizeResult {
  const marks: string[] = [];
  const result = mapBodyLines(text, (line) => formalizeLine(line, marks));
  return { text: marks.length ? result.text : text, marks };
}

/** 正式文件内容中仍残留的禁用标记（代码块除外），按出现顺序去重。 */
export function findForbiddenMarkers(text: string): string[] {
  const found: string[] = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const match of line.matchAll(FORBIDDEN_MARKER)) {
      if (!found.includes(match[0])) found.push(match[0]);
    }
  }
  return found;
}

/** 说明书行文规范：注入成稿（INVENTION_SYSTEM）和分节扩写（EXPAND_SYSTEM）的系统提示词。 */
export const SPEC_STYLE_GUIDE = `【说明书行文规范】
- 技术问题、技术方案、具体实施方式和有益效果逐项对应：每个技术问题都有解决它的技术手段，每个技术手段在具体实施方式中都有展开的实现，每项有益效果都能追溯到具体的技术特征。
- 说明书采用由上位到下位的递进式表述：先写总体方案；用“具体地，”写实现方式；用“进一步地，”写对上一层特征的细化限定；用“优选地，”写优选的参数、结构或算法及其理由；用“在一些实施方式中，”“在另一种可选的实施方式中，”写替代方案；用“示例性地，”给出具体取值或工况示例；用“需要说明的是，”写边界条件和注意事项。上述用语只用于说明书，权利要求仍禁用“优选”“例如”等词。
- 每引入一个技术特征，都同时写清三件事：采用什么手段；为什么这样设置（工作原理、约束条件或参数之间的关系）；产生什么技术效果。不写“大大提高”“显著优越”一类没有技术依据的宣传性语句。
- 方法步骤写成“步骤S1：……”，需要细化时拆为子步骤“S11、……；S12、……”，每一步写清输入、处理过程、输出，以及与前后步骤之间的数据流或控制流（哪一步的输出作为哪一步的输入、在什么条件下跳转或循环）。
- 装置和系统写清各部件或模块的形状、相对位置、连接方式、配合关系、信号或介质的传递路径以及动作过程，部件名称与附图标记一致。
- 关键参数给出取值范围、优选范围和具体值，并说明取值过小或过大时会出现的问题；材料中没有的参数，写所属领域常规的取值范围及其确定方法（例如“可根据……在……范围内选取”），不得写成实测结论；多个实施例之间写清参数、结构或步骤上的差异及其对效果的影响。
- 同一部件、步骤、参数和符号的名称全文一致；相邻段落之间用承接语句衔接，不机械重复同一句式，不整段重复前文。
- 申请文件正文中不得出现任何内部工作提示或占位标记（例如“【待……】”“待检索”“待补充对比文件”“待填写”“此处补充”“略”），所有内容都写成可以直接审阅的正式文本；需要发明人补充的事实写进结尾 json 的 pending，不写进正文。全自动模式要求的“（模拟值，待实验验证）”标注按事实纪律保留；正式化时改写为“示例性设定”或“示例计算”，明确属于“非实测数据”且尚需实验核验，原始标注保留在内部审核单。不得通过删除不确定性限定把假设数值变成实测结论。`;
