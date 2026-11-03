import { test } from "node:test";
import assert from "node:assert/strict";
import { intentUsesTools, runPatentTurn, sourcesTrace, traceForEvent } from "./skill-run.ts";
import type { Action, ChatMessage } from "./model.ts";
import { CONVERSATION_MATERIAL_NAME, conversationMaterial, titleFromMaterials } from "./skill-turn.ts";
import { draftQueries } from "./prior-art.ts";

function ndjsonResponse(events: unknown[]): Response {
  const body = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  return new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
}

test("only search, chart and chat may use web tools", () => {
  assert.equal(intentUsesTools("search"), true);
  assert.equal(intentUsesTools("chart"), true);
  assert.equal(intentUsesTools("chat"), true);
  assert.equal(intentUsesTools("ideas"), false);
  assert.equal(intentUsesTools("disclosure"), false);
  assert.equal(intentUsesTools("read"), false);
});

test("tool events become readable trace lines, deltas do not", () => {
  assert.equal(traceForEvent({ type: "tool_call", id: "1", name: "web_search", input: { query: "云检测 注意力" } }), "联网检索：「云检测 注意力」");
  assert.match(traceForEvent({ type: "tool_result", id: "1", name: "web_search", ok: true, summary: "3 条", sources: [] }) || "", /联网检索完成：3 条/);
  assert.equal(traceForEvent({ type: "delta", text: "x" }), null);
  assert.match(sourcesTrace([{ n: 1, title: "A", url: "https://a.example", via: "search" }]), /\[1\] A https:\/\/a\.example/);
});

test("search turn streams through /api/agent, records trace, sources and a knowledge note", async () => {
  const calls: Array<{ url: string; body: { tools?: boolean; maxSteps?: number } }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body || "{}")) });
    return ndjsonResponse([
      { type: "start", model: "agnes-2.5-flash", provider: "agnes", tools: ["web_search"] },
      { type: "tool_call", id: "c1", name: "web_search", input: { query: "遥感 云检测 多尺度注意力 专利" } },
      { type: "tool_result", id: "c1", name: "web_search", ok: true, summary: "2 条结果", sources: [{ n: 1, title: "CN1 云检测", url: "https://example.com/cn1", via: "search" }] },
      { type: "done", text: "找到一条相关线索 [1]。", sources: [{ n: 1, title: "CN1 云检测", url: "https://example.com/cn1", via: "search" }, { n: 2, title: "未引用", url: "https://example.com/x", via: "search" }], steps: 2, model: "agnes-2.5-flash", usage: { input: 10, output: 5 } },
    ]);
  }) as typeof fetch;
  const actions: Action[] = [];
  try {
    await runPatentTurn({
      caseId: "case-1",
      userText: "查一下多尺度注意力云检测",
      intent: "search",
      recordUser: true,
      dispatch: (action) => actions.push(action),
    });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls.length, 1, "agent search must not trigger a second /api/search call");
  assert.equal(calls[0].url, "/api/agent");
  assert.equal(calls[0].body.tools, true);
  const notes = actions.filter((action): action is Extract<Action, { type: "chat-note" }> => action.type === "chat-note");
  assert.ok(notes.some((note) => note.role === "user"));
  assert.ok(notes.some((note) => note.role === "trace" && note.text.includes("联网检索：「遥感 云检测")));
  assert.ok(notes.some((note) => note.role === "assistant" && note.text.length > 0));
  const sourceNote = notes.find((note) => note.role === "trace" && note.text.startsWith("本轮引用"));
  assert.ok(sourceNote && sourceNote.text.includes("https://example.com/cn1"));
  assert.ok(sourceNote && !sourceNote.text.includes("https://example.com/x"), "uncited sources are dropped");
  const knowledge = actions.find((action) => action.type === "add-knowledge");
  assert.ok(knowledge && knowledge.type === "add-knowledge" && knowledge.text.includes("尚未核验"));
});

test("ideas turn asks the agent without tools and falls back to local facts on failure", async () => {
  const calls: Array<{ tools?: boolean }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body || "{}")));
    return ndjsonResponse([{ type: "error", detail: "模型服务暂时不可用", status: 503 }]);
  }) as typeof fetch;
  const actions: Action[] = [];
  try {
    await runPatentTurn({
      caseId: "case-2",
      userText: "挖点",
      intent: "ideas",
      materials: [{ name: "交底.md", kind: "text", text: "本发明涉及一种遥感影像云检测方法，输入为多光谱影像，采用多尺度注意力网络提取特征，输出云掩膜，提高检测精度。" }],
      recordUser: false,
      dispatch: (action) => actions.push(action),
    });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls[0].tools, false);
  const last = actions.filter((action) => action.type === "chat-note").at(-1);
  assert.ok(last && last.type === "chat-note" && last.role === "assistant" && last.text.includes("模型服务暂时不可用"));
});

test("read-only replies cannot mutate case state or run a fallback search", async () => {
  const calls: Array<{ url: string; body: { tools?: boolean } }> = [];
  const original = globalThis.fetch;
  const actions: Action[] = [];
  const reply = '附件描述成膜添加剂。没有给出实验数据。';
  const metadata = { title: '不应重命名', facts: [{ statement: '不应加入的推测浓度参数', kind: 'parameter', origin: 'inference' }], patentPoints: [{ title: '不应新增的候选方案' }], searchQueries: ['不应发出的检索词'] };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) });
    return ndjsonResponse([{ type: 'done', text: reply + '\n```json\n' + JSON.stringify(metadata) + '\n```', sources: [], model: 'mock-model' }]);
  }) as typeof fetch;
  try {
    await runPatentTurn({ caseId: 'read-case', userText: '只阅读附件，用两句话概述，不要联网', intent: 'read', materials: [{ name: 'note.txt', kind: 'text', text: '附件描述一种成膜添加剂，未给出实验数据。' }], recordUser: true, dispatch: action => actions.push(action) });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/agent');
  assert.equal(calls[0].body.tools, false);
  assert.ok(actions.every(action => action.type === 'chat-note'), 'reading must not alter facts, ideas, titles or draft state');
  const last = actions.at(-1);
  assert.ok(last?.type === 'chat-note' && last.role === 'assistant');
  assert.equal(last.text, reply);
});

