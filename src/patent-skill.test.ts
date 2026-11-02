import assert from "node:assert/strict";
import { groundFacts, parseSkillReply } from "./patent-skill.ts";

const parsed = parseSkillReply(`先确认边界细化是不是核心特征。

\`\`\`json
{"title":"边界细化分割","patentPoints":["边界细化模块"],"searchQueries":["遥感 建筑物 边界细化"],"facts":[
  {"statement":"输入为高分辨率遥感影像","kind":"input","origin":"source"},
  {"statement":"实验准确率达到99%","kind":"effect","origin":"source"}
]}
\`\`\``);

assert.equal(parsed.title, "边界细化分割");
assert.equal(parsed.searchQueries[0], "遥感 建筑物 边界细化");
assert.equal(parsed.facts.length, 2);
assert.ok(!parsed.reply.includes("99%"));

const grounded = groundFacts(parsed.facts, "本发明的输入为高分辨率遥感影像。处理过程包括边界细化。");
assert.equal(grounded[0]?.origin, "source");
assert.equal(grounded[1]?.origin, "inference");

const rich = parseSkillReply(`可以从成膜添加剂切入。

\`\`\`json
{"title":"电解液成膜添加剂","patentPoints":[{"title":"成膜添加剂","problem":"循环过程界面持续生长","feature":"在电解液中加入成膜添加剂","effect":"抑制界面生长","pending":"添加剂浓度未给出"}],"searchQueries":["电解液 成膜添加剂"],"facts":[{"statement":"在电解液中加入成膜添加剂","kind":"process","origin":"source"}],"questions":["添加剂的具体化学结构是什么？"]}
\`\`\``);
assert.equal(rich.patentPoints[0]?.title, "成膜添加剂");
assert.equal(rich.patentPoints[0]?.pending, "添加剂浓度未给出");
assert.equal(rich.questions[0], "添加剂的具体化学结构是什么？");
assert.ok(!rich.reply.includes("```"));

console.log("patent skill checks passed");
