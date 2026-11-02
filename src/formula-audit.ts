/**
 * 公式与符号的确定性一致性检查（权利要求书、说明书、摘要之间）。
 *
 * 只检查机器能可靠判断的问题，每一项都给出具体位置和原文，便于修订轮或用户定点修改：
 *   - formula-syntax          公式定界符、花括号、\left/\right、环境、双层下标
 *   - formula-plain           公式写成普通文字（导出 Word 时不能生成公式对象）
 *   - formula-subscript       正文中 Unicode 下标与下划线下标混用、θ_i_min 式的双层下标
 *   - formula-symbol-conflict 同一符号被定义为两种含义（例如 Kₛ 既是水分胁迫系数又是饱和导水率）
 *   - formula-undefined       公式中的符号在全文没有定义
 *   - formula-sum             求和号没有写明求和范围
 *   - formula-numbering       说明书独立公式的编号缺失、重复、不连续，或正文引用了不存在的式号
 *   - formula-cross           权利要求（或摘要）中的公式与说明书中同一左端的公式不一致，或说明书中没有
 *   - formula-range           权利要求限定的数值范围与说明书实施例给出的数值相矛盾
 * 物理意义层面的错误（坐标方向与重力项符号、边界条件、量纲）由 math-review 的模型审阅负责。
 */
import {
  canonicalFormula,
  joinDisplayBlocks,
  normalizeSymbol,
  parseDisplayLine,
  splitEquation,
  splitMath,
  symbolFamily,
  texSyntaxProblems,
  texToPlain,
  formulaSymbols,
} from "./formula.ts";

export interface FormulaSource {
  /** 所属部分：说明书摘要、权利要求书，或说明书的五个部分之一。 */
  part: string;
  /** 定位名称，例如“权利要求6”“具体实施方式”。 */
  where: string;
  text: string;
}

export interface FormulaEntry {
  tex: string;
  display: boolean;
  label: string | null;
  part: string;
  where: string;
  /** 可读形式（θ_fc、∂θ/∂t），用于比对与展示。 */
  plain: string;
}

export interface SymbolDef {
  key: string;
  meaning: string;
  unit: string;
  where: string;
  /** explicit：“X为……”“X表示……”或符号表；term：“田间持水量θ_fc”式的随文标注。 */
  kind: "explicit" | "term" | "table";
}

export interface SymbolValue {
  key: string;
  family: string;
  value: number;
  unit: string;
  text: string;
  part: string;
  where: string;
}

export interface SymbolRange {
  key: string;
  family: string;
  lo: number;
  hi: number;
  unit: string;
  text: string;
  part: string;
  where: string;
  /** A classification branch, not a universal bound on all samples. */
  conditional?: true;
}

export type FormulaLevel = "error" | "warn";

export interface FormulaIssue {
  id: FormulaCheckId;
  level: FormulaLevel;
  detail: string;
  where: string[];
}

export type FormulaCheckId =
  | "formula-syntax"
  | "formula-plain"
  | "formula-subscript"
  | "formula-symbol-conflict"
  | "formula-undefined"
  | "formula-sum"
  | "formula-numbering"
  | "formula-cross"
  | "formula-range";

export const FORMULA_CHECK_LABELS: Record<FormulaCheckId, string> = {
  "formula-syntax": "公式语法",
  "formula-plain": "公式书写方式",
  "formula-subscript": "下标写法统一",
  "formula-symbol-conflict": "一个符号只有一个含义",
  "formula-undefined": "公式符号均有定义",
  "formula-sum": "求和范围写明",
  "formula-numbering": "公式编号与引用",
  "formula-cross": "权利要求与说明书公式一致",
  "formula-range": "权利要求数值范围与实施例一致",
};

export const FORMULA_CHECK_ORDER: FormulaCheckId[] = [
  "formula-syntax",
  "formula-cross",
  "formula-range",
  "formula-symbol-conflict",
  "formula-numbering",
  "formula-plain",
  "formula-subscript",
  "formula-undefined",
  "formula-sum",
];

export interface FormulaReport {
  formulas: FormulaEntry[];
  symbols: SymbolDef[];
  values: SymbolValue[];
  ranges: SymbolRange[];
  issues: FormulaIssue[];
  /** 用普通文字书写、未用 LaTeX 的公式行数。 */
  plainFormulaCount: number;
  /** 草稿中是否有公式（LaTeX 或普通文字）。没有公式时整组检查不适用。 */
  applicable: boolean;
}

const DESCRIPTION_PARTS = new Set(["技术领域", "背景技术", "发明内容", "附图说明", "具体实施方式"]);
const CLAIMS_PART = "权利要求书";
const ABSTRACT_PART = "说明书摘要";

// ---------------------------------------------------------------------------
// text helpers

const SUB_CHARS = "₀₁₂₃₄₅₆₇₈₉ₐₑₒₓₕₖₗₘₙₚₛₜᵢⱼᵣᵤᵥ";
const SYM_BASE = String.raw`[ΔδΣ]?[A-Za-zα-ωΑ-Ωϑϕφ][\u0300-\u036f\u20d7]?`;
const SYM_SUB = String.raw`(?:_(?:\([^()\s]{1,24}\)|[A-Za-z0-9,]{1,24})|[${SUB_CHARS}]+)`;
/** A symbol in plain text: θ, θ_fc, K_sat, Kₛ, ET_0, V_req, θ_min,i, Δt, θ̄. Multi-letter bases need a subscript. */
const SYM = String.raw`(?:${SYM_BASE}(?:[A-Za-z]{1,3}(?=_|[${SUB_CHARS}]))?${SYM_SUB}?)`;
const NUM = String.raw`[+\-−]?\d+(?:\.\d+)?(?:\s*[×x*]\s*10\s*(?:\^\s*\(?\s*[+\-−]?\d+\s*\)?|[⁺⁻]?[⁰¹²³⁴⁵⁶⁷⁸⁹]+))?(?:[eE][+\-−]?\d+)?`;
const UNIT = String.raw`(?:[A-Za-zμ°℃%‰][A-Za-zμ°℃%‰/·³²¹⁻^()−\d]{0,12})`;
const RANGE_SEP = String.raw`(?:～|~|〜|至|到|—|–|-)`;
const BEFORE_SYMBOL = String.raw`(?<![A-Za-z0-9_\u0300-\u036f])(?<!_\()`;

