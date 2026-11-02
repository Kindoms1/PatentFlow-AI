/**
 * 中国发明专利申请文件（CNIPA）的结构化表示与形式检查。
 *
 * invention-draft.ts 管“写得好不好”（实质自检打分），这里管“是不是一份格式合规、能交给代理师的申请文件”：
 *   - parseApplication：把 Markdown 草稿拆成 说明书摘要 / 摘要附图 / 权利要求书 / 说明书（五部分）/ 说明书附图；
 *   - formalCheck：参照《专利审查指南》对说明书、权利要求书和摘要的形式要求，逐项给出 error / warn。
 * Word 导出（export-docx.ts）和知识库样例都复用这里的结构。
 * 检查只覆盖机器能判断的形式问题，不代表国家知识产权局会受理，也不替代专利代理师审核。
 */
import { parseClaims } from "./invention-draft.ts";
import { auditFormulas, groupFormulaIssues } from "./formula-audit.ts";
import type { FormulaReport, FormulaSource } from "./formula-audit.ts";
import { joinDisplayBlocks, parseDisplayLine, plainParagraph } from "./formula.ts";
import { extractFigureSpecs, stripDraftJsonTail } from "./figure-spec.ts";
import type { FigureSpec, FigureSpecIssue } from "./figure-spec.ts";
import { auditFigures, parseReferenceList } from "./figure-audit.ts";
import type { FigureAuditResult, ReferenceEntry } from "./figure-audit.ts";
import { renderedFiguresOf } from "./figure-assets.ts";
import { stripInternalMarkers, formalizePendingMarks, findForbiddenMarkers } from "./draft-polish.ts";
import { formalizeSimulationAnnotations } from "./review-annotations.ts";

export const DESCRIPTION_HEADINGS = ["技术领域", "背景技术", "发明内容", "附图说明", "具体实施方式"] as const;
export type DescriptionHeading = (typeof DESCRIPTION_HEADINGS)[number];

export interface AppParagraph {
  text: string;
  /** A sub-heading inside a part (### 实施例1, ### 技术方案): printed bold and not paragraph-numbered. */
  sub: boolean;
  /** A display formula line ($$ … $$（n）): exported as a centred Word equation with its number flush right. */
  formula?: { tex: string; label: string | null };
  /** The Markdown line as written, kept for table rows so the formula audit can read symbol tables. */
  raw?: string;
}

export interface DescriptionPart {
  heading: DescriptionHeading;
  paragraphs: AppParagraph[];
}

export interface AppClaim {
  no: number;
  lines: string[];
  refs: number[];
  independent: boolean;
}

export interface AppFigure {
  no: number;
  caption: string;
}

export interface ParsedApplication {
  title: string;
  abstract: string[];
  abstractFigure: number | null;
  claims: AppClaim[];
  description: DescriptionPart[];
  figures: AppFigure[];
  pendingMarks: string[];
  /** 草稿中“（推断，待确认）”“（模拟值，待实验验证）”一类审核标注（带所在句子）；正式文件中已去掉，只列入内部审核单。 */
  reviewAnnotations?: string[];
  /** 草稿中 ```附图 代码块给出的结构化绘图数据（按图号排序）；代码块本身不进入说明书正文。 */
  figureSpecs?: FigureSpec[];
  /** 附图数据中无法识别或自相矛盾的地方。 */
  figureSpecIssues?: FigureSpecIssue[];
  /** “附图标记”列表：标记 → 部件名称。 */
  references?: ReferenceEntry[];
}

export type CheckLevel = "error" | "warn" | "ok";

export interface FormalCheck {
  id: string;
  label: string;
  level: CheckLevel;
  detail: string;
}

export interface FormalStats {
  titleChars: number;
  abstractChars: number;
  claimCount: number;
  independentCount: number;
  descriptionChars: number;
  figureCount: number;
  pendingCount: number;
}

export interface FormalReport {
  checks: FormalCheck[];
  errors: number;
  warnings: number;
  exportable: boolean;
  fatal: string;
  stats: FormalStats;
  /** 公式与符号一致性检查的完整结果（草稿中有公式时）。 */
  formulas?: FormulaReport;
  /** 附图核查的完整结果（草稿给出附图数据时）。 */
  figureAudit?: FigureAuditResult;
}

