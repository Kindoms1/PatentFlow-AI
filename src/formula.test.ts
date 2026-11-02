import test from "node:test";
import assert from "node:assert/strict";
import { canonicalFormula, formulaSymbols, joinDisplayBlocks, normalizeSymbol, parseDisplayLine, splitMath, symbolFamily, texSyntaxProblems, texToPlain } from "./formula.ts";
import { auditFormulas, draftFormulaSources, formulaIssueLines } from "./formula-audit.ts";
import { applyPatches, parseMathReview, shouldReviewMath } from "./math-review.ts";

const R = String.raw;
const RICHARDS = R`\frac{\partial \theta}{\partial t} = \frac{\partial}{\partial z}\left[K(\theta)\left(\frac{\partial \psi}{\partial z} - 1\right)\right] - S(z,t)`;
const VREQ = R`V_{\mathrm{req}} = \frac{A}{\eta}\sum_{i=1}^{N}\max\left(0, \theta_{\mathrm{min},i} - \theta_{\mathrm{pred},i}\right) d_{i}`;

test("splitMath separates inline and display math and keeps escaped dollars", () => {
  const parts = splitMath(R`其中$K_{s}$为饱和导水率，价格 \$5，$$x=1$$ 结束 $未闭合`);
  assert.deepEqual(
    parts.map((part) => (part.kind === "math" ? `${part.display ? "D" : "I"}:${part.tex}` : `T:${part.value}`)),
    ["T:其中", "I:K_{s}", "T:为饱和导水率，价格 $5，", "D:x=1", "T: 结束 $未闭合"],
  );
});

test("parseDisplayLine reads numbers before, after or as a tag", () => {
  assert.deepEqual(parseDisplayLine("$$ x = \\frac{a}{b} $$（1）"), { tex: "x = \\frac{a}{b}", label: "1" });
  assert.deepEqual(parseDisplayLine("（2）$$y=1$$"), { tex: "y=1", label: "2" });
  assert.deepEqual(parseDisplayLine("$$ z=2 \\tag{3} $$。"), { tex: "z=2", label: "3" });
  assert.deepEqual(parseDisplayLine("$$ w=1 $$"), { tex: "w=1", label: null });
  assert.equal(parseDisplayLine("文字 $x$"), null);
  assert.equal(parseDisplayLine("$$a$$ 其中a为长度"), null);
});

test("joinDisplayBlocks folds multi-line display formulas but not fenced code", () => {
  assert.equal(joinDisplayBlocks("前\n$$\n\\frac{a}{b}\n= c\n$$（4）\n后"), "前\n$$ \\frac{a}{b} = c $$（4）\n后");
  assert.equal(joinDisplayBlocks("```\n$$\n```"), "```\n$$\n```");
});

test("texToPlain gives a readable form", () => {
  assert.equal(texToPlain(RICHARDS), "∂θ/∂t=∂/∂z[K(θ)(∂ψ/∂z−1)]−S(z,t)");
  assert.equal(texToPlain(R`\theta_{\mathrm{fc}}`, { unicodeScripts: false }), "θ_fc");
  assert.equal(texToPlain(R`K_{s} x^{2}`), "Kₛx²");
});

test("formulaSymbols lists variables, not operators, units or indices", () => {
  assert.deepEqual(formulaSymbols(RICHARDS), ["θ", "t", "z", "K", "ψ", "S"]);
  assert.deepEqual(formulaSymbols(VREQ), ["V_req", "A", "η", "N", "θ_min,i", "θ_pred,i", "d_i"]);
  assert.deepEqual(formulaSymbols(R`ET_{0} = \Delta t \cdot 600\ \mathrm{s}`), ["ET_0", "Δt"]);
});

test("normalizeSymbol and symbolFamily merge subscript spellings and indices", () => {
  assert.equal(normalizeSymbol("Kₛ"), "K_s");
  assert.equal(normalizeSymbol("K_s"), "K_s");
  assert.equal(normalizeSymbol(R`θ_{\mathrm{min},i}`), "θ_min,i");
  assert.equal(symbolFamily("R_1"), symbolFamily("R_i"));
  assert.equal(symbolFamily("θ_fc"), "θ_fc");
});

test("texSyntaxProblems catches broken formulas", () => {
  assert.ok(texSyntaxProblems(R`\frac{a}{b`).some((item) => item.kind === "braces"));
  assert.ok(texSyntaxProblems(R`\left( x`).some((item) => item.kind === "left-right"));
  assert.ok(texSyntaxProblems(R`\theta_i_{min}`).some((item) => item.kind === "double-subscript"));
  assert.deepEqual(texSyntaxProblems(R`x \in [300, 1800)`), []);
  assert.equal(canonicalFormula(R`a = b ,`), "a=b");
});

