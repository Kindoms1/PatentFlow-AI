/**
 * 申请文件中公式的统一表示。
 *
 * 草稿（Markdown）里的公式一律用 LaTeX 书写：
 *   - 行内：`$K_{\mathrm{sat}}$`；
 *   - 独立成行：`$$ \frac{\partial \theta}{\partial t} = … $$（1）`，编号写在行尾（也接受行首或 `\tag{1}`）；
 *     也接受跨行写法：单独一行 `$$`，公式若干行，再单独一行 `$$`（编号可跟在结束的 `$$` 后面）。
 *
 * 这里只做纯文本层面的工作，不依赖 docx：
 *   - splitMath：把一段文字切成「普通文字 / 公式」片段，导出 Word 时公式片段转成原生 OMML；
 *   - parseDisplayLine / joinDisplayBlocks：识别独立公式行与编号；
 *   - texToPlain：把 LaTeX 转成可读的 Unicode 文本（字数统计、预览、跨章节比对）；
 *   - formulaSymbols / normalizeSymbol / symbolFamily：抽取并归一化公式里的变量符号，供 formula-audit 做一致性检查。
 */

export interface TextSegment {
  kind: "text";
  value: string;
}

export interface MathSegment {
  kind: "math";
  tex: string;
  display: boolean;
  /** The opening delimiter as written: a dollar, a double dollar, backslash-bracket or backslash-paren. */
  open: string;
}

export type Segment = TextSegment | MathSegment;

export interface DisplayFormula {
  tex: string;
  /** 编号（“1”“2-1”），没有编号时为 null。 */
  label: string | null;
}

const LABEL_CORE = String.raw`\d{1,3}(?:[-.－]\d{1,3})?`;
const LABEL_RE = new RegExp(String.raw`^[（(]\s*(${LABEL_CORE})\s*[）)]$`);
const TRAIL_PUNCT = /[，,。．.；;：:、]$/;

/** Read a `\tag{…}` out of a formula; returns the formula without it and the tag. */
function takeTag(tex: string): { tex: string; tag: string | null } {
  const hit = /\\tag\*?\s*\{\s*([^{}]*?)\s*\}/.exec(tex);
  if (!hit) return { tex: tex.trim(), tag: null };
  return { tex: (tex.slice(0, hit.index) + tex.slice(hit.index + hit[0].length)).trim(), tag: hit[1] || null };
}

function cleanLabel(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const value = raw.trim().replace(/^[（(]\s*/, "").replace(/\s*[）)]$/, "").replace("－", "-");
  return new RegExp(`^${LABEL_CORE}$`).test(value) ? value : null;
}

/**
 * A whole line that is one display formula: `$$…$$`, `\[…\]`, optionally with a number such as `（1）` before or
 * after it, trailing punctuation allowed. Returns null for anything else (ordinary text with inline math included).
 */
