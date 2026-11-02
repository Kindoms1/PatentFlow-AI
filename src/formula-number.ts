/**
 * 说明书公式编号：说明书中独立成行的公式按出现顺序编为（1）（2）……，编号写在行尾，
 * 与 parseDisplayLine、公式核查和 Word 导出读取的格式一致。
 *
 * 只在确定不会改变文意时动手：说明书已有任何编号、正文已有“式（n）”引用、公式不是单行 `$$…$$`
 * （行尾只允许标点）时一律原样返回，交给公式核查提示人工处理。权利要求和摘要中的公式不编号。
 */
import { parseDisplayLine, splitMath } from "./formula.ts";

/** 与 formula-audit 的 DESCRIPTION_PARTS 相同：这些二级标题下的公式属于说明书。 */
const DESCRIPTION_PARTS = ["技术领域", "背景技术", "发明内容", "附图说明", "具体实施方式"];

export interface FormulaNumbering {
  text: string;
  /** 本次加上编号的公式数。 */
  numbered: number;
  /** 未编号的原因；numbered 为 0 时给出。 */
  skipped: string | null;
}

export function numberDescriptionFormulas(markdown: string): FormulaNumbering {
  const unchanged = (skipped: string): FormulaNumbering => ({ text: markdown, numbered: 0, skipped });
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/);
  const targets: number[] = [];
  let inDescription = false;
  let fenced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading) {
      const head = heading[1].trim().replace(/[\s*:：]/g, "");
      inDescription = DESCRIPTION_PARTS.some((part) => head.startsWith(part));
      continue;
    }
    if (!inDescription) continue;
    if (line.trim() === "$$") return unchanged("说明书含多行公式块");
    const display = parseDisplayLine(line);
    // $$ 后跟正文等无法解析的公式行：编号会前后不一致，整体不动
    if (!display && line.includes("$$")) return unchanged("公式行尾有其他文字");
    if (!display) continue;
    if (display.label) return unchanged("说明书公式已有编号");
    targets.push(index);
  }
  if (!targets.length) return unchanged("说明书没有独立成行的公式");
  // 正文引用了式号却没有编号：不猜测对应关系
  const outside = splitMath(markdown).map((segment) => (segment.kind === "text" ? segment.value : " ")).join("");
  if (/(?:式|公式)\s*[（(]\s*\d/.test(outside)) return unchanged("正文已引用式号");
  const next = [...lines];
  for (const [order, index] of targets.entries()) {
    const line = lines[index];
    const close = line.lastIndexOf("$$");
    const tail = line.slice(close + 2);
    if (close <= 0 || !/^[\s，,。．.；;]*$/.test(tail)) return unchanged("公式行尾有其他文字");
    const label = String(order + 1);
    const numbered = `${line.slice(0, close + 2)}（${label}）${tail.trim()}`;
    if (parseDisplayLine(numbered)?.label !== label) return unchanged("编号后无法解析");
    next[index] = numbered;
  }
  return { text: next.join(eol), numbered: targets.length, skipped: null };
}