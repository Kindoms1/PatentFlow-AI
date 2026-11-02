/**
 * 成稿后的用户主动修改（/修改，或已有申请文件时直接说“把权利要求1放宽”“补充一个实施例”）。
 *
 * 流水线：
 *   1. 把当前申请文件全文和发明人的修改要求交给模型，要求它只输出 {find, replace, reason} 形式的定点补丁，不重写全文；
 *   2. 补丁逐条套用：原文必须能在全文唯一定位（或标明 all 统一替换），不得增删或改名「# 」「## 」级标题；
 *      允许新增「### 」小标题和权利要求，套用后统一核对权利要求从 1 起连续编号、从属权利要求只引用在前的权利要求；
 *   3. 套用后重新做确定性兜底和审查：公开号护栏、摘要字数、附图标记修复、导出前形式核查、公式形式检查、自检评分；
 *      结构被破坏、权利要求编号或引用出错、形式核查由通过变为不通过、附图或公式错误增加、自检分数下降超过 10 分时
 *      整体不采用，原稿保持不变；
 *   4. 采用时保留修改前的版本（最多 5 个）和修改记录（最多 20 条），可以一键撤销。
 *
 * 模型调用通过参数注入（skill-run 传入流式 askModel），便于测试。
 */
import type { Dispatch } from "react";
import type { Action, DraftRevisionRecord, InventionDraftState } from "./model.ts";
import { auditInvention, draftShape } from "./invention-draft.ts";
import type { DraftAudit } from "./invention-draft.ts";
import { formalCheck, parseApplication } from "./cnipa-format.ts";
import type { FormalReport } from "./cnipa-format.ts";
import { FORMULA_CHECK_LABELS, auditFormulas, draftFormulaSources } from "./formula-audit.ts";
import type { FormulaIssue } from "./formula-audit.ts";
import { ABSTRACT_MAX, abstractOverflow, fitAbstract, guardCitations, locateAbstract, replaceAbstract } from "./draft-guards.ts";
import { repairFigureRefs } from "./figure-ref-repair.ts";
import { numberDescriptionFormulas } from "./formula-number.ts";
import { findForbiddenMarkers } from "./draft-polish.ts";
import { getDomain } from "./patent-library.ts";
import { escapeLatexBackslashes } from "./json-latex.ts";

/** 一轮修改最多套用的补丁条数。 */
export const MAX_REVISE_PATCHES = 30;
/** 修改记录最多保留条数。 */
export const MAX_REVISIONS = 20;
/** 撤销栈最多保留的版本数。 */
export const MAX_UNDO = 5;
/** 自检分数允许的最大降幅：超过即不采用。 */
export const REVISE_SCORE_TOLERANCE = 10;

const MAX_FIND = 1500;
const MAX_REPLACE = 8000;
const RECORD_CLIP = 1200;
const DRAFT_CLIP = 60_000;

export type ReviseAsk = (
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  onTrace: (text: string) => void,
  signal?: AbortSignal,
) => Promise<{ ok: boolean; text: string; detail: string; model: string; aborted: boolean }>;

export interface RevisePatch {
  find: string;
  replace: string;
  reason: string;
  /** 同一段原文在多处出现且都要改（例如统一更换一个术语）时为 true。 */
  all?: boolean;
}

export interface ReviseReply {
  patches: RevisePatch[];
  summary: string;
  notes: string[];
  /** 要求含糊或无法在不编造信息的前提下完成时，模型向发明人提出的问题。 */
  question: string;
}

export interface AppliedRevisePatch extends RevisePatch {
  count: number;
}

export interface SkippedRevisePatch extends RevisePatch {
  why: string;
}

export interface RevisionPatchResult {
  text: string;
  applied: AppliedRevisePatch[];
  skipped: SkippedRevisePatch[];
}

export interface RevisionCheck {
  ok: boolean;
  /** 不采用时的原因。 */
  reason: string;
  /** 经过兜底处理（公开号标注、摘要截短、附图标记修复）后的稿件。 */
  text: string;
  auditBefore: DraftAudit;
  audit: DraftAudit;
  formal: FormalReport;
  /** 兜底处理说明，写进对话。 */
  fixes: string[];
}

/** 申请文件卡片上的常用修改要求。 */
export const REVISE_QUICK_ACTIONS: Array<{ label: string; instruction: string }> = [
  {
    label: "放宽独立权利要求",
    instruction:
      "在说明书有支持的前提下放宽独立权利要求的保护范围：删去非必要技术特征，具体数值改为合理范围或上位概念，被删去的细化特征移到从属权利要求，并同步修改发明内容中对应的技术方案。",
  },
  {
    label: "补全公式参数定义",
    instruction:
      "检查全文公式：为每个公式补全“式中”参数定义（物理意义、单位和取值范围），没有编号的公式按出现顺序补上（1）（2）……编号，并同步修改正文中对公式的引用；材料中没有的取值写所属领域常规的取值范围及其确定方法，正文不写任何【待……】占位。",
  },
  {
    label: "补充一个实施例",
    instruction:
      "在具体实施方式中补充一个与现有实施例参数或应用场景不同的实施例，写法与现有实施例一致；材料中没有的数值写所属领域常规的取值范围及其确定方法，正文不写任何【待……】占位，不要编造实验数据。",
  },
  {
    label: "去除绝对化表述",
    instruction:
      "把全文中“最佳”“完全”“彻底”“绝对”“100%”“显著优于”等绝对化或缺少依据的表述改为客观、可支持的表述；权利要求中不得出现“约”“左右”“大致”“例如”等含糊用语。",
  },
  {
    label: "润色说明书摘要",
    instruction: `润色说明书摘要：概括技术领域、技术方案要点和主要用途，语言简洁，不写商业宣传用语，不超过 ${ABSTRACT_MAX} 字。`,
  },
];