export function parseDisplayLine(line: string): DisplayFormula | null {
  let text = line.trim();
  if (!text) return null;
  let label: string | null = null;
  // leading number: （1）$$…$$
  const lead = new RegExp(String.raw`^[（(]\s*(${LABEL_CORE})\s*[）)]\s*`).exec(text);
  if (lead && /^\s*(?:\$\$|\\\[)/.test(text.slice(lead[0].length))) {
    label = cleanLabel(lead[1]);
    text = text.slice(lead[0].length).trim();
  }
  let open: string;
  let close: string;
  if (text.startsWith("$$")) {
    open = "$$";
    close = "$$";
  } else if (text.startsWith("\\[")) {
    open = "\\[";
    close = "\\]";
  } else {
    return null;
  }
  const end = text.indexOf(close, open.length);
  if (end === -1) return null;
  const body = text.slice(open.length, end);
  let rest = text.slice(end + close.length).trim();
  while (TRAIL_PUNCT.test(rest)) rest = rest.slice(0, -1).trim();
  if (rest) {
    const tail = LABEL_RE.exec(rest.replace(/[，,。．.；;]+$/, "").trim());
    if (!tail) return null;
    label = label ?? cleanLabel(tail[1]);
  }
  const tagged = takeTag(body);
  if (!tagged.tex) return null;
  return { tex: tagged.tex, label: label ?? cleanLabel(tagged.tag) };
}

/**
 * Join display formulas that span several lines (`$$` alone on a line … `$$` alone, or `\[` … `\]`) into one
 * line `$$ … $$（n）`, so line-based parsers see each formula as a single paragraph. Text inside fenced code
 * blocks is left alone. A block that never closes is returned unchanged.
 */
export function joinDisplayBlocks(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let fence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      fence = !fence;
      out.push(line);
      continue;
    }
    const opener = fence ? null : /^\s*(?:([（(]\s*\d{1,3}(?:[-.－]\d{1,3})?\s*[）)])\s*)?(\$\$|\\\[)\s*$/.exec(line);
    if (!opener) {
      out.push(line);
      continue;
    }
    const closeToken = opener[2] === "$$" ? "$$" : "\\]";
    const body: string[] = [];
    let closed = -1;
    let tail = "";
    for (let probe = index + 1; probe < lines.length && probe - index <= 40; probe += 1) {
      const candidate = lines[probe];
      const trimmed = candidate.trim();
      if (trimmed.startsWith(closeToken)) {
        closed = probe;
        tail = trimmed.slice(closeToken.length).trim();
        break;
      }
      if (trimmed.endsWith(closeToken) && trimmed.length > closeToken.length && !trimmed.startsWith("$$")) {
        body.push(trimmed.slice(0, -closeToken.length));
        closed = probe;
        break;
      }
      body.push(trimmed);
    }
    if (closed === -1) {
      out.push(line);
      continue;
    }
    const lead = opener[1] ? `${opener[1]}` : "";
    out.push(`${lead}$$ ${body.join(" ").replace(/\s+/g, " ").trim()} $$${tail}`);
    index = closed;
  }
  return out.join("\n");
}

/**
 * Split text into plain and math segments. `$$…$$` and `\[…\]` are display math, `$…$` and `\(…\)` inline.
 * `\$` is a literal dollar. An unclosed delimiter is kept as plain text (formula-audit reports it).
 */
export function splitMath(text: string): Segment[] {
  const out: Segment[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) out.push({ kind: "text", value: buffer });
    buffer = "";
  };
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    if (ch === "\\" && text[index + 1] === "$") {
      buffer += "$";
      index += 2;
      continue;
    }
    let open = "";
    let close = "";
    let display = false;
    if (text.startsWith("$$", index)) {
      open = "$$";
      close = "$$";
      display = true;
    } else if (ch === "$") {
      open = "$";
      close = "$";
    } else if (text.startsWith("\\[", index)) {
      open = "\\[";
      close = "\\]";
      display = true;
    } else if (text.startsWith("\\(", index)) {
      open = "\\(";
      close = "\\)";
    }
    if (!open) {
      buffer += ch;
      index += 1;
      continue;
    }
    const start = index + open.length;
    let end = -1;
    for (let probe = start; probe < text.length; probe += 1) {
      if (text[probe] === "\\" && close === "$" ) {
        probe += 1;
        continue;
      }
      if (text.startsWith(close, probe)) {
        if (close === "$" && text[probe + 1] === "$") continue;
        end = probe;
        break;
      }
    }
    const body = end === -1 ? "" : text.slice(start, end);
    if (end === -1 || !body.trim() || (open === "$" && body.length > 600)) {
      buffer += open;
      index += open.length;
      continue;
    }
    flush();
    out.push({ kind: "math", tex: takeTag(body).tex, display, open });
    index = end + close.length;
  }
  flush();
  return out;
}

export function hasMath(text: string): boolean {
  return splitMath(text).some((segment) => segment.kind === "math");
}

/** Remove every math segment, leaving the plain words (for checks that must not look inside formulas). */
export function textOutsideMath(text: string): string {
  return splitMath(text)
    .map((segment) => (segment.kind === "text" ? segment.value : " "))
    .join("");
}

// ---------------------------------------------------------------------------
// LaTeX → readable Unicode

const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ",
  vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", varpi: "ϖ", rho: "ρ",
  varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ",
  omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ",
  Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};

