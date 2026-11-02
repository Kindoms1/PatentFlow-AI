/**
 * Daily patent radar built on AnySearch.
 *
 * For each subscribed topic it runs a few short queries aimed at public Chinese patent pages,
 * keeps only results that carry a real CN publication number, links each to its Google Patents page,
 * and drops numbers already seen in earlier runs. The search function is injected so the route can
 * pass the real AnySearch client and tests can pass a stub.
 */
import { extractCnNumbers, kindLabel, patentUrl } from "../src/invention-draft.ts";

export interface RadarTopic {
  id: string;
  name: string;
  keywords: string[];
  ipc?: string;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet?: string;
}

export interface RadarHit {
  pn: string;
  kind: string;
  title: string;
  url: string;
  sourceUrl: string;
  snippet: string;
  topicId: string;
  query: string;
  foundAt: string;
}

export interface RadarRun {
  topicId: string;
  ranAt: string;
  queries: string[];
  hits: RadarHit[];
  skippedSeen: number;
  errors: string[];
}

export type SearchFn = (query: string) => Promise<SearchHit[]>;

/** Short single-intent queries; AnySearch works best with one intent per query. */
export function radarQueries(topic: RadarTopic, now = new Date()): string[] {
  const words = topic.keywords.map((item) => item.trim()).filter(Boolean).slice(0, 4).join(" ");
  const year = now.getFullYear();
  const queries = [
    `${words} 发明专利 CN 公开 ${year}`,
    `${words} patents.google.com CN`,
    `${words} 专利 授权公告`,
  ];
  if (topic.ipc?.trim()) queries.push(`${topic.ipc.trim()} ${words} 专利`);
  return [...new Set(queries)];
}

/** 学者主页、成果列表常把年份直接拼在发明名称前，例如“2021一种…方法”。只在后面紧跟“一种/基于”时才去掉。 */
const LEADING_YEAR = /^(?:19|20)\d{2}\s*年?\s*[.、:：\-–]?\s*(?=一种|基于)/;

/** 新闻式标题：“X取得/获得/获授…（发明）专利（授权）”，取中间的发明名称。 */
const NEWS_WRAP = /^[^，,。！？]{1,30}?(?:取得|获得|获授|获批|荣获|斩获)了?(?:一项|一件|一个)?(?:名为|名称为)?[“"「《]?(.{4,100}?)[”"」》]?(?:发明)?专利(?:授权|证书)?$/;

function cleanTitle(title: string): string {
  const text = title
    .replace(/\s+/g, " ")
    .replace(/\s*[-–|_]\s*(?:Google Patents|百度学术|百度文库|SooPAT|专利之星|佰腾网|incoPat)\s*$/i, "")
    .replace(/^CN\d+[A-Z]?\d?\s*[-–:：]\s*/i, "")
    .replace(/\s*(?:\.{3,}|…+)\s*$/, "")
    .trim()
    .replace(LEADING_YEAR, "")
    .trim();
  const wrapped = NEWS_WRAP.exec(text);
  if (wrapped) {
    const inner = wrapped[1].trim();
    if (looksLikeInventionTitle(inner)) return inner;
  }
  return text;
}

/** 搜索结果页面是否就是这件专利本身：URL 或标题里带着这个号，或者整页只抽出这一个号。 */
function isOwnPage(result: SearchHit, numbers: string[], key: string): boolean {
  if (numbers.length === 1) return true;
  return `${result.url} ${result.title}`.toUpperCase().includes(key.toUpperCase());
}

/** 标题是否落在专题里：包含任一关键词；4 字以上的关键词也接受前后两半同时出现（如“建筑物…提取”）。 */
export function matchesTopic(title: string, keywords: string[]): boolean {
  const text = (title || "").replace(/\s+/g, "").toLowerCase();
  if (!text) return false;
  return keywords.some((raw) => {
    const word = (raw || "").replace(/\s+/g, "").toLowerCase();
    if (!word) return false;
    if (text.includes(word)) return true;
    if (word.length < 4) return false;
    const mid = Math.ceil(word.length / 2);
    return text.includes(word.slice(0, mid)) && text.includes(word.slice(mid));
  });
}

const CJK_PAIR = /^[\u4e00-\u9fff]{2}$/;

/** 宽松判断标题是否和专题沾边：满足 matchesTopic，或与任一关键词共享至少一个连续两字中文片段（如“建筑物提取”与“…提取倒塌房屋…”）。 */
export function touchesTopic(title: string, keywords: string[]): boolean {
  if (matchesTopic(title, keywords)) return true;
  const text = (title || "").replace(/\s+/g, "");
  if (!text) return false;
  return keywords.some((raw) => {
    const word = (raw || "").replace(/\s+/g, "");
    for (let index = 0; index + 2 <= word.length; index += 1) {
      const pair = word.slice(index, index + 2);
      if (CJK_PAIR.test(pair) && text.includes(pair)) return true;
    }
    return false;
  });
}

