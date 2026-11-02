/**
 * 领域化的发明稿自检。
 *
 * auditInvention 的通用检查（章节、编号、引用关系、模糊用语、篇幅等）对所有领域一样；
 * 本模块补上和技术领域有关的三项：
 *   1. 保护主题布局：按领域判断独立权利要求的主题（机械类不强制“方法+装置+设备+介质”）；
 *   2. 附图标记：结构类领域的实体装置/产品权利要求要带附图标记，并与附图标记列表一致；
 *   3. 数值范围：核心独立权利要求中的数值范围，实施例应覆盖两个端值和至少一个中间值。
 * 另外，化学/材料和生物/医药领域允许没有附图，不再因缺少“附图说明”扣分。
 *
 * 这些检查都是确定性的格式检查，只能提示问题，不能代替代理师对实质内容的审核。
 */
import { claimKindOf, detectDomain, getDomain, subjectCoverage } from "./patent-library.ts";
import type { DomainId, TechDomain } from "./patent-library.ts";

export interface DomainAuditCheck {
  id: string;
  label: string;
  ok: boolean;
  weight: number;
  detail: string;
}

/** 解析调用方给出的领域：领域对象、领域 id，或者都没有时从文本识别。 */
export function resolveDomain(domain: TechDomain | DomainId | string | null | undefined, text: string): TechDomain {
  if (domain && typeof domain === "object") return domain;
  if (typeof domain === "string" && domain) return getDomain(domain);
  return detectDomain(text).domain;
}

/** 化学/材料、生物/医药申请通常没有附图。 */
export function figuresOptional(domain: TechDomain): boolean {
  return domain.id === "chem-materials" || domain.id === "bio-pharma";
}

// ---------------------------------------------------------------------------
// 数值范围

export interface NumericRange {
  /** 原文片段，例如“40～60份”。 */
  text: string;
  low: number;
  high: number;
  unit: string;
}

const RANGE_PATTERN =
  /(\d+(?:\.\d+)?)\s*(?:～|~|〜|至|到|－|–|—|-)\s*(\d+(?:\.\d+)?)\s*(重量份|质量份|体积份|份|wt%|%|℃|°C|小时|分钟|秒|毫米|厘米|微米|纳米|毫升|升|千克|克|毫克|摩尔|米|度|倍|[a-zA-Zμ°]+(?:\/[a-zA-Z]+)?)/g;

/**
 * 找出文本中带单位的数值范围。不带单位的范围（例如比例“4:1～6:1”、径厚比“20～60”）不计入，
 * 以免把比例式或编号误认为数值范围；“权利要求1-3”一类引用也会因为没有单位而被排除。
 */
