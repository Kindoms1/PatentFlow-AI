import assert from "node:assert/strict";
import test from "node:test";
import { isIncompleteSlash, parseSlash } from "./skill-turn.ts";

test("孤立斜杠和未写完的技能前缀会被拦截，不作为普通对话发送", () => {
  assert.equal(isIncompleteSlash("/"), true);
  assert.equal(isIncompleteSlash("/发"), true);
  assert.equal(isIncompleteSlash("/创"), true);
});

test("普通路径、普通文本和带内容的技能命令照常发送", () => {
  assert.equal(isIncompleteSlash("/usr/bin"), false);
  assert.equal(isIncompleteSlash("帮我看看"), false);
  assert.equal(isIncompleteSlash(""), false);
  assert.equal(isIncompleteSlash("/发明稿 重点保护边界细化"), false);
  assert.equal(isIncompleteSlash("/创作 智慧农业"), false);
  assert.equal(isIncompleteSlash("/不存在的技能"), false);
});

test("拦截只影响前缀判定，不改变 parseSlash 的既有结果", () => {
  assert.equal(parseSlash("/创作 智慧农业").intent, "create");
  assert.equal(parseSlash("帮我看看").intent, "chat");
});