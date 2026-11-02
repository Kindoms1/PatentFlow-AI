import assert from "node:assert/strict";
import test from "node:test";
import { candidatesOnlyRequest, runAutoPatent, type AutoDeps } from "./auto-flow.ts";
import type { Action } from "./model.ts";

const fence = "```";
const USER = "帮我写一个智慧农业领域的发明专利，按照你的想法来进行，不要询问我，直接帮我做";
const PROSE_ONLY =
  "已完成 6 次检索。智慧农业方向的现有做法集中在壒情监测、灌溉控制和病虫害识别，普遍存在单点测量代表性差、模型依赖人工阈值、边缘端算力受限等问题。以上均为检索线索，未核验。";
const PICKED = "一种面向边缘端的轻量化病虫害识别方法";
const RETRY_JSON = `${fence}json
{"candidates":[{"title":"一种基于多源壒情融合的分区灌溉决策方法","problem":"单点测量代表性差","feature":"多源数据融合","effect":"预期减少过灌"},{"title":"${PICKED}","problem":"边缘算力受限","feature":"模型剪枝","effect":"预期识别更快"}],"recommended":2}
${fence}`;

type Call = { intent: string; messages: Array<{ role: string; content: string }> };
type ChatNote = Extract<Action, { type: "chat-note" }>;

const reply = (text: string, aborted = false) => ({ ok: Boolean(text), text, detail: text ? "" : "空回答", model: "mock-model", aborted, sources: [] });

/** 选题只回归纳段落；只要 JSON 的追问回 retryText；到大纲阶段就中止，只测选题。 */
function mockDeps(calls: Call[], retryText: string, controller: AbortController): AutoDeps {
  return {
    ask: async (messages, intent) => {
      calls.push({ intent, messages: messages.map((message) => ({ role: message.role, content: message.content })) });
      if (intent === "create") return reply(PROSE_ONLY);
      if (messages.at(-1)?.content === candidatesOnlyRequest()) return reply(retryText);
      controller.abort();
      return reply("", true);
    },
    draft: {
      ask: async () => reply(""),
      search: async () => ({ ok: true, detail: "", results: [] }),
      extract: async () => ({ ok: false, content: "" }),
    },
  };
}

async function runTopicStage(retryText: string) {
  const actions: Action[] = [];
  const calls: Call[] = [];
  const controller = new AbortController();
  await runAutoPatent(
    { caseId: "case-retry", userText: USER, history: [], materials: [], dispatch: (action: Action) => actions.push(action), signal: controller.signal },
    mockDeps(calls, retryText, controller),
  );
  const notes = actions.filter((action): action is ChatNote => action.type === "chat-note");
  return {
    actions,
    calls,
    traces: notes.filter((note) => note.role === "trace").map((note) => note.text),
    said: notes.filter((note) => note.role === "assistant").map((note) => note.text),
  };
}

test("unparseable topic reply triggers one tools-off JSON-only follow-up and adopts its recommended candidate", async () => {
  const { actions, calls, traces, said } = await runTopicStage(RETRY_JSON);
  assert.deepEqual(calls.map((call) => call.intent), ["create", "outline", "outline"]);
  const followUp = calls[1].messages;
  assert.equal(followUp.at(-2)?.role, "assistant");
  assert.equal(followUp.at(-2)?.content, PROSE_ONLY);
  assert.equal(followUp.at(-1)?.role, "user");
  assert.equal(followUp.at(-1)?.content, candidatesOnlyRequest());
  assert.equal(followUp.length, calls[0].messages.length + 2);

  const merged = actions.find((action): action is Extract<Action, { type: "merge-ideas" }> => action.type === "merge-ideas");
  assert.equal(merged?.ideas.length, 2);
  const pursued = actions.find((action): action is Extract<Action, { type: "pursue-idea" }> => action.type === "pursue-idea");
  assert.equal(pursued?.title, PICKED);

  assert.ok(traces.some((text) => /不联网再追问一次/.test(text)));
  assert.ok(traces.some((text) => text.includes(`已自动采用推荐题目「${PICKED}」`)));
  assert.ok(!traces.some((text) => /没有整理出结构化的候选题目/.test(text)));
  assert.ok(said.includes(PROSE_ONLY), "第一次回复的归纳仍展示给发明人");
});

test("follow-up without candidates falls back to the topic and keeps an excerpt of the raw reply", async () => {
  const { actions, calls, traces } = await runTopicStage("仍然只是一段归纳，没有题目。");
  assert.deepEqual(calls.map((call) => call.intent), ["create", "outline", "outline"]);
  assert.ok(!actions.some((action) => action.type === "pursue-idea"));
  assert.ok(traces.some((text) => /没有整理出结构化的候选题目.*追问后仍没有.*直接以「[^」]+」为主题继续/.test(text)));
  assert.ok(traces.some((text) => text.startsWith("选题阶段模型原始回复（节选）：已完成 6 次检索")));
  assert.ok(!traces.some((text) => /已自动采用推荐题目/.test(text)));
});

test("failed follow-up call is reported in the fallback trace", async () => {
  const { traces } = await runTopicStage("");
  assert.ok(traces.some((text) => text.includes("；追问失败（空回答）")));
  assert.ok(traces.some((text) => text.startsWith("选题阶段模型原始回复（节选）：")));
});

test("candidatesOnlyRequest asks for a JSON block of titles starting with 一种, without searching or inventing data", () => {
  const text = candidatesOnlyRequest();
  assert.match(text, /json/);
  assert.match(text, /"candidates"/);
  assert.match(text, /"recommended"/);
  assert.match(text, /以“一种”开头/);
  assert.match(text, /不要再检索/);
  assert.match(text, /不得编造专利号/);
});