const OLD_DRAFT = [
  "# 发明名称：一种智能灌溉控制方法",
  "## 说明书摘要",
  "本发明公开了一种智能灌溉控制方法。",
  "## 权利要求书",
  "1. 一种智能灌溉控制方法，其特征在于，包括：S1、获取数据；S2、计算。",
  "2. 根据权利要求1所述的方法，其特征在于，土壤水分运动采用Richards方程：∂θ/∂t = ∂/∂z[K(θ)·(∂ψ/∂z + 1)]，其中θ为体积含水量。",
  "3. 根据权利要求1所述的方法，其特征在于，θ_i_min = θ_wp + f_i·(θ_fc - θ_wp)·R_i，R_i的取值范围为0.6～0.8。",
  "4. 根据权利要求1所述的方法，其特征在于，V_req = Σ[Δθ_i · δz_i · A] / η。",
  "## 技术领域",
  "本发明涉及农业灌溉。",
  "## 具体实施方式",
  "实际蒸散发ET_actual = Kₛ·ET₀，其中Kₛ为水分胁迫系数。",
  "K_s为饱和导水率，K_s = 2×10⁻⁴ m/s。",
  "根密度比例R₁ = 0.20、R₂ = 0.35、R₃ = 0.30、R₄ = 0.15。",
].join("\n");

test("auditFormulas finds the problems of a plain-text draft", () => {
  const report = auditFormulas(draftFormulaSources(OLD_DRAFT));
  const ids = new Set(report.issues.map((item) => `${item.id}:${item.level}`));
  assert.ok(ids.has("formula-range:error"), "R_i range contradicts R₁…R₄");
  assert.ok(ids.has("formula-symbol-conflict:error"), "Kₛ and K_s mean two things");
  assert.ok(ids.has("formula-plain:warn"));
  assert.ok(ids.has("formula-subscript:warn"));
  assert.ok(ids.has("formula-sum:warn"));
  assert.ok(formulaIssueLines(report).every((line) => line.startsWith("【")));
  assert.equal(shouldReviewMath(OLD_DRAFT), true);
});

test("auditFormulas passes a consistent LaTeX draft and flags cross-section drift", () => {
  const draft = [
    "# 发明名称：一种方法",
    "## 权利要求书",
    "1. 一种方法，其特征在于，按下式计算：",
    `$$ ${RICHARDS} $$`,
    "其中，$\\theta$为土壤体积含水量。",
    "## 具体实施方式",
    `$$ ${RICHARDS} $$（1）`,
    "式中，$\\theta$为土壤体积含水量（m³/m³），$t$为时间（s），$z$为垂向坐标（m），$K(\\theta)$为非饱和导水率（m/s），$\\psi$为基质势（m），$S(z,t)$为根系吸水速率（s⁻¹）。由式（1）计算。",
  ].join("\n");
  const clean = auditFormulas(draftFormulaSources(draft));
  assert.deepEqual(clean.issues, []);
  const drifted = auditFormulas(draftFormulaSources(draft.replace(`$$ ${RICHARDS} $$\n其中`, `$$ ${RICHARDS.replace("- 1", "+ 1")} $$\n其中`)));
  assert.ok(drifted.issues.some((item) => item.id === "formula-cross" && item.level === "error"));
  const dangling = auditFormulas(draftFormulaSources(draft.replace("由式（1）计算", "由式（3）计算")));
  assert.ok(dangling.issues.some((item) => item.id === "formula-numbering" && item.level === "error"));
  assert.equal(auditFormulas(draftFormulaSources("# x\n## 具体实施方式\n没有公式的正文。")).applicable, false);
});

test("math review patches apply only when unambiguous", () => {
  const draft = "# x\n## 权利要求书\n1. 一种方法，(∂ψ/∂z + 1)。\n## 具体实施方式\nK_s为饱和导水率。K_s为饱和导水率。\n```json\n{}\n```";
  const reply = parseMathReview('```json\n{"patches":[{"find":"(∂ψ/∂z + 1)","replace":"(∂ψ/∂z − 1)","reason":"z 向下为正"},{"find":"K_s为饱和导水率","replace":"K_sat为饱和导水率","reason":"符号冲突"},{"find":"## 具体实施方式","replace":"","reason":""}],"notes":["需确认"]}\n```');
  assert.equal(reply.patches.length, 3);
  assert.deepEqual(reply.notes, ["需确认"]);
  const result = applyPatches(draft, reply.patches);
  assert.match(result.text, /∂ψ\/∂z − 1/);
  assert.equal(result.applied.length, 1);
  assert.equal(result.skipped.length, 2);
  assert.ok(result.text.endsWith("```json\n{}\n```"));
  const all = applyPatches(draft, [{ find: "K_s为饱和导水率", replace: "K_sat为饱和导水率", reason: "", all: true }]);
  assert.equal(all.applied[0].count, 2);
  assert.deepEqual(parseMathReview("不是 json"), { patches: [], notes: [] });
});
