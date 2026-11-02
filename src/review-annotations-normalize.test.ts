import assert from "node:assert/strict";
import test from "node:test";
import { formalizeSimulationAnnotations } from "./review-annotations.ts";

test("original annotation offsets and mixed parameter text survive rewriting", () => {
  const raw = "说明。下限（取设计流量的60%～70%，本例取65%，即1.43 m³/h，模拟值，待实验验证）用于比较。";
  const out = formalizeSimulationAnnotations(raw);
  assert.equal(out.annotations.length, 1);
  for (const item of out.annotations) assert.equal(raw.slice(item.index, item.index + item.raw.length), item.raw);
  assert.equal(out.annotations[0].raw, "（取设计流量的60%～70%，本例取65%，即1.43 m³/h，模拟值，待实验验证）");
  assert.ok(out.text.includes("取设计流量的60%～70%，本例取65%，即1.43 m³/h"));
  assert.ok(out.text.includes("示例性设定，非实测数据，尚需实验核验"));
});

test("normalization does not edit fenced audit data or multiline display formulas", () => {
  const raw = ["~~~json", '{"pending":"模拟值，待实验验证"}', "~~~", "$$", "x_{模拟值}", "$$", "数值为模拟值。"].join("\n");
  const out = formalizeSimulationAnnotations(raw);
  assert.ok(out.text.startsWith(raw.slice(0, raw.lastIndexOf("数值"))));
  assert.ok(out.text.endsWith("数值为示例性设定（非实测数据）。"));
  assert.deepEqual(out.annotations, [{ index: raw.lastIndexOf("数值"), raw: "数值为模拟值。" }]);
});

test("normalization retains the exact numeric sequence and formula definitions", () => {
  const raw = "按 $e_3=3.0-3.32=-0.32$ m³（模拟值，待实验验证）计算；系数（$k_3(n+1)$ 的取值为1.15，模拟值）用于下轮。";
  const out = formalizeSimulationAnnotations(raw);
  assert.deepEqual(out.text.match(/-?\d+(?:\.\d+)?/g), raw.match(/-?\d+(?:\.\d+)?/g));
  assert.ok(out.text.includes("$e_3=3.0-3.32=-0.32$"));
  assert.ok(out.text.includes("$k_3(n+1)$ 的取值为1.15"));
  assert.equal(out.annotations.length, 2);
  assert.deepEqual(formalizeSimulationAnnotations(out.text), { text: out.text, annotations: [] });
});
