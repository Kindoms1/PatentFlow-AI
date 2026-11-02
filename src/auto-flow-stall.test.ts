import assert from "node:assert/strict";
import test from "node:test";
import { canRetryTopicFailure, candidatesAfterFailureRequest, candidatesOnlyRequest, runAutoPatent, type AutoDeps, type AutoReply } from "./auto-flow.ts";
import type { Action } from "./model.ts";

const fence = "```";
const USER = "帮我写一个智慧农业领域的发明专利，按照你的想法来进行，不要询问我，直接帮我做";
const STALL = "模型连续 90 秒 没有新输出，已中断。";
const PICKED = "一种基于土壤壒情与气象预报融合的分区灌溉决策方法";
const RETRY_JSON = `${fence}json
{"candidates":[{"title":"${PICKED}","problem":"单点测量代表性差","feature":"壒情与气象融合","effect":"预期减少过灌"},{"title":"一种面向边缘端的轻量化病虫害识别方法","problem":"边缘算力受限","feature":"模型剪枝","effect":"预期识别更快"}],"recommended":1}
${fence}`;
const CLUES = [
  { n: 1, title: "水肥一体化灌溉控制方法及系统", url: "https://example.com/clue-1" },
  { n: 2, title: "基于多源数据融合的农田管理决策支持", url: "https://example.com/clue-2" },
];
const FOLLOW_UP_MARK = "上一轮检索后的归纳没有完成";

type Call = { intent: string; messages: Array<{ role: string; content: string }> };
type ChatNote = Extract<Action, { type: "chat-note" }>;

const ok = (text: string): AutoReply => ({ ok: Boolean(text), text, detail: text ? "" : "空回答", model: "mock-model", aborted: false, sources: [] });
const failed = (detail: string, sources = CLUES): AutoReply => ({ ok: false, text: "", detail, model: "", aborted: false, sources });

/** 选题返回 first；带线索的追问回候选 JSON；到大纲阶段就中止，只测选题。 */
function mockDeps(calls: Call[], first: AutoReply, controller: AbortController): AutoDeps {
  return {
    ask: async (messages, intent) => {
      calls.push({ intent, messages: messages.map((message) => ({ role: message.role, content: message.content })) });
      if (intent === "create") return first;
      if (messages.at(-1)?.content.includes(FOLLOW_UP_MARK)) return ok(RETRY_JSON);
      controller.abort();
      return { ...ok(""), aborted: true };
    },
    draft: {
      ask: async () => ok(""),
      search: async () => ({ ok: true, detail: "", results: [] }),
      extract: async () => ({ ok: false, content: "" }),
    },
  };
}

async function runTopicStage(first: AutoReply) {
  const actions: Action[] = [];
  const calls: Call[] = [];
  const controller = new AbortController();
  await runAutoPatent(
    { caseId: "case-stall", userText: USER, history: [], materials: [], dispatch: (action: Action) => actions.push(action), signal: controller.signal },
    mockDeps(calls, first, controller),
  );
  const notes = actions.filter((action): action is ChatNote => action.type === "chat-note");
  return { actions, calls, traces: notes.filter((note) => note.role === "trace").map((note) => note.text) };
}

test("stalled topic reply is followed up without tools, carrying the clues already found, and adopts a structured candidate", async () => {
  const { actions, calls, traces } = await runTopicStage(failed(STALL));
  assert.deepEqual(calls.map((call) => call.intent), ["create", "outline", "outline"]);

  const original = calls[0].messages;
  const followUp = calls[1].messages;
  assert.equal(followUp.length, original.length, "追问并进最后一条用户消息，不出现连续两条用户消息");
  const last = followUp.at(-1);
  assert.equal(last?.role, "user");
  assert.ok(last?.content.startsWith(original.at(-1)?.content ?? "\u0000"));
  assert.ok(last?.content.includes(STALL));
  for (const clue of CLUES) {
    assert.ok(last?.content.includes(clue.title));
    assert.ok(last?.content.includes(clue.url));
  }
  assert.ok(last?.content.includes(candidatesOnlyRequest()));

  const pursued = actions.find((action): action is Extract<Action, { type: "pursue-idea" }> => action.type === "pursue-idea");
  assert.equal(pursued?.title, PICKED);
  assert.ok(traces.some((text) => /选题回复中断.*2 条线索.*不联网再追问一次/.test(text)));
  assert.ok(traces.some((text) => text.includes(`已自动采用推荐题目「${PICKED}」`)));
  assert.ok(!traces.some((text) => /没有整理出结构化的候选题目/.test(text)));
});

test("auth failure on the topic step is not retried and falls back to the topic", async () => {
  const { actions, calls, traces } = await runTopicStage(failed("401 未授权：密钥无效", []));
  assert.ok(!calls.some((call) => call.messages.at(-1)?.content.includes(FOLLOW_UP_MARK)));
  assert.ok(!actions.some((action) => action.type === "pursue-idea"));
  assert.ok(traces.some((text) => /没有整理出结构化的候选题目（401 未授权/.test(text)));
});

test("canRetryTopicFailure retries stalls and dropped connections but not key, auth or billing failures", () => {
  assert.equal(canRetryTopicFailure(STALL), true);
  assert.equal(canRetryTopicFailure("连接中断，回答可能不完整。"), true);
  assert.equal(canRetryTopicFailure("暂时连不上服务，请稍后重试。"), true);
  assert.equal(canRetryTopicFailure(""), true);
  assert.equal(canRetryTopicFailure("当前模型没有服务端密钥。"), false);
  assert.equal(canRetryTopicFailure("401 未授权"), false);
  assert.equal(canRetryTopicFailure("402 余额不足"), false);
  assert.equal(canRetryTopicFailure("403 Forbidden"), false);
});

test("candidatesAfterFailureRequest without clues asks to work from common pain points and keeps the JSON-only rules", () => {
  const text = candidatesAfterFailureRequest(STALL, []);
  assert.match(text, /没有拿到可用的检索线索/);
  assert.ok(text.includes(candidatesOnlyRequest()));
  assert.match(text, /不得编造专利号/);
});