/**
 * Prior-art gathering for the invention-draft pipeline.
 *
 * Before the model writes a draft we look for real Chinese patent documents with AnySearch:
 * short single-intent queries, keep only results that carry a CN publication number, link each one
 * to its Google Patents page, and (for the top few) read that page to pull the abstract. The draft
 * prompt may then cite only these numbers, so the background section is grounded instead of invented.
 *
 * Search results are noisy, so candidates are screened before they reach the prompt:
 *   - a title that is only a document-type label ("(12)发明专利"), a news headline ("……取得……专利") or a
 *     truncated snippet is repaired from the patent page (page title, or the "一种……" title in its text),
 *     and dropped when it cannot be repaired;
 *   - when the case topic is given, a document whose title and abstract share too little with the topic is dropped.
 *
 * The search and extract functions are injected so the browser can pass the real API helpers and
 * tests can pass stubs.
 */
import { extractCnNumbers, patentUrl } from "./invention-draft.ts";
import type { PriorArtRef } from "./invention-draft.ts";

export interface LeadHit {
  title: string;
  url: string;
  snippet?: string;
}

export interface LeadSearchResult {
  ok: boolean;
  detail: string;
  results: LeadHit[];
}

export interface PageResult {
  ok: boolean;
  title?: string;
  content: string;
}

export interface PriorArtDeps {
  search: (query: string) => Promise<LeadSearchResult>;
  extract?: (url: string) => Promise<PageResult>;
  onTrace?: (text: string) => void;
  signal?: AbortSignal;
  /** Most documents to keep (default 5). */
  limit?: number;
  /** How many of the kept documents get their page read for an abstract (default 3). */
  enrich?: number;
  /** 案件主题（标题 + 核心特征）。给出时只保留标题或摘要与主题有足够重合的文献；不给时不做相关性过滤。 */
  topic?: string;
}

/** Strip Google Patents decorations and a leading publication number from a page title. */
export function cleanPatentTitle(title: string): string {
  return title
    .replace(/\s*[-–|]\s*Google Patents\s*$/i, "")
    .replace(/^\s*CN\s?\d{7,10}(?:\.\d)?\s?[A-Z]?\d?(?:\s*[-–:：]\s*|\s+)/i, "")
    .trim();
}

export type TitleProblem = "" | "placeholder" | "news" | "truncated";

const PROBLEM_LABEL: Record<Exclude<TitleProblem, "">, string> = {
  placeholder: "标题只是文献类型标识",
  news: "新闻稿，不是专利文献",
  truncated: "标题被截断",
};

/** "(12)发明专利"、"(19)中华人民共和国国家知识产权局" and the like: PDF page headers, not titles. */
const NUMBERED_HEADER = /^[(（]?\d{2}[)）]?(?:中华人民共和国)?(?:国家知识产权局)?(?:发明专利|实用新型专利|外观设计专利|实用新型|发明)?(?:申请)?(?:公布|公告)?(?:说明书)?$/;
const DOC_TYPE_ONLY = /^(?:中华人民共和国)?(?:国家知识产权局)?(?:发明专利|实用新型专利|外观设计专利|发明专利申请|实用新型|专利文献|专利说明书|专利)(?:申请)?(?:公布)?(?:说明书)?$/;
const NEWS_PATTERNS = [
  /(?:取得|获得|获授|获批|荣获|斩获|喜获|新获|拿下)[^，。,]{0,40}专利/,
  /(?:公司|股份|集团|科技|研究院)[^，。,]{0,10}(?:申请|公布|公开)[^，。,]{0,30}专利/,
  /专利(?:授权)?(?:信息|动态|快讯)/,
];

/** Why a title cannot be shown as a prior-art document title, or "" when it can. */
export function titleProblem(title: string, pn?: string): TitleProblem {
  const compact = title.replace(/\s+/g, "");
  if (compact.length < 4) return "placeholder";
  if (pn && compact.toUpperCase() === pn.replace(/\s+/g, "").toUpperCase()) return "placeholder";
  if (/^CN\d{7,10}[A-Z]?\d?$/i.test(compact)) return "placeholder";
  if (NUMBERED_HEADER.test(compact) || DOC_TYPE_ONLY.test(compact)) return "placeholder";
  if (NEWS_PATTERNS.some((pattern) => pattern.test(compact))) return "news";
  if (/(?:…|\.{3}|。{2,})\s*$/.test(title.trim())) return "truncated";
  return "";
}