const SYMBOLS: Record<string, string> = {
  partial: "∂", nabla: "∇", cdot: "·", times: "×", div: "÷", pm: "±", mp: "∓", le: "≤", leq: "≤", leqslant: "≤",
  ge: "≥", geq: "≥", geqslant: "≥", ne: "≠", neq: "≠", approx: "≈", sim: "∼", simeq: "≃", equiv: "≡",
  propto: "∝", infty: "∞", sum: "Σ", prod: "Π", int: "∫", iint: "∬", oint: "∮", in: "∈", notin: "∉",
  subset: "⊂", subseteq: "⊆", cup: "∪", cap: "∩", forall: "∀", exists: "∃", to: "→", rightarrow: "→",
  leftarrow: "←", Rightarrow: "⇒", Leftarrow: "⇐", leftrightarrow: "↔", Leftrightarrow: "⇔", mapsto: "↦",
  cdots: "⋯", ldots: "…", dots: "…", vdots: "⋮", ddots: "⋱", circ: "∘", degree: "°", prime: "′", ast: "∗",
  star: "⋆", bullet: "•", langle: "⟨", rangle: "⟩", lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉",
  vert: "|", Vert: "‖", mid: "|", parallel: "∥", perp: "⊥", angle: "∠", triangle: "△", ell: "ℓ", hbar: "ħ",
  "%": "%", "#": "#", "&": "&", "_": "_", "{": "{", "}": "}", "|": "‖", ",": " ", ";": " ", ":": " ", " ": " ",
  "!": "", quad: " ", qquad: " ", enspace: " ", thinspace: " ", medspace: " ", thickspace: " ", "\\": "; ",
  lbrace: "{", rbrace: "}", lbrack: "[", rbrack: "]", backslash: "\\",
};

const FUNCTION_NAMES = new Set([
  "max", "min", "exp", "ln", "log", "lg", "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan",
  "sinh", "cosh", "tanh", "lim", "sup", "inf", "arg", "det", "dim", "gcd", "sgn", "mod", "argmin", "argmax",
]);

const FONT_COMMANDS = new Set(["mathrm", "text", "textrm", "mathbf", "mathit", "mathsf", "mathtt", "mathcal", "mathbb", "boldsymbol", "bm", "operatorname", "textit", "textbf", "mbox", "rm", "displaystyle", "textstyle"]);

const ACCENTS: Record<string, string> = { bar: "\u0304", overline: "\u0304", hat: "\u0302", widehat: "\u0302", tilde: "\u0303", widetilde: "\u0303", dot: "\u0307", ddot: "\u0308", vec: "\u20d7", check: "\u030c", breve: "\u0306", acute: "\u0301", grave: "\u0300", underline: "\u0332" };

const FRACTIONS = new Set(["frac", "dfrac", "tfrac", "cfrac"]);

const SUB_MAP: Record<string, string> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "−": "₋", "-": "₋", "=": "₌", "(": "₍", ")": "₎", a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ" };
const SUP_MAP: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "−": "⁻", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ", a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ", h: "ʰ", k: "ᵏ", l: "ˡ", m: "ᵐ", o: "ᵒ", p: "ᵖ", r: "ʳ", s: "ˢ", t: "ᵗ", u: "ᵘ", v: "ᵛ", w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ" };

const UNICODE_SUB_BACK: Record<string, string> = Object.fromEntries(Object.entries(SUB_MAP).filter(([key]) => key !== "-").map(([key, value]) => [value, key === "−" ? "-" : key]));
const UNICODE_SUP_BACK: Record<string, string> = Object.fromEntries(Object.entries(SUP_MAP).filter(([key]) => key !== "-").map(([key, value]) => [value, key === "−" ? "-" : key]));

export interface PlainOptions {
  /** Write sub/superscripts with Unicode characters when every character has one (θ₁, x²). Default true. */
  unicodeScripts?: boolean;
}

interface Cursor {
  s: string;
  i: number;
}

function skipSpace(cursor: Cursor): void {
  while (cursor.i < cursor.s.length && /\s/.test(cursor.s[cursor.i])) cursor.i += 1;
}

/** Read a balanced `{…}` group starting at cursor.i (which must be `{`); returns its inner text. */
function readBraced(cursor: Cursor): string {
  let depth = 0;
  const start = cursor.i + 1;
  for (let index = cursor.i; index < cursor.s.length; index += 1) {
    const ch = cursor.s[index];
    if (ch === "\\") {
      index += 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        cursor.i = index + 1;
        return cursor.s.slice(start, index);
      }
    }
  }
  cursor.i = cursor.s.length;
  return cursor.s.slice(start);
}

