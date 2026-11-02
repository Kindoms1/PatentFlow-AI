import { test } from "node:test";
import assert from "node:assert/strict";
import { OUTLINE_MATERIAL_NAME, SLASH_SKILLS, createTopic, defaultPrompt, detectCreateRequest, parseSlash, titleFromMaterials } from "./skill-turn.ts";

test("a one-line request for a patent in a field is a create request", () => {
  assert.equal(detectCreateRequest("帮我写一个智慧农业领域的发明专利"), true);
  assert.equal(detectCreateRequest("我想申请一个无人机巡检方面的专利"), true);
  assert.equal(detectCreateRequest("写一份新能源汽车电池热管理的发明专利"), true);
  assert.equal(detectCreateRequest("给我出个医疗影像方向的专利"), true);
});

test("a described scheme, a how-to question or a slash command is not a create request", () => {
  assert.equal(detectCreateRequest("现有做法是人工清掏。我的方案：在井口下方设置弧形格栅，帮我写成专利"), false);
  assert.equal(detectCreateRequest("发明专利怎么写权利要求？"), false);
  assert.equal(detectCreateRequest("申请发明专利的流程是什么"), false);
  assert.equal(detectCreateRequest("/挖点 帮我写一个专利"), false);
  assert.equal(detectCreateRequest("雨水井截污装置的格栅倾角取多少合适"), false);
  assert.equal(detectCreateRequest(""), false);
});

test("the topic is read from the request", () => {
  assert.equal(createTopic("帮我写一个智慧农业领域的发明专利"), "智慧农业");
  assert.equal(createTopic("我想申请一个无人机巡检方面的专利"), "无人机巡检");
  assert.equal(createTopic("写一份新能源汽车电池热管理的发明专利"), "新能源汽车电池热管理");
  assert.equal(createTopic("/创作 帮我写一个智慧农业领域的发明专利"), "智慧农业");
  assert.equal(createTopic("帮我写一个专利"), "");
});

test("/创作 and /大纲 are slash skills with their own default prompts", () => {
  assert.ok(SLASH_SKILLS.some((item) => item.command === "/创作" && item.intent === "create"));
  assert.ok(SLASH_SKILLS.some((item) => item.command === "/大纲" && item.intent === "outline"));
  assert.equal(parseSlash("/创作 智慧农业").intent, "create");
  assert.equal(parseSlash("/创作 智慧农业").rest, "智慧农业");
  assert.ok(defaultPrompt("create", false).includes("领域"));
  assert.ok(defaultPrompt("outline", true).includes("大纲"));
});

test("the outline material never becomes the invention title", () => {
  const title = titleFromMaterials([{ name: OUTLINE_MATERIAL_NAME, kind: "text", text: "大纲正文" }], "一种基于多光谱的作物病害早期识别方法");
  assert.equal(title, "一种基于多光谱的作物病害早期识别方法");
});