export const TITLE_SOFT_LIMIT = 25;
export const TITLE_HARD_LIMIT = 40;
export const ABSTRACT_LIMIT = 300;

const PROMO_WORDS = ["国际领先", "国内领先", "国际先进", "国内首创", "填补国内空白", "填补空白", "革命性", "划时代", "独一无二", "世界一流", "最先进"];
const CLAIM_VAGUE = ["例如", "最好是", "尤其是", "必要时", "等等", "或类似物", "大约", "接近于"];
const NUMERIC_APPROX = /\d[\d.]*\s*[A-Za-z%‰℃°μ个次秒分钟小时天倍]*\s*(?:左右|上下)/;
const CLAIM_FIGURE_REF = /如图|图\s*\d+\s*所示|附图\s*\d|如说明书/;
const DESCRIPTION_CLAIM_REF = /如权利要求\s*\d|权利要求\s*\d+\s*(?:所述|中任一)/;

export function countChars(text: string): number {
  return text.replace(/\s/g, "").length;
}

/** Formulas ($…$, $$…$$, \(…\), \[…\]) are shielded from the markdown clean-up and put back verbatim. */
const MATH_SHIELD = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<!\\)\$(?!\$)[^$\n]+?(?<!\\)\$/g;

/** Strip inline markdown so the Word file carries plain text. LaTeX formulas are kept exactly as written. */
export function cleanInline(line: string): string {
  const kept: string[] = [];
  const shielded = line.replace(MATH_SHIELD, (math) => {
    kept.push(math);
    return `\uE000${kept.length - 1}\uE001`;
  });
  return shielded
    .replace(/^\s{0,3}#{1,6}\s*/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/^\s*[-*+]\s+(?=\S)/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\uE000(\d+)\uE001/g, (_match, index: string) => kept[Number(index)] ?? "");
}

/**
 * 审核标注的上下文是从句中截取的片段，截取点可能落在加粗或强调标记的中间（例如“**步骤S1：数据采集。** 田间……”
 * 以“。”断句后只剩闭合的“**”）。cleanInline 只能去掉成对标记，这里再去掉落单的 ** 与 __；公式内的字符原样保留。
 */
export function stripStrayEmphasis(text: string): string {
  const kept: string[] = [];
  const shielded = text.replace(MATH_SHIELD, (math) => {
    kept.push(math);
    return `\uE000${kept.length - 1}\uE001`;
  });
  return shielded
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\uE000(\d+)\uE001/g, (_match, index: string) => kept[Number(index)] ?? "");
}

