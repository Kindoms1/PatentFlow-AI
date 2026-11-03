import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChatMessages, clipText, defaultPrompt, dialogHasMaterial, packMaterials, parseSlash, detectReadRequest } from "./skill-turn.ts";
import type { ChatMessage } from "./model.ts";
import { READ_SYSTEM } from "./patent-skill.ts";

const slash = parseSlash("/挖点 这份论文有没有发明点");
assert.equal(slash.intent, "ideas");
assert.equal(slash.rest, "这份论文有没有发明点");
assert.equal(parseSlash("帮我看看").intent, "chat");
assert.equal(parseSlash("/查新").intent, "search");

const onlyFile = defaultPrompt("ideas", true);
assert.match(onlyFile, /候选发明点/);
assert.doesNotMatch(onlyFile, /请按内置中国专利交底技能处理这份材料/);
const noFile = defaultPrompt("ideas", false);
assert.match(noFile, /不要编造/);

const packed = packMaterials(
  [
    { name: "paper.pdf", kind: "pdf", text: "本发明公开一种电解液添加剂。" },
    { name: "note.md", kind: "text", text: "实验室还没有做循环测试。" },
  ],
  12000,
);
assert.match(packed, /paper\.pdf/);
assert.match(packed, /电解液添加剂/);
assert.match(packed, /循环测试/);
assert.ok(!packed.includes("帮我挖点"));

const long = "甲".repeat(400);
const clipped = clipText(long, 80);
assert.ok(clipped.includes("中间省略"));
assert.ok(clipped.length < long.length);

const messages = buildChatMessages({
  intent: "ideas",
  userText: "帮我挖点",
  materials: [{ name: "paper.pdf", kind: "pdf", text: "本发明公开一种电解液添加剂。" }],
  history: [
    { id: "1", role: "user", text: "上一轮问题", at: "2026-01-01T00:00:00.000Z" },
    { id: "2", role: "trace", text: "不应当进模型上下文", at: "2026-01-01T00:00:00.000Z" },
    { id: "3", role: "assistant", text: "上一轮答复", at: "2026-01-01T00:00:00.000Z" },
  ],
  pursued: ["电解液成膜添加剂"],
});
assert.equal(messages[0]?.role, "system");
assert.equal(messages.at(-1)?.role, "user");
assert.match(messages.at(-1)?.content || "", /电解液添加剂/);
assert.match(messages.at(-1)?.content || "", /电解液成膜添加剂/);
assert.equal(
  messages.filter((item) => item.role !== "system").length,
  3,
);
assert.ok(!messages.some((item) => item.content.includes("不应当进模型上下文")));

console.log("skill turn checks passed");

// 对话里给出的交底内容也算材料：单独发 /挖点 不应再得到“还没有材料”的提示。
const chatMsg = (role: ChatMessage["role"], text: string): ChatMessage => ({ id: `${role}-${text.length}`, role, text, at: "2026-10-23T00:00:00.000Z" });
assert.equal(dialogHasMaterial(undefined), false);
assert.equal(dialogHasMaterial([], []), false);
assert.equal(dialogHasMaterial([chatMsg("user", "/挖点"), chatMsg("user", "帮我看看"), chatMsg("user", "/查新")]), false);
assert.equal(dialogHasMaterial([chatMsg("assistant", "甲".repeat(200)), chatMsg("trace", "乙".repeat(200))]), false);
assert.equal(dialogHasMaterial([chatMsg("user", "/交底书 一种雨水井截污装置，在井口下方设置倾斜的弧形截污格栅，格栅上方设有刮板，由下泄水流冲击叶轮，经曲柄连杆带动刮板往复刮扫。")]), true);
assert.equal(dialogHasMaterial([chatMsg("user", "格栅倾斜布置在井口下方，上方有刮板。"), chatMsg("user", "叶轮由穿过格栅的下泄水流冲击转动，经曲柄连杆带动刮板。")]), true);
assert.equal(dialogHasMaterial([], [{ text: "叶轮由下泄水流驱动" }]), true);
assert.equal(dialogHasMaterial([], [{ text: "   " }]), false);
for (const intent of ["ideas", "disclosure", "search", "read", "chart", "chat", "draft"] as const) {
  assert.doesNotMatch(defaultPrompt(intent, true), /还没有|没有上传|没有给/);
  assert.match(defaultPrompt(intent, true), /已有材料/);
}

test("detectReadRequest routes summaries and section questions, not writing", () => {
  for (const text of [
    "Based on the attached paper, summarize the experimental setup of Section 4, citing page numbers.",
    "请总结一下这篇论文",
    "解读第 4 节的实验设置",
    "What does the paper propose? Give me the key findings.",
    "Explain Section 3.2",
  ]) assert.equal(detectReadRequest(text), true, text);
  for (const text of [
    "",
    "/发明稿 总结一下",
    "总结附件并写一份交底书",
    "帮我从附件里挖点",
    "Draft claims from this summary",
    "这个方案能不能申请专利？",
  ]) assert.equal(detectReadRequest(text), false, text);
});

test("read-only prompts isolate the reading task from invention and domain guidance", () => {
  const request = '只阅读附件，用两句话概述技术内容。不要联网，也不要生成专利全文或候选发明点。';
  const built = buildChatMessages({ intent: 'read', userText: request, materials: [{ name: 'note.txt', kind: 'text', text: '电解液中添加成膜添加剂，实验室尚未测定其浓度。' }], history: [chatMsg('user', '之前讨论了添加剂方案'), chatMsg('assistant', '之前的推测不是附件证据')], tools: false });
  assert.equal(built[0].content, READ_SYSTEM);
  assert.match(built[0].content, /两句话时只给两句话/);
  assert.match(built[0].content, /不默认上传材料已经公开/);
  assert.match(built[0].content, /此前助手提出的假设/);
  const prompt = built.at(-1)?.content || '';
  assert.ok(prompt.endsWith(request));
  assert.match(prompt, /实验室尚未测定其浓度/);
  assert.doesNotMatch(prompt, /所属领域常规的取值范围|pending|把附件当公开文本|对发明人可能的启发/);
  assert.equal(built.length, 4, 'preserve dialogue references without treating them as source evidence');
});

test("default reading requests do not silently ask for invention proposals", () => {
  assert.doesNotMatch(defaultPrompt('read', true), /转化成发明点|候选/);
  assert.doesNotMatch(defaultPrompt('read', false), /公开文本/);
});
