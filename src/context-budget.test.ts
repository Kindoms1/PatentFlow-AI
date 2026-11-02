import test from "node:test";
import assert from "node:assert/strict";
import { chunkText, compactDialog, environmentBlock, estimateTokens, queryTerms, sectionRefs, selectMaterial } from "./context-budget.ts";

test("estimateTokens counts CJK about one per character", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("截污格栅"), 4);
  assert.ok(estimateTokens("boundary refinement module") < 10);
});

test("compactDialog keeps recent turns, opens with a user turn and summarises the rest", () => {
  const messages = Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", text: `第${index}条：${"内容".repeat(200)}` }));
  messages.push({ role: "trace", text: "过程" });
  const result = compactDialog(messages, { budget: 2000, keep: 10 });
  assert.ok(result.recent.length >= 2 && result.recent.length <= 10);
  assert.equal(result.recent[0].role, "user");
  assert.equal(result.dropped + result.recent.length, 30);
  assert.match(result.summary, /^发明人：第0条/);
  assert.doesNotMatch(result.summary, /过程/);
});

test("selectMaterial returns null when everything fits, otherwise picks relevant chunks", () => {
  const small = [{ name: "a.md", kind: "text", text: "短材料" }];
  assert.equal(selectMaterial(small, "刮板", 12000), null);
  const filler = Array.from({ length: 40 }, (_, index) => `第${index}段，与主题无关的背景描述。`.repeat(20)).join("\n\n");
  const target = "刮板由下泄水流驱动的叶轮经曲柄连杆带动，沿格栅表面往复摆动。";
  const text = `开头概述。\n\n${filler}\n\n${target}\n\n${filler}`;
  const picked = selectMaterial([{ name: "交底.docx", kind: "text", text }], "刮板 叶轮 曲柄连杆", 4000);
  assert.ok(picked);
  assert.ok(picked.includes(target));
  assert.ok(picked.includes("开头概述"));
  assert.ok(picked.length <= 4200);
  assert.match(picked, /按与本轮问题的相关度节选/);
});

test("queryTerms and chunkText", () => {
  assert.ok(queryTerms("请根据附件写刮板驱动").includes("刮板"));
  assert.ok(!queryTerms("一种方法").includes("一种"));
  assert.deepEqual(chunkText("a\n\nb", 10), ["a\n\nb"]);
  assert.equal(chunkText("x".repeat(2000), 900).length, 3);
});

test("environmentBlock states the date, task, tools and materials", () => {
  const block = environmentBlock({ intent: "draft", materials: [{ name: "交底.docx", kind: "text", text: "12345" }], turns: 3, tools: false, now: new Date("2026-10-23T04:00:00Z") });
  assert.match(block, /2026年10月23日/);
  assert.match(block, /撰写完整的发明专利申请文件/);
  assert.match(block, /本轮不联网/);
  assert.match(block, /《交底.docx》（5 字）/);
});

test("selectMaterial labels pages, ignores English stop words and favours the asked-for section", () => {
  const pages = Array.from({ length: 9 }, (_, index) => {
    const no = index + 1;
    const heading = no === 4 ? "4 Experiments\n\nDatasets. We evaluate on ten remote sensing benchmarks and report mIoU metrics.\n\n" : "";
    const body = Array.from({ length: 6 }, (_, k) => `Paragraph ${no}.${k} of the method and the results and the discussion. `.repeat(8)).join("\n\n");
    return `【第 ${no} 页】\n${heading}${body}`;
  }).join("\n\n");
  const query = "Based on the attached paper, summarize the experimental setup of Section 4 (datasets and metrics), citing page numbers.";
  const picked = selectMaterial([{ name: "paper.pdf", kind: "pdf", text: pages }], query, 3000);
  assert.ok(picked);
  assert.match(picked, /4 Experiments/);
  assert.match(picked, /Datasets\. We evaluate/);
  assert.match(picked, /【第 \d+ 页（续）】/);
  const runs = (picked.match(/^…$/gm) ?? []).length + 1;
  const labels = (picked.match(/【第 \d+ 页(（续）)?】/g) ?? []).length;
  assert.ok(labels >= runs, `every excerpt carries a page label (${labels} labels, ${runs} runs)`);
  assert.match(picked, /每段标有所在页码/);
});

test("queryTerms drops English stop words; sectionRefs reads section numbers", () => {
  const terms = queryTerms("Summarize the experimental setup and the datasets, citing page numbers");
  assert.ok(terms.includes("datasets"));
  assert.ok(terms.includes("experimental"));
  for (const word of ["the", "and", "page", "numbers", "citing", "summarize"]) assert.ok(!terms.includes(word), word);
  assert.deepEqual(sectionRefs("see Section 4 and Sec. 3.2"), ["4", "3.2"]);
  assert.deepEqual(sectionRefs("请总结第 5 节的实验"), ["5"]);
  assert.deepEqual(sectionRefs("no section here"), []);
});