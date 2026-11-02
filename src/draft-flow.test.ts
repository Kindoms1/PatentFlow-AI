import test from "node:test";
import assert from "node:assert/strict";
import { buildChatMessages, parseSlash } from "./skill-turn.ts";
import { INVENTION_SYSTEM } from "./invention-draft.ts";
import { SKILL_SYSTEM } from "./patent-skill.ts";
import { abstractOf, cleanPatentTitle, draftQueries, gatherPriorArt } from "./prior-art.ts";
import { draftBody, parseDraftTail, runDraftTurn } from "./draft-run.ts";
import type { Action } from "./model.ts";
import { reduce, seed } from "./model.ts";
import { radarDue } from "./radar-schedule.ts";

const MATERIAL = "本发明涉及高分辨率遥感影像处理。现有方法在建筑物边界处容易粘连。本方法先提取多尺度特征，再用边界细化模块逐像素修正掩膜，输出建筑物轮廓。";

test("/发明稿 is a slash skill", () => {
  const parsed = parseSlash("/发明稿 重点保护边界细化");
  assert.equal(parsed.intent, "draft");
  assert.equal(parsed.rest, "重点保护边界细化");
});

test("draft with material uses the invention drafting prompt and cites only given prior art", () => {
  const messages = buildChatMessages({
    materials: [{ name: "交底.md", kind: "text", text: MATERIAL }],
    history: [],
    userText: "重点保护边界细化",
    intent: "draft",
    facts: ["边界细化模块逐像素修正掩膜"],
    priorArt: [{ pn: "CN114494821A", title: "一种建筑物提取方法", url: "https://patents.google.com/patent/CN114494821A/zh" }],
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].content, INVENTION_SYSTEM);
  assert.match(messages[1].content, /CN114494821A/);
  assert.match(messages[1].content, /边界细化模块逐像素修正掩膜/);
  assert.match(messages[1].content, /【发明人补充要求】重点保护边界细化/);
});

test("draft without material falls back to the interview skill", () => {
  const messages = buildChatMessages({ materials: [], history: [], userText: "", intent: "draft" });
  assert.equal(messages[0].content, SKILL_SYSTEM);
});

test("prior-art helpers clean titles, build queries and read abstracts", () => {
  assert.equal(cleanPatentTitle("CN114494821A - 一种遥感影像建筑物提取方法 - Google Patents"), "一种遥感影像建筑物提取方法");
  const queries = draftQueries("一种基于边界细化的遥感影像建筑物分割方法", "边界细化模块逐像素修正掩膜");
  assert.ok(queries.length >= 2);
  assert.ok(queries.every((query) => query.length <= 60));
  const abstract = abstractOf(`CN114494821A 一种方法 Abstract 本发明公开了一种遥感影像建筑物提取方法，包括获取影像、提取多尺度特征、融合边界信息并输出建筑物掩膜，提高了边界精度。 Images (3) Classifications G06V`);
  assert.match(abstract, /^本发明公开了/);
  assert.doesNotMatch(abstract, /Classifications/);
});

test("gatherPriorArt keeps real CN numbers, dedupes and enriches from the patent page", async () => {
  const traces: string[] = [];
  const refs = await gatherPriorArt(["遥感 建筑物 专利"], {
    search: async () => ({
      ok: true,
      detail: "",
      results: [
        { title: "CN114494821A - 一种遥感影像建筑物提取方法 - Google Patents", url: "https://patents.google.com/patent/CN114494821A/zh", snippet: "本发明公开了……" },
        { title: "建筑物提取专利 CN114494821", url: "https://example.com/a", snippet: "同一件申请" },
        { title: "一种边界优化方法", url: "https://patents.google.com/patent/CN113033448B/zh", snippet: "授权公告" },
        { title: "没有公开号的新闻", url: "https://example.com/news", snippet: "遥感行业新闻" },
      ],
    }),
    extract: async (url) => ({
      ok: true,
      title: "",
      content: url.includes("CN114494821A") ? "摘要 本发明公开了一种遥感影像建筑物提取方法，通过多尺度特征和边界注意力提高建筑物边界的提取精度，适用于高分辨率影像。 权利要求 1. 一种……" : "",
    }),
    onTrace: (text) => traces.push(text),
  });
  assert.deepEqual(refs.map((ref) => ref.pn), ["CN114494821A", "CN113033448B"]);
  assert.equal(refs[0].url, "https://patents.google.com/patent/CN114494821A/zh");
  assert.match(refs[0].note || "", /多尺度特征和边界注意力/);
  assert.ok(traces.some((line) => line.includes("检索对比文件")));
});