/** Plain form of a line for symbol and value matching: math converted with `_` subscripts, spacing collapsed. */
function auditPlain(line: string): string {
  return splitMath(line)
    .map((segment) => (segment.kind === "text" ? segment.value : ` ${texToPlain(segment.tex, { unicodeScripts: false })} `))
    .join("")
    .replace(/[ \t]+/g, " ");
}

function parseNumber(raw: string): number | null {
  const text = raw.replace(/\s+/g, "").replace(/−/g, "-");
  const hit = /^([+-]?\d+(?:\.\d+)?)(?:[×x*]10(?:\^\(?([+-]?\d+)\)?|([⁺⁻]?[⁰¹²³⁴⁵⁶⁷⁸⁹]+)))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!hit) return null;
  let value = Number(hit[1]);
  if (hit[2]) value *= 10 ** Number(hit[2]);
  if (hit[3]) {
    const digits = hit[3].replace("⁺", "").replace("⁻", "-").replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (ch) => String("⁰¹²³⁴⁵⁶⁷⁸⁹".indexOf(ch)));
    value *= 10 ** Number(digits);
  }
  if (hit[4]) value *= 10 ** Number(hit[4]);
  return Number.isFinite(value) ? value : null;
}

const LENGTH: Record<string, number> = { μm: 1e-6, um: 1e-6, mm: 1e-3, cm: 1e-2, dm: 0.1, m: 1, km: 1e3 };
const TIME: Record<string, number> = { ms: 1e-3, s: 1, min: 60, h: 3600, d: 86400, day: 86400 };

function cleanUnit(unit: string): string {
  return unit.trim().replace(/[（(].*$/, "").replace(/[，,。；;、]+$/, "");
}

/** Convert a value to the other unit when both are lengths or both are times; null when not comparable. */
function convert(value: number, from: string, to: string): number | null {
  const a = cleanUnit(from);
  const b = cleanUnit(to);
  if (!a || !b || a === b) return value;
  if (a in LENGTH && b in LENGTH) return (value * LENGTH[a]) / LENGTH[b];
  if (a in TIME && b in TIME) return (value * TIME[a]) / TIME[b];
  return null;
}

function keyOf(raw: string): string {
  return normalizeSymbol(raw.replace(/\s+/g, ""));
}

/** Step labels (S1), model numbers and Chinese ordinal markers are not symbols. */
function plausibleSymbol(key: string): boolean {
  if (!key) return false;
  if (/^[A-Za-z]+\d+$/.test(key)) return false;
  if (/^[A-Z]{2,}$/.test(key)) return false;
  return true;
}

function dice(a: string, b: string): number {
  const grams = (text: string) => {
    const chars = [...text.replace(/[\s，,。；;、（）()]/g, "")];
    const out = new Map<string, number>();
    for (let index = 0; index < chars.length - 1; index += 1) {
      const gram = chars[index] + chars[index + 1];
      out.set(gram, (out.get(gram) ?? 0) + 1);
    }
    return out;
  };
  const left = grams(a);
  const right = grams(b);
  let shared = 0;
  let total = 0;
  for (const count of left.values()) total += count;
  for (const count of right.values()) total += count;
  for (const [gram, count] of left) shared += Math.min(count, right.get(gram) ?? 0);
  return total ? (2 * shared) / total : 0;
}

const MEANING_NOISE = /^(?:所述|该|上述|本发明的?|当前|实际)|(?:的值|值)$/g;

function cleanMeaning(raw: string): { meaning: string; unit: string } {
  let meaning = raw.trim();
  let unit = "";
  const paren = /[（(]([^（）()]{1,24})[）)]\s*$/.exec(meaning);
  if (paren) {
    const inner = paren[1].replace(/^单位\s*[:：为]?\s*/, "").trim();
    if (/^[A-Za-zμ°℃%‰\d/·³²¹⁻^()−\s-]+$/.test(inner) || /^无量纲/.test(inner)) unit = inner;
    meaning = meaning.slice(0, paren.index).trim();
  }
  const unitWord = /[，,]?\s*单位(?:为|是|：|:)\s*(\S+)\s*$/.exec(meaning);
  if (unitWord) {
    unit = unit || unitWord[1];
    meaning = meaning.slice(0, unitWord.index).trim();
  }
  meaning = meaning.replace(MEANING_NOISE, "").replace(/[，,。；;：:、\s]+$/g, "").trim();
  return { meaning, unit };
}

function meaningsConflict(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = a.replace(/\s/g, "");
  const y = b.replace(/\s/g, "");
  if (x === y || x.includes(y) || y.includes(x)) return false;
  return dice(x, y) < 0.25;
}

function preview(text: string, cap = 36): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > cap ? `${line.slice(0, cap)}…` : line;
}

function uniq<T>(values: T[]): T[] {
  return [...new Set(values)];
}

// ---------------------------------------------------------------------------
// collection

function sourceLines(source: FormulaSource): string[] {
  let fence = false;
  const out: string[] = [];
  for (const line of joinDisplayBlocks(source.text).split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      continue;
    }
    if (!fence && line.trim()) out.push(line);
  }
  return out;
}

function collectFormulas(sources: FormulaSource[]): { formulas: FormulaEntry[]; delimiterProblems: Array<{ where: string; line: string }> } {
  const formulas: FormulaEntry[] = [];
  const delimiterProblems: Array<{ where: string; line: string }> = [];
  for (const source of sources) {
    for (const line of sourceLines(source)) {
      const display = parseDisplayLine(line);
      if (display) {
        formulas.push({ tex: display.tex, display: true, label: display.label, part: source.part, where: source.where, plain: texToPlain(display.tex) });
        continue;
      }
      const segments = splitMath(line);
      let consumed = 0;
      for (const segment of segments) {
        if (segment.kind !== "math") continue;
        consumed += segment.open === "$$" ? 4 : segment.open === "$" ? 2 : 0;
        formulas.push({ tex: segment.tex, display: segment.display, label: null, part: source.part, where: source.where, plain: texToPlain(segment.tex) });
      }
      const dollars = (line.match(/(?<!\\)\$/g) ?? []).length;
      if (dollars > consumed) delimiterProblems.push({ where: source.where, line });
    }
  }
  return { formulas, delimiterProblems };
}

