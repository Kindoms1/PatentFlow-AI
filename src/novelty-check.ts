/**
 * 一键成稿前的查新对比（新颖性 / 创造性风险评估）。
 *
 * 全自动成稿过去在选题后直接写全文：对比文件只检索 5 篇、只用来写背景技术，从没有逐项比对过技术特征，
 * 也就无法保证选定的方案真的有创新空间。本模块在大纲和全文之前插入一个查新阶段：
 *
 *   1. 多角度检索：题目、核心特征的各个分句、技术问题分别成式，收集带真实公开号的中国专利，
 *      并读取前几篇的专利页面补全摘要（prior-art.ts 的 gatherPriorArt，含标题修复和相关性过滤）；
 *   2. 特征比对：请模型把方案分解为 F1…Fn 个技术特征，只依据检索到的标题和摘要，逐篇标注
 *      公开 / 部分公开 / 未公开，给出最接近的现有技术、区别技术特征、创新点分析和风险评级；
 *   3. 确定性复核：任一篇文献被标为公开了全部特征时风险至少为“高”；方案与文献摘要的字面重合度很高时风险至少为“中”；
 *   4. 迭代：风险为中或高时，采用模型给出的强化方案（增加未被任何文献公开的具体技术手段）重新检索复查；
 *      没有强化方案时换下一个候选题目；最多 NOVELTY_MAX_ROUNDS 轮，最终采用风险最低的一轮；
 *   5. 输出：确定性生成的《查新对比报告》（特征分解表、对比文件表、特征对比矩阵、区别技术特征、创新点分析、结论和查新过程），
 *      以及可供成稿引用的对比文件列表。
 *
 * 检索结果是公开网页线索，报告明确声明不是官方查新结论；模型调用、检索和网页抽取都通过参数注入，便于测试。
 */
import type { PriorArtRef } from "./invention-draft.ts";
import { draftQueries, gatherPriorArt } from "./prior-art.ts";
import type { LeadSearchResult, PageResult } from "./prior-art.ts";

export const NOVELTY_MATERIAL_NAME = "查新对比报告.md";
/** 查新最多进行的轮数（含强化方案复查和换题）。 */
export const NOVELTY_MAX_ROUNDS = 3;
/** 每轮最多保留的对比文件篇数。 */
export const NOVELTY_DOC_LIMIT = 8;

export interface NoveltyPoint {
  title: string;
  problem: string;
  feature: string;
  effect: string;
  pending: string;
}

export type NoveltyRisk = "低" | "中" | "高";

const RISK_ORDER: Record<NoveltyRisk, number> = { 低: 0, 中: 1, 高: 2 };

export interface NoveltyFeature {
  id: string;
  text: string;
}

export interface NoveltyRow {
  pn: string;
  title: string;
  disclosed: string[];
  partial: string[];
  note: string;
}

export interface NoveltyDistinction {
  feature: string;
  problem: string;
  effect: string;
}

export interface NoveltyInnovation {
  point: string;
  analysis: string;
}

export interface NoveltyAssessment {
  features: NoveltyFeature[];
  rows: NoveltyRow[];
  closest: string;
  distinguishing: NoveltyDistinction[];
  innovations: NoveltyInnovation[];
  risk: NoveltyRisk;
  reason: string;
  improved: NoveltyPoint | null;
}

export interface NoveltyRoundRecord {
  round: number;
  title: string;
  queries: string[];
  docs: number;
  risk: NoveltyRisk | null;
  action: string;
}

export interface NoveltyOutcome {
  /** 最终采用的方案（可能是强化后的方案或换用的候选题目）。 */
  point: NoveltyPoint;
  /** 最终方案对应的对比文件，可直接交给成稿流水线引用。 */
  refs: PriorArtRef[];
  assessment: NoveltyAssessment | null;
  /** 最终方案的风险评级；没有检到可比对文献时为 null。 */
  risk: NoveltyRisk | null;
  /** 方案与对比文件摘要的最大字面重合度（0–1）。 */
  overlap: number;
  report: string;
  rounds: NoveltyRoundRecord[];
  /** 最终方案与输入方案不同（强化或换题）。 */
  changed: boolean;
  aborted: boolean;
}

