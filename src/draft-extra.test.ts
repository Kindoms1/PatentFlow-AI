import test from "node:test";
import assert from "node:assert/strict";
import { buildChatMessages, defaultPrompt, draftExtra } from "./skill-turn.ts";

const materials = [
  {
    name: "对话交底.md",
    kind: "text" as const,
    text: "一种雨水井截污装置：井口下方设倾斜弧形截污格栅，刚板由下泄水流驱动的叶轮经曲柄连杆带动，沿格栅表面往复摆动。",
  },
];

test("draftExtra drops the canned /发明稿 default prompt", () => {
  assert.equal(draftExtra(defaultPrompt("draft", false)), "");
  assert.equal(draftExtra(defaultPrompt("draft", true)), "");
  assert.equal(draftExtra(`  ${defaultPrompt("draft", false)}\n`), "");
  assert.equal(draftExtra("   "), "");
  assert.equal(draftExtra(" 重点保护刮板驱动 "), "重点保护刮板驱动");
});

test("draft prompt never carries the canned 'ask me first' text as an inventor requirement", () => {
  for (const userText of [defaultPrompt("draft", false), defaultPrompt("draft", true), ""]) {
    const messages = buildChatMessages({ materials, history: [], userText, intent: "draft" });
    const user = messages.at(-1)?.content ?? "";
    assert.doesNotMatch(user, /【发明人补充要求】/);
    assert.doesNotMatch(user, /请先问我/);
  }
});

test("a real inventor requirement is still appended to the draft prompt", () => {
  const messages = buildChatMessages({ materials, history: [], userText: "重点保护刮板驱动", intent: "draft" });
  assert.match(messages.at(-1)?.content ?? "", /【发明人补充要求】重点保护刮板驱动$/);
});