/** The "一种……" title a patent page states in its opening text (abstract or heading), or "". */
export function titleFromContent(content: string): string {
  const head = content.replace(/\s+/g, " ").slice(0, 1200);
  const hit = /一种[^\s，。,.;；:：、（(]{3,40}/.exec(head);
  return hit ? hit[0].replace(/(?:及其|的)$/, "") : "";
}

const GENERIC_BIGRAMS = new Set(["装置", "方法", "系统", "一种", "结构", "设备", "组件", "及其", "用于", "基于", "包括", "具有", "技术", "应用", "专利", "发明", "实用", "新型", "制备"]);

/** Distinctive terms of a case topic: Chinese bigrams minus filler and generic words, plus latin words. */
export function topicTerms(topic: string): string[] {
  // Boilerplate such as “本发明涉及” opens almost every Chinese abstract, so its bigrams would make any document look relevant.
  const cleaned = topic.replace(/本(?:发明|申请|实用新型)(?:涉及|公开了?|提供了?|属于)?|一种|及其|以及|用于|基于|发明专利|实用新型|专利/g, " ");
  const terms = new Set<string>();
  for (const run of cleaned.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let index = 0; index + 2 <= run.length; index += 1) {
      const bigram = run.slice(index, index + 2);
      if (/[的和与及或带在]/.test(bigram) || GENERIC_BIGRAMS.has(bigram)) continue;
      terms.add(bigram);
    }
  }
  for (const word of topic.match(/[A-Za-z][A-Za-z0-9-]{2,}/g) ?? []) terms.add(word.toLowerCase());
  return [...terms];
}

/** How many distinct topic terms occur in a text. */
export function relevanceHits(terms: string[], text: string): number {
  const haystack = text.toLowerCase();
  return terms.filter((term) => haystack.includes(term)).length;
}