function readCommand(cursor: Cursor): string {
  const hit = /^\\([A-Za-z]+|.)/.exec(cursor.s.slice(cursor.i));
  if (!hit) {
    cursor.i += 1;
    return "";
  }
  cursor.i += hit[0].length;
  return hit[1];
}

/** One argument: a braced group, a command (with its own braced argument for font/accent commands), or one char. */
function readArg(cursor: Cursor): string {
  skipSpace(cursor);
  if (cursor.i >= cursor.s.length) return "";
  const ch = cursor.s[cursor.i];
  if (ch === "{") return readBraced(cursor);
  if (ch === "\\") {
    const start = cursor.i;
    const name = readCommand(cursor);
    if (FONT_COMMANDS.has(name) || name in ACCENTS) {
      skipSpace(cursor);
      if (cursor.s[cursor.i] === "{") readBraced(cursor);
    }
    return cursor.s.slice(start, cursor.i);
  }
  cursor.i += 1;
  return ch;
}

function readOptional(cursor: Cursor): string | null {
  skipSpace(cursor);
  if (cursor.s[cursor.i] !== "[") return null;
  const end = cursor.s.indexOf("]", cursor.i);
  if (end === -1) return null;
  const value = cursor.s.slice(cursor.i + 1, end);
  cursor.i = end + 1;
  return value;
}

const ATOM = /^[\p{L}\p{N}.′∂∇₀-₉ₐ-ₜᵢ-ᵥⱼ⁰-⁹ⁱⁿ_̀-ͯ⃗]+$/u;

function wrap(value: string): string {
  const v = value.trim();
  if (!v) return "";
  return ATOM.test(v) || /^\(.*\)$/.test(v) ? v : `(${v})`;
}

function script(value: string, map: Record<string, string>, mark: "_" | "^", unicode: boolean): string {
  const v = value.trim();
  if (!v) return "";
  if (unicode && [...v].every((ch) => ch in map)) return [...v].map((ch) => map[ch]).join("");
  if (/^[\p{L}\p{N}]$/u.test(v) || (mark === "_" && /^[\p{L}\p{N},]+$/u.test(v))) return `${mark}${v}`;
  return `${mark}(${v})`;
}