/** Markdown body to printable paragraphs: drops fences, rules and table separators, keeps sub-headings flagged. */
export function markdownParagraphs(body: string): AppParagraph[] {
  const out: AppParagraph[] = [];
  let fence = false;
  for (const raw of joinDisplayBlocks(body).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*```/.test(line)) {
      fence = !fence;
      continue;
    }
    if (!line.trim()) continue;
    if (fence) {
      out.push({ text: line.trim(), sub: false });
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) continue;
    if (line.includes("|") && line.includes("-") && /^\s*\|?[\s:|-]+\|?\s*$/.test(line)) continue;
    const display = parseDisplayLine(line);
    if (display) {
      out.push({ text: line.trim(), sub: false, formula: display });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cleanInline).filter(Boolean);
      if (cells.length) out.push({ text: cells.join("　"), sub: false, raw: line.trim() });
      continue;
    }
    const sub = /^\s{0,3}#{3,6}\s*\S/.test(line);
    const text = cleanInline(line);
    if (text) out.push({ text, sub });
  }
  return out;
}

interface RawSection {
  head: string;
  body: string;
}

/** Sections at exactly `level` (## = 2); a body runs until the next heading of the same or a higher level. */
function splitLevel(text: string, level: number): RawSection[] {
  const out: RawSection[] = [];
  let current: { head: string; body: string[] } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const hit = /^(#{1,6})(?![#\d])\s*(\S.*)$/.exec(line);
    if (hit && hit[1].length <= level) {
      if (current) out.push({ head: current.head, body: current.body.join("\n").trim() });
      current = hit[1].length === level ? { head: hit[2].trim(), body: [] } : null;
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) out.push({ head: current.head, body: current.body.join("\n").trim() });
  return out;
}

function headMatches(head: string, name: string): boolean {
  const clean = head.replace(/[\s*:：]/g, "").replace(/^[一二三四五六七八九十\d]+[、.．]/, "");
  if (name === "摘要" && clean.startsWith("摘要附图")) return false;
  return clean.startsWith(name);
}

function findSection(text: string, names: string[]): string | null {
  for (const level of [2, 3]) {
    for (const section of splitLevel(text, level)) {
      if (names.some((name) => headMatches(section.head, name))) return section.body;
    }
  }
  return null;
}

/** Every figure number a text points at, with ranges such as “图1至图3” expanded. */
export function figureRefs(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(/图\s*(\d{1,3})(?:\s*(?:-|~|～|至|到)\s*图?\s*(\d{1,3}))?/g)) {
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    for (let value = start; value <= end && value - start < 50; value += 1) found.add(value);
  }
  return [...found].sort((a, b) => a - b);
}

function parseFigures(paragraphs: AppParagraph[]): AppFigure[] {
  const found = new Map<number, string>();
  for (const paragraph of paragraphs) {
    for (const piece of paragraph.text.split(/[；;]/)) {
      const hit = /^\s*图\s*(\d{1,3})\s*(?:为|是|示出了?|表示|：|:|，|,)?\s*(.*?)\s*[。.]?\s*$/.exec(piece);
      if (hit && !found.has(Number(hit[1]))) found.set(Number(hit[1]), hit[2] ?? "");
    }
  }
  return [...found].sort((a, b) => a[0] - b[0]).map(([no, caption]) => ({ no, caption }));
}

/** “附图标记”小节标题（### 附图标记、### 附图标记说明）或以“附图标记：”开头的段落。 */
const REFERENCE_HEAD = /^附图标记(?:说明|列表)?(?:[:：]|$)/;

function referenceHead(paragraph: AppParagraph): boolean {
  return REFERENCE_HEAD.test(paragraph.text.replace(/\s/g, ""));
}

/**
 * 说明书各部分中属于“附图标记”列表的段落：### 附图标记 小标题之后、下一个小标题之前的段落，
 * 以及单独一段“附图标记：10—……；11—……”。附图说明一节不算。
 */
function referenceParagraphs(description: DescriptionPart[]): Set<AppParagraph> {
  const found = new Set<AppParagraph>();
  for (const part of description) {
    if (part.heading === "附图说明") continue;
    let inList = false;
    for (const paragraph of part.paragraphs) {
      if (paragraph.sub) {
        inList = referenceHead(paragraph);
        continue;
      }
      if (inList || referenceHead(paragraph)) found.add(paragraph);
    }
  }
  return found;
}

/** 附图标记列表：优先取“附图标记”小节（## 或 ###），否则取说明书中的“附图标记：……”段落。 */
function parseReferences(text: string, description: DescriptionPart[]): ReferenceEntry[] {
  const section = findSection(text, ["附图标记"]);
  const lines = section !== null
    ? markdownParagraphs(section).map((item) => item.text)
    : [...referenceParagraphs(description)].map((item) => item.text.replace(/^\s*附图标记(?:说明|列表)?\s*[:：]?\s*/, ""));
  const seen = new Set<string>();
  return parseReferenceList(lines.join("\n")).filter((entry) => {
    const key = `${entry.ref}\u0000${entry.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 审核用的行内标注：“（推断，待确认）”“（模拟值，待实验验证）”“（待确认）”以及句首的“待确认：”。
 * 这些是给代理师和发明人看的提示，不得出现在正式申请文件中：解析时从正文去掉，带所在句子收进内部审核单。
 * 【待发明人确认：……】一类缺项占位不在此列：解析时由 formalizePendingMarks 改写为正式表述，原文列入 pendingMarks，由内部审核单逐项列出。
 */
const REVIEW_ANNOTATION = /[（(][ \t]*(?:推断[ \t]*[，,、][ \t]*待确认|模拟值[ \t]*[，,、][ \t]*待实验验证|待确认)[ \t]*[）)]/g;
const REVIEW_PREFIX = /(^[ \t]*(?:[-*+][ \t]+|\d+[.、）)][ \t]*)?|[。；;！？!?])[ \t]*待确认[ \t]*[：:][ \t]*/gm;
const SENTENCE_MARKS = ["\n", "。", "；", "！", "？"];

/** 草稿中的审核标注（带所在句子），按出现顺序去重。 */
export function reviewAnnotationsOf(text: string): string[] {
  const hits: Array<{ at: number; context: string }> = [];
  for (const match of text.matchAll(REVIEW_ANNOTATION)) {
    const at = match.index ?? 0;
    const before = text.slice(Math.max(0, at - 80), at);
    const cut = Math.max(...SENTENCE_MARKS.map((mark) => before.lastIndexOf(mark)));
    hits.push({ at, context: stripStrayEmphasis(cleanInline(`${before.slice(cut + 1)}${match[0]}`)) });
  }
  const inlineMark = new RegExp(REVIEW_ANNOTATION.source);
  for (const { index: at, raw } of formalizeSimulationAnnotations(text).annotations) {
    // Standard bracketed labels were collected above; retain the original text of the other forms too.
    if (inlineMark.exec(raw)?.[0] === raw) continue;
    const before = text.slice(Math.max(0, at - 80), at);
    const cut = Math.max(...SENTENCE_MARKS.map((mark) => before.lastIndexOf(mark)));
    hits.push({ at, context: stripStrayEmphasis(cleanInline(`${before.slice(cut + 1)}${raw}`)) });
  }
  for (const match of text.matchAll(REVIEW_PREFIX)) {
    const at = (match.index ?? 0) + match[1].length;
    const rest = text.slice(at, at + 120);
    const stop = rest.search(/[\n。；！？]/);
    const sentence = stop >= 0 ? rest.slice(0, stop + 1) : rest;
    // 同一句里另有“（推断，待确认）”一类标注时，那一条已带上整句，不重复列出
    if (inlineMark.test(sentence)) continue;
    hits.push({ at, context: stripStrayEmphasis(cleanInline(sentence)) });
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hit of hits.sort((a, b) => a.at - b.at)) {
    if (!hit.context || seen.has(hit.context)) continue;
    seen.add(hit.context);
    out.push(hit.context);
  }
  return out;
}

/** 正式正文保留模拟数值的非实测限定和核验要求；原始审核标注另存。 */
export function stripReviewAnnotations(text: string): string {
  return formalizeSimulationAnnotations(text).text.replace(REVIEW_ANNOTATION, "").replace(REVIEW_PREFIX, "$1");
}
/** Parse a markdown draft (the /发明稿 output or a library sample) into the parts of a CNIPA filing. */
export function parseApplication(markdown: string, fallbackTitle = ""): ParsedApplication {
  // 内部检索/审核提示（如“【待检索补充对比文件】”）不属于申请文件：解析前去掉，导出、预览和形式核查都不再看到（代码块原样保留）。
  const figureData = extractFigureSpecs(stripInternalMarkers(markdown.replace(/\r\n/g, "\n")).text);
  const draftText = stripDraftJsonTail(figureData.text);
  const reviewAnnotations = reviewAnnotationsOf(draftText);
  const annotated = stripReviewAnnotations(draftText);
  // 缺项占位（【待发明人确认：……】【待填写】等）不得出现在正式文件中：正文改写为正式表述，原文保留在 pendingMarks 中供内部审核单列出，缺失的事实不会被静默丢弃。
  const pendingMarks = [...new Set(annotated.match(/【待[^】]*】/g) ?? [])];
  const text = formalizePendingMarks(annotated).text;
  const h1 = /^#(?![#\d])\s*(\S.*)$/m.exec(text);
  const rawTitle = h1?.[1] ?? findSection(text, ["发明名称"]) ?? fallbackTitle;
  const title = cleanInline(rawTitle.split("\n")[0] ?? "")
    .replace(/^发明名称\s*[:：]\s*/, "")
    .replace(/[。．.；;，,\s]+$/, "")
    .trim();

  let abstractFigure: number | null = null;
  const abstract: string[] = [];
  for (const paragraph of markdownParagraphs(findSection(text, ["说明书摘要", "摘要"]) ?? "")) {
    const figure = /摘要附图\s*(?:[:：]|为|是)?\s*图\s*(\d{1,3})/.exec(paragraph.text);
    if (figure) {
      abstractFigure = Number(figure[1]);
      continue;
    }
    abstract.push(paragraph.text);
  }
  if (abstractFigure === null) {
    const figure = /图\s*(\d{1,3})/.exec(findSection(text, ["摘要附图"]) ?? "");
    if (figure) abstractFigure = Number(figure[1]);
  }

  const claimBody = joinDisplayBlocks(findSection(text, ["权利要求书", "权利要求"]) ?? "").split("\n").map(cleanInline).join("\n");
  const claims = parseClaims(claimBody).map((claim) => ({
    no: claim.no,
    lines: claim.text.split("\n").map((line) => line.trim()).filter(Boolean),
    refs: claim.refs,
    independent: claim.independent,
  }));

  const description = DESCRIPTION_HEADINGS.map((heading) => ({ heading, paragraphs: markdownParagraphs(findSection(text, [heading]) ?? "") }));
  const figures = parseFigures(description.find((part) => part.heading === "附图说明")?.paragraphs ?? []);

  return {
    title,
    abstract,
    abstractFigure,
    claims,
    description,
    figures,
    pendingMarks,
    reviewAnnotations,
    figureSpecs: figureData.specs,
    figureSpecIssues: figureData.issues,
    references: parseReferences(text, description),
  };
}

function partText(app: ParsedApplication, heading: DescriptionHeading): string {
  return (app.description.find((part) => part.heading === heading)?.paragraphs ?? []).map((item) => item.text).join("\n");
}

function listNos(values: number[]): string {
  return values.map((value) => `第 ${value} 条`).join("、");
}

/** The parsed application as formula-audit sources: the abstract, each claim, each part of the description. */
export function formulaSourcesOf(app: ParsedApplication): FormulaSource[] {
  const sources: FormulaSource[] = [];
  if (app.abstract.length) sources.push({ part: "说明书摘要", where: "说明书摘要", text: app.abstract.join("\n") });
  for (const claim of app.claims) sources.push({ part: "权利要求书", where: `权利要求${claim.no}`, text: claim.lines.join("\n") });
  for (const part of app.description) sources.push({ part: part.heading, where: part.heading, text: part.paragraphs.map((item) => item.raw ?? item.text).join("\n") });
  return sources;
}

/** 附图核查用的正文：技术领域至具体实施方式，不含附图说明和附图标记列表本身。 */
function figureBodyText(app: ParsedApplication): string {
  const list = referenceParagraphs(app.description);
  return app.description
    .filter((part) => part.heading !== "附图说明")
    .map((part) => part.paragraphs.filter((item) => !list.has(item) && !(item.sub && referenceHead(item))).map((item) => item.raw ?? item.text).join("\n"))
    .join("\n");
}

/** 草稿给出附图数据时的附图核查（图号、绘图数据、附图标记三方一致、步骤、图中文字、黑白与图幅）；没有附图数据时返回 null。 */
export function auditApplicationFigures(app: ParsedApplication): FigureAuditResult | null {
  const specs = app.figureSpecs ?? [];
  if (!specs.length) return null;
  return auditFigures({
    figures: app.figures,
    abstractFigure: app.abstractFigure,
    specs,
    rendered: renderedFiguresOf(app),
    specIssues: app.figureSpecIssues ?? [],
    referenceList: app.references ?? [],
    descriptionText: figureBodyText(app),
    claimsText: app.claims.map((claim) => claim.lines.join("\n")).join("\n"),
  });
}

/** 正式申请文件各部分（发明名称、摘要、权利要求、说明书、附图说明）中残留的内部占位与审核标记。 */
export function forbiddenMarkersOf(app: ParsedApplication): string[] {
  const parts = [
    app.title,
    ...app.abstract,
    ...app.claims.flatMap((claim) => claim.lines),
    ...app.description.flatMap((part) => part.paragraphs.map((item) => item.text)),
    ...app.figures.map((figure) => figure.caption),
  ];
  return findForbiddenMarkers(parts.join("\n"));
}

/** Formal completeness and layout checks for a parsed application. */
export function formalCheck(app: ParsedApplication): FormalReport {
  const checks: FormalCheck[] = [];
  const add = (id: string, label: string, level: CheckLevel, detail: string) => checks.push({ id, label, level, detail });

  // 发明名称
  const titleChars = countChars(app.title);
  if (!app.title) add("title", "发明名称", "error", "没有识别到发明名称（草稿首行应为“# 发明名称：……”）。");
  else if (titleChars > TITLE_HARD_LIMIT) add("title", "发明名称", "error", `${titleChars} 字，超过 ${TITLE_HARD_LIMIT} 字，需要压缩。`);
  else if (titleChars > TITLE_SOFT_LIMIT) add("title", "发明名称", "warn", `${titleChars} 字。一般不超过 ${TITLE_SOFT_LIMIT} 字，化学等特定领域可放宽到 ${TITLE_HARD_LIMIT} 字。`);
  else add("title", "发明名称", "ok", `${titleChars} 字`);
  if (/[®™©]|商标|型号/.test(app.title)) add("title-terms", "发明名称用语", "warn", "发明名称不应含商标、型号、人名地名等非技术用语。");

  // 摘要
  const abstractChars = countChars(app.abstract.map((text) => plainParagraph(text)).join(""));
  if (!abstractChars) add("abstract", "说明书摘要", "error", "没有摘要。");
  else if (abstractChars > ABSTRACT_LIMIT) add("abstract", "说明书摘要", "error", `${abstractChars} 字，超过 ${ABSTRACT_LIMIT} 字（含标点）。`);
  else add("abstract", "说明书摘要", "ok", `${abstractChars} 字`);

  if (!app.figures.length) {
    add("abstract-figure", "摘要附图", app.abstractFigure === null ? "ok" : "warn", app.abstractFigure === null ? "说明书没有附图，无需摘要附图。" : "说明书没有附图，却指定了摘要附图。");
  } else if (app.abstractFigure === null) {
    add("abstract-figure", "摘要附图", "warn", `未指定摘要附图，导出时默认使用图${app.figures[0].no}；应选最能说明技术方案的一幅。`);
  } else if (!app.figures.some((figure) => figure.no === app.abstractFigure)) {
    add("abstract-figure", "摘要附图", "error", `摘要附图指定为图${app.abstractFigure}，但附图说明里没有这幅图。`);
  } else {
    add("abstract-figure", "摘要附图", "ok", `图${app.abstractFigure}`);
  }

  // 权利要求书
  const independents = app.claims.filter((claim) => claim.independent);
  if (!app.claims.length) {
    add("claims", "权利要求书", "error", "没有识别到权利要求。");
  } else {
    add("claims", "权利要求书", "ok", `共 ${app.claims.length} 项，独立权利要求 ${independents.length} 项`);
    const sequential = app.claims.every((claim, index) => claim.no === index + 1);
    add("claim-numbering", "权利要求编号", sequential ? "ok" : "error", sequential ? "从 1 起连续编号" : "编号不连续或重复，应以阿拉伯数字顺序编号。");

    const badRefs = app.claims.filter((claim) => !claim.independent && claim.refs.some((ref) => ref >= claim.no || ref < 1));
    add("claim-refs", "从属权利要求引用", badRefs.length ? "error" : "ok", badRefs.length ? `${listNos(badRefs.map((claim) => claim.no))}引用了在后或不存在的权利要求。` : "只引用在前的权利要求");

    const multiSentence = app.claims.filter((claim) => {
      const joined = claim.lines.join("");
      return !/。$/.test(joined) || joined.slice(0, -1).includes("。");
    });
    add("claim-sentence", "每项权利要求一句话", multiSentence.length ? "warn" : "ok", multiSentence.length ? `${listNos(multiSentence.map((claim) => claim.no))}中间出现句号或未以句号结尾。` : "只在结尾使用句号");

    const figureInClaims = app.claims.filter((claim) => CLAIM_FIGURE_REF.test(claim.lines.join("")));
    add("claim-figure", "权利要求不引用附图和说明书", figureInClaims.length ? "error" : "ok", figureInClaims.length ? `${listNos(figureInClaims.map((claim) => claim.no))}使用了“如图……所示”或“如说明书……所述”。` : "未引用附图或说明书");

    const vague = app.claims.filter((claim) => {
      const joined = claim.lines.join("");
      return CLAIM_VAGUE.some((word) => joined.includes(word)) || NUMERIC_APPROX.test(joined);
    });
    add("claim-clarity", "权利要求用语清楚", vague.length ? "warn" : "ok", vague.length ? `${listNos(vague.map((claim) => claim.no))}含“例如、最好是、大约、……左右”等使范围不清楚的用语。` : "未发现模糊用语");

    const onePart = independents.filter((claim) => !claim.lines.join("").includes("其特征在于"));
    add("claim-two-part", "独立权利要求两段式", onePart.length ? "warn" : "ok", onePart.length ? `${listNos(onePart.map((claim) => claim.no))}没有“其特征在于”，确认是否适合写成前序部分加特征部分。` : "前序部分 + 特征部分");
  }

  // 说明书
  const requiredParts: DescriptionHeading[] = ["技术领域", "背景技术", "发明内容", "具体实施方式"];
  const missingParts = requiredParts.filter((heading) => !partText(app, heading));
  add("description-parts", "说明书组成部分", missingParts.length ? "error" : "ok", missingParts.length ? `缺少：${missingParts.join("、")}` : "技术领域、背景技术、发明内容、具体实施方式齐全");

  const bodyText = app.description.filter((part) => part.heading !== "附图说明").map((part) => part.paragraphs.map((item) => item.text).join("\n")).join("\n");
  const refs = figureRefs(bodyText);
  const listed = app.figures.map((figure) => figure.no);
  if (!app.figures.length) {
    add("figures", "附图说明", refs.length ? "error" : "ok", refs.length ? `正文提到图${refs.join("、图")}，但没有附图说明。` : "无附图（确认方案确实不需要图示）");
  } else {
    const unlisted = refs.filter((no) => !listed.includes(no));
    const unused = listed.filter((no) => !refs.includes(no));
    const continuous = listed.every((no, index) => no === index + 1);
    if (unlisted.length) add("figures", "附图引用一致", "error", `正文提到图${unlisted.join("、图")}，附图说明里没有。`);
    else if (unused.length) add("figures", "附图引用一致", "warn", `图${unused.join("、图")}在具体实施方式中没有被说明。`);
    else add("figures", "附图引用一致", "ok", `共 ${listed.length} 幅，正文均有引用`);
    if (!continuous) add("figure-numbering", "附图编号", "warn", `附图编号为图${listed.join("、图")}，应从图1起连续编号。`);
  }

  // 附图：有附图数据时逐幅核查；图号连续性已在上面检查，不重复列出
  const figureAudit = auditApplicationFigures(app);
  if (figureAudit) {
    for (const check of figureAudit.checks) if (check.id !== "figure-numbering") add(check.id, check.label, check.level, check.detail);
  } else if (app.figures.length) {
    add("figure-data", "附图绘制数据", "warn", `草稿没有附图绘图数据，图${app.figures.map((figure) => figure.no).join("、图")}在 Word 中为占位，需按附图说明用黑色线条绘制后替换；重新生成草稿可得到自动绘制的附图。`);
  }

  add("description-claim-ref", "说明书不引用权利要求", DESCRIPTION_CLAIM_REF.test(bodyText) ? "warn" : "ok", DESCRIPTION_CLAIM_REF.test(bodyText) ? "说明书中出现“如权利要求……所述”一类引用语，应改为直接写明技术内容。" : "未发现");

  const promo = PROMO_WORDS.filter((word) => bodyText.includes(word) || app.abstract.join("").includes(word));
  add("promo", "无商业宣传用语", promo.length ? "warn" : "ok", promo.length ? `出现：${promo.join("、")}` : "未发现");

  const embodimentChars = countChars(partText(app, "具体实施方式"));
  if (embodimentChars) add("embodiment-depth", "具体实施方式充分", embodimentChars < 800 ? "warn" : "ok", embodimentChars < 800 ? `仅 ${embodimentChars} 字，可能不足以使本领域技术人员实现。` : `${embodimentChars} 字`);

  // 公式与符号：权利要求书、说明书、摘要之间的一致性（草稿中有公式时才检查）
  const formulas = auditFormulas(formulaSourcesOf(app));
  if (formulas.applicable) {
    for (const group of groupFormulaIssues(formulas)) {
      const shown = group.details.slice(0, 3).join("；");
      add(group.id, group.label, group.level, group.level === "ok" ? "未发现问题" : group.details.length > 3 ? `${shown}；另有 ${group.details.length - 3} 处，见公式与符号一览` : shown);
    }
  }

  add("pending", "待补充事实", app.pendingMarks.length ? "warn" : "ok", app.pendingMarks.length ? `${app.pendingMarks.length} 处缺项在正式文件中已改写为“根据实际应用需求确定”“以实际测试记录为准”等概括表述，提交前须按内部审核单补充真实参数或数据。` : "无");
  const annotations = app.reviewAnnotations ?? [];
  if (annotations.length) {
    add("review-annotations", "推断与模拟值标注", "warn", `${annotations.length} 处“（推断，待确认）”“（模拟值，待实验验证）”一类标注已从正式文件中去掉，相应内容提交前须逐项核实，清单见内部审核单。`);
  }
  const forbidden = forbiddenMarkersOf(app);
  if (forbidden.length) add("forbidden-marks", "内部占位与审核标记", "error", `正式文件中仍有 ${forbidden.length} 处：${forbidden.slice(0, 5).join("、")}`);
  const descriptionChars = countChars(app.description.map((part) => part.paragraphs.map((item) => plainParagraph(item.text)).join("")).join(""));
  let fatal = "";
  if (!app.claims.length) fatal = "没有识别到权利要求书，无法按申请文件格式导出。请先用 /发明稿 生成完整草稿。";
  else if (!descriptionChars) fatal = "没有识别到说明书正文，无法按申请文件格式导出。";
  else if (figureAudit?.errorCount) {
    const figureErrors = figureAudit.checks.filter((check) => check.level === "error");
    const shown = figureErrors.slice(0, 3).map((check) => `${check.label}：${check.detail}`).join("；");
    fatal = `附图核查有 ${figureErrors.length} 项需修改，修改附图数据、附图说明或附图标记后再导出。${shown}${figureErrors.length > 3 ? `；另有 ${figureErrors.length - 3} 项` : ""}`;
  }
  if (!fatal && forbidden.length) {
    fatal = `正式文件中仍有内部占位或审核标记（${forbidden.slice(0, 5).join("、")}${forbidden.length > 5 ? ` 等 ${forbidden.length} 处` : ""}），已拦截导出；请重新成稿或删去这些标记后再导出。`;
  }

  return {
    checks,
    errors: checks.filter((item) => item.level === "error").length,
    warnings: checks.filter((item) => item.level === "warn").length,
    exportable: !fatal,
    fatal,
    formulas: formulas.applicable ? formulas : undefined,
    figureAudit: figureAudit ?? undefined,
    stats: {
      titleChars,
      abstractChars,
      claimCount: app.claims.length,
      independentCount: independents.length,
      descriptionChars,
      figureCount: app.figures.length,
      pendingCount: app.pendingMarks.length,
    },
  };
}

/** One line for a toast or chat note. */
export function reportSummary(report: FormalReport): string {
  if (!report.exportable) return report.fatal;
  if (!report.errors && !report.warnings) return "形式检查全部通过。";
  return `形式检查：${report.errors} 项需修改，${report.warnings} 项需注意，详见文末内部审核单。`;
}