export const REVISE_SYSTEM = `你是资深中国专利代理师，正在按发明人的修改要求修改一份已经写好的发明专利申请文件草稿。你只输出 JSON 定点补丁，不重写全文，不解释修改过程。

规则：
1. 只改发明人要求的地方，以及为保持全文一致必须连带修改的地方（例如修改独立权利要求后，发明内容中对应的技术方案段落、摘要中的同一表述也要改）；其他内容一字不动。
2. 每条补丁的 find 必须逐字摘自原文（含标点、空格、公式符号），尽量短，但要能在全文唯一定位；需要在多处统一替换同一词语时把 all 设为 true。
3. 不得增删或改名「# 」「## 」级标题；可以新增「### 」级小标题（例如新增实施例）。新增内容时，find 取插入位置前的一句或一行原文，replace 写成该原文加上新增内容。
4. 新增或删除权利要求时，必须同时给出补丁，使全部权利要求从 1 起连续编号、从属权利要求只引用在前的权利要求，并同步修改受影响的引用关系。
5. 放宽保护范围：删去非必要技术特征，把具体数值改为范围或上位概念，但保留解决技术问题所必需的特征，并确保说明书有支持；收窄保护范围则把细化特征补进独立权利要求或从属权利要求。
6. 不得编造实验数据、百分比、公开号或网址；材料中没有的数值写所属领域常规的取值范围及其确定方法，正文不写任何【待……】占位。原文中残留的【待……】占位：发明人在修改要求中给出对应信息时替换为该信息，否则改写为常规取值范围或确定方法的正式表述；原有的“（模拟值，待实验验证）”“（推断，待确认）”“（待确认）”标注连同所在句子保留不动（不得删除、改写或移动），除非发明人在修改要求中针对该处给出了对应信息；修改要求没有提到的段落，即使其中有审核标注也不要输出补丁。新增或改写的内容中不得出现“模拟值”“待实验验证”“待确认”“待补充”“待填写”“待检索”等审核字样（写成“（模拟值）”“（待实验验证）”或写进句子里都不行），新写的数值一律写成所属领域常规的取值范围及其确定方法，不加审核标注。
7. 发明人没有明确要求新增或修改公式时，不新增公式：新增实施例、补充参数或比较不同应用场景时，用文字写明参数取值范围及其确定方法，需要计算的地方引用原文已有公式的编号（例如“按式（1）计算”），不另写公式或计算式。确需修改或新增公式时，沿用原文已有公式的书写格式和编号方式（编号按原文顺延），公式中的每个符号都要在公式后的“式中”说明中定义，与原文同名符号含义一致，量纲一致。新增实施例或补充参数时：不在符号说明表中新增条目，也不给新出现的量另起变量符号，直接用中文名称描述；不得把原文已有的符号用于另一种含义；提及原文已有符号时写成“中文名称+符号”（例如“作物生长基础温度T_base取10℃”）或只写中文名称，符号后面不得紧跟“为”“表示”“是”“代表”“指”“：”再接说明文字（这种句式会被当作给该符号重新下定义）；引用公式只能用原文说明书中已有的公式编号，不得写出原文没有的式号；实施例中写出的每个参数数值都必须落在权利要求和发明内容中已限定的对应范围之内，应用场景的常规取值超出该范围时，改写为该范围内的取值。
8. 附图说明、附图绘图数据代码块、附图标记和图号不要改动，除非发明人明确要求修改附图；改动部件名称时连同“部件名(标记)”的写法一起改。
9. 要求含糊、与原稿技术方案矛盾，或无法在不编造信息的前提下完成时，不输出补丁，在 question 中用一句话说明还需要发明人提供什么。
10. 本系统没有任何本地文件：不要索要或假设存在检查报告、交底书文件、inspection/、outputs/ 等路径；稿件全文、导出前形式核查问题和此前的修改记录都已在用户消息中给出。修改附图类要求时优先解决形式核查列出的附图问题：附图标记列了但没有任何附图画出的部件，可以去掉正文中“部件名(标记)”里的标记、只保留部件名，并从附图标记列表删去该条。

输出格式：只输出一个 json 代码块，不要输出其他内容。
\`\`\`json
{"summary":"一句话概括这次修改","patches":[{"find":"逐字摘自原文的片段","replace":"修改后的片段","reason":"为什么这样改","all":false}],"notes":["需要发明人确认的事项"],"question":""}
\`\`\``;

const REVISE_VERB =
  /(修改|改写|改成|改为|改得|改一下|改动|改宽|改窄|改短|改长|调整|删除|删去|删掉|删减|去掉|去除|减少|弱化|补充|补上|补全|补齐|增加|增设|添加|加上|加入|加一|新增|完善|润色|精简|压缩|缩短|扩写|扩充|展开|放宽|收窄|缩小|扩大|上位|替换|换成|换为|统一|规范|重写|合并|拆分|拆成|细化|优化|修正|纠正|更正|修复|修好|重新生成|重新出|重画|重绘|补画|补绘|画出|改)/;
const REVISE_TARGET =
  /(权利要求|从属|独立|说明书|摘要|背景技术|发明内容|技术领域|具体实施方式|实施例|附图|配图|图纸|图(?!像|片|形化|标)|全套|申请文件|公式|参数|术语|措辞|表述|用词|说法|语句|错别字|符号|定义|编号|字数|第\s*[一二三四五六七八九十百\d]+\s*[段条项节句步]|全文|稿子|稿件|标题|发明名称|有益效果|技术方案|技术效果|步骤|保护范围|附图标记)/;
const ASKING = /(吗|么|嘛|是否|为什么|为何|怎么样|如何评价|有没有问题|什么意思|对不对|行不行|合理不)\s*[？?]?\s*$/;
const IMPERATIVE = /(请|帮我|帮忙|麻烦|把|将|给我|改成|改为)/;

/**
 * 已有申请文件时，判断一句普通消息是不是修改稿件的要求（动词 + 稿件部位，且不是单纯的疑问）。
 * 斜杠命令、空消息和大段粘贴的材料（超过 600 字）都不算。
 */
export function detectReviseRequest(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.length > 600) return false;
  const cleaned = trimmed.replace(/改(?:进|善|良|变|革|造)/g, "");
  if (!REVISE_VERB.test(cleaned) || !REVISE_TARGET.test(cleaned)) return false;
  const asking = ASKING.test(cleaned) || /^(为什么|为何|是否)/.test(cleaned);
  return !asking || IMPERATIVE.test(cleaned);
}

const PACKAGE_ASK = /(?:全套|整套|完整|全部|所有)[^。！？\n]{0,12}?(?:文件|材料|申请|word|docx|附图|压缩包|zip)|(?:打包|下载|导出)[^。！？\n]{0,8}?(?:文件|全套|申请|word|docx|zip|附图)|\bzip\b/i;

/**
 * 已有申请文件时，“给我完整详细的全套文件”“打包下载”这类话是在要全套文件：
 * 改完稿（或不需要改）后直接在卡片上给出全套 Word、附图和 zip，不进入闲聊。
 */
export function detectPackageRequest(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.length > 600) return false;
  return PACKAGE_ASK.test(trimmed);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}……` : text;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 从模型回复里取出 json 对象：先试代码块，再试第一个“{”到最后一个“}”。补丁里含 ``` 时代码块会被截断，退回第二种。 */
function jsonObject(reply: string): Record<string, unknown> | null {
  const candidates = [...reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1]);
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(reply.slice(start, end + 1));
  for (const raw of candidates) {
    try {
      const data: unknown = parseLoose(raw);
      if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
    } catch {
      // 这一段不是合法 json，换下一个候选
    }
  }
  return null;
}

