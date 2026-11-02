/**
 * 分节扩写的回显防护：模型把整篇申请文件原样回显，或大段照搬原稿句子时，扩写结果不能插进正文。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_REPEATED_RATIO, echoesDocument, repeatedRatio } from "./draft-expand.ts";

const DOC = [
  "# 发明名称：一种雨水井截污装置",
  "",
  "## 说明书摘要",
  "本发明公开了一种雨水井截污装置，利用下泄水流驱动刮板清理截污格栅。",
  "",
  "## 权利要求书",
  "1. 一种雨水井截污装置，其特征在于，包括截污格栅(1)、叶轮(2)和刮板(3)。",
  "2. 根据权利要求1所述的雨水井截污装置，其特征在于，所述刮板(3)通过曲柄连杆与所述叶轮(2)连接。",
  "",
  "## 具体实施方式",
  "截污格栅(1)倾斜设置在井口下方，叶轮(2)位于下泄水流路径上。叶轮(2)通过曲柄连杆带动刮板(3)沿截污格栅(1)表面往复刮扫。刮下的杂物被推入集污斗(4)中暂存。",
].join("\n");

test("a reply that echoes the whole application is recognised as an echo", () => {
  assert.equal(echoesDocument(DOC), true);
  assert.equal(echoesDocument("1. 一种装置，包括部件A。\n2. 根据权利要求1所述的装置，还包括部件B。"), true);
  assert.equal(echoesDocument("```\n## 权利要求书\n```\n### 实施例2\n本实施例的叶轮采用六叶片结构。"), false);
});

test("a genuine section reply is neither an echo nor over the repeat limit", () => {
  const section = [
    "### 实施例2",
    "本实施例与实施例1的区别在于，叶轮(2)采用六叶片结构，叶片倾角取30°，在汛期大流量工况下刮板(3)的往复频率提高约一倍。",
    "",
    "### 实施例3",
    "本实施例将集污斗(4)替换为可拆卸滤袋，滤袋孔径取5 mm，便于养护人员在不进入井内的情况下完成清掏。",
  ].join("\n");
  assert.equal(echoesDocument(section), false);
  assert.ok(repeatedRatio(section, DOC) <= MAX_REPEATED_RATIO);
});

test("a reply that mostly repeats sentences already in the draft is over the repeat limit", () => {
  const reply =
    "截污格栅(1)倾斜设置在井口下方，叶轮(2)位于下泄水流路径上。叶轮(2)通过曲柄连杆带动刮板(3)沿截污格栅(1)表面往复刮扫。新增一句说明控制箱的安装方式与供电线路的布置。";
  assert.ok(repeatedRatio(reply, DOC) > MAX_REPEATED_RATIO);
  assert.equal(repeatedRatio("短句。", DOC), 0);
});
