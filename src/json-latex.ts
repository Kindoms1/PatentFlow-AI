/**
 * 模型在 JSON 字符串里直接写 LaTeX（如 $\theta$、$\mathrm{d}$）时，单个反斜杠会被 JSON 当作转义：
 * \m、\s、\a 等非法转义让 JSON.parse 报错；\theta、\frac、\rho、\beta、\nabla 则会被悄悄解析成
 * 制表符、换页符、回车等控制字符，公式被破坏。这里只在字符串字面量内部把这些反斜杠改成双反斜杠；
 * 合法转义（双反斜杠、\"、\/、\uXXXX，以及后面不是 LaTeX 命令的 \n、\t 等）原样保留。
 */
const LATEX_ON_JSON_ESCAPE = new Set([
  // \b
  "beta", "bar", "bf", "big", "bigl", "bigr", "bigg", "biggl", "biggr", "boldsymbol", "binom", "bullet", "bmod",
  "backslash", "begin", "boxed", "breve", "bot",
  // \f
  "frac", "forall", "flat", "frown",
  // \n
  "nabla", "neq", "nu", "neg", "notin", "nonumber", "newline", "nolimits",
  // \r
  "rho", "right", "rightarrow", "rm", "rangle", "rceil", "rfloor", "rbrace", "rvert",
  // \t
  "theta", "tau", "times", "text", "textrm", "textbf", "textit", "tan", "tanh", "tilde", "top", "triangle", "to",
]);

export function escapeLatexBackslashes(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = text[i + 1] ?? "";
    if (next === "\\" || next === '"' || next === "/") {
      out += ch + next;
      i += 1;
      continue;
    }
    if (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
      out += ch + next;
      i += 1;
      continue;
    }
    if (next !== "" && "bfnrt".includes(next)) {
      const run = /^[A-Za-z]+/.exec(text.slice(i + 1))?.[0] ?? "";
      if (!LATEX_ON_JSON_ESCAPE.has(run)) {
        out += ch + next;
        i += 1;
        continue;
      }
    }
    out += "\\\\";
  }
  return out;
}