type ModelMessage = { role: "system" | "user" | "assistant"; content: string };

export interface NoveltyReply {
  ok: boolean;
  text: string;
  detail?: string;
  aborted?: boolean;
}

export interface NoveltyDeps {
  ask: (messages: ModelMessage[], onTrace: (text: string) => void, signal?: AbortSignal) => Promise<NoveltyReply>;
  search: (query: string) => Promise<LeadSearchResult>;
  extract?: (url: string) => Promise<PageResult>;
}

export interface NoveltyInput {
  point: NoveltyPoint;
  /** 其他候选题目：当前方案风险高且没有强化方案时依次换用。 */
  alternatives?: NoveltyPoint[];
  /** 是否允许改写方案（发明人自带交底材料时为 false：只出报告和改进建议，不替换方案）。 */
  allowRewrite: boolean;
  trace: (text: string) => void;
  signal?: AbortSignal;
}

function clip(text: string, max: number): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function cell(text: string, max = 80): string {
  return clip(text, max).replace(/\|/g, "／") || "—";
}

function normTitle(title: string): string {
  return title.replace(/\s+/g, "").replace(/[，,。.、；;：:“”"'（）()]/g, "");
}

function normPn(pn: string): string {
  return pn.replace(/\s+/g, "").toUpperCase();
}

/** 公开号去掉文献种类代码后的主体（CN112345678A → CN112345678），用于宽松匹配。 */
function pnBase(pn: string): string {
  return normPn(pn).replace(/\.\d$/, "").replace(/[A-Z]\d?$/, "");
}

// ───────────────────────────── 检索式 ─────────────────────────────

/** 题目、核心特征分句、技术问题分别成式，去重后最多 7 条。 */
export function noveltyQueries(point: NoveltyPoint): string[] {
  const out: string[] = [];
  const push = (query: string) => {
    const value = query.replace(/\s+/g, " ").trim();
    if (value.length >= 4 && !out.some((item) => item === value)) out.push(value);
  };
  for (const query of draftQueries(point.title, point.feature)) push(query);
  const subject = point.title
    .replace(/^一种/, "")
    .replace(/(?:的)?(?:方法|系统|装置|设备|平台|终端)(?:[及和与]其?(?:方法|系统|装置|设备|应用|制备方法))*$/, "")
    .trim();
  if (subject.length >= 6) push(subject.slice(0, 24));
  const clauses = point.feature
    .split(/[，,；;。、\n]/)
    .map((item) => item.replace(/^(?:通过|采用|利用|基于|根据|并|且|再|然后|其中)/, "").trim())
    .filter((item) => item.length >= 5 && item.length <= 28);
  for (const clause of clauses.slice(0, 3)) push(clause);
  const problem = point.problem.split(/[，,；;。]/).map((item) => item.trim()).find((item) => item.length >= 6 && item.length <= 28);
  if (problem) push(problem);
  return out.slice(0, 7);
}

// ───────────────────────────── 字面重合度 ─────────────────────────────

const GENERIC = new Set(["一种", "方法", "系统", "装置", "设备", "包括", "所述", "进行", "通过", "根据", "基于", "实现", "以及", "用于", "其中", "得到", "获取", "本发", "发明", "技术", "处理", "数据", "模块", "单元"]);

function bigrams(text: string): Set<string> {
  const set = new Set<string>();
  for (const run of text.replace(/[^\u4e00-\u9fff]+/g, " ").split(" ").filter(Boolean)) {
    for (let index = 0; index + 1 < run.length; index += 1) {
      const pair = run.slice(index, index + 2);
      if (!GENERIC.has(pair)) set.add(pair);
    }
  }
  return set;
}

/** 方案（题目 + 核心特征）的字面二元组被一篇文献的标题和摘要覆盖的比例。 */
export function featureCoverage(point: NoveltyPoint, ref: PriorArtRef): number {
  const own = bigrams(`${point.title} ${point.feature}`);
  if (own.size < 4) return 0;
  const doc = bigrams(`${ref.title} ${ref.note || ""}`);
  let hit = 0;
  for (const pair of own) if (doc.has(pair)) hit += 1;
  return Math.round((hit / own.size) * 100) / 100;
}

function coverageRisk(overlap: number): NoveltyRisk {
  if (overlap >= 0.8) return "高";
  if (overlap >= 0.55) return "中";
  return "低";
}

function maxRisk(a: NoveltyRisk, b: NoveltyRisk): NoveltyRisk {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

// ───────────────────────────── 提示词 ─────────────────────────────

export const NOVELTY_SYSTEM = `你是资深的中国专利检索审查员，正在为一件即将撰写的发明专利申请做查新对比和授权前景评估。

【工作方法】
1. 特征分解：把待查方案分解为 5 到 8 个技术特征 F1、F2……，覆盖完整技术方案（输入 → 关键处理手段 → 输出/控制），每个特征是一句具体的技术手段，不写效果和口号。
2. 逐篇比对：只依据给出的每篇对比文件的标题和摘要，判断它对每个特征是“公开”（摘要明确记载了相同手段）、“部分公开”（记载了上位或相近手段）还是“未公开”。摘要没有提到的一律按未公开处理，不得凭印象推测文献内容。
3. 最接近的现有技术：选公开特征最多、技术领域和要解决的问题最接近的一篇。
4. 区别技术特征：列出相对最接近现有技术的区别特征，每条写清它实际解决的技术问题和带来的技术效果（三步法）。
5. 创新点分析：3 到 5 条，每条写创新点名称，以及为什么对本领域技术人员不是显而易见的（其他文献是否给出了结合启示、是否属于公知常识、是否产生了预料不到的效果）。
6. 风险评级：
   - 高：某一篇文献公开了全部或几乎全部特征（新颖性存疑），或区别特征只是公知常识的简单替换；
   - 中：最接近现有技术公开了大部分特征，区别特征可由其他文献结合得到，创造性论证较弱；
   - 低：区别特征明确、未被任何一篇文献公开，且没有结合启示。
7. 风险为中或高时，必须给出强化方案 improved：在原方案基础上增加至少两个未被任何对比文件公开的具体技术手段（具体的处理机制、参数关系、结构配合或控制逻辑，而不是“更智能”“更高效”之类的效果描述），题目以“一种”开头，可以直接作为发明名称；风险为低时 improved 为 null。

【纪律】
- 只能使用给出的公开号，不得编造公开号、网址或实验数据；不得下法律结论，只做风险评估。
- 只输出一个 json 代码块，不要输出其他文字。格式：
{"features":[{"id":"F1","text":"……"}],"rows":[{"pn":"CN……","disclosed":["F1"],"partial":["F2"],"note":"该文献公开了……，未公开……"}],"closest":"CN……","distinguishing":[{"feature":"……","problem":"……","effect":"……"}],"innovations":[{"point":"……","analysis":"……"}],"risk":"低","reason":"……","improved":null}`;

function refLines(refs: PriorArtRef[]): string {
  return refs
    .map((ref, index) => `D${index + 1} ${ref.pn}《${ref.title}》\n    摘要/要点：${clip(ref.note || "（未取得摘要，只能依据标题判断）", 420)}`)
    .join("\n");
}

export function noveltyPrompt(point: NoveltyPoint, refs: PriorArtRef[], rejected: string[] = []): string {
  return [
    "【待查方案】",
    `题目：${point.title}`,
    `技术问题：${point.problem || "（未给出，请按题目推断）"}`,
    `核心特征：${point.feature || "（未给出，请按题目展开）"}`,
    `预期效果：${point.effect || "（未给出）"}`,
    "",
    `【对比文件（共 ${refs.length} 篇，只可使用这些公开号）】`,
    refLines(refs),
    rejected.length ? `\n【已排除的方案（风险较高，强化方案不要回到这些题目）】\n${rejected.map((title, index) => `${index + 1}. ${title}`).join("\n")}` : "",
    "",
    "请按系统要求完成特征分解、逐篇比对、区别技术特征、创新点分析和风险评级，只输出 json 代码块。",
  ]
    .filter((line, index, all) => line || all[index - 1])
    .join("\n");
}

// ───────────────────────────── 解析 ─────────────────────────────

type Loose = Record<string, unknown>;

function isRecord(value: unknown): value is Loose {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number") return String(value);
  return "";
}

function looseParse(text: string): unknown {
  const attempts = [text, text.replace(/\/\/[^\n"]*$/gm, "").replace(/,(\s*[}\]])/g, "$1")];
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      // try the next repair
    }
  }
  return null;
}

function jsonCandidates(reply: string): string[] {
  const blocks = [...reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1].trim()).reverse();
  const first = reply.indexOf("{");
  const last = reply.lastIndexOf("}");
  if (first >= 0 && last > first) blocks.push(reply.slice(first, last + 1));
  return blocks;
}

function parseRisk(value: unknown): NoveltyRisk {
  const text = str(value).toLowerCase();
  if (/高|high/.test(text)) return "高";
  if (/低|low/.test(text)) return "低";
  return "中";
}

function ids(value: unknown, known: Set<string>): string[] {
  const out: string[] = [];
  for (const entry of Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,，、\s]+/) : []) {
    const id = str(entry).toUpperCase().replace(/^F?(\d+)$/, "F$1");
    if (known.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

function parsePoint(value: unknown, fallback?: NoveltyPoint): NoveltyPoint | null {
  if (!isRecord(value)) return null;
  const title = str(value.title ?? value["题目"] ?? value.name);
  if (!/^一种/.test(title) || title.length < 6) return null;
  return {
    title,
    problem: str(value.problem ?? value["技术问题"]) || fallback?.problem || "",
    feature: str(value.feature ?? value.solution ?? value["核心特征"]) || fallback?.feature || "",
    effect: str(value.effect ?? value["技术效果"]) || fallback?.effect || "",
    pending: fallback?.pending || "",
  };
}

/** 解析模型的查新 JSON；公开号只认本轮检索到的文献（也接受 D1、D2 这样的序号），解析不出时返回 null。 */
export function parseNoveltyReply(reply: string, refs: PriorArtRef[], point?: NoveltyPoint): NoveltyAssessment | null {
  let data: Loose | null = null;
  for (const candidate of jsonCandidates(reply)) {
    const parsed = looseParse(candidate);
    if (isRecord(parsed)) {
      data = parsed;
      break;
    }
  }
  if (!data) return null;
  const features: NoveltyFeature[] = [];
  const rawFeatures = Array.isArray(data.features) ? data.features : [];
  rawFeatures.forEach((entry, index) => {
    const text = isRecord(entry) ? str(entry.text ?? entry.feature ?? entry.content) : str(entry);
    if (!text) return;
    const rawId = isRecord(entry) ? str(entry.id).toUpperCase() : "";
    const id = /^F\d+$/.test(rawId) && !features.some((item) => item.id === rawId) ? rawId : `F${index + 1}`;
    if (!features.some((item) => item.id === id)) features.push({ id, text });
  });
  if (!features.length) return null;
  const known = new Set(features.map((item) => item.id));
  const findRef = (value: string): PriorArtRef | undefined => {
    const label = /^D(\d+)$/i.exec(value.trim());
    if (label) return refs[Number(label[1]) - 1];
    const key = pnBase(value);
    return refs.find((ref) => normPn(ref.pn) === normPn(value)) ?? refs.find((ref) => key.length >= 9 && pnBase(ref.pn) === key);
  };
  const rows: NoveltyRow[] = refs.map((ref) => ({ pn: ref.pn, title: ref.title, disclosed: [], partial: [], note: "" }));
  for (const entry of Array.isArray(data.rows) ? data.rows : Array.isArray(data.matrix) ? data.matrix : []) {
    if (!isRecord(entry)) continue;
    const ref = findRef(str(entry.pn ?? entry.doc ?? entry.id));
    if (!ref) continue;
    const row = rows.find((item) => item.pn === ref.pn);
    if (!row) continue;
    row.disclosed = ids(entry.disclosed ?? entry["公开"], known);
    row.partial = ids(entry.partial ?? entry["部分公开"], known).filter((id) => !row.disclosed.includes(id));
    row.note = str(entry.note ?? entry["说明"]);
  }
  const closestRef = findRef(str(data.closest ?? data.closestArt ?? data["最接近的现有技术"]));
  const closest =
    closestRef?.pn ??
    [...rows].sort((a, b) => b.disclosed.length * 2 + b.partial.length - (a.disclosed.length * 2 + a.partial.length))[0]?.pn ??
    "";
  const distinguishing: NoveltyDistinction[] = (Array.isArray(data.distinguishing) ? data.distinguishing : [])
    .map((entry) => (isRecord(entry) ? { feature: str(entry.feature), problem: str(entry.problem), effect: str(entry.effect) } : { feature: str(entry), problem: "", effect: "" }))
    .filter((entry) => entry.feature);
  const innovations: NoveltyInnovation[] = (Array.isArray(data.innovations) ? data.innovations : [])
    .map((entry) => (isRecord(entry) ? { point: str(entry.point ?? entry.title ?? entry.name), analysis: str(entry.analysis ?? entry.reason ?? entry.detail) } : { point: str(entry), analysis: "" }))
    .filter((entry) => entry.point);
  return {
    features,
    rows,
    closest,
    distinguishing,
    innovations,
    risk: parseRisk(data.risk),
    reason: str(data.reason ?? data["理由"]),
    improved: parsePoint(data.improved, point),
  };
}

/** 确定性复核：任一篇文献被标为公开了全部特征时，风险至少为“高”。 */
export function matrixRisk(assessment: NoveltyAssessment): NoveltyRisk {
  const total = assessment.features.length;
  if (!total) return "低";
  let worst: NoveltyRisk = "低";
  for (const row of assessment.rows) {
    if (row.disclosed.length >= total) return "高";
    if (row.disclosed.length + row.partial.length * 0.5 >= total * 0.75) worst = "中";
  }
  return worst;
}

// ───────────────────────────── 报告 ─────────────────────────────

function mark(row: NoveltyRow, id: string): string {
  if (row.disclosed.includes(id)) return "●";
  if (row.partial.includes(id)) return "◐";
  return "○";
}

export interface NoveltyReportInput {
  point: NoveltyPoint;
  refs: PriorArtRef[];
  assessment: NoveltyAssessment | null;
  risk: NoveltyRisk | null;
  overlap: number;
  rounds: NoveltyRoundRecord[];
  queries: string[];
  /** 发明人自带材料、方案未被替换时，强化方案只作为改进建议写入报告。 */
  suggestion?: NoveltyPoint | null;
}

/** 由查新结果确定性生成 Markdown 报告（不经模型改写，表格与数据一致）。 */
export function noveltyReport(input: NoveltyReportInput): string {
  const { point, refs, assessment, risk, rounds } = input;
  const lines: string[] = [];
  lines.push(`# 查新对比报告：${point.title}`);
  lines.push("");
  lines.push("说明：本报告依据公开网页检索到的中国专利线索及其摘要逐项比对，用于判断方案是否有创新空间、指导撰写区别技术特征；不是国家知识产权局出具的官方查新结论，也不构成法律意见，提交前请到专利检索及分析系统核实。");
  lines.push("");
  lines.push("## 一、待查方案");
  lines.push(`- 题目：${point.title}`);
  if (point.problem) lines.push(`- 技术问题：${point.problem}`);
  if (point.feature) lines.push(`- 核心特征：${point.feature}`);
  if (point.effect) lines.push(`- 预期效果：${point.effect}`);
  lines.push(`- 检索式（${input.queries.length} 条）：${input.queries.map((query) => `「${query}」`).join("、") || "—"}`);
  lines.push("");
  lines.push("## 二、对比文件");
  if (!refs.length) {
    lines.push("本轮没有检到带公开号且与方案相关的中国专利页面，无法逐项比对；以下结论只基于方案本身，背景技术需在提交前补充检索。");
  } else {
    lines.push("| 编号 | 公开号 | 名称 | 摘要要点 |");
    lines.push("| --- | --- | --- | --- |");
    refs.forEach((ref, index) => lines.push(`| D${index + 1} | ${ref.pn} | ${cell(ref.title, 40)} | ${cell(ref.note || "未取得摘要", 110)} |`));
  }
  lines.push("");
  if (assessment) {
    lines.push("## 三、技术特征分解");
    lines.push("| 编号 | 技术特征 |");
    lines.push("| --- | --- |");
    assessment.features.forEach((feature) => lines.push(`| ${feature.id} | ${cell(feature.text, 120)} |`));
    lines.push("");
    if (refs.length) {
      lines.push("## 四、特征对比矩阵");
      lines.push("● 公开　◐ 部分公开　○ 未公开（只依据标题和摘要判断）");
      lines.push("");
      lines.push(`| 对比文件 | ${assessment.features.map((feature) => feature.id).join(" | ")} | 公开数 |`);
      lines.push(`| --- | ${assessment.features.map(() => "---").join(" | ")} | --- |`);
      assessment.rows.forEach((row, index) => {
        lines.push(`| D${index + 1} ${row.pn} | ${assessment.features.map((feature) => mark(row, feature.id)).join(" | ")} | ${row.disclosed.length}/${assessment.features.length} |`);
      });
      const notes = assessment.rows.map((row, index) => (row.note ? `- D${index + 1}（${row.pn}）：${row.note}` : "")).filter(Boolean);
      if (notes.length) {
        lines.push("");
        lines.push(...notes);
      }
      lines.push("");
    }
    lines.push("## 五、最接近的现有技术与区别技术特征");
    const closestIndex = refs.findIndex((ref) => ref.pn === assessment.closest);
    lines.push(closestIndex >= 0 ? `最接近的现有技术为 D${closestIndex + 1}（${refs[closestIndex].pn}《${refs[closestIndex].title}》）。` : "没有可作为最接近现有技术的对比文件。");
    if (assessment.distinguishing.length) {
      lines.push("");
      lines.push("| 序号 | 区别技术特征 | 实际解决的技术问题 | 技术效果 |");
      lines.push("| --- | --- | --- | --- |");
      assessment.distinguishing.forEach((row, index) => lines.push(`| ${index + 1} | ${cell(row.feature, 90)} | ${cell(row.problem, 70)} | ${cell(row.effect, 70)} |`));
    }
    lines.push("");
    lines.push("## 六、创新点分析");
    if (assessment.innovations.length) {
      assessment.innovations.forEach((row, index) => {
        lines.push(`${index + 1}. **${row.point}**`);
        if (row.analysis) lines.push(`   ${row.analysis}`);
      });
    } else {
      lines.push("模型没有给出单独的创新点分析，以区别技术特征为准。");
    }
    lines.push("");
  }
  lines.push("## 七、结论");
  if (risk) {
    const meaning = risk === "低" ? "区别技术特征未被检到的文献公开，具备撰写和争取授权的创新空间" : risk === "中" ? "最接近现有技术公开了较多特征，撰写时需重点论证区别特征的技术效果" : "存在新颖性或创造性风险，建议调整方案后再申请";
    lines.push(`- 风险评级：**${risk}**（${meaning}）。`);
  } else {
    lines.push(refs.length ? "- 风险评级：未评估（特征比对未完成，不能根据字面相似度判断新颖性或创造性）。" : "- 风险评级：未评估（没有检到可比对的专利文献）。");
  }
  lines.push(`- 方案与对比文件摘要的最大字面重合度：${Math.round(input.overlap * 100)}%（仅作辅助参考）。`);
  if (assessment?.reason) lines.push(`- 评估理由：${assessment.reason}`);
  if (input.suggestion) {
    lines.push(`- 改进建议（未替换发明人方案）：可考虑调整为「${input.suggestion.title}」，${input.suggestion.feature ? `增加特征：${input.suggestion.feature}` : "强化区别技术特征"}。`);
  }
  lines.push("- 撰写要求：权利要求 1 必须包含上表全部区别技术特征；背景技术逐篇评述对比文件；说明书“创新点分析”和“有益效果”与区别特征一一对应。");
  lines.push("");
  lines.push("## 八、查新过程");
  lines.push("| 轮次 | 方案 | 文献数 | 风险 | 处理 |");
  lines.push("| --- | --- | --- | --- | --- |");
  rounds.forEach((row) => lines.push(`| ${row.round} | ${cell(row.title, 40)} | ${row.docs} | ${row.risk ?? "未评估"} | ${cell(row.action, 60)} |`));
  return lines.join("\n");
}

/** 聊天里展示的一段话：结论先行。 */
export function noveltySummary(outcome: NoveltyOutcome): string {
  const { assessment, refs, risk } = outcome;
  const closestIndex = assessment ? refs.findIndex((ref) => ref.pn === assessment.closest) : -1;
  const changedLine = outcome.changed ? `经 ${outcome.rounds.length} 轮查新，方案调整为「${outcome.point.title}」。` : "";
  const riskLine = risk ? `风险评级「${risk}」` : refs.length ? "特征比对未完成，风险未评估" : "没有检到可比对的专利文献，风险未评估";
  const parts = [
    `查新对比完成：${changedLine}检到 ${refs.length} 篇带公开号的中国专利，${riskLine}${closestIndex >= 0 ? `，最接近的现有技术为 ${refs[closestIndex].pn}` : ""}。`,
    assessment?.distinguishing.length ? `区别技术特征 ${assessment.distinguishing.length} 项：${assessment.distinguishing.slice(0, 3).map((row) => clip(row.feature, 40)).join("；")}${assessment.distinguishing.length > 3 ? " 等" : ""}。` : "",
    "完整的特征对比矩阵、创新点分析和查新过程已保存为《查新对比报告.md》，写全文时据此撰写背景技术、区别技术特征和创新点分析。检索结果是公开网页线索，不是官方查新结论。",
  ];
  return parts.filter(Boolean).join("\n\n");
}

// ───────────────────────────── 流程 ─────────────────────────────

interface RoundResult {
  point: NoveltyPoint;
  refs: PriorArtRef[];
  assessment: NoveltyAssessment | null;
  risk: NoveltyRisk | null;
  overlap: number;
  queries: string[];
}

function riskRank(risk: NoveltyRisk | null): number {
  // 没有检到文献的方案无法比对，排在“低”之后、“中”之前。
  return risk === null ? 0.5 : RISK_ORDER[risk];
}

export async function runNoveltyCheck(input: NoveltyInput, deps: NoveltyDeps): Promise<NoveltyOutcome> {
  const { trace, signal } = input;
  const rounds: NoveltyRoundRecord[] = [];
  const visited = new Set<string>([normTitle(input.point.title)]);
  const queue = (input.alternatives ?? []).filter((item) => item.title.trim() && !visited.has(normTitle(item.title)));
  const rejected: string[] = [];
  let current = input.point;
  let best: RoundResult | null = null;
  let suggestion: NoveltyPoint | null = null;
  const abortedOutcome = (): NoveltyOutcome => ({
    point: input.point,
    refs: [],
    assessment: null,
    risk: null,
    overlap: 0,
    report: "",
    rounds,
    changed: false,
    aborted: true,
  });

  for (let round = 1; round <= NOVELTY_MAX_ROUNDS; round += 1) {
    if (signal?.aborted) return abortedOutcome();
    const queries = noveltyQueries(current);
    trace(`查新第 ${round} 轮：「${current.title}」，按题目、核心特征和技术问题生成 ${queries.length} 条检索式。`);
    const refs = queries.length
      ? await gatherPriorArt(queries, {
          search: deps.search,
          extract: deps.extract,
          onTrace: trace,
          signal,
          limit: NOVELTY_DOC_LIMIT,
          enrich: 6,
          topic: [current.title, current.feature].filter(Boolean).join(" "),
        })
      : [];
    if (signal?.aborted) return abortedOutcome();
    const overlap = refs.reduce((max, ref) => Math.max(max, featureCoverage(current, ref)), 0);
    let assessment: NoveltyAssessment | null = null;
    let risk: NoveltyRisk | null = null;
    if (refs.length) {
      trace(`查新第 ${round} 轮检到 ${refs.length} 篇，逐项比对技术特征、评估新颖性和创造性风险。`);
      const reply = await deps.ask(
        [
          { role: "system", content: NOVELTY_SYSTEM },
          { role: "user", content: noveltyPrompt(current, refs, rejected) },
        ],
        trace,
        signal,
      );
      if (signal?.aborted || reply.aborted) return abortedOutcome();
      assessment = reply.ok ? parseNoveltyReply(reply.text, refs, current) : null;
      if (assessment) {
        risk = maxRisk(maxRisk(assessment.risk, matrixRisk(assessment)), coverageRisk(overlap) === "高" ? "中" : "低");
      } else {
        risk = null;
        trace(`特征比对${reply.ok ? "回复无法解析" : `没有完成（${reply.detail || "无返回"}）`}，风险未评估。字面重合度 ${Math.round(overlap * 100)}% 仅作辅助参考，不能据此判断创新性。`);
      }
    } else {
      trace(`查新第 ${round} 轮没有检到带公开号且相关的中国专利，无法逐项比对。`);
    }
    const result: RoundResult = { point: current, refs, assessment, risk, overlap, queries };
    if (!best || riskRank(risk) <= riskRank(best.risk)) best = result;
    const record: NoveltyRoundRecord = { round, title: current.title, queries, docs: refs.length, risk, action: "" };
    rounds.push(record);

    if (risk === null || risk === "低") {
      record.action = risk === null ? (refs.length ? "特征比对未完成，保留方案且风险未评估" : "未检到可比对文献，采用该方案") : "区别特征明确，采用该方案";
      best = result;
      break;
    }
    if (!input.allowRewrite) {
      record.action = "保留发明人方案，强化建议写入报告";
      suggestion = assessment?.improved ?? null;
      break;
    }
    if (round === NOVELTY_MAX_ROUNDS) {
      record.action = "已达查新轮数上限，采用风险最低的一轮";
      break;
    }
    const improved = assessment?.improved;
    if (improved && !visited.has(normTitle(improved.title))) {
      record.action = `风险${risk}，按未公开的技术手段强化方案后复查`;
      rejected.push(current.title);
      visited.add(normTitle(improved.title));
      current = improved;
      continue;
    }
    const next = queue.shift();
    if (next) {
      record.action = `风险${risk}且无强化方案，换下一个候选题目`;
      rejected.push(current.title);
      visited.add(normTitle(next.title));
      current = next;
      continue;
    }
    record.action = "没有更优的候选方案，采用风险最低的一轮";
    break;
  }

  const final = best as RoundResult;
  const report = noveltyReport({
    point: final.point,
    refs: final.refs,
    assessment: final.assessment,
    risk: final.risk,
    overlap: final.overlap,
    rounds,
    queries: final.queries,
    suggestion,
  });
  return {
    point: final.point,
    refs: final.refs,
    assessment: final.assessment,
    risk: final.risk,
    overlap: final.overlap,
    report,
    rounds,
    changed: normTitle(final.point.title) !== normTitle(input.point.title),
    aborted: false,
  };
}
