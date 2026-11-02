/**
 * 成稿后的确定性兜底，不依赖模型自觉：
 *   - 说明书摘要硬性不超过 ABSTRACT_LIMIT（300）字（含标点，不计空白）；
 *   - 正文出现的中国专利公开号必须来自本次检索结果，否则就地标注“待核实”，不冒充对比文件。
 */
import { ABSTRACT_LIMIT, countChars } from "./cnipa-format.ts";
import { extractCnNumbers } from "./invention-draft.ts";

export const ABSTRACT_MAX = ABSTRACT_LIMIT;
export const UNVERIFIED_MARK = "【未在本次检索结果中，待核实】";

const ABSTRACT_HEADING = /^##[ \t]*(?:说明书摘要|摘要)[ \t]*$/m;
const NEXT_BLOCK = /^(?:#{1,2}[ \t]|```)/m;
const FIGURE_LINE = /^\s*摘要附图[:：]/;

export interface AbstractBlock {
  /** Offset right after the heading line. */
  start: number;
  /** Offset of the next heading or code fence (or end of text). */
  end: number;
  /** Abstract prose without the 摘要附图 line. */
  text: string;
  figureLines: string[];
}

export function abstractChars(text: string): number {
  return countChars(text);
}

export function locateAbstract(draft: string): AbstractBlock | null {
  const head = ABSTRACT_HEADING.exec(draft);
  if (!head) return null;
  const start = head.index + head[0].length;
  const next = NEXT_BLOCK.exec(draft.slice(start));
  const end = next ? start + next.index : draft.length;
  const lines = draft.slice(start, end).split(/\r?\n/);
  return {
    start,
    end,
    text: lines.filter((line) => !FIGURE_LINE.test(line)).join("\n").trim(),
    figureLines: lines.filter((line) => FIGURE_LINE.test(line)).map((line) => line.trim()),
  };
}

/** How many characters the abstract is over the limit; 0 when within it or absent. */
export function abstractOverflow(draft: string, limit = ABSTRACT_LIMIT): number {
  const block = locateAbstract(draft);
  return block ? Math.max(0, countChars(block.text) - limit) : 0;
}

/** Replace the abstract prose, keeping the 摘要附图 line and everything after the section. */
export function replaceAbstract(draft: string, abstract: string): string {
  const block = locateAbstract(draft);
  if (!block) return draft;
  const eol = draft.includes("\r\n") ? "\r\n" : "\n";
  const body = [abstract.trim(), ...block.figureLines].join(eol);
  const tail = draft.slice(block.end);
  return `${draft.slice(0, block.start)}${eol}${body}${eol}${tail ? eol : ""}${tail}`;
}

/**
 * Deterministic fallback: keep whole sentences in order while they fit (the first sentence always stays,
 * it carries the title and field); an overlong first sentence is cut at a clause boundary.
 */
export function fitAbstract(text: string, limit = ABSTRACT_LIMIT): string {
  const flat = text.replace(/\s+/g, "");
  if (flat.length <= limit) return flat;
  const sentences = flat.match(/[^。！？；]+[。！？；]?/g) ?? [flat];
  let out = "";
  sentences.forEach((sentence, index) => {
    if (index === 0 || out.length + sentence.length <= limit) out += sentence;
  });
  if (out.length <= limit) return out;
  const cut = out.slice(0, limit - 1);
  const clause = Math.max(cut.lastIndexOf("，"), cut.lastIndexOf("、"), cut.lastIndexOf("；"));
  return `${clause > limit / 2 ? cut.slice(0, clause) : cut}。`;
}

export function compressAbstractPrompt(abstract: string, limit = ABSTRACT_LIMIT): string {
  return [
    `下面这段说明书摘要有 ${countChars(abstract)} 字，超过 ${limit} 字（含标点）的上限。请压缩到 ${limit - 30} 字以内：`,
    "- 保留发明名称、所属技术领域、要解决的技术问题、技术方案要点和主要用途；",
    "- 不增加原文没有的技术内容、数值、公开号或网址；",
    "- 只输出压缩后的摘要正文一段，不要标题、不要解释、不要代码块。",
    "",
    `【原摘要】\n${abstract}`,
  ].join("\n");
}

/** Strip headings, fences, bold and a leading “摘要：” from a compression reply. */
export function cleanAbstractReply(reply: string): string {
  return reply
    .replace(/```\w*/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s{0,3}#{1,6}\s*/, "").replace(/\*\*(.+?)\*\*/g, "$1").trim())
    .filter((line) => line && !/^(?:说明书)?摘要[:：]?$/.test(line) && !FIGURE_LINE.test(line))
    .join("")
    .replace(/^(?:说明书)?摘要[:：]/, "")
    .trim();
}

const baseOf = (pn: string) => pn.toUpperCase().replace(/[A-Z]\d?$/, "");
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Mark every CN publication number that did not come from this run's prior-art search. Idempotent. */
export function guardCitations(text: string, allowed: string[]): { text: string; unknown: string[] } {
  const known = new Set(allowed.filter(Boolean).map(baseOf));
  const unknown = [...new Set(extractCnNumbers(text))].filter((pn) => !known.has(baseOf(pn)));
  let next = text;
  for (const pn of unknown) {
    const pattern = new RegExp(`${escapeRegExp(pn)}(?![A-Z0-9]|${escapeRegExp(UNVERIFIED_MARK)})`, "g");
    next = next.replace(pattern, `${pn}${UNVERIFIED_MARK}`);
  }
  return { text: next, unknown };
}