test("draft tail and body are separated", () => {
  const text = "# 发明名称：一种方法\n\n## 权利要求书\n1. 一种方法\n\n```json\n{\"distinguishing\":[{\"feature\":\"边界细化\",\"problem\":\"粘连\",\"effect\":\"轮廓清晰\"}],\"pending\":[\"阈值\"],\"closestArt\":\"CN114494821A\"}\n```";
  const tail = parseDraftTail(text);
  assert.equal(tail.distinguishing[0].feature, "边界细化");
  assert.deepEqual(tail.pending, ["阈值"]);
  assert.equal(tail.closestArt, "CN114494821A");
  assert.doesNotMatch(draftBody(text), /```/);
});

test("runDraftTurn searches, drafts, audits, revises once and stores the draft", async () => {
  const actions: Action[] = [];
  let asks = 0;
  // Structurally complete (so it is audited, not regenerated) but weak: few claims, a vague word, no cited prior art.
  const draft = [
    "# 发明名称：一种遥感影像建筑物分割方法",
    "",
    "## 说明书摘要",
    "本发明公开了一种遥感影像建筑物分割方法。",
    "",
    "## 权利要求书",
    "1. 一种遥感影像建筑物分割方法，其特征在于，包括：S1、提取多尺度特征；S2、边界细化模块逐像素修正掩膜。",
    "2. 根据权利要求1所述的方法，其特征在于，所述边界细化模块优选为卷积网络。",
    "",
    "## 技术领域",
    "本发明涉及遥感影像处理。",
    "",
    "## 背景技术",
    "现有方法在建筑物边界处容易粘连。",
    "",
    "## 具体实施方式",
    "提取多尺度特征后由边界细化模块逐像素修正掩膜，输出建筑物轮廓。".repeat(60),
    "",
    "```json",
    '{"distinguishing":[],"pending":["阈值"],"closestArt":""}',
    "```",
  ].join("\n");
  await runDraftTurn(
    { caseId: "c1", materials: [{ name: "交底.md", kind: "text", text: MATERIAL }], userText: "", dispatch: (action) => actions.push(action) },
    {
      ask: async () => {
        asks += 1;
        return { ok: true, text: draft, detail: "", model: "stub-model", aborted: false };
      },
      search: async () => ({ ok: true, detail: "", results: [{ title: "CN114494821A - 一种遥感影像建筑物提取方法 - Google Patents", url: "https://patents.google.com/patent/CN114494821A/zh", snippet: "" }] }),
    },
  );
  assert.equal(asks, 2, "a failing audit triggers exactly one revision round");
  const stored = actions.find((action) => action.type === "set-invention-draft");
  assert.ok(stored && stored.type === "set-invention-draft");
  assert.equal(stored.draft.priorArt[0].pn, "CN114494821A");
  assert.equal(stored.draft.model, "stub-model");
  assert.ok(stored.draft.score < 100);
  assert.doesNotMatch(stored.draft.text, /```json/);
  const note = actions.filter((action) => action.type === "chat-note" && action.role === "assistant").at(-1);
  assert.ok(note && note.type === "chat-note" && note.text.includes("成稿自检"));
});

test("reducer stores drafts and dedupes radar hits", () => {
  let state = seed();
  const caseId = state.cases[0].id;
  state = reduce(state, {
    type: "set-invention-draft",
    caseId,
    draft: { text: "# 发明名称：x", score: 80, at: "2026-10-22T00:00:00.000Z", model: "m", revised: false, pendingMarks: 0, claimCount: 9, priorArt: [], checks: [], distinguishing: [], pending: [] },
  });
  assert.equal(state.cases[0].inventionDraft?.score, 80);
  assert.equal((state.cases[0] as unknown as { disclosure: string }).disclosure, "# 发明名称：x");

  state = reduce(state, { type: "add-sub", name: "遥感", keywords: "遥感，建筑物", schedule: "daily", ipc: "G06V" });
  const sub = state.subscriptions[0];
  assert.equal(sub.ipc, "G06V");
  const hit = { pn: "CN114494821A", kind: "发明申请公开", title: "t", url: "u", sourceUrl: "s", snippet: "", query: "q", foundAt: "2026-10-22T01:00:00.000Z" };
  state = reduce(state, { type: "radar-result", id: sub.id, ranAt: "2026-10-22T01:00:00.000Z", ok: true, detail: "ok", hits: [hit] });
  state = reduce(state, { type: "radar-result", id: sub.id, ranAt: "2026-10-23T01:00:00.000Z", ok: true, detail: "ok", hits: [hit] });
  assert.equal(state.subscriptions[0].hits?.length, 1);
  assert.deepEqual(state.subscriptions[0].seen, ["CN114494821"]);
  assert.equal(state.subscriptions[0].lastStatus, "ok");
});

test("radar schedule", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  assert.equal(radarDue({ enabled: true, schedule: "daily" }, now), true);
  assert.equal(radarDue({ enabled: true, schedule: "daily", lastRunAt: "2026-10-22T02:00:00Z" }, now), false);
  assert.equal(radarDue({ enabled: true, schedule: "daily", lastRunAt: "2026-10-21T10:00:00Z" }, now), true);
  assert.equal(radarDue({ enabled: false, schedule: "daily" }, now), false);
  assert.equal(radarDue({ enabled: true, schedule: "manual" }, now), false);
});