export interface RadarOptions {
  /**
   * 按公开号读取该专利自己的页面（路由层读取 Google Patents）拿真实发明名称。
   * 提供时：本页只拿到公开号的条目会补标题；从别人页面（引用列表、列表页）带出来的号必须补到可用标题且命中专题关键词才保留。
   */
  resolveTitle?: (hit: { pn: string; url: string; sourceUrl?: string }) => Promise<string | null | undefined>;
  /** 每次运行最多补取多少个标题，默认 8；本页缺标题的优先，其次是非本页条目。 */
  maxResolve?: number;
}

export async function runRadar(topic: RadarTopic, search: SearchFn, seen: Set<string>, now = new Date(), options: RadarOptions = {}): Promise<RadarRun> {
  const queries = radarQueries(topic, now);
  const hits: RadarHit[] = [];
  const errors: string[] = [];
  const local = new Set<string>();
  const foreign = new Set<RadarHit>();
  let skippedSeen = 0;
  for (const query of queries) {
    let results: SearchHit[] = [];
    try {
      results = await search(query);
    } catch (error) {
      errors.push(`${query}：${error instanceof Error ? error.message : "检索失败"}`);
      continue;
    }
    for (const result of results) {
      const numbers = extractCnNumbers(`${result.url} ${result.title} ${result.snippet || ""}`);
      for (const pn of numbers) {
        const key = pn.replace(/[A-Z]\d?$/, "");
        if (local.has(key)) continue;
        local.add(key);
        if (seen.has(key)) {
          skippedSeen += 1;
          continue;
        }
        const own = isOwnPage(result, numbers, key);
        const hit: RadarHit = {
          pn,
          kind: kindLabel(pn),
          title: (own && titleFromMention(result.snippet || "", pn)) || radarTitle(result.title, result.snippet || "", pn, own),
          url: patentUrl(pn),
          sourceUrl: result.url,
          snippet: (result.snippet || "").trim().slice(0, 240),
          topicId: topic.id,
          query,
          foundAt: now.toISOString(),
        };
        hits.push(hit);
        if (!own) foreign.add(hit);
      }
    }
  }
  if (options.resolveTitle) {
    const resolve = options.resolveTitle;
    const limit = Math.max(0, options.maxResolve ?? 8);
    const ownFallback = hits.filter((hit) => !foreign.has(hit) && hit.title === hit.pn);
    const foreignHits = hits.filter((hit) => foreign.has(hit));
    const pending = [...ownFallback, ...foreignHits].slice(0, limit);
    const verified = new Set<RadarHit>();
    await Promise.all(
      pending.map(async (hit) => {
        try {
          const found = cleanTitle((await resolve({ pn: hit.pn, url: hit.url, sourceUrl: hit.sourceUrl })) || "");
          if (isUsableTitle(found)) {
            hit.title = found;
            verified.add(hit);
          }
        } catch {
          // 补标题只是增强：失败时保留公开号，不影响本次雷达结果。
        }
      }),
    );
    // 从别人页面带出来的号：没核实到真实名称，或名称不在专题里，就不进结果（也不记入 seen，以后仍可能被重新发现）。
    // 本页条目：有真实名称时要和专题沾边（剔除公司名、歧义词误命中的跑题结果）；只有公开号的 PDF 等结果保留回退。
    for (let index = hits.length - 1; index >= 0; index -= 1) {
      const hit = hits[index];
      const drop = foreign.has(hit)
        ? !(verified.has(hit) && matchesTopic(hit.title, topic.keywords))
        : hit.title !== hit.pn && !touchesTopic(hit.title, topic.keywords);
      if (drop) hits.splice(index, 1);
    }
  }
  for (const hit of hits) seen.add(hit.pn.replace(/[A-Z]\d?$/, ""));
  return { topicId: topic.id, ranAt: now.toISOString(), queries, hits, skippedSeen, errors };
}

/** True when a daily topic has not run yet on the local calendar day of `now`. */
export function isDue(lastRunIso: string | undefined, schedule: "daily" | "weekly" | "manual", now = new Date()): boolean {
  if (schedule === "manual") return false;
  if (!lastRunIso) return true;
  const last = new Date(lastRunIso);
  if (Number.isNaN(last.getTime())) return true;
  const gap = schedule === "daily" ? 20 * 3600_000 : 6.5 * 86_400_000;
  return now.getTime() - last.getTime() >= gap;
}

/** PDF 抬头类标题（去空白后整体匹配），例如“(12)发明专利”“中华人民共和国国家知识产权局”。 */
const PDF_HEADER_TITLE = /^(?:[(（]?1\d[)）])?(?:发明专利(?:申请|说明书)?|实用新型专利|中华人民共和国国家知识产权局)?$/;

