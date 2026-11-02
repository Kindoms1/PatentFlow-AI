/** Preserve the epistemic status of illustrative values while removing internal review wording. */
export interface SimulationAnnotation {
  /** Offset and exact source text for the internal review sheet, before any rewriting. */
  index: number;
  raw: string;
}

export interface SimulationFormalization {
  text: string;
  annotations: SimulationAnnotation[];
}

const MATH = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<!\\)\$(?!\$)[^$\n]+?(?<!\\)\$/g;
const TOKENS = /模拟值|待实验验证/g;
const NEGATED = /(?:不是|并非|不属于|非|无需|无须|不必)[ \t]*$/;
const SENTENCE_END = /[\r\n。；;！？!?]/;
const blank = (value: string) => value.replace(/[^\r\n]/g, " ");

/** Same-length mask: fenced payloads, inline code and math cannot become prose or review entries. */
function proseMask(text: string): string {
  let fence = "";
  const tick = String.fromCharCode(96);
  const lines = text.split(/(?<=\n)/).map((line) => {
    const trimmed = line.trimStart();
    const char = trimmed[0];
    const length = char === tick || char === "~" ? trimmed.match(new RegExp("^" + char + "+"))?.[0].length ?? 0 : 0;
    if (fence) {
      if (char === fence[0] && length >= fence.length && !trimmed.slice(length).trim()) fence = "";
      return blank(line);
    }
    if (length >= 3) {
      fence = char.repeat(length);
      return blank(line);
    }
    return line;
  });
  return lines.join("").replace(MATH, blank).replace(new RegExp(tick + "+[^" + tick + "\\r\\n]*" + tick + "+", "g"), blank);
}

/**
 * Rephrase simulation/verification labels, never the numbers, definitions or technical statements.
 * Both bracketed labels and narrative sentences keep their original text in annotations.
 * Negated labels are left for manual review rather than changing the meaning of the statement.
 */
export function formalizeSimulationAnnotations(text: string): SimulationFormalization {
  const mask = proseMask(text);
  const pairs: Array<{ start: number; end: number }> = [];
  const stack: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    const char = mask[i];
    if (char === "(" || char === "（") stack.push(i);
    else if (char === ")" || char === "）") {
      const start = stack.at(-1);
      if (start !== undefined && (mask[start] === "(" ? char === ")" : char === "）")) {
        stack.pop();
        pairs.push({ start, end: i + 1 });
      }
    } else if (char === "\n") stack.length = 0;
  }
  const annotations: SimulationAnnotation[] = [];
  const spans = new Set<string>();
  let out = "";
  let last = 0;
  for (const match of mask.matchAll(TOKENS)) {
    const at = match.index;
    if (NEGATED.test(mask.slice(Math.max(0, at - 12), at))) continue;
    // Inner parentheses close first. Formula parentheses were masked above.
    const pair = pairs.find(({ start, end }) => start < at && at < end);
    let start = pair?.start ?? at;
    let end = pair?.end ?? at + match[0].length;
    if (!pair) {
      while (start > 0 && !SENTENCE_END.test(mask[start - 1])) start--;
      while (end < mask.length && !SENTENCE_END.test(mask[end])) end++;
      if (end < mask.length && !/[\r\n]/.test(mask[end])) end++;
    }
    const key = start + ":" + end;
    if (!spans.has(key)) {
      spans.add(key);
      annotations.push({ index: start, raw: text.slice(start, end) });
    }
    out += text.slice(last, at);
    out += match[0] === "模拟值" ? (pair ? "示例性设定，非实测数据" : "示例性设定（非实测数据）") : "尚需实验核验";
    last = at + match[0].length;
  }
  return { text: last ? out + text.slice(last) : text, annotations };
}