function plainWalk(source: string, options: Required<PlainOptions>): string {
  const cursor: Cursor = { s: source, i: 0 };
  let out = "";
  while (cursor.i < cursor.s.length) {
    const ch = cursor.s[cursor.i];
    if (ch === "\\") {
      const name = readCommand(cursor);
      if (FRACTIONS.has(name)) {
        const top = plainWalk(readArg(cursor), options);
        const bottom = plainWalk(readArg(cursor), options);
        out += `${wrap(top)}/${wrap(bottom)}`;
      } else if (name === "sqrt") {
        const degree = readOptional(cursor);
        const body = plainWalk(readArg(cursor), options);
        out += `${degree ? script(plainWalk(degree, options), SUP_MAP, "^", true) : ""}√${wrap(body)}`;
      } else if (FONT_COMMANDS.has(name)) {
        skipSpace(cursor);
        if (cursor.s[cursor.i] === "{") out += plainWalk(readBraced(cursor), options);
      } else if (name in ACCENTS) {
        const body = plainWalk(readArg(cursor), options);
        out += [...body].length === 1 ? `${body}${ACCENTS[name]}` : `${wrap(body)}${ACCENTS[name]}`;
      } else if (name === "begin" || name === "end") {
        skipSpace(cursor);
        const env = cursor.s[cursor.i] === "{" ? readBraced(cursor) : "";
        if (name === "begin" && env.startsWith("array")) {
          skipSpace(cursor);
          if (cursor.s[cursor.i] === "{") readBraced(cursor);
        }
        if (name === "begin" && /^(?:cases|dcases)$/.test(env)) out += "{ ";
        else if (name === "begin" && /matrix/.test(env)) out += env.startsWith("p") ? "(" : env.startsWith("b") ? "[" : "";
        else if (name === "end" && /matrix/.test(env)) out += env.startsWith("p") ? ")" : env.startsWith("b") ? "]" : "";
      } else if (/^(?:left|right|big|Big|bigg|Bigg|bigl|bigr|Bigl|Bigr|biggl|biggr|Biggl|Biggr|middle)$/.test(name)) {
        skipSpace(cursor);
        if (cursor.s[cursor.i] === "\\") {
          const delimiter = readCommand(cursor);
          out += delimiter === "{" ? "{" : delimiter === "}" ? "}" : delimiter === "|" ? "‖" : (SYMBOLS[delimiter] ?? "");
        } else if (cursor.s[cursor.i] === ".") {
          cursor.i += 1;
        } else if (cursor.i < cursor.s.length) {
          out += cursor.s[cursor.i];
          cursor.i += 1;
        }
      } else if (name === "tag" || name === "label" || name === "nonumber" || name === "notag") {
        skipSpace(cursor);
        if (cursor.s[cursor.i] === "{") readBraced(cursor);
      } else if (name === "limits" || name === "nolimits") {
        // no visible output
      } else if (name in GREEK) {
        out += GREEK[name];
      } else if (name in SYMBOLS) {
        out += SYMBOLS[name];
      } else if (FUNCTION_NAMES.has(name)) {
        out += name;
      } else if (/^[A-Za-z]+$/.test(name)) {
        out += name;
      } else {
        out += name;
      }
      continue;
    }
    if (ch === "_" || ch === "^") {
      cursor.i += 1;
      const body = plainWalk(readArg(cursor), options);
      out += ch === "_" ? script(body, SUB_MAP, "_", options.unicodeScripts) : script(body, SUP_MAP, "^", options.unicodeScripts);
      continue;
    }
    if (ch === "{") {
      out += plainWalk(readBraced(cursor), options);
      continue;
    }
    if (ch === "}") {
      cursor.i += 1;
      continue;
    }
    if (ch === "&" || ch === "~") {
      out += " ";
      cursor.i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      cursor.i += 1;
      continue;
    }
    out += ch === "-" ? "−" : ch === "*" ? "∗" : ch;
    cursor.i += 1;
  }
  return out;
}

/** LaTeX to readable Unicode text: `\frac{\partial\theta}{\partial t}` → `∂θ/∂t`, `\theta_{\mathrm{fc}}` → `θ_fc`. */
export function texToPlain(tex: string, options: PlainOptions = {}): string {
  const resolved: Required<PlainOptions> = { unicodeScripts: options.unicodeScripts ?? true };
  return plainWalk(tex, resolved).replace(/[ \t]{2,}/g, " ").replace(/\s*;\s*$/, "").trim();
}

/** A paragraph with every formula replaced by its readable form (character counts, previews, plain search). */
export function plainParagraph(text: string, options: PlainOptions = {}): string {
  return splitMath(text)
    .map((segment) => (segment.kind === "text" ? segment.value : texToPlain(segment.tex, options)))
    .join("");
}

// ---------------------------------------------------------------------------
// Symbols