/** 发明名称里几乎总会出现的主题词。 */
const INVENTION_WORD = /(方法|系统|装置|设备|介质|终端|平台|程序|产品|模块|单元|电路|芯片|结构|组件|组合物|材料|工艺|用途|应用|网络|模型|器|机|仪|剂)/;

/** 明显是网页、作者主页或列表页的标题特征。 */
const PAGE_NOISE = /(百度|知乎|CSDN|博客|主页|首页|学者|搜索结果|查询结果|专利列表|UCAS|-\s*[^-]*大学\s*-)/i;

/** 粗判一个字符串是不是中国专利的发明名称，用来挡住网页标题、作者主页和摘要句子。 */
export function looksLikeInventionTitle(title: string): boolean {
  const text = (title || "").trim();
  const compact = text.replace(/\s+/g, "");
  if (compact.length < 4 || compact.length > 120) return false;
  if (!/[\u4e00-\u9fff]/.test(compact)) return false;
  if (/^CN\d+[A-Z]?\d?$/i.test(compact)) return false;
  if (/[。！？]/.test(compact) || /^(本发明|本申请|本实用新型|本公开|摘要)/.test(compact)) return false;
  if (PAGE_NOISE.test(text)) return false;
  return /^(一种|基于)/.test(compact) || INVENTION_WORD.test(compact);
}

function isUsableTitle(title: string): boolean {
  return Boolean(title) && !PDF_HEADER_TITLE.test(title.replace(/\s+/g, "")) && looksLikeInventionTitle(title);
}

/**
 * 雷达命中的展示标题：页面就是这件专利且标题像发明名称时用页面标题，其次从摘要里的“(54)发明名称”恢复，最后退回公开号。
 * 页面不是这件专利时直接退回公开号：页面标题和摘要里的“(54)”都属于页面自己那件专利。
 */
export function radarTitle(rawTitle: string, snippet: string, pn: string, ownPage = true): string {
  if (!ownPage) return pn;
  const cleaned = cleanTitle(rawTitle || "");
  if (isUsableTitle(cleaned)) return cleaned;
  const named = /[(（]\s*54\s*[)）]\s*发明名称\s*[:：]?\s*([^\n\r(（]{4,80})/.exec(snippet || "");
  if (named) {
    const recovered = cleanTitle(named[1]);
    if (isUsableTitle(recovered)) return recovered;
  }
  return pn;
}

/** 从专利详情页（如 Google Patents 抽取结果）取发明名称：先看页面标题，再看“发明名称：”，最后看正文前 40 行。 */
export function titleFromPatentPage(pageTitle: string, content: string): string | null {
  const body = content || "";
  const candidates: Array<{ text: string; strict: boolean }> = [{ text: pageTitle || "", strict: false }];
  const named = /(?:[(（]\s*54\s*[)）])?\s*发明名称\s*[:：]\s*([^\n\r]{4,120})/.exec(body);
  if (named) candidates.push({ text: named[1], strict: false });
  for (const line of body.split(/\r?\n/).slice(0, 40)) candidates.push({ text: line.replace(/^\s*#+\s*/, ""), strict: true });
  for (const candidate of candidates) {
    const cleaned = cleanTitle(candidate.text);
    if (candidate.strict && /[，,；;：:]/.test(cleaned)) continue;
    if (isUsableTitle(cleaned)) return cleaned;
  }
  return null;
}

/** 新闻/公告里“名为“X”的专利，授权公告号CN…”这种明确指名。 */
const MENTION = /(?:名为|名称为|题为)\s*[“"「《]([^”"」》\r\n]{4,100})[”"」》]\s*的?(?:发明|实用新型)?专利/g;
const MENTION_NUMBER = /CN\s?\d{9,12}/i;

/**
 * 从正文里取“名为“X”的专利”中的 X，但只有当紧随其后的第一个 CN 号就是本号时才采用，
 * 避免一篇报道列了多件专利时串号；绝不使用新闻标题或网页标题。
 */
export function titleFromMention(text: string, pn: string): string | null {
  const body = text || "";
  const base = (pn || "").toUpperCase().replace(/[A-Z]\d?$/, "");
  if (!body || !base) return null;
  for (const match of body.matchAll(MENTION)) {
    const end = (match.index ?? 0) + match[0].length;
    const next = MENTION_NUMBER.exec(body.slice(end, end + 80));
    if (!next || next[0].replace(/\s+/g, "").toUpperCase() !== base) continue;
    const cleaned = cleanTitle(match[1]);
    if (isUsableTitle(cleaned) && looksLikeInventionTitle(cleaned)) return cleaned;
  }
  return null;
}