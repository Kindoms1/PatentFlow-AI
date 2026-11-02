import { test } from "node:test";
import assert from "node:assert/strict";
import { auditFormulas, draftFormulaSources } from "./formula-audit.ts";
import { formulaSymbols } from "./formula.ts";

const NDVI_FORMULA = String.raw`$$NDVI=\frac{\rho_{NIR}-\rho_{Red}}{\rho_{NIR}+\rho_{Red}}$$`;
const RHO_DEFS = String.raw`式中，$\rho_{NIR}$为近红外波段反射率，$\rho_{Red}$为红光波段反射率`;
const LOSS = [
  "总损失按下式计算：",
  String.raw`$$L=\lambda_1 L_{MAE}+\lambda_2 L_{MSE}$$`,
  String.raw`式中，$L$为总损失，$L_{MAE}$为平均绝对误差损失，$L_{MSE}$为均方误差损失，$\lambda_1$和$\lambda_2$分别为MAE和MSE的权重系数。`,
];

function undefinedDetail(lines: string[]): string {
  const report = auditFormulas(draftFormulaSources(["## 具体实施方式", ...lines].join("\n")));
  return report.issues.filter((item) => item.id === "formula-undefined").map((item) => item.detail).join("\n");
}

test("formulaSymbols keeps an unscripted run of capitals as one symbol", () => {
  const symbols = formulaSymbols(String.raw`NDVI=\frac{\rho_{NIR}-\rho_{Red}}{\rho_{NIR}+\rho_{Red}}`);
  assert.ok(symbols.includes("NDVI"), symbols.join(","));
  for (const letter of ["N", "D", "V", "I"]) assert.ok(!symbols.includes(letter), symbols.join(","));
  const product = formulaSymbols("x=ab");
  assert.ok(product.includes("a") && product.includes("b"), product.join(","));
});

test("NDVI为…… defines the acronym and λ₁和λ₂分别为…… defines both weights", () => {
  assert.equal(undefinedDetail(["归一化植被指数按下式计算：", NDVI_FORMULA, `${RHO_DEFS}，NDVI为归一化植被指数。`, ...LOSS]), "");
});

test("the 分别为 sentence is what defines λ", () => {
  const without = LOSS.map((line) => line.replace(String.raw`，$\lambda_1$和$\lambda_2$分别为MAE和MSE的权重系数`, ""));
  assert.match(undefinedDetail(without), /λ/);
});

test("an undefined acronym is reported whole, not letter by letter", () => {
  const detail = undefinedDetail(["植被指数按下式计算：", NDVI_FORMULA, `${RHO_DEFS}。`]);
  assert.match(detail, /NDVI/);
  assert.doesNotMatch(detail, /(?:^|[\s、])[NDVI](?:[\s、]|$)/);
});

test("a symbol-table row or ……（NDVI） defines the acronym", () => {
  const table = ["| 符号 | 含义 | 单位 |", "| --- | --- | --- |", "| $NDVI$ | 归一化植被指数 | 无量纲 |", ""];
  assert.equal(undefinedDetail([...table, NDVI_FORMULA, `${RHO_DEFS}。`]), "");
  assert.equal(undefinedDetail(["归一化植被指数（NDVI）按下式计算：", NDVI_FORMULA, `${RHO_DEFS}。`]), "");
});

test("a product of defined letters is still accepted", () => {
  assert.equal(undefinedDetail(["功率按下式计算：", "$$P=UI$$", "式中，$P$为功率，$U$为电压，$I$为电流。"]), "");
});