import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeLatexBackslashes } from "./json-latex.ts";
import { parseReviseReply } from "./draft-revise.ts";
import { parseMathReview } from "./math-review.ts";

const parse = (raw: string) => JSON.parse(escapeLatexBackslashes(raw)) as { s: string };

test("LaTeX 非法转义不再让 JSON 解析失败", () => {
  assert.equal(parse(String.raw`{"s":"$T_{\mathrm{b}}$，$\sigma$，$\alpha$，$\{x\}$"}`).s, String.raw`$T_{\mathrm{b}}$，$\sigma$，$\alpha$，$\{x\}$`);
});

test("\\theta、\\frac 等不再被悄悄解析成控制字符", () => {
  const s = parse(String.raw`{"s":"$\theta_v=\frac{a}{b}$ $\rho$ $\beta$ $\nabla h$ $\times$ $\text{x}$"}`).s;
  assert.equal(s, String.raw`$\theta_v=\frac{a}{b}$ $\rho$ $\beta$ $\nabla h$ $\times$ $\text{x}$`);
  assert.doesNotMatch(s, /[\t\f\r\b\n]/);
});

test("合法 JSON 转义原样保留", () => {
  assert.equal(parse(String.raw`{"s":"第一段\n第二段\nS1：\t\u4e2d\"引号\"\\theta\/"}`).s, '第一段\n第二段\nS1：\t中"引号"\\theta/');
});

test("字符串之外的内容不动", () => {
  const raw = '{\n  "a": 1,\n  "b": [true, null]\n}';
  assert.equal(escapeLatexBackslashes(raw), raw);
});

test("修订补丁里的 LaTeX 解析后与模型原意一致", () => {
  const reply = "```json\n" + String.raw`{"summary":"补充","patches":[{"find":"原句。","replace":"原句。其中 $\theta$ 为含水率，$\mathrm{d}$ 为距离。\n另起一段。","reason":"补充"}]}` + "\n```";
  const parsed = parseReviseReply(reply);
  assert.equal(parsed.patches.length, 1);
  assert.equal(parsed.patches[0].replace, "原句。其中 $\\theta$ 为含水率，$\\mathrm{d}$ 为距离。\n另起一段。");
});

test("公式审阅补丁里的 LaTeX 同样保留", () => {
  const reply = String.raw`{"patches":[{"find":"$x$","replace":"$\frac{\Delta \theta}{\Delta t}$"}],"notes":[]}`;
  const parsed = parseMathReview(reply);
  assert.equal(parsed.patches.length, 1);
  assert.equal(parsed.patches[0].replace, String.raw`$\frac{\Delta \theta}{\Delta t}$`);
});