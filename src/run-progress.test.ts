import test from "node:test";
import assert from "node:assert/strict";
import { AUTO_TRACE_PREFIX } from "./auto-flow.ts";
import type { ChatMessage } from "./model.ts";
import { detectRunKind, formatElapsed, runProgress, runTraces } from "./run-progress.ts";

const BASE = Date.parse("2026-10-27T00:00:00.000Z");
let seq = 0;
function msg(text: string, offsetSec: number, role: ChatMessage["role"] = "trace"): ChatMessage {
  seq += 1;
  return { id: `m${seq}`, role, text, at: new Date(BASE + offsetSec * 1000).toISOString() };
}
const FULL_PLAN = `${AUTO_TRACE_PREFIX}：检索选题 → 自动采用推荐题目 → 查新对比 → 设计大纲 → 写完整申请文件 → 生成 Word。`;
const statuses = (progress: ReturnType<typeof runProgress>) => Object.fromEntries(progress.stages.map((stage) => [stage.id, stage.status]));

test("auto: 开场后处在选题阶段，共 7 步，尚无完成", () => {
  const progress = runProgress([msg("帮我写", 0, "user"), msg(FULL_PLAN, 1), msg("① 选题：联网检索该领域的专利", 2)], { kind: "auto", since: BASE });
  assert.equal(progress.total, 7);
  assert.equal(progress.done, 0);
  assert.equal(progress.step, 1);
  assert.equal(progress.activeLabel, "检索选题");
  assert.equal(statuses(progress).topic, "active");
  assert.equal(statuses(progress).polish, "pending");
});

test("auto: 撰写全文时前三步完成，第 4/7 步", () => {
  const progress = runProgress(
    [
      msg(FULL_PLAN, 1),
      msg("① 选题：…", 2),
      msg("已自动采用推荐题目「一种…」", 30),
      msg("①½ 查新对比：…", 31),
      msg("查新第 1 轮检到 6 篇", 50),
      msg("② 大纲：按「一种…」写", 70),
      msg("③ 成稿：按选题和大纲写", 100),
      msg("正在撰写全文：权利要求书", 110),
    ],
    { kind: "auto", since: BASE },
  );
  assert.deepEqual(statuses(progress), { topic: "done", novelty: "done", outline: "done", write: "active", audit: "pending", figures: "pending", polish: "pending" });
  assert.equal(progress.done, 3);
  assert.equal(progress.step, 4);
  assert.equal(progress.total, 7);
});

test("auto: 已有查新报告时查新被越过，标为已跳过且不计入总步数", () => {
  const progress = runProgress([msg(FULL_PLAN, 1), msg("① 选题：…", 2), msg("② 大纲：…", 40), msg("③ 成稿：…", 80)], { kind: "auto", since: BASE });
  assert.equal(statuses(progress).novelty, "skipped");
  assert.match(progress.stages.find((stage) => stage.id === "novelty")?.hint ?? "", /查新报告/);
  assert.equal(progress.total, 6);
  assert.equal(progress.done, 2);
  assert.equal(progress.step, 3);
});

test("auto: 按材料直写时选题和大纲从开头就标为已跳过，当前在查新", () => {
  const plan = `${AUTO_TRACE_PREFIX}：按你给的材料 → 查新对比 → 写完整申请文件 → 生成 Word。`;
  const progress = runProgress([msg(plan, 1)], { kind: "auto", since: BASE });
  assert.equal(statuses(progress).topic, "skipped");
  assert.equal(statuses(progress).outline, "skipped");
  assert.equal(statuses(progress).novelty, "active");
  assert.equal(progress.total, 5);
  assert.equal(progress.step, 1);
  assert.match(progress.stages[0].hint, /材料/);
});