/** `Kₛ` → `K_s`, `θ₁` → `θ_1`, `x²` → `x^2`, `θ_{fc}` → `θ_fc`, `θ_{\mathrm{min},i}` → `θ_min,i`. */
export function normalizeSymbol(raw: string): string {
  let value = raw.trim();
  if (/\\|\{/.test(value)) value = texToPlain(value, { unicodeScripts: false });
  let out = "";
  let subRun = "";
  let supRun = "";
  const flush = () => {
    if (subRun) out += `_${subRun}`;
    if (supRun) out += `^${supRun}`;
    subRun = "";
    supRun = "";
  };
  for (const ch of value) {
    if (ch in UNICODE_SUB_BACK) {
      if (supRun) flush();
      subRun += UNICODE_SUB_BACK[ch];
      continue;
    }
    if (ch in UNICODE_SUP_BACK) {
      supRun += UNICODE_SUP_BACK[ch];
      continue;
    }
    flush();
    out += ch;
  }
  flush();
  return out
    .replace(/\s+/g, "")
    .replace(/_\(([^()]*)\)/g, "_$1")
    .replace(/\^\(([^()]*)\)/g, "^$1")
    .replace(/_\{([^{}]*)\}/g, "_$1");
}

/** The symbol without its power: `x^2` → `x`. Powers are not part of a symbol's identity. */
function dropPower(key: string): string {
  return key.replace(/\^.*$/, "");
}

/**
 * Index-free family of a symbol, so `R_1`, `R_2`, `R_i` and `R_N` meet: `R_#`. Only the trailing index position
 * is generalised: `θ_min,i` → `θ_min,#`, `θ_fc` stays `θ_fc`, `u_2` → `u_#`.
 */
export function symbolFamily(key: string): string {
  return dropPower(key).replace(/([_,])(?:[ijklnN]|\d{1,2})$/u, "$1#");
}

const SKIP_FUNCTIONS = new Set([...FUNCTION_NAMES, "partial", "nabla", "sum", "prod", "int", "iint", "oint", "infty", "cdot", "times", "div", "pm", "mp", "le", "leq", "ge", "geq", "ne", "neq", "approx", "sim", "equiv", "propto", "in", "notin", "to", "rightarrow", "leftarrow", "Rightarrow", "ldots", "cdots", "dots", "quad", "qquad", "left", "right", "big", "Big", "bigg", "Bigg", "frac", "dfrac", "tfrac", "sqrt", "begin", "end", "tag", "limits", "degree", "circ", "prime", "forall", "exists"]);

const UNIT_WORDS = /^(?:m|mm|cm|km|s|ms|min|h|d|kg|g|mg|N|Pa|kPa|MPa|J|kJ|MJ|W|kW|V|A|Hz|K|L|mL|mol|rad|lx|dB)$/;

interface SymbolHit {
  key: string;
  family: string;
}

/**
 * Variable symbols used in a LaTeX formula, normalised (`θ_fc`, `K_sat`, `ET_0`, `Δt`, `θ̄`). Function names,
 * operators, differentials (`\partial`, `\mathrm{d}`), numbers, upright unit words and indices inside large
 * operator limits are not symbols.
 */
export function formulaSymbols(tex: string): string[] {
  const found = new Map<string, SymbolHit>();
  const cursor: Cursor = { s: tex, i: 0 };
  const add = (base: string, sub: string) => {
    const key = normalizeSymbol(sub ? `${base}_${sub.length > 1 ? `{${sub}}` : sub}` : base);
    if (!key || /^\d/.test(key)) return;
    if (!found.has(key)) found.set(key, { key, family: symbolFamily(key) });
  };
  const readScripts = (): { sub: string; skipped: boolean } => {
    let sub = "";
    let skipped = false;
    for (let round = 0; round < 2; round += 1) {
      skipSpace(cursor);
      const ch = cursor.s[cursor.i];
      if (ch === "_") {
        cursor.i += 1;
        const raw = readArg(cursor);
        sub = texToPlain(raw, { unicodeScripts: false }).replace(/\s+/g, "");
        if (cursor.s[cursor.i] === "_") skipped = true;
      } else if (ch === "^") {
        cursor.i += 1;
        const raw = readArg(cursor);
        // a power may itself hold symbols: x^{1/m}
        for (const inner of formulaSymbols(raw)) if (!found.has(inner)) found.set(inner, { key: inner, family: symbolFamily(inner) });
      } else if (ch === "'") {
        cursor.i += 1;
      } else {
        break;
      }
    }
    return { sub, skipped };
  };
  while (cursor.i < cursor.s.length) {
    const ch = cursor.s[cursor.i];
    if (ch === "\\") {
      const start = cursor.i;
      const name = readCommand(cursor);
      if (name === "sum" || name === "prod" || name === "int" || name === "lim" || name === "max" || name === "min" || name === "iint" || name === "oint") {
        // limits carry indices (i=1…N): only the upper limit's symbols count (N, T)
        for (let round = 0; round < 2; round += 1) {
          skipSpace(cursor);
          if (cursor.s.startsWith("\\limits", cursor.i)) cursor.i += 7;
          const mark = cursor.s[cursor.i];
          if (mark !== "_" && mark !== "^") break;
          cursor.i += 1;
          const raw = readArg(cursor);
          if (mark === "^") for (const inner of formulaSymbols(raw)) if (!found.has(inner)) found.set(inner, { key: inner, family: symbolFamily(inner) });
        }
        continue;
      }
      if (FRACTIONS.has(name)) continue;
      if (name in GREEK) {
        let base = GREEK[name];
        // Δt, Δz, δθ: a difference symbol written straight against its variable
        if ((name === "Delta" || name === "delta") && /^\s?[A-Za-z](?![A-Za-z])/.test(cursor.s.slice(cursor.i))) {
          skipSpace(cursor);
          base += cursor.s[cursor.i];
          cursor.i += 1;
        } else if ((name === "Delta" || name === "delta") && /^\s*\\(?:theta|psi|phi|tau)\b/.test(cursor.s.slice(cursor.i))) {
          skipSpace(cursor);
          base += GREEK[readCommand(cursor)];
        }
        const { sub } = readScripts();
        add(base, sub);
        continue;
      }
      if (name in ACCENTS) {
        const body = readArg(cursor);
        const inner = texToPlain(body, { unicodeScripts: false });
        const { sub } = readScripts();
        if (inner && /^[\p{L}]$/u.test(inner)) add(`${inner}${ACCENTS[name]}`, sub);
        else for (const symbol of formulaSymbols(body)) if (!found.has(symbol)) found.set(symbol, { key: symbol, family: symbolFamily(symbol) });
        continue;
      }
      if (FONT_COMMANDS.has(name)) {
        skipSpace(cursor);
        const body = cursor.s[cursor.i] === "{" ? readBraced(cursor) : "";
        const plain = texToPlain(body, { unicodeScripts: false }).replace(/\s+/g, "");
        skipSpace(cursor);
        if (cursor.s[cursor.i] === "_" && plain && /^[A-Za-z]+$/.test(plain)) {
          // \mathrm{ET}_{0}: an upright multi-letter symbol with a subscript
          const { sub } = readScripts();
          add(plain, sub);
        } else if (name === "operatorname" || UNIT_WORDS.test(plain) || plain === "d" || !plain) {
          // operator names, units and differentials are not variables
        } else if (!/^[A-Za-z]+$/.test(plain)) {
          for (const symbol of formulaSymbols(body)) if (!found.has(symbol)) found.set(symbol, { key: symbol, family: symbolFamily(symbol) });
        }
        continue;
      }
      if (name === "begin" || name === "end" || name === "tag" || name === "label") {
        skipSpace(cursor);
        if (cursor.s[cursor.i] === "{") readBraced(cursor);
        continue;
      }
      if (SKIP_FUNCTIONS.has(name) || name in SYMBOLS) continue;
      cursor.i = start + 1 + name.length;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      // ET_0, PET_{c}: two or more capitals written together and subscripted are one symbol
      const run = /^[A-Z][A-Za-z]*(?=\s*_)/.exec(cursor.s.slice(cursor.i));
      if (run && run[0].length >= 2 && run[0].length <= 4) {
        cursor.i += run[0].length;
        const { sub } = readScripts();
        add(run[0], sub);
        continue;
      }
      // NDVI, GDD, SWI: an unscripted run of capitals names one quantity; the audit resolves it against the symbol
      // table, and falls back to the single letters (P = UI) when the run itself has no definition
      const acronym = /^[A-Z]{2,6}(?![A-Za-z])(?!\s*_)/.exec(cursor.s.slice(cursor.i));
      if (acronym && !/[A-Za-z]$/.test(cursor.s.slice(0, cursor.i))) {
        cursor.i += acronym[0].length;
        readScripts();
        add(acronym[0], "");
        continue;
      }
      // a differential d directly before a variable (dθ, dt) is not a symbol
      if (ch === "d" && /^d\s*(?:\\[A-Za-z]|[A-Za-z])/.test(cursor.s.slice(cursor.i)) && /(?:^|[{(\s/=+\-])$/.test(cursor.s.slice(0, cursor.i))) {
        cursor.i += 1;
        continue;
      }
      cursor.i += 1;
      // e^{…} is Euler's number
      if (ch === "e" && /^\s*\^/.test(cursor.s.slice(cursor.i))) {
        readScripts();
        continue;
      }
      const { sub } = readScripts();
      add(ch, sub);
      continue;
    }
    if (ch === "{") {
      const inner = readBraced(cursor);
      for (const symbol of formulaSymbols(inner)) if (!found.has(symbol)) found.set(symbol, { key: symbol, family: symbolFamily(symbol) });
      continue;
    }
    if (ch === "_" || ch === "^") {
      // script on a closing bracket or a number: its own symbols still count, the base does not
      cursor.i += 1;
      const raw = readArg(cursor);
      if (ch === "^") for (const symbol of formulaSymbols(raw)) if (!found.has(symbol)) found.set(symbol, { key: symbol, family: symbolFamily(symbol) });
      continue;
    }
    cursor.i += 1;
  }
  return [...found.keys()];
}

/** True when a LaTeX string writes two subscripts on one base (`\theta_i_{min}`), which is invalid TeX. */
export function hasDoubleSubscript(tex: string): boolean {
  const cursor: Cursor = { s: tex, i: 0 };
  while (cursor.i < cursor.s.length) {
    const ch = cursor.s[cursor.i];
    if (ch === "\\") {
      readCommand(cursor);
      continue;
    }
    if (ch === "_") {
      cursor.i += 1;
      readArg(cursor);
      skipSpace(cursor);
      if (cursor.s[cursor.i] === "^") {
        cursor.i += 1;
        readArg(cursor);
        skipSpace(cursor);
      }
      if (cursor.s[cursor.i] === "_") return true;
      continue;
    }
    cursor.i += 1;
  }
  return false;
}

export interface TexSyntaxProblem {
  kind: "braces" | "left-right" | "environment" | "brackets" | "double-subscript";
  detail: string;
}

/** Structural problems that would make the formula fail to render or render wrongly. */
export function texSyntaxProblems(tex: string): TexSyntaxProblem[] {
  const problems: TexSyntaxProblem[] = [];
  let depth = 0;
  let negative = false;
  for (let index = 0; index < tex.length; index += 1) {
    const ch = tex[index];
    if (ch === "\\") {
      index += 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth < 0) negative = true;
    }
  }
  if (depth !== 0 || negative) problems.push({ kind: "braces", detail: "花括号 { } 不配对" });
  const lefts = (tex.match(/\\left(?![A-Za-z])/g) ?? []).length;
  const rights = (tex.match(/\\right(?![A-Za-z])/g) ?? []).length;
  if (lefts !== rights) problems.push({ kind: "left-right", detail: `\\left 有 ${lefts} 个，\\right 有 ${rights} 个` });
  const begins = [...tex.matchAll(/\\begin\s*\{([^}]*)\}/g)].map((hit) => hit[1]);
  const ends = [...tex.matchAll(/\\end\s*\{([^}]*)\}/g)].map((hit) => hit[1]);
  if (begins.length !== ends.length || begins.some((env) => !ends.includes(env))) problems.push({ kind: "environment", detail: "\\begin{…} 与 \\end{…} 不配对" });
  const stripped = tex.replace(/\\[A-Za-z]+/g, " ").replace(/\\./g, " ");
  const opens = (stripped.match(/[([]/g) ?? []).length;
  const closes = (stripped.match(/[)\]]/g) ?? []).length;
  if (opens !== closes) problems.push({ kind: "brackets", detail: `左括号 ${opens} 个、右括号 ${closes} 个` });
  if (hasDoubleSubscript(tex)) problems.push({ kind: "double-subscript", detail: "同一符号写了两层下标（如 \\theta_i_{min}），应合并为 \\theta_{\\mathrm{min},i}" });
  return problems;
}

/** The left side of a formula's first `=` (not part of ≤ ≥ ≠ ≈), or null when it has none. */
export function splitEquation(plain: string): { lhs: string; rhs: string } | null {
  for (let index = 0; index < plain.length; index += 1) {
    if (plain[index] !== "=") continue;
    const before = plain[index - 1] ?? "";
    const after = plain[index + 1] ?? "";
    if ("<>!≤≥≠≈:".includes(before) || after === "=") continue;
    return { lhs: plain.slice(0, index), rhs: plain.slice(index + 1) };
  }
  return null;
}

/** A canonical string for comparing two formulas: readable form without spaces, punctuation-trimmed. */
export function canonicalFormula(tex: string): string {
  return texToPlain(tex, { unicodeScripts: false })
    .replace(/\s+/g, "")
    .replace(/[，,。．.；;]+$/u, "")
    .replace(/[·⋅]/g, "·")
    .replace(/[×]/g, "×");
}