function compactTopic(text: string, cap: number): string {
  return text
    .replace(/[【】《》“”"'()（）[\]]/g, " ")
    .replace(/^(一种|本发明涉及|本发明公开了)/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, cap);
}

/** Short single-intent queries for prior art on a topic. AnySearch works best with one intent per query. */
export function draftQueries(topic: string, feature?: string): string[] {
  const head = compactTopic(topic, 36);
  const core = compactTopic(feature || "", 30);
  const queries = [
    head ? `${head} 发明专利 CN` : "",
    head ? `${head} patents.google.com CN` : "",
    core && core !== head ? `${core} 专利` : "",
  ];
  return [...new Set(queries.filter((item) => item.length >= 6))];
}

/** Pull the abstract out of a patent page's extracted text; falls back to the opening of the page. */
export function abstractOf(content: string, cap = 360): string {
  const text = content.replace(/\s+/g, " ").trim();
  if (!text) return "";
  const marker = /(摘要|Abstract)\s*[:：]?\s*/i.exec(text);
  if (marker) {
    const start = marker.index + marker[0].length;
    const piece = text.slice(start, start + cap + 40).replace(/^[\s:：.。,，-]+/, "");
    const stop = piece.search(/\s(?:Images?|Classifications|Description|Claims|权利要求|说明书|附图)\b/);
    const body = (stop > 40 ? piece.slice(0, stop) : piece).trim();
    if (body.length >= 40) return body.length > cap ? `${body.slice(0, cap)}…` : body;
  }
  return text.length > Math.min(cap, 300) ? `${text.slice(0, Math.min(cap, 300))}…` : text;
}

function baseKey(pn: string): string {
  return pn.replace(/[A-Z]\d?$/, "");
}

export async function gatherPriorArt(queries: string[], deps: PriorArtDeps): Promise<PriorArtRef[]> {
  const limit = Math.max(1, deps.limit ?? 5);
  const enrich = Math.max(0, deps.enrich ?? 3);
  // Collect more candidates than we keep: some are dropped once their page has been read.
  const pool = Math.max(limit, Math.min(limit * 2, 10));
  const terms = topicTerms(deps.topic || "");
  const need = terms.length >= 6 ? 2 : 1;
  const irrigationTopic = /灌溉|滴灌|喷灌|水肥|灌水|\birrigation\b/i.test(deps.topic || "");
  const relevant = (ref: PriorArtRef) => {
    const corpus = `${ref.title} ${ref.note || ""}`;
    // Shared control words (“分区”“闭环”“补偿”) are insufficient evidence for irrigation:
    // they also retrieve railway signalling and power-supply patents. Require subject evidence.
    if (irrigationTopic && !/灌溉|滴灌|喷灌|水肥|灌水|作物|温室|土壤|农业|灌区|田间|种植|根区|蒸散|\b(?:irrigation|drip|sprinkler|crop|soil|agricultur\w*)\b/i.test(corpus)) return false;
    return !terms.length || relevanceHits(terms, corpus) >= need;
  };
  const kept = new Map<string, PriorArtRef>();
  const rejected = new Set<string>();
  const dropped: string[] = [];

  for (const query of queries) {
    if (deps.signal?.aborted || kept.size >= pool) break;
    deps.onTrace?.(`检索对比文件：「${query}」`);
    let found: LeadSearchResult;
    try {
      found = await deps.search(query);
    } catch (error) {
      deps.onTrace?.(`检索没有完成：${error instanceof Error ? error.message : "未知错误"}`);
      continue;
    }
    if (!found.ok) {
      deps.onTrace?.(`检索没有完成：${found.detail}`);
      continue;
    }
    for (const hit of found.results) {
      for (const pn of extractCnNumbers(`${hit.url} ${hit.title} ${hit.snippet || ""}`)) {
        const key = baseKey(pn);
        if (rejected.has(key)) continue;
        const existing = kept.get(key);
        if (existing) {
          // Prefer a number that carries its kind code (needed for a direct Google Patents page).
          if (!/[A-Z]\d?$/.test(existing.pn) && /[A-Z]\d?$/.test(pn)) kept.set(key, { ...existing, pn, url: patentUrl(pn) });
          continue;
        }
        if (kept.size >= pool) break;
        const ref: PriorArtRef = {
          pn,
          title: cleanPatentTitle(hit.title) || pn,
          url: patentUrl(pn),
          note: (hit.snippet || "").replace(/\s+/g, " ").trim().slice(0, 240),
        };
        // A proper title that has nothing to do with the case is not worth a page read.
        if (!titleProblem(ref.title, pn) && !relevant(ref)) {
          rejected.add(key);
          dropped.push(`${pn}《${ref.title}》（与本案主题无关）`);
          continue;
        }
        kept.set(key, ref);
      }
      if (kept.size >= pool) break;
    }
  }

  const list = [...kept.values()];
  if (deps.extract) {
    // Pages are read for the abstracts of the first few good documents, and to repair bad titles.
    let budget = enrich + 3;
    let enrichedGood = 0;
    for (const ref of list) {
      if (deps.signal?.aborted || budget <= 0) break;
      const bad = Boolean(titleProblem(ref.title, ref.pn));
      if (!bad && enrichedGood >= enrich) continue;
      if (!/patents\.google\.com\/patent\//.test(ref.url)) continue;
      budget -= 1;
      if (!bad) enrichedGood += 1;
      try {
        const page = await deps.extract(ref.url);
        if (!page.ok || !page.content) continue;
        const abstract = abstractOf(page.content);
        if (abstract) ref.note = abstract;
        const pageTitle = cleanPatentTitle(page.title || "");
        const better = pageTitle && !titleProblem(pageTitle, ref.pn) ? pageTitle : titleFromContent(page.content);
        if (better && !titleProblem(better, ref.pn) && (bad || ref.title.length < 6)) ref.title = better;
      } catch {
        // A page that cannot be read keeps its search snippet.
      }
    }
  }

  const out: PriorArtRef[] = [];
  for (const ref of list) {
    const problem = titleProblem(ref.title, ref.pn);
    if (problem) {
      dropped.push(`${ref.pn}（${PROBLEM_LABEL[problem]}）`);
      continue;
    }
    if (!relevant(ref)) {
      dropped.push(`${ref.pn}《${ref.title}》（与本案主题无关）`);
      continue;
    }
    if (out.length < limit) out.push(ref);
  }
  if (dropped.length) deps.onTrace?.(`已剔除 ${dropped.length} 条不可用的检索线索：${dropped.join("、")}。`);
  return out;
}

/** One trace line listing the documents the draft may cite. */
export function priorArtTrace(refs: PriorArtRef[]): string {
  if (!refs.length) return "没有检到带公开号的中国专利页面。背景技术将按所属领域的通用现有技术撰写，不引用具体公开号；如需引用对比文件，请到专利检索及分析系统检索核实后补充。";
  return `找到 ${refs.length} 篇可引用的中国专利：${refs.map((ref) => `${ref.pn}《${ref.title}》${ref.url}`).join("；")}。这些是公开网页线索，提交前请到国家知识产权局系统核实。`;
}
