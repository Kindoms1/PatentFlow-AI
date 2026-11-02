import assert from "node:assert/strict";
import { DEMO_MATERIAL, buildClaims, extractFacts, judge, reduce, renderDisclosure, seed } from "./model.ts";

const facts = extractFacts(DEMO_MATERIAL, "示范材料.md");
assert.ok(facts.some((fact) => fact.kind === "problem" && fact.origin === "source"));
assert.ok(facts.some((fact) => fact.kind === "process" && fact.statement.includes("边界细化")));
assert.ok(facts.some((fact) => fact.kind === "parameter"));
assert.ok(facts.some((fact) => fact.kind === "output"));
assert.ok(facts.some((fact) => fact.kind === "effect" && fact.origin === "source"));
assert.ok(facts.some((fact) => fact.origin === "inference"));

const corpus = "本发明公开一种高分辨率遥感影像语义分割方法。该方法使用编码器提取特征。全文没有记载边界细化模块。";
assert.equal(judge("本发明的输入为高分辨率遥感影像", corpus), "明确包含");
assert.equal(judge("在解码阶段引入边界细化模块，利用边界损失约束分割轮廓", corpus), "部分对应");
assert.equal(judge("可选地，边界损失的权重取 0.3", corpus), "未找到");

const confirmed = facts.map((fact) => (fact.origin === "inference" ? fact : { ...fact, status: "confirmed" as const }));
const broad = buildClaims(confirmed, "broad");
const narrow = buildClaims(confirmed, "narrow");
assert.match(broad[0].text, /0\.3/);
assert.doesNotMatch(narrow[0].text, /0\.3/);
assert.match(narrow.map((claim) => claim.text).join("\n"), /0\.3/);

const state = seed();
const generated = reduce(reduce(state, { type: "confirm-source", caseId: state.cases[0].id }), { type: "generate", caseId: state.cases[0].id });
const drafted = generated.cases[0];
assert.ok(drafted.disclosure.includes("边界细化"));
assert.ok(!drafted.disclosure.includes("不能写入正文"));
assert.equal(renderDisclosure({ ...drafted, facts: drafted.facts.map((fact) => ({ ...fact, status: "rejected" as const })) }).includes("边界细化模块，利用边界损失"), false);

const opened = reduce(seed(), {
  type: "create-case",
  id: "case-pdf",
  title: "",
  text: "帮我挖点，这句话不应当当成技术材料。",
  fileName: "paper.pdf",
  skill: true,
  materials: [{ name: "paper.pdf", kind: "pdf", text: "本发明公开一种电解液添加剂，用于抑制界面生长。" }],
});
const created = opened.cases.find((item) => item.id === "case-pdf");
assert.ok(created);
assert.equal(created.messages.length, 0);
assert.match(created.materialText, /电解液添加剂/);
assert.doesNotMatch(created.materialText, /不应当当成技术材料/);
assert.equal(created.materials[0]?.name, "paper.pdf");

const attached = reduce(opened, {
  type: "attach-materials",
  caseId: "case-pdf",
  materials: [{ name: "note.md", kind: "text", text: "实验室还没有做循环测试。" }],
});
const withNote = attached.cases.find((item) => item.id === "case-pdf");
assert.equal(withNote?.materials.length, 2);
assert.match(withNote?.materialText || "", /循环测试/);

const withIdeas = reduce(attached, {
  type: "merge-ideas",
  caseId: "case-pdf",
  ideas: [{ title: "成膜添加剂", problem: "界面生长", feature: "加入添加剂", effect: "抑制生长", pending: "浓度未知" }],
});
const ideaCase = reduce(withIdeas, { type: "idea-status", caseId: "case-pdf", ideaId: withIdeas.cases.find((item) => item.id === "case-pdf")?.ideas[0]?.id || "", status: "pursued" });
assert.equal(ideaCase.cases.find((item) => item.id === "case-pdf")?.ideas[0]?.status, "pursued");

const library = reduce(seed(), {
  type: "add-knowledge",
  name: "paper.pdf",
  kind: "pdf",
  text: "本发明公开一种电解液添加剂。",
});
assert.equal(library.knowledge.length, 1);
assert.equal(library.knowledge[0]?.name, "paper.pdf");
const queued = reduce(library, { type: "queue-knowledge", ids: [library.knowledge[0]?.id || ""] });
assert.equal(queued.knowledgeQueue[0]?.name, "paper.pdf");
assert.match(queued.knowledgeQueue[0]?.text || "", /电解液添加剂/);
const cleared = reduce(queued, { type: "clear-knowledge-queue" });
assert.equal(cleared.knowledgeQueue.length, 0);
assert.equal(cleared.knowledge.length, 1);

// restore-case: undo of a delete must bring the selection back with the case
const undoBase = seed();
const victim = undoBase.cases[0];
assert.ok(victim);
const removed = reduce({ ...undoBase, activeCaseId: victim.id }, { type: "delete-case", id: victim.id });
assert.ok(!removed.cases.some((patentCase) => patentCase.id === victim.id));
assert.notEqual(removed.activeCaseId, victim.id);
const undone = reduce(removed, { type: "restore-case", patentCase: victim, index: 0, activate: true });
assert.equal(undone.cases[0]?.id, victim.id);
assert.equal(undone.activeCaseId, victim.id);
const other = { ...victim, id: victim.id + "-other", title: "另一个案件" };
const withOther = { ...removed, cases: [other, ...removed.cases], activeCaseId: other.id };
const quiet = reduce(withOther, { type: "restore-case", patentCase: victim, index: 1, activate: false });
assert.equal(quiet.activeCaseId, other.id);
assert.equal(quiet.cases[1]?.id, victim.id);
const fromEmpty = reduce({ ...removed, activeCaseId: null }, { type: "restore-case", patentCase: victim });
assert.equal(fromEmpty.activeCaseId, victim.id);
assert.equal(reduce(undone, { type: "restore-case", patentCase: victim }), undone);

console.log("model checks passed");