/** 先按原样解析；失败时把字符串字面量里的裸换行、回车、制表符转义后再试一次（模型常在 replace 里直接换行，JSON.parse 会拒绝）。 */
function parseLoose(raw: string): unknown {
  // LaTeX 反斜杠先修正：否则 \theta 等会被悄悄解析成控制字符，\mathrm 等会让解析报错。
  const text = escapeLatexBackslashes(raw.trim());
  try {
    return JSON.parse(text);
  } catch (error) {
    const fixed = escapeBareControls(text);
    if (fixed === text) throw error;
    return JSON.parse(fixed);
  }
}

/** 只转义 json 字符串字面量内部的裸控制字符（换行、回车、制表符），字符串之外的空白原样保留。 */
export function escapeBareControls(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (!inString) {
      if (ch === "\"") inString = true;
      out += ch;
      continue;
    }
    if (escaped) {
      escaped = false;
      out += ch;
    } else if (ch === "\\") {
      escaped = true;
      out += ch;
    } else if (ch === "\"") {
      inString = false;
      out += ch;
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (ch === "\t") {
      out += "\\t";
    } else {
      out += ch;
    }
  }
  return out;
}

/** 解析模型的修改回复；格式不对时没有补丁。 */
export function parseReviseReply(reply: string): ReviseReply {
  const empty: ReviseReply = { patches: [], summary: "", notes: [], question: "" };
  if (!reply.trim()) return empty;
  const record = jsonObject(reply);
  if (!record) return empty;
  const patches = (Array.isArray(record.patches) ? record.patches : [])
    .map((item) => {
      const row = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      return { find: str(row.find), replace: str(row.replace), reason: str(row.reason).trim(), all: row.all === true };
    })
    .filter((patch) => patch.find.trim() && patch.find !== patch.replace)
    .slice(0, MAX_REVISE_PATCHES);
  const notes = (Array.isArray(record.notes) ? record.notes : [])
    .map(str)
    .map((note) => note.trim())
    .filter(Boolean)
    .slice(0, 8);
  return {
    patches,
    summary: str(record.summary).trim().slice(0, 300),
    notes,
    question: str(record.question).trim().slice(0, 300),
  };
}