test("failed read-only requests do not extract fallback facts", async () => {
  const original = globalThis.fetch;
  const actions: Action[] = [];
  globalThis.fetch = (async () => ndjsonResponse([{ type: 'error', detail: '测试服务不可用', status: 503 }])) as typeof fetch;
  try {
    await runPatentTurn({ caseId: 'read-case', userText: '概述附件', intent: 'read', materials: [{ name: 'note.txt', kind: 'text', text: '采用水流冲击叶轮，经曲柄连杆带动刮板，对倾斜格栅进行清洁，输出干净水流，无需外接电源。'.repeat(3) }], recordUser: false, dispatch: action => actions.push(action) });
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(actions.every(action => action.type === 'chat-note'));
  const last = actions.at(-1);
  assert.ok(last?.type === 'chat-note' && last.role === 'assistant');
  assert.match(last.text, /未更改案件事实/);
  assert.doesNotMatch(last.text, /已改用本地规则整理事实/);
});

const CHAT_DESCRIPTION = "一种雨水井截污装置，包括井体、设在进水口下方的格栅，以及沿格栅表面往复运动的刮板；下泄水流冲击叶轮，叶轮经曲柄连杆带动刮板刮扫格栅，无需外接电源。";

test("conversationMaterial keeps only the inventor's own chat lines", () => {
  const history = [
    { role: "user", text: CHAT_DESCRIPTION },
    { role: "assistant", text: "候选点 1：模型推断的内容" },
    { role: "trace", text: "专利技能：对话挖点。" },
    { role: "user", text: "/发明稿" },
    { role: "user", text: CHAT_DESCRIPTION },
  ];
  const material = conversationMaterial(history);
  assert.ok(material);
  assert.equal(material.kind, "text");
  assert.equal(material.text, CHAT_DESCRIPTION, "duplicates collapse to one line");
  assert.doesNotMatch(material.text, /候选点|专利技能|\/发明稿/);
  assert.equal(conversationMaterial([{ role: "user", text: "/发明稿" }]), null);
  assert.equal(conversationMaterial(history, "附件全文：" + CHAT_DESCRIPTION), null, "text already in the attachments is not repeated");
});

test("/发明稿 drafts from a chat-only description instead of asking for more material", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).includes("/api/agent")) return ndjsonResponse([{ type: "error", detail: "测试桩：不调用真实模型", status: 503 }]);
    return new Response(JSON.stringify({ ok: false, detail: "测试桩：离线", results: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const history: ChatMessage[] = [
    { id: "m1", role: "user", text: CHAT_DESCRIPTION, at: "2026-10-23T00:00:00.000Z" },
    { id: "m2", role: "assistant", text: "候选点 1：水力驱动的刮扫机构。", at: "2026-10-23T00:01:00.000Z" },
  ];
  const actions: Action[] = [];
  try {
    await runPatentTurn({
      caseId: "case-chat",
      intent: "draft",
      userText: "请按发明专利撰写完整申请文件草稿",
      displayText: "/发明稿",
      recordUser: true,
      history,
      dispatch: (action) => actions.push(action),
    });
  } finally {
    globalThis.fetch = original;
  }
  const notes = actions.filter((action): action is Extract<Action, { type: "chat-note" }> => action.type === "chat-note");
  assert.ok(!notes.some((note) => note.role === "trace" && note.text.includes("材料还不够")), "a chat description is enough material to start drafting");
  assert.ok(notes.some((note) => note.role === "assistant" && note.text.includes("发明稿没有写成")), "the draft pipeline ran and reported the stubbed model failure");
});

test("draft topic never comes from the synthetic chat material name or a bracketed label line", () => {
  const material = conversationMaterial([
    { role: "user", text: "【测试案件·虚构材料，仅用于软件端到端验证】" },
    { role: "user", text: "一种带自清洁刮板的雨水井截污装置，截污框内设有可往复移动的刮板。" },
    { role: "user", text: "/发明稿" },
  ]);
  assert.ok(material);
  assert.equal(material.name, CONVERSATION_MATERIAL_NAME);
  const title = titleFromMaterials([material], material.text);
  assert.doesNotMatch(title, /对话交底|测试案件/);
  assert.match(title, /雨水井截污装置/);
  for (const query of draftQueries(title)) assert.doesNotMatch(query, /对话交底/);

  // A real attachment still names the topic, even when the chat material comes first.
  const withFile = titleFromMaterials([material, { name: "雨水井方案.pdf", kind: "text", text: "附件正文" }], material.text);
  assert.equal(withFile, "雨水井方案");

  // The “一种…装置及…方法” clause wins over a labelled first line and over a background “一种…” clause.
  const labelled = "技术领域：市政排水设施，具体是一种带自清洁刮板的雨水井截污装置及清污方法。现有技术中一种常见做法是人工清掏。";
  assert.equal(titleFromMaterials([], labelled), "一种带自清洁刮板的雨水井截污装置及清污方法");
  assert.equal(titleFromMaterials([], "现有技术中一种常见做法是人工清掏。\n发明名称：雨水井自清洁截污篮"), "现有技术中一种常见做法是人工清掏");
  assert.equal(titleFromMaterials([], "发明名称：雨水井自清洁截污篮"), "雨水井自清洁截污篮");
});