test("auto: 沿用已有题目时选题跳过原因写明沿用", () => {
  const plan = `${AUTO_TRACE_PREFIX}：沿用已有题目「一种…」 → 查新对比 → 设计大纲 → 写完整申请文件 → 生成 Word。`;
  const progress = runProgress([msg(plan, 1)], { kind: "auto", since: BASE });
  assert.equal(statuses(progress).topic, "skipped");
  assert.match(progress.stages[0].hint, /沿用/);
  assert.equal(statuses(progress).outline, "pending");
  assert.equal(progress.total, 6);
});

test("阶段只进不退：补绘附图之后的修订记录不会把进度拉回自检", () => {
  const progress = runProgress(
    [msg("发明稿流水线：① …", 1), msg("正在撰写全文", 5), msg("自检 88 分：…", 90), msg("附图说明列出的图3没有绘图数据", 100), msg("修订后 93 分", 120)],
    { kind: "draft", since: BASE },
  );
  assert.equal(statuses(progress).figures, "active");
  assert.equal(statuses(progress).audit, "done");
  assert.equal(progress.latest, "修订后 93 分");
});

test("since 之前的旧一轮记录不计入本轮", () => {
  const old = msg("分节扩写：创新点分析。", -600);
  const progress = runProgress([old, msg("发明稿流水线：…", 1)], { kind: "draft", since: BASE });
  assert.equal(statuses(progress).search, "active");
  assert.equal(statuses(progress).polish, "pending");
  assert.equal(progress.traceCount, 1);
  assert.equal(runTraces([old], BASE).length, 0);
  assert.equal(runTraces([old]).length, 1);
});

test("draft: 自检阶段时检索和撰写已完成，共 5 步", () => {
  const progress = runProgress([msg("发明稿流水线：…", 1), msg("自检 92 分：结构检查全部通过。", 80)], { kind: "draft", since: BASE });
  assert.deepEqual(statuses(progress), { search: "done", write: "done", audit: "active", figures: "pending", polish: "pending" });
  assert.equal(progress.total, 5);
  assert.equal(progress.done, 2);
  assert.equal(progress.step, 3);
});

test("没有任何记录时停在第一步，不伪造进度", () => {
  const progress = runProgress([], { kind: "draft", since: BASE });
  assert.equal(progress.done, 0);
  assert.equal(progress.step, 1);
  assert.equal(progress.latest, "");
  assert.equal(progress.latestAt, null);
  assert.equal(progress.attention, false);
});

test("失败重试记录需要提醒，最新记录压成一行并截短", () => {
  const retry = runProgress([msg("正在撰写全文", 1), msg("撰写全文第 1 次失败：网络中断（timeout）。 8 秒后自动重试（第 2/3 次）。", 60)], { kind: "draft", since: BASE });
  assert.equal(retry.attention, true);
  assert.equal(retry.latestAt, BASE + 60_000);
  const long = runProgress([msg(`自检 80 分：\n${"很长的说明".repeat(60)}`, 1)], { kind: "draft", since: BASE });
  assert.ok(long.latest.length <= 141);
  assert.ok(long.latest.endsWith("…"));
  assert.ok(!long.latest.includes("\n"));
});

test("detectRunKind：只有全自动和 /发明稿 显示生成进度", () => {
  assert.equal(detectRunKind("auto"), "auto");
  assert.equal(detectRunKind("draft"), "draft");
  assert.equal(detectRunKind("chat"), null);
  assert.equal(detectRunKind("ideas", [msg(FULL_PLAN, 1)], BASE), "auto");
  assert.equal(detectRunKind("ideas", [msg(FULL_PLAN, -600)], BASE), null);
});

test("formatElapsed", () => {
  assert.equal(formatElapsed(-5), "0 秒");
  assert.equal(formatElapsed(Number.NaN), "0 秒");
  assert.equal(formatElapsed(45_400), "45 秒");
  assert.equal(formatElapsed(125_000), "2 分 05 秒");
  assert.equal(formatElapsed(3_780_000), "1 小时 03 分");
});