/** 「# 」「## 」级标题行：这些是法定章节，修改不得增删或改名。 */
function topHeadings(text: string): string[] {
  return (text.match(/^#{1,2}(?!#)[ \t]+.*$/gm) ?? []).map((line) => line.trim());
}

function patchRefusal(patch: RevisePatch): string {
  if (!patch.find.trim()) return "原文为空";
  if (patch.find.length > MAX_FIND) return "原文片段过长";
  if (patch.replace.length > MAX_REPLACE) return "新增内容过长";
  if (topHeadings(patch.find).join("\n") !== topHeadings(patch.replace).join("\n")) return "会增删或改动一级标题";
  return "";
}

/**
 * 逐条套用补丁。原文只出现一次（或标明 all）才套用；找不到精确文字时容忍空白差异（多出或缺少空白），但仍要求唯一。
 * 增删或改名「# 」「## 」级标题的补丁拒绝；权利要求编号是否连续在全部套用后统一核对（见 claimIssues）。
 */
export function applyRevisionPatches(draft: string, patches: RevisePatch[]): RevisionPatchResult {
  let body = draft;
  const applied: AppliedRevisePatch[] = [];
  const skipped: SkippedRevisePatch[] = [];
  for (const patch of patches.slice(0, MAX_REVISE_PATCHES)) {
    const refusal = patchRefusal(patch);
    if (refusal) {
      skipped.push({ ...patch, why: refusal });
      continue;
    }
    let count = body.split(patch.find).length - 1;
    let pattern: RegExp | null = null;
    if (count === 0) {
      const loose = new RegExp(escapeRegExp(patch.find.trim()).replace(/\s+/g, "\\s*"), "g");
      const hits = body.match(loose)?.length ?? 0;
      if (hits > 0) {
        pattern = loose;
        count = hits;
      }
    }
    if (count === 0) {
      skipped.push({ ...patch, why: "原文中找不到这段文字" });
      continue;
    }
    if (count > 1 && !patch.all) {
      skipped.push({ ...patch, why: `这段文字在全文出现 ${count} 次，无法确定改哪一处` });
      continue;
    }
    const replacement = patch.replace;
    body = pattern ? body.replace(pattern, () => replacement) : body.split(patch.find).join(replacement);
    applied.push({ ...patch, count });
  }
  return { text: body, applied, skipped };
}

/** 「## 权利要求书」一节的正文（到下一个「# 」「## 」级标题为止）；没有这一节时为 null。 */
export function claimSection(text: string): string | null {
  const heading = /^##(?!#)[ \t]*权利要求书[^\n]*$/m.exec(text);
  if (!heading) return null;
  const rest = text.slice(heading.index + heading[0].length);
  const next = /^#{1,2}(?!#)[ \t]/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** 权利要求编号与引用关系的问题：编号须从 1 起连续，从属权利要求只能引用在前的权利要求。 */
export function claimIssues(text: string): string[] {
  const section = claimSection(text);
  if (section === null) return [];
  const starts = [...section.matchAll(/^[ \t]*(\d{1,3})[ \t]*[.、．](?!\d)/gm)];
  if (!starts.length) return ["权利要求书中没有编号的权利要求"];
  const issues: string[] = [];
  const numbers = starts.map((match) => Number(match[1]));
  if (!numbers.every((value, index) => value === index + 1)) issues.push(`权利要求编号不连续（${numbers.join("、")}）`);
  starts.forEach((match, index) => {
    const own = Number(match[1]);
    const from = (match.index ?? 0) + match[0].length;
    const to = index + 1 < starts.length ? (starts[index + 1].index ?? section.length) : section.length;
    const block = section.slice(from, to);
    for (const ref of block.matchAll(/权利要求\s*(\d{1,3})(?:\s*[-—–~～至到]\s*(\d{1,3}))?/g)) {
      const values = [Number(ref[1]), ...(ref[2] ? [Number(ref[2])] : [])];
      for (const value of values) {
        if (value >= own) issues.push(`权利要求${own}引用了在后或自身的权利要求${value}`);
      }
    }
  });
  return [...new Set(issues)];
}

function formalOf(text: string): FormalReport {
  return formalCheck(parseApplication(text));
}

function figureErrors(report: FormalReport): number {
  return report.figureAudit?.errorCount ?? 0;
}

/** 公式自动编号写进 fixes 时的前缀，兜底路径据此识别。 */
export const FORMULA_NUMBER_FIX = "说明书公式编号：";

function formulaErrors(text: string): number {
  return auditFormulas(draftFormulaSources(text)).issues.filter((item) => item.level === "error").length;
}

/**
 * 判断套用补丁后的稿件能否采用，并做确定性兜底（公开号护栏、摘要字数、附图标记修复）。
 * 原稿本身的问题不算在修改头上：只拒绝修改新引入的问题。
 */
export function evaluateRevision(original: string, patched: string, options: { domainId?: string; priorArt: string[] }): RevisionCheck {
  const domain = getDomain(options.domainId);
  const auditOf = (text: string) => auditInvention(text, { domain, priorArt: options.priorArt });
  const auditBefore = auditOf(original);
  const fixes: string[] = [];
  const reject = (reason: string, text: string): RevisionCheck => ({
    ok: false,
    reason,
    text,
    auditBefore,
    audit: auditBefore,
    formal: formalOf(original),
    fixes,
  });

  const shapeBefore = draftShape(original);
  const shapeAfter = draftShape(patched);
  if (shapeBefore.complete && !shapeAfter.complete) return reject(`会破坏申请文件结构（${shapeAfter.reason}）`, patched);

  const claimsBefore = new Set(claimIssues(original));
  const newClaimIssues = claimIssues(patched).filter((issue) => !claimsBefore.has(issue));
  if (newClaimIssues.length) return reject(`权利要求编号或引用关系出错：${newClaimIssues.slice(0, 3).join("；")}`, patched);

  let text = patched;
  const cite = guardCitations(text, options.priorArt);
  if (cite.unknown.length) {
    text = cite.text;
    fixes.push(`修改中出现了检索结果之外的公开号：${cite.unknown.join("、")}，已就地标注“待核实”，不当作对比文件。`);
  }
  if (abstractOverflow(text) > 0 && abstractOverflow(original) <= 0) {
    const block = locateAbstract(text);
    if (block) {
      text = replaceAbstract(text, fitAbstract(block.text));
      fixes.push(`修改后说明书摘要超过 ${ABSTRACT_MAX} 字上限，已按句截短。`);
    }
  }

  // 说明书独立公式全部未编号、正文没有式号引用时按出现顺序补编号；已有编号、多行公式或行尾不确定时原样保留。
  const numbered = numberDescriptionFormulas(text);
  if (numbered.numbered) {
    text = numbered.text;
    fixes.push(`${FORMULA_NUMBER_FIX}按出现顺序为 ${numbered.numbered} 个独立公式补上（1）至（${numbered.numbered}）。`);
  }
  const formalBefore = formalOf(original);
  let formal = formalOf(text);
  if (!formal.exportable && figureErrors(formal) > 0) {
    const repaired = repairFigureRefs(text, { unrefUndrawn: true });
    if (repaired.changes.length) {
      const next = formalOf(repaired.text);
      const improved = figureErrors(next) < figureErrors(formal) || (next.exportable && !formal.exportable);
      if (draftShape(repaired.text).complete === shapeAfter.complete && improved) {
        text = repaired.text;
        formal = next;
        fixes.push(`附图标记确定性修复：${repaired.changes.join("；")}。`);
      }
    }
  }
  if (formalBefore.exportable && !formal.exportable) return reject(`会使导出前形式核查不通过（${clip(formal.fatal, 160)}）`, text);
  if (!formalBefore.exportable && figureErrors(formal) > figureErrors(formalBefore)) {
    return reject(`会使附图问题从 ${figureErrors(formalBefore)} 项增加到 ${figureErrors(formal)} 项`, text);
  }

  const formulasBefore = formulaErrors(original);
  const formulasAfter = formulaErrors(text);
  if (formulasAfter > formulasBefore) return reject(`会使公式形式错误从 ${formulasBefore} 处增加到 ${formulasAfter} 处`, text);

  const audit = auditOf(text);
  if (audit.score < auditBefore.score - REVISE_SCORE_TOLERANCE) {
    return reject(`会使自检分数从 ${auditBefore.score} 分降到 ${audit.score} 分`, text);
  }
  return { ok: true, reason: "", text, auditBefore, audit, formal, fixes };
}

/** 公式形式检查拦下的修改。 */
export function isFormulaRejection(reason: string): boolean {
  return reason.startsWith("会使公式形式错误");
}

/** 套用修改后新增的公式错误（原稿已有的不算）；差集为空时列出修改后的全部错误。 */
export function newFormulaErrorLines(original: string, patched: string, cap = 8): string[] {
  const key = (item: FormulaIssue) => item.id + "|" + item.detail;
  const errorsOf = (text: string) => auditFormulas(draftFormulaSources(text)).issues.filter((item) => item.level === "error");
  const before = new Set(errorsOf(original).map(key));
  const after = errorsOf(patched);
  const fresh = after.filter((item) => !before.has(key(item)));
  return (fresh.length ? fresh : after)
    .slice(0, cap)
    .map((item) => `【${FORMULA_CHECK_LABELS[item.id]}】${item.detail}${item.where.length ? `（位置：${item.where.slice(0, 3).join("、")}）` : ""}`);
}

/** 公式重试时提供给模型的原稿上下文：发生冲突的符号在原稿中的含义、原稿说明书已有的公式编号。 */
export interface FormulaRetryContext {
  symbols: Array<{ key: string; meaning: string }>;
  labels: string[];
}

export function formulaRetryContext(original: string, lines: string[]): FormulaRetryContext {
  const report = auditFormulas(draftFormulaSources(original));
  const keys = new Set<string>();
  for (const line of lines) for (const hit of line.matchAll(/符号\s*(\S+?)\s*有\s*\d+\s*种含义/g)) keys.add(hit[1]);
  const symbols: FormulaRetryContext["symbols"] = [];
  for (const key of keys) {
    const defs = report.symbols.filter((def) => def.key === key);
    const best = defs.find((def) => def.kind !== "term") ?? defs[0];
    if (best) symbols.push({ key, meaning: best.meaning });
  }
  const labels = [...new Set(report.formulas.filter((entry) => entry.display && entry.label && !/^权利要求/.test(entry.where)).map((entry) => entry.label as string))];
  return { symbols, labels };
}

/** 公式错误增加时反馈给模型的重试要求。 */
export function formulaRetryPrompt(lines: string[], context: FormulaRetryContext = { symbols: [], labels: [] }): string {
  return [
    "你上一轮给出的修改套用后，公式形式检查新增了下列错误，整轮修改因此没有采用：",
    ...(lines.length ? lines.map((line) => "· " + line) : ["· 公式形式错误数量增加"]),
    ...(context.symbols.length ? ["原稿中这些符号已有固定含义，只能按原含义使用：", ...context.symbols.map((item) => `· ${item.key}：${item.meaning}`)] : []),
    context.labels.length
      ? `原稿说明书已有的公式编号：${context.labels.map((label) => `（${label}）`).join("")}；正文只能引用这些式号，不新增公式时不要写出其他式号。`
      : "原稿说明书中没有带编号的公式，不要写“式（n）”形式的引用。",
    "请保持修改意图不变，重新给出完整的定点修改 JSON（输出格式与上一轮相同，find 仍须逐字摘自原稿），并做到：",
    "1. 新增公式的写法、下标和编号方式与原稿已有公式保持一致；",
    "2. 公式中的每个符号都在紧随其后的“式中”说明里定义，不得用原稿已有符号表示另一含义；",
    "3. 求和写明下标范围，例如 \\sum_{k=1}^{K}；",
    "4. 不得改动权利要求中的公式使其与说明书不一致；",
    "5. 不用公式也能说清的内容直接用文字表述，不要硬加公式；",
    "6. 提及原稿已有符号时写成“中文名称+符号”（例如“作物生长基础温度T_base取……”）或只写中文名称；不要写成“符号：……”“符号为……”“符号表示……”的句式，这类写法会被当作给该符号重新下定义。",
  ].join("\n");
}

/** 采用修改后的稿件状态：修改前的版本压入撤销栈（不含它自己的撤销栈），修改记录追加一条。 */
export function buildRevisedDraft(
  previous: InventionDraftState,
  next: { text: string; audit: DraftAudit; model: string; at: string },
  record: DraftRevisionRecord,
): InventionDraftState {
  const { undo = [], ...snapshot } = previous;
  return {
    ...previous,
    text: next.text,
    score: next.audit.score,
    at: next.at,
    model: next.model || previous.model,
    pendingMarks: next.audit.pendingMarks,
    claimCount: next.audit.claims.length,
    checks: next.audit.checks.map((item) => ({ label: item.label, ok: item.ok, detail: item.detail })),
    revisions: [...(previous.revisions ?? []), record].slice(-MAX_REVISIONS),
    undo: [...undo, snapshot].slice(-MAX_UNDO),
  };
}

/** 给模型的修改提示：修改要求、此前的修改、待确认事项、可引用的对比文件和全文。 */
export function buildRevisePrompt(draft: InventionDraftState, instruction: string): string {
  const earlier = (draft.revisions ?? []).slice(-3);
  return [
    `【发明人的修改要求】\n${instruction}`,
    earlier.length
      ? `【此前已做的修改（保持一致，不要回退）】\n${earlier.map((item, index) => `${index + 1}. ${item.instruction}${item.summary ? `（${item.summary}）` : ""}`).join("\n")}`
      : "",
    draft.pending.length ? `稿件中仍需发明人补充的事项（供修改参考，正文不写占位）：\n${draft.pending.map((item, index) => `${index + 1}. ${item}`).join("\n")}` : "",
    draft.priorArt.length
      ? `【可以引用的对比文件（不得引用其他公开号）】\n${draft.priorArt.map((ref) => `${ref.pn}《${ref.title}》`).join("\n")}`
      : "【可以引用的对比文件】无，不得新增任何公开号。",
    (() => {
      const formal = formalOf(draft.text);
      return formal.exportable ? "" : `【导出前形式核查当前发现的问题（修改附图或要全套文件时一并解决）】\n${clip(formal.fatal, 800)}`;
    })(),
    `【申请文件全文】\n${clip(draft.text, DRAFT_CLIP)}`,
    "请按系统要求只输出一个 json 代码块。",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** 发了 /修改 但没写要求时的说明。 */
export function reviseHelp(): string {
  return [
    "直接说要怎么改就行，我只改你指出的地方，改完重新自检和形式核查，不达标就保留原稿。例如：",
    "· 把权利要求1放宽一点，阈值改成范围",
    "· 改写具体实施方式第3段，语言更简洁",
    "· 补充一个实施例",
    "· 把公式中的参数定义补全",
    "· 减少背景技术中的绝对化表述",
    "改错了可以在申请文件卡片上点「撤销上次修改」。",
  ].join("\n");
}

export interface ReviseTurnInput {
  caseId: string;
  draft?: InventionDraftState | null;
  instruction: string;
  dispatch: Dispatch<Action>;
  signal?: AbortSignal;
}

export interface ReviseDeps {
  ask: ReviseAsk;
  now?: () => Date;
}

export type ReviseOutcome = "no-draft" | "empty" | "stopped" | "failed" | "question" | "nothing" | "rejected" | "applied";

function skippedLines(skipped: SkippedRevisePatch[], limit = 4): string[] {
  return skipped.slice(0, limit).map((item) => `· ${item.reason || clip(item.find.replace(/\s+/g, " "), 40)}：${item.why}`);
}

/** 全套文件在哪里、还差什么。 */
export function packageLine(formal: FormalReport): string {
  return formal.exportable
    ? "全套申请文件在申请文件卡片上：可以逐件下载 Word，也可以点「下载全套（zip）」一次拿到说明书摘要、摘要附图、权利要求书、说明书、说明书附图（含 300 dpi PNG）、内部审核单和合订稿。"
    : `全套文件可以在申请文件卡片上下载，但导出前形式核查还有问题：${clip(formal.fatal, 160)}。问题写在内部审核单里；也可以直接说“修复附图”或指出要改的地方。`;
}

/**
 * 模型没有给出可用修改（空回复、无补丁、复核不通过）或只是要全套文件时的确定性兜底：
 * ① 稿件有附图标记问题就做确定性修复（含未画出部件去标记），复核不变差且附图问题减少才采用；
 * ② 说明书独立公式全部未编号、正文也没有式号引用时按出现顺序补编号（由 evaluateRevision 完成，已有编号或不确定时不动）。
 * 采用时记为一次修改，可撤销。
 */
function figureFallback(
  input: ReviseTurnInput,
  draft: InventionDraftState,
  deps: ReviseDeps,
  say: (text: string) => void,
  trace: (text: string) => void,
): ReviseOutcome | null {
  const before = formalOf(draft.text);
  const options = { domainId: draft.domain, priorArt: draft.priorArt.map((ref) => ref.pn) };
  let check: RevisionCheck | null = null;
  let figureChanges: string[] = [];
  if (!before.exportable && figureErrors(before) > 0) {
    const repaired = repairFigureRefs(draft.text, { unrefUndrawn: true });
    if (repaired.changes.length) {
      const tried = evaluateRevision(draft.text, repaired.text, options);
      if (tried.ok && figureErrors(tried.formal) < figureErrors(before)) {
        check = tried;
        figureChanges = repaired.changes;
      } else {
        trace(`附图标记确定性修复没有采用：${tried.ok ? "附图问题没有减少" : tried.reason}。`);
      }
    }
  }
  if (!check) {
    if (!numberDescriptionFormulas(draft.text).numbered) return null;
    const tried = evaluateRevision(draft.text, draft.text, options);
    if (!tried.ok || tried.text === draft.text) return null;
    check = tried;
  }
  const formulaChanges = check.fixes.filter((fix) => fix.startsWith(FORMULA_NUMBER_FIX));
  if (!figureChanges.length && !formulaChanges.length) return null;
  const changes = [...figureChanges, ...formulaChanges];
  const at = (deps.now?.() ?? new Date()).toISOString();
  const record: DraftRevisionRecord = {
    at,
    instruction: clip(input.instruction.trim(), 600),
    summary: figureChanges.length ? (formulaChanges.length ? "附图标记确定性修复、说明书公式编号" : "附图标记确定性修复") : "说明书公式编号",
    applied: changes.map((change) => ({ find: "", replace: "", reason: clip(change, RECORD_CLIP) })),
    skipped: [],
    notes: [],
    scoreBefore: check.auditBefore.score,
    scoreAfter: check.audit.score,
    model: draft.model,
  };
  const next = buildRevisedDraft(draft, { text: check.text, audit: check.audit, model: draft.model, at }, record);
  input.dispatch({ type: "revise-invention-draft", caseId: input.caseId, draft: next });
  if (figureChanges.length) trace(`附图标记确定性修复：${figureChanges.join("；")}。`);
  if (formulaChanges.length) trace(formulaChanges.join("；"));
  const round = next.revisions?.length ?? 1;
  const figureLine = figureChanges.length ? `附图问题 ${figureErrors(before)} → ${figureErrors(check.formal)} 项；` : "";
  say(
    [
      figureChanges.length
        ? `已自动修好附图问题${formulaChanges.length ? "并补上说明书公式编号" : ""}（第 ${round} 次修改）：`
        : `已为说明书公式补上编号（第 ${round} 次修改）：`,
      ...changes.slice(0, 6).map((change) => `· ${change}`),
      `自检 ${check.auditBefore.score} → ${check.audit.score} 分，${next.claimCount} 条权利要求；${figureLine}导出前形式核查${check.formal.exportable ? "通过" : `未通过：${clip(check.formal.fatal, 120)}`}。`,
      packageLine(check.formal),
      "不满意可以点「撤销上次修改」恢复。",
    ].join("\n"),
  );
  return "applied";
}
/** 标准模拟值标注（与 auto-flow.ts 的 SIMULATED_MARK 一致）：导出时从正式文件去掉并列入内部审核单。 */
const SIMULATED_MARK_TEXT = "（模拟值，待实验验证）";
/** 非标准的括号模拟值标注：（模拟值）（模拟数值）（模拟值，需实验验证）（待实验验证）等；标准写法也匹配，替换后不变。 */
const SIMULATED_VARIANT = /[（(][ \t]*(?:模拟数?值(?:[ \t]*[，,、;；][ \t]*(?:待|需|须|有待)?[ \t]*(?:实验)?[ \t]*验证)?|(?:待|需|须|有待)[ \t]*实验[ \t]*验证)[ \t]*[)）]/g;
const FENCE_LINE = /^\s*(?:```|~~~)/;

/** 把非标准的括号模拟值标注归一为“（模拟值，待实验验证）”；代码块（附图绘图数据等）内不动。不删除标注，避免模拟数值变成看似实测的数值。 */
export function normalizeSimulatedMarks(text: string): { text: string; count: number } {
  let fenced = false;
  let count = 0;
  const lines = text.split("\n").map((line) => {
    if (FENCE_LINE.test(line)) {
      fenced = !fenced;
      return line;
    }
    if (fenced) return line;
    return line.replace(SIMULATED_VARIANT, (match) => {
      if (match !== SIMULATED_MARK_TEXT) count += 1;
      return SIMULATED_MARK_TEXT;
    });
  });
  return { text: lines.join("\n"), count };
}

function normalizePatchMarks<T extends { replace: string }>(patches: T[], trace: (text: string) => void): T[] {
  let total = 0;
  const next = patches.map((patch) => {
    const { text, count } = normalizeSimulatedMarks(patch.replace);
    total += count;
    return count ? { ...patch, replace: text } : patch;
  });
  if (total) trace(`修改中有 ${total} 处非标准的模拟值标注，已统一为“${SIMULATED_MARK_TEXT}”，导出时移入内部审核单。`);
  return next;
}

/** 复核失败原因是正式文件中残留内部占位或审核标记（cnipa-format 的 forbidden-marks 拦截）。 */
export function isMarkerRejection(reason: string): boolean {
  return /内部占位或审核标记/.test(reason);
}

/** 内部标记被拦截后给模型的重试要求。 */
export function markerRetryPrompt(marks: string[]): string {
  const shown = marks.length ? marks.slice(0, 8).map((mark) => `“${mark}”`).join("、") : "内部审核字样";
  return [
    `上一次给出的补丁会让正式申请文件中出现 ${shown}，导出前形式核查因此不通过，修改没有采用。`,
    "正式文件中不得出现“模拟值”“待实验验证”“待确认”“待补充”“待填写”“待检索”或【待……】等字样。请按同一修改要求重新输出全部补丁（find 仍逐字摘自原稿，不要在上一次补丁的基础上改），把这些字样改写为所属领域常规取值范围及其确定方法的正式表述。",
    "只输出一个 json 代码块，不要输出其他内容。",
  ].join("\n");
}

/** 回复里取不到可解析的 json 补丁时的重试反馈。 */
export function formatRetryPrompt(): string {
  return [
    "上一次的回复不是可以解析的 json，系统取不到补丁，修改没有采用。",
    "请按同一修改要求重新输出全部补丁：只输出一个 json 代码块，字段为 summary、patches、notes、question；字符串里的换行写成 \\n，英文双引号写成 \\\"；find 仍逐字摘自原稿。",
    "确实无法完成修改时 patches 留空，在 question 中用一句话说明还需要发明人提供什么。",
  ].join("\n");
}

/** 补丁全部无法在原稿中唯一定位时的重试反馈：列出定位失败的 find 及原因。 */
export function anchorRetryPrompt(skipped: SkippedRevisePatch[]): string {
  const shown = skipped.slice(0, 6).map((item) => "· “" + clip(item.find.replace(/\s+/g, " "), 60) + "”：" + item.why);
  return [
    "上一次给出的补丁都无法在原稿中唯一定位，修改没有采用：",
    ...shown,
    "请按同一修改要求重新输出全部补丁（不要在上一次补丁的基础上改）：find 必须逐字复制原稿中连续的一句话或一行，含标点和空格，不改写、不省略、不跨段拼接，并且在全文只出现一次；新增内容时 find 取插入位置前的一句原文，replace 写成该原文加上新增内容。",
    "只输出一个 json 代码块，不要输出其他内容。",
  ].join("\n");
}

export async function runReviseTurn(input: ReviseTurnInput, deps: ReviseDeps): Promise<ReviseOutcome> {
  const { caseId, dispatch, signal } = input;
  const trace = (text: string) => dispatch({ type: "chat-note", caseId, role: "trace", text });
  const say = (text: string) => dispatch({ type: "chat-note", caseId, role: "assistant", text });
  const draft = input.draft;
  if (!draft?.text?.trim()) {
    say("这个会话还没有写好的申请文件，暂时没有可以修改的稿子。先发送 /发明稿 或 /一键成稿 生成全套文件，再提修改要求。");
    return "no-draft";
  }
  const instruction = input.instruction.trim();
  if (!instruction) {
    say(reviseHelp());
    return "empty";
  }

  // 只是要全套文件（没有具体修改要求）：不调模型，有附图问题先确定性修复，再告诉发明人全套文件在哪。
  if (detectPackageRequest(instruction) && !detectReviseRequest(instruction)) {
    const fixed = figureFallback(input, draft, deps, say, trace);
    if (fixed) return fixed;
    say(packageLine(formalOf(draft.text)));
    return "nothing";
  }
  // 带反馈的重试：带上原要求和上一次回复，再追加一句反馈。格式重试和定位重试共用一次机会，控制总耗时。
  const askAgain = (previous: string, feedback: string) =>
    deps.ask(
      [
        { role: "system", content: REVISE_SYSTEM },
        { role: "user", content: buildRevisePrompt(draft, instruction) },
        { role: "assistant", content: previous },
        { role: "user", content: feedback },
      ],
      trace,
      signal,
    );
  let feedbackRetried = false;
  trace("修改申请文件：只改你指出的地方，其余内容不动；改完重新自检、核对权利要求编号和导出前形式核查，不达标就保留原稿。");
  let reply = await deps.ask(
    [
      { role: "system", content: REVISE_SYSTEM },
      { role: "user", content: buildRevisePrompt(draft, instruction) },
    ],
    trace,
    signal,
  );
  if (signal?.aborted || reply.aborted) {
    say("已停止这一轮，申请文件没有改动。");
    return "stopped";
  }
  // 模型偶尔返回空内容：自动重试一次；仍为空时做附图确定性兜底，再告诉发明人。
  if (!reply.ok || !reply.text.trim()) {
    trace(`模型这次没有返回可用内容（${reply.detail || "无返回"}），自动重试一次。`);
    reply = await deps.ask(
      [
        { role: "system", content: REVISE_SYSTEM },
        { role: "user", content: buildRevisePrompt(draft, instruction) },
      ],
      trace,
      signal,
    );
    if (signal?.aborted || reply.aborted) {
      say("已停止这一轮，申请文件没有改动。");
      return "stopped";
    }
  }
  if (!reply.ok || !reply.text.trim()) {
    const fixed = figureFallback(input, draft, deps, say, trace);
    if (fixed) return fixed;
    say(`这次修改没有完成：模型没有返回结果（${reply.detail || "无返回"}）。申请文件没有改动，可以再发一次修改要求。`);
    return "failed";
  }

  let parsed = parseReviseReply(reply.text);
  // 回复里取不到 json 补丁，也没有 summary/question 说明为何不改：把格式要求反馈给模型，自动重试一次。
  if (!parsed.patches.length && !parsed.question && !parsed.summary) {
    feedbackRetried = true;
    trace("模型的回复里取不到可以解析的补丁（开头：" + clip(reply.text.replace(/\s+/g, " "), 80) + "），把格式要求反馈给模型，自动重试一次。");
    const retry = await askAgain(reply.text, formatRetryPrompt());
    if (signal?.aborted || retry.aborted) {
      say("已停止这一轮，申请文件没有改动。");
      return "stopped";
    }
    const retried = retry.ok && retry.text.trim() ? parseReviseReply(retry.text) : null;
    if (retried && (retried.patches.length || retried.question || retried.summary)) {
      trace(retried.patches.length ? "重试给出 " + retried.patches.length + " 条补丁。" : "重试没有给出补丁，模型说明了原因。");
      reply = retry;
      parsed = retried;
    } else {
      trace("重试仍没有给出可以解析的补丁。");
    }
  }
  if (!parsed.patches.length) {
    const fixed = figureFallback(input, draft, deps, say, trace);
    if (fixed) return fixed;
    if (parsed.question) {
      say(`要按这个要求修改，还需要你确认：${parsed.question}\n申请文件暂时没有改动。`);
      return "question";
    }
    say(
      parsed.summary
        ? `这次没有改动申请文件：${parsed.summary}`
        : "模型没有给出可以套用的修改，申请文件没有改动。可以把要求说得更具体一些，例如指明权利要求编号、段落，或直接给出要替换的原话。",
    );
    return "nothing";
  }

  let patched = applyRevisionPatches(draft.text, normalizePatchMarks(parsed.patches, trace));
  trace(`模型给出 ${parsed.patches.length} 条定点修改，可以唯一定位的 ${patched.applied.length} 条${patched.skipped.length ? `，${patched.skipped.length} 条无法套用` : ""}。`);
  // 补丁全部定位失败：把失败的原文片段反馈给模型，自动重试一次。
  if (!patched.applied.length && patched.skipped.length && !feedbackRetried) {
    feedbackRetried = true;
    trace("把无法定位的原文片段反馈给模型，自动重试一次。");
    const retry = await askAgain(reply.text, anchorRetryPrompt(patched.skipped));
    if (signal?.aborted || retry.aborted) {
      say("已停止这一轮，申请文件没有改动。");
      return "stopped";
    }
    const retried = retry.ok && retry.text.trim() ? parseReviseReply(retry.text) : null;
    if (retried?.patches.length) {
      const again = applyRevisionPatches(draft.text, normalizePatchMarks(retried.patches, trace));
      trace("重试给出 " + retried.patches.length + " 条定点修改，可以唯一定位的 " + again.applied.length + " 条。");
      if (again.applied.length) {
        reply = retry;
        parsed = retried;
        patched = again;
      }
    } else {
      trace("重试没有给出可以套用的修改。");
    }
  }
  if (!patched.applied.length) {
    const fixed = figureFallback(input, draft, deps, say, trace);
    if (fixed) return fixed;
    say(["这次给出的修改都无法在原文中唯一定位，申请文件没有改动：", ...skippedLines(patched.skipped), "可以换个说法，或指明要改的原句。"].join("\n"));
    return "nothing";
  }

  const priorArt = draft.priorArt.map((ref) => ref.pn);
  let check = evaluateRevision(draft.text, patched.text, { domainId: draft.domain, priorArt });
  check.fixes.forEach((line) => trace(line));
  // 只因内部审核字样被形式核查拦下：把问题片段反馈给模型重试一次，重试结果同样走完整复核。
  if (!check.ok && isMarkerRejection(check.reason)) {
    const marks = findForbiddenMarkers(patched.applied.map((item) => item.replace).join("\n"));
    trace(`修改后正式文件里会出现内部审核字样（${marks.length ? marks.slice(0, 5).join("、") : "见形式核查"}），把问题反馈给模型，自动重试一次。`);
    const retry = await deps.ask(
      [
        { role: "system", content: REVISE_SYSTEM },
        { role: "user", content: buildRevisePrompt(draft, instruction) },
        { role: "assistant", content: reply.text },
        { role: "user", content: markerRetryPrompt(marks) },
      ],
      trace,
      signal,
    );
    if (signal?.aborted || retry.aborted) {
      say("已停止这一轮，申请文件没有改动。");
      return "stopped";
    }
    const retried = retry.ok && retry.text.trim() ? parseReviseReply(retry.text) : null;
    if (retried?.patches.length) {
      const again = applyRevisionPatches(draft.text, normalizePatchMarks(retried.patches, trace));
      if (again.applied.length) {
        const recheck = evaluateRevision(draft.text, again.text, { domainId: draft.domain, priorArt });
        recheck.fixes.forEach((line) => trace(line));
        if (recheck.ok) {
          trace(`重试给出的 ${again.applied.length} 条修改复核通过。`);
          reply = retry;
          parsed = retried;
          patched = again;
          check = recheck;
        } else {
          trace(`重试后复核仍没有通过：${recheck.reason}。`);
        }
      } else {
        trace("重试给出的修改都无法在原文中唯一定位。");
      }
    } else {
      trace("重试没有给出可以套用的修改。");
    }
  }
  // 只因公式形式错误增加被拦下：把新增的公式问题反馈给模型重试一次，重试结果同样走完整复核。
  if (!check.ok && isFormulaRejection(check.reason)) {
    const lines = newFormulaErrorLines(draft.text, check.text);
    trace(`修改后公式形式检查新增错误（${lines.length ? lines.slice(0, 3).join("；") : check.reason}），把问题反馈给模型，自动重试一次。`);
    const retry = await deps.ask(
      [
        { role: "system", content: REVISE_SYSTEM },
        { role: "user", content: buildRevisePrompt(draft, instruction) },
        { role: "assistant", content: reply.text },
        { role: "user", content: formulaRetryPrompt(lines, formulaRetryContext(draft.text, lines)) },
      ],
      trace,
      signal,
    );
    if (signal?.aborted || retry.aborted) {
      say("已停止这一轮，申请文件没有改动。");
      return "stopped";
    }
    const retried = retry.ok && retry.text.trim() ? parseReviseReply(retry.text) : null;
    if (retried?.patches.length) {
      const again = applyRevisionPatches(draft.text, normalizePatchMarks(retried.patches, trace));
      if (again.applied.length) {
        const recheck = evaluateRevision(draft.text, again.text, { domainId: draft.domain, priorArt });
        recheck.fixes.forEach((line) => trace(line));
        if (recheck.ok) {
          trace(`重试给出的 ${again.applied.length} 条修改复核通过。`);
          reply = retry;
          parsed = retried;
          patched = again;
          check = recheck;
        } else {
          trace(`重试后复核仍没有通过：${recheck.reason}。`);
          if (isFormulaRejection(recheck.reason)) {
            const still = newFormulaErrorLines(draft.text, recheck.text, 3);
            if (still.length) trace(`重试后仍有的公式问题：${still.join("；")}`);
          }
        }
      } else {
        trace("重试给出的修改都无法在原文中唯一定位。");
      }
    } else {
      trace("重试没有给出可以套用的修改。");
    }
  }
  if (!check.ok) {
    const fixed = figureFallback(input, draft, deps, say, trace);
    if (fixed) return fixed;
    trace(`修改后复核没有通过：${check.reason}，整体放弃，保留原稿。`);
    const formulaDetail = isFormulaRejection(check.reason) ? newFormulaErrorLines(draft.text, check.text, 5) : [];
    say(
      [
        `这次修改没有采用：${check.reason}。申请文件保持原样。`,
        ...(formulaDetail.length ? ["新增的公式问题：", ...formulaDetail.map((line) => `· ${line}`)] : []),
        "模型尝试的修改：",
        ...patched.applied.slice(0, 5).map((item) => `· ${item.reason || clip(item.replace.replace(/\s+/g, " "), 40)}`),
        "可以把要求拆小一点再试，例如一次只改一条权利要求或一个段落。",
      ].join("\n"),
    );
    return "rejected";
  }

  const at = (deps.now?.() ?? new Date()).toISOString();
  const record: DraftRevisionRecord = {
    at,
    instruction: clip(instruction, 600),
    summary: parsed.summary,
    applied: patched.applied.map((item) => ({ find: clip(item.find, RECORD_CLIP), replace: clip(item.replace, RECORD_CLIP), reason: item.reason })),
    skipped: patched.skipped.map((item) => ({ find: clip(item.find, RECORD_CLIP), reason: item.reason, why: item.why })),
    notes: parsed.notes,
    scoreBefore: check.auditBefore.score,
    scoreAfter: check.audit.score,
    model: reply.model || draft.model,
  };
  const next = buildRevisedDraft(draft, { text: check.text, audit: check.audit, model: reply.model, at }, record);
  dispatch({ type: "revise-invention-draft", caseId, draft: next });

  const round = next.revisions?.length ?? 1;
  const lines = [
    `已按你的要求修改申请文件（第 ${round} 次修改）${parsed.summary ? `：${parsed.summary}` : "。"}`,
    `改动 ${patched.applied.length} 处：`,
    ...patched.applied.slice(0, 8).map((item) => `· ${item.reason || clip(item.replace.replace(/\s+/g, " "), 40)}${item.count > 1 ? `（${item.count} 处统一替换）` : ""}`),
    ...(patched.applied.length > 8 ? [`· 其余 ${patched.applied.length - 8} 处见修改记录`] : []),
    `自检 ${check.auditBefore.score} → ${check.audit.score} 分，${next.claimCount} 条权利要求；导出前形式核查${check.formal.exportable ? "通过" : `未通过：${clip(check.formal.fatal, 120)}`}。`,
  ];
  if (patched.skipped.length) lines.push(`另有 ${patched.skipped.length} 条修改无法在原文中唯一定位，没有套用：`, ...skippedLines(patched.skipped));
  if (check.fixes.length) lines.push(...check.fixes);
  if (parsed.notes.length) lines.push("需要你确认：", ...parsed.notes.slice(0, 6).map((note, index) => `${index + 1}. ${note}`));
  lines.push("申请文件卡片上的 Word 和打包下载已经是修改后的版本；不满意可以点「撤销上次修改」恢复，或继续提修改要求。");
  say(lines.join("\n"));
  return "applied";
}
