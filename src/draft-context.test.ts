import test from "node:test";
import assert from "node:assert/strict";
import { draftContext } from "./skill-turn.ts";

test("draftContext keeps confirmed and inventor facts and the first pursued idea", () => {
  const context = draftContext({
    facts: [
      { statement: "边界细化模块逐像素修正掩膜", status: "confirmed", origin: "source" },
      { statement: "推断：精度提升明显", status: "pending", origin: "inference" },
      { statement: "阈值取0.5", status: "pending", origin: "inventor" },
      { statement: "被否定的说法", status: "rejected", origin: "inventor" },
      { statement: "边界细化模块逐像素修正掩膜", status: "confirmed", origin: "source" },
    ],
    ideas: [
      { title: "多尺度融合", problem: "", feature: "", effect: "", status: "dismissed" },
      { title: "边界细化", problem: "边界粘连", feature: "逐像素修正", effect: "轮廓清晰", status: "pursued" },
    ],
  });
  assert.deepEqual(context.facts, ["边界细化模块逐像素修正掩膜", "阈值取0.5"]);
  assert.equal(context.chosenPoint?.title, "边界细化");
  assert.equal(context.chosenPoint?.feature, "逐像素修正");
});

test("draftContext tolerates a missing case", () => {
  assert.deepEqual(draftContext(undefined), { facts: [], chosenPoint: undefined });
});