export function extractNumericRanges(text: string): NumericRange[] {
  const out: NumericRange[] = [];
  const seen = new Set<string>();
  for (const match of (text || "").matchAll(RANGE_PATTERN)) {
    const before = text.slice(Math.max(0, (match.index ?? 0) - 6), match.index ?? 0);
    if (/权利要求\s*$|[SsＳ]$|[:：]$/.test(before)) continue;
    const low = Number(match[1]);
    const high = Number(match[2]);
    if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) continue;
    const key = `${low}-${high}-${match[3]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: match[0].replace(/\s+/g, ""), low, high, unit: match[3] });
  }
  return out;
}

function numbersIn(text: string): number[] {
  return [...(text || "").matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0])).filter(Number.isFinite);
}

export interface RangeCoverage {
  ok: boolean;
  checked: number;
  problems: string[];
}

/** 每个数值范围：实施例中要出现两个端值，以及至少一个严格位于两端之间的值。 */
export function rangeCoverage(ranges: NumericRange[], embodiment: string): RangeCoverage {
  const values = numbersIn(embodiment);
  const problems: string[] = [];
  for (const range of ranges) {
    const missing: string[] = [];
    if (!values.some((value) => value === range.low)) missing.push(`端值${range.low}`);
    if (!values.some((value) => value === range.high)) missing.push(`端值${range.high}`);
    if (!values.some((value) => value > range.low && value < range.high)) missing.push("中间值");
    if (missing.length) problems.push(`${range.text}缺${missing.join("、")}`);
  }
  return { ok: problems.length === 0, checked: ranges.length, problems };
}

// ---------------------------------------------------------------------------
// 附图标记

/** 实体结构的装置/产品权利要求；由“……模块，用于……”构成的虚拟装置不算。 */
export function isStructuralClaim(text: string): boolean {
  const kind = claimKindOf(text);
  if (kind !== "装置" && kind !== "产品") return false;
  return !/(?:模块|单元)\s*[，,]?\s*用于/.test(text);
}

/** 权利要求中括号形式的附图标记，例如“底座(1)”“锁舌（6）”。 */
export function claimNumerals(text: string): string[] {
  const found = new Set<string>();
  for (const match of (text || "").matchAll(/[\u4e00-\u9fa5a-zA-Z]\s*[（(]\s*(\d{1,3}[a-z]?)\s*[)）]/g)) found.add(match[1]);
  return [...found].sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b));
}

/** 具体实施方式中“### 附图标记”之后的列表正文；没有列表时返回空字符串。 */
export function numeralList(embodiment: string): string {
  const hit = /^#{2,4}\s*附图标记[^\n]*\n([\s\S]*?)(?=^#{2,4}\s|(?![\s\S]))/m.exec(embodiment || "");
  return hit ? hit[1].trim() : "";
}

export interface NumeralCheck {
  ok: boolean;
  detail: string;
  numerals: string[];
  unlisted: string[];
}

export function referenceNumeralCheck(claimsText: string, embodiment: string): NumeralCheck {
  const numerals = claimNumerals(claimsText);
  const list = numeralList(embodiment);
  if (!numerals.length) {
    return { ok: false, detail: "实体装置/产品权利要求中的部件没有附图标记，例如应写成“底座(1)”", numerals, unlisted: [] };
  }
  if (!list) {
    return { ok: false, detail: `权利要求用了 ${numerals.length} 个附图标记，但具体实施方式末尾没有“### 附图标记”列表`, numerals, unlisted: [] };
  }
  const listed = new Set([...list.matchAll(/(?:^|[^\d])(\d{1,3}[a-z]?)(?=[\u4e00-\u9fa5\s—–\-:：、.．])/g)].map((match) => match[1]));
  const unlisted = numerals.filter((value) => !listed.has(value));
  if (unlisted.length) {
    return { ok: false, detail: `附图标记列表中缺少：${unlisted.join("、")}`, numerals, unlisted };
  }
  return { ok: true, detail: `权利要求中的 ${numerals.length} 个附图标记均在列表中`, numerals, unlisted };
}

// ---------------------------------------------------------------------------
// 汇总

export interface DomainAuditInput {
  domain: TechDomain;
  claimsText: string;
  /** 按编号顺序的独立权利要求全文，第一项视为核心独立权利要求。 */
  independentTexts: string[];
  embodiment: string;
}

export function domainAuditChecks(input: DomainAuditInput): DomainAuditCheck[] {
  const { domain, claimsText, independentTexts, embodiment } = input;
  const checks: DomainAuditCheck[] = [];

  const coverage = subjectCoverage(domain, independentTexts);
  checks.push({ id: "claim-subjects", label: `保护主题符合${domain.name}布局`, ok: coverage.ok, weight: 8, detail: coverage.detail });

  const structural = independentTexts.filter(isStructuralClaim);
  if (domain.usesReferenceNumerals && structural.length) {
    const numerals = referenceNumeralCheck(claimsText, embodiment);
    checks.push({ id: "reference-numerals", label: "结构部件带附图标记且与列表一致", ok: numerals.ok, weight: 6, detail: numerals.detail });
  }

  const core = independentTexts[0] ?? "";
  const coreRanges = extractNumericRanges(core);
  if (coreRanges.length) {
    const result = rangeCoverage(coreRanges, embodiment);
    const others = extractNumericRanges(claimsText).filter((range) => !coreRanges.some((item) => item.text === range.text));
    const otherResult = rangeCoverage(others, embodiment);
    const advisory = otherResult.problems.length ? `；其他权利要求供参考：${otherResult.problems.slice(0, 4).join("；")}` : "";
    checks.push({
      id: "numeric-range",
      label: "数值范围有端值和中间值实施例",
      ok: result.ok,
      weight: 6,
      detail: result.ok
        ? `权利要求1的 ${result.checked} 个数值范围均有端值和中间值实施例${advisory}`
        : `权利要求1：${result.problems.slice(0, 4).join("；")}${advisory}`,
    });
  }
  return checks;
}