/**
 * Upright multi-letter names (NDVI, GDD, SWI) defined in the symbol table, by “NDVI为……”, or by “归一化植被指数（NDVI）”.
 * Used only to tell whether such a name in a formula is defined; they never enter the symbol-conflict check.
 */
function collectAcronyms(sources: FormulaSource[]): Set<string> {
  const found = new Set<string>();
  const ACRONYM = String.raw`(?<![A-Za-z0-9_])([A-Z]{2,6})(?![A-Za-z0-9_])`;
  const patterns = [
    new RegExp(String.raw`${ACRONYM}\s*(?:[（(][^（）()]{1,24}[）)])?\s*(?:为|表示|是|代表|指|——|：|:)`, "g"),
    new RegExp(String.raw`[\u4e00-\u9fa5]{2,}\s*[（(][^（）()]{0,40}?${ACRONYM}\s*[）)]`, "g"),
    new RegExp(String.raw`[\u4e00-\u9fa5]{2,16}\s*${ACRONYM}(?=\s*(?:[，、。；;,）)和及与或]|$))`, "g"),
  ];
  for (const source of sources) {
    let symbolAt = -1;
    for (const line of sourceLines(source)) {
      const trimmed = line.trim();
      if (/^\|.*\|$/.test(trimmed)) {
        const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
        if (cells.some((cell) => /符号/.test(cell)) && cells.some((cell) => /含义|名称|意义|说明/.test(cell))) {
          symbolAt = cells.findIndex((cell) => /符号/.test(cell));
          continue;
        }
        if (symbolAt >= 0) {
          const tex = (cells[symbolAt] ?? "").replace(/^\$+|\$+$/g, "");
          const key = texToPlain(tex, { unicodeScripts: false }).replace(/\s+/g, "");
          if (/^[A-Z]{2,6}$/.test(key)) found.add(key);
        }
        continue;
      }
      symbolAt = -1;
      const plain = auditPlain(line);
      for (const pattern of patterns) for (const hit of plain.matchAll(pattern)) found.add(hit[1]);
    }
  }
  return found;
}

function isDefinitionSubject(plain: string, at: number): boolean {
  const before = plain.slice(0, at).trimEnd();
  // A final operand in “0.10 × q_i0 为…” is not the defined expression.
  // Likewise “以 q_3 为反馈量” uses an existing quantity rather than defining it.
  const listMarker = /^\s*(?:>\s*)*[-+*]$/.test(before);
  return (listMarker || !/[+−\-×·*/÷=<>≤≥^]$/.test(before)) && !/(?:将|把|以|用)$/.test(before);
}

