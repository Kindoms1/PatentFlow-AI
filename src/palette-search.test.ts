import assert from "node:assert/strict";
import test from "node:test";
import { buildPaletteView, groupOf, highlight, isCurrent, scoreCommand, searchTerms, shortcutOf, type PaletteCommand } from "./palette-search.ts";

const noop = () => undefined;
const cmd = (id: string, label: string, hint: string, extra: Partial<PaletteCommand> = {}): PaletteCommand => ({ id, label, hint, run: noop, ...extra });

test("groupOf prefers the explicit group and falls back to the category hint", () => {
  assert.equal(groupOf(cmd("a", "x", "页面")), "page");
  assert.equal(groupOf(cmd("b", "x", "面板")), "panel");
  assert.equal(groupOf(cmd("c", "x", "当前会话")), "session");
  assert.equal(groupOf(cmd("d", "x", "Ctrl+B")), "action");
  assert.equal(groupOf(cmd("e", "x", "页面", { group: "action" })), "action");
});

test("shortcutOf keeps key hints and drops category words", () => {
  assert.equal(shortcutOf(cmd("a", "x", "Ctrl+B")), "Ctrl+B");
  assert.equal(shortcutOf(cmd("b", "x", "/")), "/");
  assert.equal(shortcutOf(cmd("c", "x", "页面")), null);
  assert.equal(shortcutOf(cmd("d", "x", "当前会话")), null);
  assert.equal(shortcutOf(cmd("e", "x", " ")), null);
});

test("isCurrent accepts the flag or the legacy hint", () => {
  assert.equal(isCurrent(cmd("a", "x", "会话", { current: true })), true);
  assert.equal(isCurrent(cmd("b", "x", "当前会话")), true);
  assert.equal(isCurrent(cmd("c", "x", "会话")), false);
});

test("searchTerms lowercases, splits on whitespace and drops duplicates", () => {
  assert.deepEqual(searchTerms("  Foo  bar foo "), ["foo", "bar"]);
  assert.deepEqual(searchTerms("   "), []);
});

test("scoreCommand needs every term and ranks label prefix > label > detail > keywords", () => {
  const c = cmd("p", "打开设置", "页面", { keywords: "settings model", detail: "模型与密钥" });
  assert.ok(scoreCommand(c, ["打开"]) > scoreCommand(c, ["设置"]));
  assert.ok(scoreCommand(c, ["设置"]) > scoreCommand(c, ["密钥"]));
  assert.ok(scoreCommand(c, ["密钥"]) > scoreCommand(c, ["settings"]));
  assert.ok(scoreCommand(c, ["settings"]) > 0);
  assert.equal(scoreCommand(c, ["设置", "雷达"]), 0);
  assert.equal(scoreCommand(c, []), 1);
});

test("idle view keeps group order and caps sessions while keeping the open one", () => {
  const sessions = Array.from({ length: 12 }, (_, i) => cmd(`s${i}`, `会话 ${i}`, "会话", { group: "session", current: i === 10 }));
  const view = buildPaletteView([cmd("new", "新对话", "动作"), cmd("v", "打开设置", "页面"), ...sessions], "", 8);
  assert.deepEqual(view.sections.map((s) => s.group), ["action", "page", "session"]);
  assert.deepEqual(view.sections[2].entries.map((e) => e.command.id), ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s10"]);
  assert.equal(view.hiddenSessions, 4);
  const entries = view.sections.flatMap((s) => s.entries);
  assert.deepEqual(entries.map((e) => e.index), entries.map((_, i) => i));
  assert.deepEqual(entries.map((e) => e.command.id), view.flat.map((c) => c.id));
});

test("searching lists every matching session", () => {
  const sessions = Array.from({ length: 12 }, (_, i) => cmd(`s${i}`, `会话 ${i}`, "会话"));
  const view = buildPaletteView(sessions, "会话", 8);
  assert.equal(view.flat.length, 12);
  assert.equal(view.hiddenSessions, 0);
});

test("searching puts the group with the best match first", () => {
  const view = buildPaletteView(
    [cmd("new", "新对话", "动作"), cmd("v", "打开技术雷达", "页面"), cmd("s", "雷达方案", "会话")],
    "雷达",
  );
  assert.deepEqual(view.sections.map((s) => s.group), ["session", "page"]);
  assert.deepEqual(view.flat.map((c) => c.id), ["s", "v"]);
});

test("a query without matches yields an empty view", () => {
  const view = buildPaletteView([cmd("new", "新对话", "动作")], "不存在的词");
  assert.deepEqual(view, { sections: [], flat: [], hiddenSessions: 0 });
});

test("highlight marks every occurrence case-insensitively and merges overlaps", () => {
  assert.deepEqual(highlight("Remote CLIP remote", ["remote"]), [
    { text: "Remote", hit: true },
    { text: " CLIP ", hit: false },
    { text: "remote", hit: true },
  ]);
  assert.deepEqual(highlight("技术雷达", ["技术", "术雷"]), [
    { text: "技术雷", hit: true },
    { text: "达", hit: false },
  ]);
  assert.deepEqual(highlight("abc", []), [{ text: "abc", hit: false }]);
  assert.deepEqual(highlight("", ["a"]), []);
});