function collectDefinitions(sources: FormulaSource[]): SymbolDef[] {
  const defs: SymbolDef[] = [];
  // “λ₁和λ₂分别为……”: several symbols defined in one breath
  const respective = new RegExp(String.raw`${BEFORE_SYMBOL}(${SYM}(?:\s*(?:、|，|,|和|及|与)\s*${SYM}){1,7})\s*分别(?:为|表示|是|代表|指)\s*([^。；;\n]{2,80})`, "gu");
  const oneSymbol = new RegExp(String.raw`${BEFORE_SYMBOL}(${SYM})`, "gu");
  const explicit = new RegExp(String.raw`${BEFORE_SYMBOL}(${SYM})(?:\s*\([^()]{1,16}\))?\s*(?:为|表示|是(?!否)|代表|指|——|：|:)\s*(?![+\-−]?\d)([^，。；;,\n]{2,48})`, "gu");
  const term = new RegExp(String.raw`([\u4e00-\u9fa5]{2,16})\s*${BEFORE_SYMBOL}(${SYM})(?=\s*(?:[，、。；;,）)和及与或]|$))`, "gu");
  for (const source of sources) {
    let tableHead: string[] | null = null;
    for (const line of sourceLines(source)) {
      const trimmed = line.trim();
      if (/^\|.*\|$/.test(trimmed)) {
        if (/^\|?[\s:|-]+\|?$/.test(trimmed)) continue;
        const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
        if (cells.some((cell) => /符号/.test(cell)) && cells.some((cell) => /含义|名称|意义|说明/.test(cell))) {
          tableHead = cells;
          continue;
        }
        if (tableHead) {
          const symbolAt = tableHead.findIndex((cell) => /符号/.test(cell));
          const meaningAt = tableHead.findIndex((cell) => /含义|名称|意义|说明/.test(cell));
          const unitAt = tableHead.findIndex((cell) => /单位|量纲/.test(cell));
          const rawSymbol = cells[symbolAt] ?? "";
          const tex = rawSymbol.replace(/^\$+|\$+$/g, "");
          const key = keyOf(/\\|\{|_/.test(tex) ? texToPlain(tex, { unicodeScripts: false }) : tex);
          const meaning = cleanMeaning(cells[meaningAt] ?? "").meaning;
          if (plausibleSymbol(key) && meaning) defs.push({ key, meaning, unit: unitAt >= 0 ? (cells[unitAt] ?? "").replace(/\$/g, "") : "", where: source.where, kind: "table" });
        }
        continue;
      }
      tableHead = null;
      const plain = auditPlain(line);
      for (const hit of plain.matchAll(explicit)) {
        if (!isDefinitionSubject(plain, hit.index ?? 0)) continue;
        const key = keyOf(hit[1]);
        if (!plausibleSymbol(key)) continue;
        const { meaning, unit } = cleanMeaning(hit[2]);
        if (!meaning || /^[A-Za-z0-9_]/.test(meaning)) continue;
        defs.push({ key, meaning, unit, where: source.where, kind: "explicit" });
      }
      // “λ₁和λ₂分别为MAE和MSE的权重系数”: kept as a weak (term) definition, so it never makes a hard conflict
      for (const hit of plain.matchAll(respective)) {
        const keys = uniq([...hit[1].matchAll(oneSymbol)].map((item) => keyOf(item[1])).filter(plausibleSymbol));
        const meaning = cleanMeaning(hit[2]).meaning;
        if (keys.length < 2 || meaning.length < 2) continue;
        for (const key of keys) defs.push({ key, meaning, unit: "", where: source.where, kind: "term" });
      }      for (const hit of plain.matchAll(term)) {
        // “控制器将 q_3” and “超出时取 k_i,max” are actions, not quantity names.
        if (/(?:将|把|以|取|对|按|由|为)$/.test(hit[1])) continue;
        const key = keyOf(hit[2]);
        if (!plausibleSymbol(key)) continue;
        const words = hit[1].split(/的|获取|计算|根据|所述|得到|包括|和|及|与|将|为|对|以|按|由|在|中|即|其中|式中|以及|设定|确定|采用|利用/).filter(Boolean);
        const meaning = cleanMeaning(words[words.length - 1] ?? "").meaning;
        if (meaning.length >= 2) defs.push({ key, meaning, unit: "", where: source.where, kind: "term" });
      }
    }
  }
  return defs;
}

interface TermRange {
  term: string;
  lo: number;
  hi: number;
  unit: string;
  text: string;
  part: string;
  where: string;
}

/** Ranges stated by name rather than symbol (“分层厚度为10～30 cm”), resolved to a symbol through its definition. */
function collectTermRanges(sources: FormulaSource[]): TermRange[] {
  const out: TermRange[] = [];
  const pattern = new RegExp(String.raw`([\u4e00-\u9fa5]{2,14})\s*(?:的)?\s*(?:取值范围|数值范围|范围)?\s*(?:为|是|取|在)\s*(${NUM})\s*(${UNIT})?\s*${RANGE_SEP}\s*(${NUM})\s*(${UNIT})?`, "gu");
  for (const source of sources) {
    for (const line of sourceLines(source)) {
      for (const hit of auditPlain(line).matchAll(pattern)) {
        const lo = parseNumber(hit[2]);
        const hi = parseNumber(hit[4]);
        if (lo === null || hi === null) continue;
        const words = hit[1].split(/的|所述|其中|包括|和|及|与|将|对|以|按|由|在|中|各|每|该/).filter(Boolean);
        const term = (words[words.length - 1] ?? "").replace(/(?:取值|数值)$/, "");
        if (term.length < 2) continue;
        out.push({ term, lo: Math.min(lo, hi), hi: Math.max(lo, hi), unit: cleanUnit(hit[5] || hit[3] || ""), text: hit[0].trim(), part: source.part, where: source.where });
      }
    }
  }
  return out;
}

function resolveTermRanges(terms: TermRange[], symbols: SymbolDef[], ranges: SymbolRange[]): SymbolRange[] {
  const out: SymbolRange[] = [];
  for (const item of terms) {
    const def = symbols.find((candidate) => candidate.meaning === item.term || candidate.meaning.endsWith(item.term) || (item.term.endsWith(candidate.meaning) && candidate.meaning.length >= 3));
    if (!def) continue;
    const family = symbolFamily(def.key);
    if (ranges.some((range) => !range.conditional && range.where === item.where && range.family === family && range.lo === item.lo && range.hi === item.hi)) continue;
    out.push({ key: def.key, family, lo: item.lo, hi: item.hi, unit: item.unit, text: item.text, part: item.part, where: item.where });
  }
  return out;
}

function isClassificationRange(plain: string, at: number, length: number): boolean {
  const before = plain.slice(0, at);
  const after = plain.slice(at + length);
  const clause = before.split(/[，,。；;：:]/).at(-1) ?? before;
  if (/(?:必须|均须|均应|应当|始终|限定|取值范围|数值范围)/.test(clause)) return false;
  const band = String.raw`(?:第[一二三四五六七八九十百0-9]+阈值|分类|分级|等级)区间`;
  // Only inspect text adjoining this range; an unrelated bound in the same
  // paragraph must still be checked against every applicable sample.
  return new RegExp(String.raw`${band}\s*(?:为|是|：|:)?\s*$`, "u").test(before)
    || new RegExp(String.raw`^\s*(?:的\s*)?${band}\s*(?:内|中)`, "u").test(after)
    || /^\s*(?:时\s*)?(?:[，,]\s*)?(?:则\s*)?(?:判为|判定为|划分为|归为|归类为)/u.test(after);
}

function collectValues(sources: FormulaSource[]): { values: SymbolValue[]; ranges: SymbolRange[] } {
  const values: SymbolValue[] = [];
  const ranges: SymbolRange[] = [];
  const rangeWords = new RegExp(String.raw`${BEFORE_SYMBOL}(${SYM})\s*(?:的)?\s*(?:取值范围|数值范围|范围|取值)?\s*(?:为|是|取|在|：|:)?\s*(${NUM})\s*(${UNIT})?\s*${RANGE_SEP}\s*(${NUM})\s*(${UNIT})?`, "gu");
  const rangeIneq = new RegExp(String.raw`(${NUM})\s*(${UNIT})?\s*(?:≤|<|＜|⩽)\s*(${SYM})\s*(?:≤|<|＜|⩽)\s*(${NUM})\s*(${UNIT})?`, "gu");
  const rangeIn = new RegExp(String.raw`${BEFORE_SYMBOL}(${SYM})\s*∈\s*[\[(（]\s*(${NUM})\s*[,，]\s*(${NUM})\s*[\])）]\s*(${UNIT})?`, "gu");
  const single = new RegExp(String.raw`${BEFORE_SYMBOL}(${SYM})\s*(?:=|＝|取值为|取为|设为|设定为|取|为)\s*(${NUM})(?!\s*(?:${UNIT})?\s*${RANGE_SEP}\s*\d)(?![\d.])\s*(${UNIT})?`, "gu");
  for (const source of sources) {
    for (const line of sourceLines(source)) {
      const plain = auditPlain(line);
      const covered: Array<[number, number]> = [];
      const pushRange = (raw: string, lo: number | null, hi: number | null, unit: string, text: string, at: number, length: number) => {
        const key = keyOf(raw);
        if (!plausibleSymbol(key) || lo === null || hi === null) return;
        covered.push([at, at + length]);
        ranges.push({ key, family: symbolFamily(key), lo: Math.min(lo, hi), hi: Math.max(lo, hi), unit: cleanUnit(unit), text, part: source.part, where: source.where,
          ...(isClassificationRange(plain, at, length) ? { conditional: true as const } : {}),
        });
      };
      for (const hit of plain.matchAll(rangeWords)) pushRange(hit[1], parseNumber(hit[2]), parseNumber(hit[4]), hit[5] || hit[3] || "", hit[0], hit.index ?? 0, hit[0].length);
      for (const hit of plain.matchAll(rangeIneq)) pushRange(hit[3], parseNumber(hit[1]), parseNumber(hit[4]), hit[5] || hit[2] || "", hit[0], hit.index ?? 0, hit[0].length);
      for (const hit of plain.matchAll(rangeIn)) pushRange(hit[1], parseNumber(hit[2]), parseNumber(hit[3]), hit[4] || "", hit[0], hit.index ?? 0, hit[0].length);
      for (const hit of plain.matchAll(single)) {
        const at = hit.index ?? 0;
        if (covered.some(([start, end]) => at >= start && at < end)) continue;
        const key = keyOf(hit[1]);
        const value = parseNumber(hit[2]);
        if (!plausibleSymbol(key) || value === null) continue;
        values.push({ key, family: symbolFamily(key), value, unit: cleanUnit(hit[3] || ""), text: hit[0].trim(), part: source.part, where: source.where });
      }
    }
  }
  return { values, ranges };
}

interface NamedClassificationBand {
  name: string;
  family: string;
  lo: number | null;
  hi: number | null;
  loClosed: boolean;
  hiClosed: boolean;
  unit: string;
  text: string;
  part: string;
  where: string;
  definition: boolean;
}

/** Read only numeric inequalities immediately adjoining an explicit interval name. */
function collectNamedClassificationBands(sources: FormulaSource[]): NamedClassificationBand[] {
  const out: NamedClassificationBand[] = [];
  const name = String.raw`第[一二三四五六七八九十百0-9]+阈值区间`;
  const leading = new RegExp(String.raw`(${name})\s*(?:(为|是|：|:)\s*)?$`, "u");
  const trailing = new RegExp(String.raw`^\s*(?:的\s*)?(${name})\s*(?:内|中)`, "u");
  const chain = new RegExp(String.raw`(${NUM})\s*(${UNIT})?\s*(≤|<|＜|⩽)\s*(${SYM})\s*(≤|<|＜|⩽)\s*(${NUM})\s*(${UNIT})?`, "gu");
  const single = new RegExp(String.raw`${BEFORE_SYMBOL}(${SYM})\s*(≥|>|＞|⩾|≤|<|＜|⩽)\s*(${NUM})\s*(${UNIT})?`, "gu");
  for (const source of sources) {
    for (const line of sourceLines(source)) {
      const plain = auditPlain(line);
      const covered: Array<[number, number]> = [];
      const add = (raw: string, lo: number | null, hi: number | null, loClosed: boolean, hiClosed: boolean, unit: string, text: string, at: number) => {
        const before = leading.exec(plain.slice(0, at));
        const after = trailing.exec(plain.slice(at + text.length));
        const label = before?.[1] ?? after?.[1];
        const key = keyOf(raw);
        if (!label || !plausibleSymbol(key) || (before && after && before[1] !== after[1])) return;
        out.push({ name: label, family: symbolFamily(key), lo, hi, loClosed, hiClosed, unit: cleanUnit(unit), text,
          part: source.part, where: source.where, definition: Boolean(before?.[2]),
        });
      };
      for (const hit of plain.matchAll(chain)) {
        const at = hit.index ?? 0;
        covered.push([at, at + hit[0].length]);
        const lo = parseNumber(hit[1]);
        const hi = parseNumber(hit[6]);
        if (lo === null || hi === null || lo > hi || (hit[2] && hit[7] && hit[2] !== hit[7])) continue;
        add(hit[4], lo, hi, /[≤⩽]/.test(hit[3]), /[≤⩽]/.test(hit[5]), hit[7] || hit[2] || "", hit[0], at);
      }
      for (const hit of plain.matchAll(single)) {
        const at = hit.index ?? 0;
        if (covered.some(([start, end]) => at >= start && at < end)) continue;
        const value = parseNumber(hit[3]);
        if (value === null) continue;
        const lower = /[≥>＞⩾]/.test(hit[2]);
        const closed = /[≥≤⩾⩽]/.test(hit[2]);
        add(hit[1], lower ? value : null, lower ? null : value, lower && closed, !lower && closed, hit[4] || "", hit[0], at);
      }
    }
  }
  return out;
}

function sameBandBounds(a: NamedClassificationBand, b: NamedClassificationBand): boolean {
  const same = (x: number | null, y: number | null) => x === y
    || (x !== null && y !== null && Math.abs(x - y) <= Math.max(Math.abs(x), Math.abs(y), 1) * 1e-9);
  return same(a.lo, b.lo) && same(a.hi, b.hi) && a.loClosed === b.loClosed && a.hiClosed === b.hiClosed;
}

/** Lines written as formulas in plain text: an equation with ∂ Σ √ ∫, a subscript, or symbol arithmetic. */
function plainFormulaLines(sources: FormulaSource[]): Array<{ where: string; text: string }> {
  const found: Array<{ where: string; text: string }> = [];
  const operator = /[∂∑Σ√∫∇]/;
  const scripted = new RegExp(String.raw`[A-Za-zα-ωΑ-Ω](?:_[A-Za-z0-9({]|[${SUB_CHARS}⁰¹²³⁴⁵⁶⁷⁸⁹])`);
  const equation = /[A-Za-zα-ωΑ-Ω)\]][^=＝。；;]{0,6}\s*[=＝]\s*[^=＝]/;
  for (const source of sources) {
    for (const line of sourceLines(source)) {
      const outside = splitMath(line)
        .map((segment) => (segment.kind === "text" ? segment.value : " "))
        .join("");
      for (const sentence of outside.split(/[。；;]/)) {
        if (!equation.test(sentence)) continue;
        if (operator.test(sentence) || scripted.test(sentence) || /[A-Za-zα-ωΑ-Ω]\s*[·×/]\s*[A-Za-zα-ωΑ-Ω(（]/.test(sentence)) {
          const at = sentence.search(/[=＝]/);
          const start = Math.max(0, at - 18);
          const piece = sentence.slice(start).trim();
          found.push({ where: source.where, text: start > 0 ? `…${piece}` : piece });
        }
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// audit

export function auditFormulas(sources: FormulaSource[]): FormulaReport {
  const { formulas, delimiterProblems } = collectFormulas(sources);
  const symbols = collectDefinitions(sources);
  const collected = collectValues(sources);
  const values = collected.values;
  const ranges = [...collected.ranges, ...resolveTermRanges(collectTermRanges(sources), symbols, collected.ranges)];
  const plainLines = plainFormulaLines(sources);
  const issues: FormulaIssue[] = [];
  const issue = (id: FormulaCheckId, level: FormulaLevel, detail: string, where: string[]) => issues.push({ id, level, detail, where: uniq(where) });

  const applicable = formulas.length > 0 || plainLines.length > 0;
  if (!applicable) return { formulas, symbols, values, ranges, issues, plainFormulaCount: 0, applicable };

  // syntax
  for (const problem of delimiterProblems) issue("formula-syntax", "error", `${problem.where}：公式定界符 $ 不配对（“${preview(problem.line)}”）`, [problem.where]);
  for (const entry of formulas) {
    for (const problem of texSyntaxProblems(entry.tex)) {
      issue("formula-syntax", problem.kind === "brackets" ? "warn" : "error", `${entry.where}：${problem.detail}（${preview(entry.plain)}）`, [entry.where]);
    }
  }

  // plain-text formulas
  if (plainLines.length) {
    const examples = plainLines.slice(0, 3).map((item) => `${item.where}“${preview(item.text, 28)}”`).join("；");
    issue("formula-plain", "warn", `${plainLines.length} 处公式以普通文字书写，未用公式定界符标记，导出 Word 时无法生成公式对象，上下标和分式也无法排版：${examples}`, plainLines.map((item) => item.where));
  }

  // subscript style
  const outsideAll = sources.map((source) => ({ where: source.where, text: splitMath(source.text).map((segment) => (segment.kind === "text" ? segment.value : " ")).join("") }));
  const unicodeSubs = outsideAll.filter((item) => new RegExp(`[A-Za-zα-ωΑ-Ω][${SUB_CHARS}]`).test(item.text));
  const underscoreSubs = outsideAll.filter((item) => /[A-Za-zα-ωΑ-Ω]_[A-Za-z0-9{(]/.test(item.text));
  if (unicodeSubs.length && underscoreSubs.length) {
    issue("formula-subscript", "warn", `正文中同时出现 Unicode 下标（如“${preview(new RegExp(`\\S{0,2}[A-Za-zα-ωΑ-Ω][${SUB_CHARS}]+`).exec(unicodeSubs[0].text)?.[0] ?? "", 12)}”）和下划线下标（如“${preview(/\S{0,2}[A-Za-zα-ωΑ-Ω]_[A-Za-z0-9{(][^\s，。；、]*/.exec(underscoreSubs[0].text)?.[0] ?? "", 12)}”），同一符号写法不统一；应统一用 $…$ 公式书写`, [...unicodeSubs, ...underscoreSubs].map((item) => item.where));
  }
  const nested = outsideAll.filter((item) => /[A-Za-zα-ωΑ-Ω]_[A-Za-z0-9]+_[A-Za-z0-9]/.test(item.text));
  if (nested.length) {
    const sample = /[A-Za-zα-ωΑ-Ω]_[A-Za-z0-9]+_[A-Za-z0-9]+/.exec(nested[0].text)?.[0] ?? "";
    issue("formula-subscript", "warn", `出现“${sample}”式的双层下标，含义不清；应写成 $\\theta_{\\mathrm{min},i}$ 这类单层组合下标`, nested.map((item) => item.where));
  }

  // symbol conflicts
  const byKey = new Map<string, SymbolDef[]>();
  for (const def of symbols) byKey.set(def.key, [...(byKey.get(def.key) ?? []), def]);
  for (const [key, defs] of byKey) {
    const strong = defs.filter((def) => def.kind !== "term");
    const pool = strong.length ? strong : defs;
    const distinct: SymbolDef[] = [];
    for (const def of pool) if (!distinct.some((other) => !meaningsConflict(other.meaning, def.meaning))) distinct.push(def);
    if (distinct.length < 2) continue;
    // a weak (term-style) clash alone is only a warning: the surrounding words may not be the symbol's name
    const level: FormulaLevel = strong.length >= 2 && distinct.every((def) => def.kind !== "term") ? "error" : "warn";
    issue("formula-symbol-conflict", level, `符号 ${key} 有 ${distinct.length} 种含义：${distinct.map((def) => `“${def.meaning}”（${def.where}）`).join("、")}；一个符号只能表示一个量，请为其中之一换用不同符号或下标`, distinct.map((def) => def.where));
  }
  // the same written symbol given two meanings through different subscript styles (Kₛ vs K_s) lands on one key
  // above; different keys that only differ by an upright/italic subscript are already merged by normalizeSymbol.

  // undefined symbols (display formulas of claims and description)
  const defined = new Set<string>();
  for (const def of symbols) {
    defined.add(def.key);
    defined.add(symbolFamily(def.key));
  }
  const used = new Map<string, string[]>();
  for (const entry of formulas.filter((item) => item.display && item.part !== ABSTRACT_PART)) {
    for (const key of formulaSymbols(entry.tex)) used.set(key, [...(used.get(key) ?? []), entry.where]);
  }
  const acronyms = collectAcronyms(sources);
  const isDefined = (key: string): boolean => defined.has(key) || defined.has(symbolFamily(key));
  // NDVI, GDD: a run of capitals is defined by its own entry (symbol table, “NDVI为……”, “……（NDVI）”) or, read as a
  // product of letters (P = UI), by every letter's definition
  const acronymDefined = (key: string): boolean => /^[A-Z]{2,6}$/.test(key) && (acronyms.has(key) || [...key].every((letter) => isDefined(letter)));
  const undefinedKeys = [...used.keys()].filter((key) => !isDefined(key) && !acronymDefined(key) && key !== "π" && key !== "e");  if (undefinedKeys.length && symbols.length) {
    issue("formula-undefined", "warn", `公式中的 ${undefinedKeys.slice(0, 10).join("、")}${undefinedKeys.length > 10 ? ` 等 ${undefinedKeys.length} 个符号` : ""}在全文没有找到“X为……”或符号表形式的定义（含义和单位）`, undefinedKeys.flatMap((key) => used.get(key) ?? []));
  } else if (undefinedKeys.length && !symbols.length) {
    issue("formula-undefined", "warn", `公式之后没有用“式中，X为……（单位）”逐个说明符号，也没有符号表；共 ${undefinedKeys.length} 个符号缺少定义`, undefinedKeys.flatMap((key) => used.get(key) ?? []));
  }

  // summation ranges
  const openSums = formulas.filter((entry) => /\\sum(?!\s*(?:\\limits\s*)?_)/.test(entry.tex));
  if (openSums.length) issue("formula-sum", "warn", `${openSums.length} 个求和号没有写明求和范围（应写成 \\sum_{i=1}^{N}）：${openSums.slice(0, 3).map((entry) => `${entry.where}“${preview(entry.plain, 24)}”`).join("；")}`, openSums.map((entry) => entry.where));
  const plainSums = plainLines.filter((item) => /[Σ∑]\s*[[(（]/.test(item.text));
  if (plainSums.length) issue("formula-sum", "warn", `${plainSums.length} 处求和“Σ[…]”没有写明下标和求和范围`, plainSums.map((item) => item.where));

  // numbering (description display formulas)
  const described = formulas.filter((entry) => entry.display && DESCRIPTION_PARTS.has(entry.part));
  if (described.length) {
    const labelled = described.filter((entry) => entry.label);
    if (!labelled.length) {
      issue("formula-numbering", "warn", `说明书中 ${described.length} 个独立公式都没有编号，应在公式右侧依次写（1）（2）…，正文用“式（1）”引用`, described.map((entry) => entry.where));
    } else {
      const missing = described.filter((entry) => !entry.label);
      if (missing.length) issue("formula-numbering", "warn", `说明书中 ${missing.length} 个独立公式没有编号：${missing.slice(0, 3).map((entry) => `“${preview(entry.plain, 24)}”`).join("、")}`, missing.map((entry) => entry.where));
      const labels = labelled.map((entry) => entry.label as string);
      const duplicates = uniq(labels.filter((label, index) => labels.indexOf(label) !== index));
      if (duplicates.length) issue("formula-numbering", "error", `公式编号（${duplicates.join("）、（")}）重复使用`, labelled.filter((entry) => duplicates.includes(entry.label as string)).map((entry) => entry.where));
      const simple = labels.filter((label) => /^\d+$/.test(label)).map(Number);
      if (simple.length === labels.length && simple.some((value, index) => value !== index + 1) && !duplicates.length) {
        issue("formula-numbering", "warn", `公式编号为（${simple.join("）（")}），应按出现顺序从（1）起连续编号`, labelled.map((entry) => entry.where));
      }
    }
    const known = new Set(described.map((entry) => entry.label).filter(Boolean) as string[]);
    const refs: Array<{ label: string; where: string }> = [];
    for (const source of sources.filter((item) => DESCRIPTION_PARTS.has(item.part) || item.part === CLAIMS_PART)) {
      const outside = splitMath(source.text).map((segment) => (segment.kind === "text" ? segment.value : " ")).join("");
      for (const hit of outside.matchAll(/(?:式|公式)\s*[（(]\s*(\d{1,3}(?:[-.－]\d{1,3})?)\s*[）)]/g)) refs.push({ label: hit[1].replace("－", "-"), where: source.where });
    }
    const dangling = refs.filter((ref) => !known.has(ref.label));
    if (dangling.length) issue("formula-numbering", "error", `正文引用了不存在的式号：${uniq(dangling.map((ref) => `式（${ref.label}）`)).join("、")}`, dangling.map((ref) => ref.where));
  }

  // claims / abstract formulas must appear identically in the description
  const descriptionByLhs = new Map<string, FormulaEntry[]>();
  const descriptionCanon = new Set<string>();
  for (const entry of formulas.filter((item) => DESCRIPTION_PARTS.has(item.part))) {
    const canon = canonicalFormula(entry.tex);
    descriptionCanon.add(canon);
    const eq = splitEquation(canon);
    if (eq) descriptionByLhs.set(eq.lhs, [...(descriptionByLhs.get(eq.lhs) ?? []), entry]);
  }
  for (const entry of formulas.filter((item) => item.part === CLAIMS_PART || item.part === ABSTRACT_PART)) {
    const canon = canonicalFormula(entry.tex);
    const eq = splitEquation(canon);
    if (descriptionCanon.has(canon)) continue;
    if (!eq) {
      // a bare symbol or an inequality: only formulas with an operator need a counterpart
      if (/[=≤≥<>]/.test(canon) && canon.length > 6) issue("formula-cross", "warn", `${entry.where}中的“${preview(entry.plain, 40)}”在说明书中没有逐字相同的表述`, [entry.where]);
      continue;
    }
    if (!eq.rhs || /^[\d.+\-−×^()]+$/.test(eq.rhs)) continue;
    const peers = descriptionByLhs.get(eq.lhs) ?? [];
    if (!peers.length) {
      if (entry.display || canon.length > 12) issue("formula-cross", "warn", `${entry.where}中的公式“${preview(entry.plain, 40)}”在说明书中没有对应公式，权利要求缺少说明书支持`, [entry.where]);
      continue;
    }
    issue("formula-cross", "error", `${entry.where}中的“${preview(entry.plain, 40)}”与说明书中“${preview(peers[0].plain, 40)}”（${peers[0].where}）不一致，同一公式在全文必须逐字相同`, [entry.where, peers[0].where]);
  }

  // A named band has a claim-defined boundary contract, not a bound on every sample.
  const bands = collectNamedClassificationBands(sources);
  const contracts = bands.filter((band) => band.part === CLAIMS_PART && band.definition);
  for (const band of bands.filter((item) => DESCRIPTION_PARTS.has(item.part))) {
    const peers = contracts.filter((item) => item.name === band.name && item.family === band.family && item.unit === band.unit);
    const contract = peers[0];
    // Different claim definitions may belong to different claim branches; do not infer their scope.
    if (!contract || !peers.every((item) => sameBandBounds(contract, item)) || sameBandBounds(contract, band)) continue;
    issue("formula-range", "error",
      `${band.where}将${band.name}写为“${preview(band.text, 48)}”，与${contract.where}定义的“${preview(contract.text, 48)}”边界不一致；同名分类区间的上下限及开闭边界必须一致`,
      [contract.where, band.where]);
  }

  // claim ranges vs description values (error); a description's own stated range vs its values (warn)
  const outsideOf = (range: SymbolRange, peers: SymbolValue[]): SymbolValue[] => {
    const outside: SymbolValue[] = [];
    for (const value of peers) {
      const converted = range.unit && value.unit ? convert(value.value, value.unit, range.unit) : value.value;
      if (converted === null) continue;
      const tolerance = Math.max(Math.abs(range.hi), Math.abs(range.lo), 1) * 1e-9;
      if (converted < range.lo - tolerance || converted > range.hi + tolerance) outside.push(value);
    }
    return outside;
  };
  for (const range of ranges.filter((item) => !item.conditional && DESCRIPTION_PARTS.has(item.part))) {
    const outside = outsideOf(range, values.filter((value) => DESCRIPTION_PARTS.has(value.part) && value.family === range.family));
    if (outside.length) {
      issue("formula-range", "warn", `${range.where}写明 ${range.key} 的范围为“${preview(range.text, 28)}”，但 ${outside.slice(0, 3).map((value) => `“${preview(value.text, 20)}”`).join("、")}不在该范围内`, [range.where, ...outside.map((value) => value.where)]);
    }
  }
  const claimRanges = ranges.filter((range) => !range.conditional && range.part === CLAIMS_PART);
  for (const range of claimRanges) {
    const peers = values.filter((value) => value.part !== CLAIMS_PART && value.family === range.family);
    const outside = outsideOf(range, peers);
    if (outside.length) {
      issue(
        "formula-range",
        "error",
        `${range.where}限定 ${range.key}（${preview(range.text, 28)}），但说明书中 ${outside.slice(0, 3).map((value) => `“${preview(value.text, 20)}”（${value.where}）`).join("、")}不在该范围内；实施例数值必须落在权利要求范围内，或修改权利要求的范围`,
        [range.where, ...outside.map((value) => value.where)],
      );
    }
  }

  const plainFormulaCount = plainLines.length;
  return { formulas, symbols, values, ranges, issues, plainFormulaCount, applicable };
}

/** Issues grouped by check, in display order; each group's level is its worst issue's level. */
export function groupFormulaIssues(report: FormulaReport): Array<{ id: FormulaCheckId; label: string; level: FormulaLevel | "ok"; details: string[] }> {
  return FORMULA_CHECK_ORDER.map((id) => {
    const own = report.issues.filter((item) => item.id === id);
    const level: FormulaLevel | "ok" = own.some((item) => item.level === "error") ? "error" : own.length ? "warn" : "ok";
    return { id, label: FORMULA_CHECK_LABELS[id], level, details: own.map((item) => item.detail) };
  });
}

/** One line per problem for a chat note or a revision prompt. */
export function formulaIssueLines(report: FormulaReport, cap = 12): string[] {
  const sorted = [...report.issues].sort((a, b) => (a.level === b.level ? FORMULA_CHECK_ORDER.indexOf(a.id) - FORMULA_CHECK_ORDER.indexOf(b.id) : a.level === "error" ? -1 : 1));
  return sorted.slice(0, cap).map((item) => `【${item.level === "error" ? "需修改" : "需注意"}·${FORMULA_CHECK_LABELS[item.id]}】${item.detail}`);
}

/**
 * Formula sources of a whole Markdown draft (`## 说明书摘要`, `## 权利要求书` split per claim, `## 技术领域` …).
 * Self-contained so invention-draft can call it without a circular import.
 */
export function draftFormulaSources(markdown: string): FormulaSource[] {
  const text = markdown.replace(/\r\n/g, "\n").replace(/```json[\s\S]*?```\s*$/i, "");
  const sources: FormulaSource[] = [];
  const parts = text.split(/^##\s+/m).slice(1);
  for (const part of parts) {
    const newline = part.indexOf("\n");
    const head = (newline === -1 ? part : part.slice(0, newline)).trim().replace(/[\s*:：]/g, "");
    const body = newline === -1 ? "" : part.slice(newline + 1);
    if (head.startsWith("说明书摘要") || head === "摘要") {
      sources.push({ part: ABSTRACT_PART, where: ABSTRACT_PART, text: body.replace(/^摘要附图[:：].*$/gm, "") });
    } else if (head.startsWith("权利要求")) {
      let current: { no: string; lines: string[] } | null = null;
      const flush = () => {
        if (current) sources.push({ part: CLAIMS_PART, where: `权利要求${current.no}`, text: current.lines.join("\n") });
      };
      for (const line of body.split("\n")) {
        const hit = /^\s*(\d{1,3})\s*[.、．]\s*/.exec(line);
        if (hit) {
          flush();
          current = { no: hit[1], lines: [line] };
        } else if (current) {
          current.lines.push(line);
        }
      }
      flush();
    } else {
      const name = [...DESCRIPTION_PARTS].find((item) => head.startsWith(item));
      if (name) sources.push({ part: name, where: name, text: body });
    }
  }
  return sources;
}
