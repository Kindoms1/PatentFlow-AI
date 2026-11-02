import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_UNDO,
  REVISE_QUICK_ACTIONS,
  REVISE_SYSTEM,
  applyRevisionPatches,
  buildRevisePrompt,
  buildRevisedDraft,
  claimIssues,
  claimSection,
  detectReviseRequest,
  parseReviseReply,
  runReviseTurn,
  normalizeSimulatedMarks,
  isMarkerRejection,
  markerRetryPrompt,
  isFormulaRejection,
  newFormulaErrorLines,
  formulaRetryPrompt,
  formulaRetryContext,
  escapeBareControls,
} from "./draft-revise.ts";
import { formalCheck, parseApplication } from "./cnipa-format.ts";
import type { ReviseAsk } from "./draft-revise.ts";
import { auditInvention } from "./invention-draft.ts";
import type { Action, DraftRevisionRecord, InventionDraftState } from "./model.ts";

const DRAFT = [
  "# 发明名称：一种作物长势监测方法",
  "",
  "## 权利要求书",
  "1. 一种作物长势监测方法，其特征在于，包括：获取多光谱影像；计算归一化植被指数；当所述归一化植被指数低于0.35时发出预警。",
  "2. 根据权利要求1所述的方法，其特征在于，所述多光谱影像由无人机采集。",
  "",
  "## 说明书",
  "### 技术领域",
  "本发明涉及农业遥感技术领域。",
  "### 具体实施方式",
  "实施例1：在玉米田中采集影像，预警阈值取0.35。",
].join("\n");

function stateOf(text: string, extra: Partial<InventionDraftState> = {}): InventionDraftState {
  return {
    text,
    score: 80,
    at: "2026-10-26T00:00:00.000Z",
    model: "test-model",
    revised: false,
    pendingMarks: 0,
    claimCount: 2,
    priorArt: [],
    checks: [],
    distinguishing: [],
    pending: [],
    ...extra,
  };
}

function recordOf(instruction: string): DraftRevisionRecord {
  return { at: "2026-10-26T01:00:00.000Z", instruction, summary: "", applied: [], skipped: [], notes: [], scoreBefore: 80, scoreAfter: 80, model: "test-model" };
}

function notes(actions: Action[], role: "assistant" | "trace"): string[] {
  return actions.flatMap((action) => (action.type === "chat-note" && action.role === role ? [action.text] : []));
}

function asking(text: string, ok = true): { ask: ReviseAsk; calls: Array<Array<{ role: string; content: string }>> } {
  const calls: Array<Array<{ role: string; content: string }>> = [];
  const ask: ReviseAsk = async (messages) => {
    calls.push(messages);
    return { ok, text, detail: ok ? "" : "HTTP 502", model: "revise-model", aborted: false };
  };
  return { ask, calls };
}

test("detectReviseRequest recognises edit requests on an existing draft", () => {
  for (const text of [
    "把权利要求1放宽一点",
    "改写说明书第3段",
    "补充一个实施例",
    "把公式中的参数定义补全",
    "减少背景技术中的绝对化表述",
    "能不能把权利要求1改宽一点？",
    "请把摘要压缩到200字以内",
  ]) {
    assert.equal(detectReviseRequest(text), true, text);
  }
  for (const text of ["", "你好", "权利要求1需要修改吗？", "为什么权利要求1这么写", "这个方案的改进效果怎么样", "/修改 权利要求1", "x".repeat(700) + "修改权利要求"]) {
    assert.equal(detectReviseRequest(text), false, text);
  }
});

test("parseReviseReply reads fenced json and falls back to the outer braces when a patch contains a fence", () => {
  const fenced = parseReviseReply('说明\n```json\n{"summary":"放宽阈值","patches":[{"find":"低于0.35","replace":"低于预设阈值","reason":"数值改为上位概念"}],"notes":["阈值范围"],"question":""}\n```');
  assert.equal(fenced.summary, "放宽阈值");
  assert.deepEqual(fenced.patches, [{ find: "低于0.35", replace: "低于预设阈值", reason: "数值改为上位概念", all: false }]);
  assert.deepEqual(fenced.notes, ["阈值范围"]);

  const nested = parseReviseReply('{"summary":"补图","patches":[{"find":"图1","replace":"图1\\n```附图\\n{}\\n```","reason":"补绘","all":true}]}');
  assert.equal(nested.patches.length, 1);
  assert.equal(nested.patches[0].all, true);
  assert.match(nested.patches[0].replace, /```附图/);

  assert.deepEqual(parseReviseReply("不是 json").patches, []);
  assert.equal(parseReviseReply('{"patches":[],"question":"阈值范围是多少？"}').question, "阈值范围是多少？");
  assert.equal(parseReviseReply('{"patches":[{"find":"同样","replace":"同样","reason":"无变化"}]}').patches.length, 0);
});

test("applyRevisionPatches applies unique matches, refuses ambiguous ones and protects statutory headings", () => {
  const unique = applyRevisionPatches(DRAFT, [{ find: "预警阈值取0.35", replace: "预警阈值取0.30", reason: "调整实施例" }]);
  assert.equal(unique.applied.length, 1);
  assert.match(unique.text, /预警阈值取0\.30/);

  const ambiguous = applyRevisionPatches(DRAFT, [{ find: "0.35", replace: "0.30", reason: "改阈值" }]);
  assert.equal(ambiguous.applied.length, 0);
  assert.match(ambiguous.skipped[0].why, /出现 2 次/);

  const all = applyRevisionPatches(DRAFT, [{ find: "0.35", replace: "0.30", reason: "统一阈值", all: true }]);
  assert.equal(all.applied[0].count, 2);
  assert.doesNotMatch(all.text, /0\.35/);

  const heading = applyRevisionPatches(DRAFT, [{ find: "## 说明书", replace: "## 说明", reason: "改标题" }]);
  assert.equal(heading.applied.length, 0);
  assert.match(heading.skipped[0].why, /一级标题/);

  const missing = applyRevisionPatches(DRAFT, [{ find: "不存在的句子", replace: "新句子", reason: "" }]);
  assert.match(missing.skipped[0].why, /找不到/);

  const loose = applyRevisionPatches(DRAFT, [{ find: "实施例1：在玉米田中  采集影像", replace: "实施例1：在小麦田中采集影像", reason: "空白差异" }]);
  assert.equal(loose.applied.length, 1);
  assert.match(loose.text, /小麦田/);
});

test("applyRevisionPatches allows new sub-headings and new claims; claimIssues checks numbering afterwards", () => {
  const embodiment = applyRevisionPatches(DRAFT, [
    { find: "实施例1：在玉米田中采集影像，预警阈值取0.35。", replace: "实施例1：在玉米田中采集影像，预警阈值取0.35。\n### 实施例2\n在小麦田中采集影像，预警阈值取【待发明人确认：阈值】。", reason: "补充实施例" },
  ]);
  assert.equal(embodiment.applied.length, 1);
  assert.match(embodiment.text, /### 实施例2/);

  const claim = "2. 根据权利要求1所述的方法，其特征在于，所述多光谱影像由无人机采集。";
  const added = applyRevisionPatches(DRAFT, [{ find: claim, replace: `${claim}\n3. 根据权利要求2所述的方法，其特征在于，所述无人机的飞行高度为【待发明人确认：高度】。`, reason: "新增从属权利要求" }]);
  assert.equal(added.applied.length, 1);
  assert.deepEqual(claimIssues(added.text), []);

  const gap = applyRevisionPatches(DRAFT, [{ find: claim, replace: `${claim}\n4. 根据权利要求2所述的方法。`, reason: "跳号" }]);
  assert.match(claimIssues(gap.text).join("；"), /编号不连续/);

  const forward = DRAFT.replace("根据权利要求1所述", "根据权利要求3所述");
  assert.match(claimIssues(forward).join("；"), /权利要求2引用了在后或自身的权利要求3/);
  assert.match(claimSection(DRAFT) ?? "", /^\n1\. 一种作物长势监测方法/);
  assert.equal(claimSection("# 无权利要求"), null);
});

test("buildRevisedDraft stacks undo snapshots without nesting and keeps the revision log", () => {
  const audit = auditInvention(DRAFT);
  const first = buildRevisedDraft(stateOf(DRAFT), { text: `${DRAFT}\n补充`, audit, model: "", at: "2026-10-26T01:00:00.000Z" }, recordOf("第一次"));
  assert.equal(first.undo?.length, 1);
  assert.equal(first.undo?.[0].text, DRAFT);
  assert.equal("undo" in (first.undo?.[0] ?? {}), false);
  assert.equal(first.model, "test-model");
  assert.equal(first.revisions?.length, 1);

  let current = first;
  for (let index = 2; index <= MAX_UNDO + 2; index += 1) {
    current = buildRevisedDraft(current, { text: `${DRAFT}\n第${index}次`, audit, model: "m", at: "2026-10-26T02:00:00.000Z" }, recordOf(`第${index}次`));
  }
  assert.equal(current.undo?.length, MAX_UNDO);
  assert.equal(current.revisions?.length, MAX_UNDO + 2);
  assert.equal(current.undo?.at(-1)?.revisions?.length, MAX_UNDO + 1);
});

test("buildRevisePrompt carries the instruction, earlier revisions, prior art and the full draft", () => {
  const prompt = buildRevisePrompt(
    stateOf(DRAFT, { priorArt: [{ pn: "CN114494821A", title: "一种遥感方法", url: "https://patents.google.com/patent/CN114494821A/zh" }], pending: ["阈值来源"], revisions: [recordOf("补全参数定义")] }),
    "把权利要求1放宽",
  );
  assert.match(prompt, /【发明人的修改要求】\n把权利要求1放宽/);
  assert.match(prompt, /补全参数定义/);
  assert.match(prompt, /CN114494821A/);
  assert.match(prompt, /阈值来源/);
  assert.match(prompt, /当所述归一化植被指数低于0\.35时发出预警/);
  assert.match(REVISE_SYSTEM, /"patches"/);
  assert.ok(REVISE_QUICK_ACTIONS.length >= 4);
});

test("runReviseTurn without a draft or instruction does not call the model", async () => {
  const actions: Action[] = [];
  const { ask, calls } = asking("{}");
  assert.equal(await runReviseTurn({ caseId: "c1", draft: null, instruction: "改权利要求1", dispatch: (action) => actions.push(action) }, { ask }), "no-draft");
  assert.equal(await runReviseTurn({ caseId: "c1", draft: stateOf(DRAFT), instruction: "  ", dispatch: (action) => actions.push(action) }, { ask }), "empty");
  assert.equal(calls.length, 0);
  assert.match(notes(actions, "assistant")[0], /还没有写好的申请文件/);
  assert.match(notes(actions, "assistant")[1], /补充一个实施例/);
});

test("runReviseTurn reports model failures, questions and unplaceable patches without touching the draft", async () => {
  const failedActions: Action[] = [];
  assert.equal(await runReviseTurn({ caseId: "c1", draft: stateOf(DRAFT), instruction: "放宽权利要求1", dispatch: (action) => failedActions.push(action) }, { ask: asking("", false).ask }), "failed");
  assert.match(notes(failedActions, "assistant").join("\n"), /HTTP 502/);

  const questionActions: Action[] = [];
  const question = asking('```json\n{"summary":"","patches":[],"notes":[],"question":"阈值放宽到什么范围？"}\n```');
  assert.equal(await runReviseTurn({ caseId: "c1", draft: stateOf(DRAFT), instruction: "放宽阈值", dispatch: (action) => questionActions.push(action) }, { ask: question.ask }), "question");
  assert.match(notes(questionActions, "assistant").join("\n"), /阈值放宽到什么范围/);
  assert.equal(question.calls[0][0].content, REVISE_SYSTEM);
  assert.match(question.calls[0][1].content, /放宽阈值/);

  const nothingActions: Action[] = [];
  const nothing = asking('{"summary":"x","patches":[{"find":"根本不存在","replace":"新","reason":"无法定位"}]}');
  assert.equal(await runReviseTurn({ caseId: "c1", draft: stateOf(DRAFT), instruction: "改一下摘要", dispatch: (action) => nothingActions.push(action) }, { ask: nothing.ask }), "nothing");
  assert.match(notes(nothingActions, "assistant").join("\n"), /无法定位：原文中找不到这段文字/);
  assert.equal(nothingActions.some((action) => action.type === "revise-invention-draft"), false);
});

test("runReviseTurn rejects a revision that breaks the claim numbering and keeps the original", async () => {
  const actions: Action[] = [];
  const claim = "2. 根据权利要求1所述的方法，其特征在于，所述多光谱影像由无人机采集。";
  const reply = JSON.stringify({ summary: "新增从属权利要求", patches: [{ find: claim, replace: `${claim}\n4. 根据权利要求2所述的方法。`, reason: "新增权利要求" }] });
  const outcome = await runReviseTurn({ caseId: "c1", draft: stateOf(DRAFT), instruction: "增加一条从属权利要求", dispatch: (action) => actions.push(action) }, { ask: asking(reply).ask });
  assert.equal(outcome, "rejected");
  assert.equal(actions.some((action) => action.type === "revise-invention-draft"), false);
  assert.match(notes(actions, "assistant").join("\n"), /没有采用：权利要求编号或引用关系出错/);
});

const EMBODIMENT = "实施例1：在玉米田中采集影像，预警阈值取0.35。";
const STD_MARK = "（模拟值，待实验验证）";

function askingSeq(texts: string[]): { ask: ReviseAsk; calls: Array<Array<{ role: string; content: string }>> } {
  const calls: Array<Array<{ role: string; content: string }>> = [];
  let index = 0;
  const ask: ReviseAsk = async (messages) => {
    calls.push(messages);
    const text = texts[Math.min(index, texts.length - 1)];
    index += 1;
    return { ok: true, text, detail: "", model: "revise-model", aborted: false };
  };
  return { ask, calls };
}

function addEmbodiment(sentence: string): string {
  return JSON.stringify({ summary: "新增实施例2", patches: [{ find: EMBODIMENT, replace: `${EMBODIMENT}\n${sentence}`, reason: "新增实施例2" }] });
}

test("normalizeSimulatedMarks unifies bracketed simulated-value variants and leaves fences and plain numbers alone", () => {
  assert.deepEqual(normalizeSimulatedMarks(`阈值取0.30${STD_MARK}`), { text: `阈值取0.30${STD_MARK}`, count: 0 });
  for (const variant of ["（模拟值）", "(模拟值)", "（模拟数值）", "（模拟值，需实验验证）", "（模拟值、有待验证）", "（待实验验证）"]) {
    assert.deepEqual(normalizeSimulatedMarks(`阈值取0.30${variant}。`), { text: `阈值取0.30${STD_MARK}。`, count: 1 }, variant);
  }
  const fenced = ["\`\`\`json", '{"label": "温度（模拟值）"}', "\`\`\`", "门限设为32（模拟值）"].join("\n");
  const out = normalizeSimulatedMarks(fenced);
  assert.equal(out.count, 1);
  assert.match(out.text, /温度（模拟值）/);
  assert.match(out.text, /门限设为32（模拟值，待实验验证）/);
  assert.deepEqual(normalizeSimulatedMarks("设为32，共15层，共32个通道。"), { text: "设为32，共15层，共32个通道。", count: 0 });
});

test("marker retry helpers recognise the export block and name the offending marks", () => {
  assert.equal(isMarkerRejection("会使导出前形式核查不通过（正式文件中仍有内部占位或审核标记（模拟值），已拦截导出）"), true);
  assert.equal(isMarkerRejection("权利要求编号或引用关系出错：缺少权利要求3"), false);
  const prompt = markerRetryPrompt(["模拟值", "待实验验证"]);
  assert.match(prompt, /“模拟值”、“待实验验证”/);
  assert.match(prompt, /json/);
});

test("the fixture draft is exportable before revision (precondition for the marker tests)", () => {
  assert.equal(formalCheck(parseApplication(DRAFT)).exportable, true);
});

test("runReviseTurn normalises a non-standard simulated-value mark instead of rejecting the revision", async () => {
  const actions: Action[] = [];
  const { ask, calls } = askingSeq([addEmbodiment("实施例2：在小麦田中采集影像，预警阈值取0.30（模拟值）。")]);
  await runReviseTurn({ caseId: "c1", draft: stateOf(DRAFT), instruction: "补充一个小麦田实施例", dispatch: (action) => actions.push(action) }, { ask });
  assert.equal(calls.length, 1);
  const revised = actions.find((action) => action.type === "revise-invention-draft");
  assert.ok(revised, notes(actions, "assistant").join("\n"));
  assert.ok(revised.type === "revise-invention-draft" && revised.draft.text.includes(`预警阈值取0.30${STD_MARK}。`));
  assert.match(notes(actions, "trace").join("\n"), /非标准的模拟值标注/);
});

test("runReviseTurn feeds blocked internal marks back to the model once and adopts a clean retry", async () => {
  const actions: Action[] = [];
  const { ask, calls } = askingSeq([
    addEmbodiment("实施例2：在小麦田中采集影像，预警阈值仍待检索。"),
    addEmbodiment("实施例2：在小麦田中采集影像，预警阈值在历史长势数据的基础上确定。"),
  ]);
  await runReviseTurn({ caseId: "c1", draft: stateOf(DRAFT), instruction: "补充一个小麦田实施例", dispatch: (action) => actions.push(action) }, { ask });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].length, 4);
  assert.equal(calls[1][2].role, "assistant");
  assert.match(calls[1][3].content, /“待检索”/);
  const revised = actions.find((action) => action.type === "revise-invention-draft");
  assert.ok(revised, notes(actions, "assistant").join("\n"));
  assert.ok(revised.type === "revise-invention-draft" && revised.draft.text.includes("历史长势数据") && !revised.draft.text.includes("模拟值"));
  assert.match(notes(actions, "trace").join("\n"), /自动重试一次[\s\S]*复核通过/);
});

test("runReviseTurn keeps the original when the retry still carries internal marks", async () => {
  const actions: Action[] = [];
  const { ask, calls } = askingSeq([addEmbodiment("实施例2：预警阈值仍待检索。")]);
  const outcome = await runReviseTurn({ caseId: "c1", draft: stateOf(DRAFT), instruction: "补充一个实施例", dispatch: (action) => actions.push(action) }, { ask });
  assert.equal(outcome, "rejected");
  assert.equal(calls.length, 2);
  assert.equal(actions.some((action) => action.type === "revise-invention-draft"), false);
  assert.match(notes(actions, "trace").join("\n"), /重试后复核仍没有通过/);
  assert.match(notes(actions, "assistant").join("\n"), /没有采用：会使导出前形式核查不通过/);
});

const FENCE = "\u0060\u0060\u0060";
function fenced(data: unknown): string {
  return FENCE + "json\n" + JSON.stringify(data) + "\n" + FENCE;
}

test("parseReviseReply tolerates bare newlines inside json strings", () => {
  const reply = FENCE + "json\n{\"summary\":\"补充实施例\",\"patches\":[{\"find\":\"预警阈值取0.35。\",\"replace\":\"预警阈值取0.35。\n实施例2：在小麦田中采集影像。\",\"reason\":\"r\"}],\"notes\":[],\"question\":\"\"}\n" + FENCE;
  const parsed = parseReviseReply(reply);
  assert.equal(parsed.patches.length, 1);
  assert.equal(parsed.patches[0].replace, "预警阈值取0.35。\n实施例2：在小麦田中采集影像。");
  assert.equal(escapeBareControls("{\"a\":\"x\ny\\\"z\"}\n"), "{\"a\":\"x\\ny\\\"z\"}\n");
});

test("runReviseTurn retries once when the reply has no parsable patches and adopts the retry", async () => {
  const actions: Action[] = [];
  const { ask, calls } = askingSeq([
    "好的，我会在实施例1之后补充小麦田的实施例。",
    addEmbodiment("实施例2：在小麦田中采集影像，预警阈值在历史长势数据的基础上确定。"),
  ]);
  await runReviseTurn({ caseId: "c1", draft: stateOf(DRAFT), instruction: "补充一个小麦田实施例", dispatch: (action) => actions.push(action) }, { ask });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].length, 4);
  assert.equal(calls[1][2].role, "assistant");
  assert.match(calls[1][3].content, /可以解析的 json/);
  const revised = actions.find((action) => action.type === "revise-invention-draft");
  assert.ok(revised, notes(actions, "assistant").join("\n"));
  assert.ok(revised.type === "revise-invention-draft" && revised.draft.text.includes("历史长势数据"));
});

test("runReviseTurn keeps the original when the format retry is still unparsable", async () => {
  const actions: Action[] = [];
  const { ask, calls } = askingSeq(["好的，我会补充。"]);
  const outcome = await runReviseTurn({ caseId: "c1", draft: stateOf(DRAFT), instruction: "补充一个小麦田实施例", dispatch: (action) => actions.push(action) }, { ask });
  assert.equal(outcome, "nothing");
  assert.equal(calls.length, 2);
  assert.equal(actions.some((action) => action.type === "revise-invention-draft"), false);
  assert.match(notes(actions, "trace").join("\n"), /重试仍没有给出可以解析的补丁/);
});

test("runReviseTurn feeds unlocatable anchors back once and adopts a locatable retry", async () => {
  const actions: Action[] = [];
  const bad = fenced({ summary: "补充实施例", patches: [{ find: "实施例1：在水稻田中采集影像。", replace: "实施例1：在水稻田中采集影像。\n实施例2：在小麦田中采集影像。", reason: "补充实施例" }], notes: [], question: "" });
  const { ask, calls } = askingSeq([bad, addEmbodiment("实施例2：在小麦田中采集影像，预警阈值在历史长势数据的基础上确定。")]);
  await runReviseTurn({ caseId: "c1", draft: stateOf(DRAFT), instruction: "补充一个小麦田实施例", dispatch: (action) => actions.push(action) }, { ask });
  assert.equal(calls.length, 2);
  assert.match(calls[1][3].content, /水稻田/);
  assert.match(calls[1][3].content, /原文中找不到这段文字/);
  const revised = actions.find((action) => action.type === "revise-invention-draft");
  assert.ok(revised, notes(actions, "assistant").join("\n"));
  assert.ok(revised.type === "revise-invention-draft" && revised.draft.text.includes("历史长势数据"));
});

test("runReviseTurn does not retry when the model explains why nothing changes", async () => {
  const actions: Action[] = [];
  const { ask, calls } = askingSeq([fenced({ summary: "原稿已包含该内容，无需修改", patches: [], notes: [], question: "" })]);
  const outcome = await runReviseTurn({ caseId: "c1", draft: stateOf(DRAFT), instruction: "补充预警阈值的说明", dispatch: (action) => actions.push(action) }, { ask });
  assert.equal(outcome, "nothing");
  assert.equal(calls.length, 1);
  assert.match(notes(actions, "assistant").join("\n"), /原稿已包含该内容/);
});

// --- Figure-mark repair on the revision review path ---
// Fixture copied from figure-ref-repair.test.ts (a test file cannot import another without re-running its tests).
const FIG_LIST = "1-截污格栅；2-叶轮；3-刮板；4-集污斗。";

type FigShape = Record<string, unknown>;

const FIG_SHAPES: FigShape[] = [
  { kind: "rect", x: 20, y: 20, w: 80, h: 20, ref: "1" },
  { kind: "circle", cx: 60, cy: 80, r: 15, ref: "2" },
  { kind: "rect", x: 110, y: 20, w: 60, h: 10, ref: "3" },
  { kind: "rect", x: 180, y: 70, w: 40, h: 40, ref: "4" },
];

/** 结构完整、带一幅结构示意图的申请文件草稿；只有附图、附图标记列表和实施例补充句随用例变化。 */
function figDraft(options: { shapes?: FigShape[]; list?: string; extra?: string; claimExtra?: string } = {}): string {
  const { shapes = FIG_SHAPES, list = FIG_LIST, extra = "", claimExtra = "" } = options;
  const claims = Array.from({ length: 9 }, (_, index) =>
    index === 0
      ? "1. 一种雨水井截污装置，其特征在于，包括截污格栅(1)、叶轮(2)和刮板(3)，所述叶轮(2)由下泄水流驱动并带动所述刮板(3)沿所述截污格栅(1)表面往复运动。"
      : index === 8 && claimExtra
        ? `${index + 1}. 根据权利要求${index}所述的雨水井截污装置，其特征在于，${claimExtra}`
        : `${index + 1}. 根据权利要求${index}所述的雨水井截污装置，其特征在于，所述刮板(3)通过曲柄连杆与所述叶轮(2)连接。`,
  ).join("\n");
  const embodiment = "截污格栅(1)倾斜设置在井口下方，叶轮(2)位于下泄水流路径上，叶轮(2)通过曲柄连杆带动刮板(3)沿截污格栅(1)表面往复刮扫，刮下的杂物被推入集污斗(4)。".repeat(30);
  return [
    "# 发明名称：一种雨水井截污装置",
    "",
    "## 说明书摘要",
    "本发明公开了一种雨水井截污装置，利用下泄水流驱动刮板清理截污格栅，防止格栅堵塞。",
    "摘要附图：图1",
    "",
    "## 权利要求书",
    claims,
    "",
    "## 技术领域",
    "本发明涉及市政排水领域，具体涉及一种雨水井截污装置。",
    "",
    "## 背景技术",
    "现有雨水井截污装置采用固定滤网，容易被落叶和塑料袋堵塞。",
    "",
    "## 发明内容",
    "### 要解决的技术问题",
    "截污格栅容易堵塞。",
    "### 技术方案",
    "设置由水流驱动的刮板。",
    "### 有益效果",
    "格栅不易堵塞，无需供电。",
    "",
    "## 附图说明",
    "图1为本发明实施例提供的雨水井截污装置的结构示意图。",
    "",
    "```附图",
    JSON.stringify({ no: 1, kind: "structure", shapes }),
    "```",
    "",
    "## 具体实施方式",
    "### 实施例1",
    embodiment + extra,
    "### 附图标记",
    list,
    "",
    "```json",
    '{"distinguishing":[{"feature":"水流驱动刮板","problem":"格栅堵塞","effect":"自清洁"}],"pending":[],"closestArt":""}',
    "```",
  ].join("\n");
}

const FIG_ANCHOR = "\u96e8\u6c34\u7531\u4e95\u53e3\u8fdb\u5165\u622a\u6c61\u683c\u6805\u3002";
const FIG_BASE = figDraft({ extra: FIG_ANCHOR });

function figPatches(list: string, sentence: string): string {
  return JSON.stringify({
    summary: "add embodiment",
    patches: [
      { find: FIG_ANCHOR, replace: FIG_ANCHOR + sentence, reason: "add embodiment" },
      { find: FIG_LIST, replace: list, reason: "add parts" },
    ],
  });
}

async function reviseFig(reply: string): Promise<{ actions: Action[]; calls: number }> {
  const actions: Action[] = [];
  const { ask, calls } = askingSeq([reply]);
  await runReviseTurn(
    { caseId: "c1", draft: stateOf(FIG_BASE, { claimCount: 9 }), instruction: "\u8865\u5145\u63a7\u5236\u7bb1\u5b9e\u65bd\u4f8b", dispatch: (action) => actions.push(action) },
    { ask },
  );
  return { actions, calls: calls.length };
}

function revisedText(actions: Action[]): string {
  const revised = actions.find((action) => action.type === "revise-invention-draft");
  assert.ok(revised, notes(actions, "assistant").join("\n"));
  assert.ok(revised.type === "revise-invention-draft");
  return revised.draft.text;
}

test("the figure fixture is exportable before revision (precondition for the figure-mark tests)", () => {
  const report = formalCheck(parseApplication(FIG_BASE));
  assert.equal(report.exportable, true, report.fatal);
});

test("runReviseTurn unreferences an undrawn bracketed mark a new embodiment adds and adopts the revision", async () => {
  const list = FIG_LIST.replace(/\u3002$/, "\uff1b70-\u63a7\u5236\u7bb1\u3002");
  const sentence = "\u63a7\u5236\u7bb1(70)\u5b89\u88c5\u5728\u4e95\u58c1\u4e0a\uff0c\u8bbe\u8ba1\u6d41\u91cf\u4e3a60-70 L/s\u3002";
  const { actions, calls } = await reviseFig(figPatches(list, sentence));
  assert.equal(calls, 1);
  const text = revisedText(actions);
  assert.ok(text.includes("\u63a7\u5236\u7bb1\u5b89\u88c5\u5728\u4e95\u58c1\u4e0a\uff0c\u8bbe\u8ba1\u6d41\u91cf\u4e3a60-70 L/s\u3002"), "the part name and the value 60-70 stay");
  assert.doesNotMatch(text, /\u63a7\u5236\u7bb1\s*[(\uff08]?\s*70/);
  assert.ok(text.includes(FIG_LIST) && !text.includes("70-\u63a7\u5236\u7bb1"), "the undrawn entry leaves the list");
  const after = formalCheck(parseApplication(text));
  assert.equal(after.exportable, true, after.fatal);
  assert.match([...notes(actions, "trace"), ...notes(actions, "assistant")].join("\n"), /\u9644\u56fe\u6807\u8bb0\u786e\u5b9a\u6027\u4fee\u590d/);
});

test("runReviseTurn unreferences several undrawn bare marks on one semicolon list line and keeps plain numbers", async () => {
  const list = FIG_LIST.replace(/\u3002$/, "\uff1b70-\u63a7\u5236\u7bb1\uff1b71-\u84c4\u7535\u6c60\u3002");
  const sentence = "\u63a7\u5236\u7bb170\u5b89\u88c5\u5728\u4e95\u58c1\u4e0a\uff0c\u63a7\u5236\u7bb170\u5185\u8bbe\u6709\u84c4\u7535\u6c6071\uff0c\u8bbe\u8ba1\u6d41\u91cf\u4e3a60-70 L/s\uff0c\u5360\u6bd470%\u3002";
  const { actions, calls } = await reviseFig(figPatches(list, sentence));
  assert.equal(calls, 1);
  const text = revisedText(actions);
  assert.ok(text.includes("\u63a7\u5236\u7bb1\u5b89\u88c5\u5728\u4e95\u58c1\u4e0a\uff0c\u63a7\u5236\u7bb1\u5185\u8bbe\u6709\u84c4\u7535\u6c60\uff0c\u8bbe\u8ba1\u6d41\u91cf\u4e3a60-70 L/s\uff0c\u5360\u6bd470%\u3002"), "names, 60-70 and 70% stay");
  assert.ok(text.includes(FIG_LIST) && !/7[01]-/.test(text.split("\n").find((line) => line.startsWith("1-")) ?? ""), "both undrawn entries leave the list");
  const after = formalCheck(parseApplication(text));
  assert.equal(after.exportable, true, after.fatal);
});

const FORMULA_ANCHOR = "实施例1：在玉米田中采集影像，预警阈值取0.35。";
const FORMULA_DRAFT = [
  "# 发明名称：一种作物长势监测方法",
  "",
  "## 权利要求书",
  "1. 一种作物长势监测方法，其特征在于，包括：获取多光谱影像；计算归一化植被指数；当所述归一化植被指数低于0.35时发出预警。",
  "2. 根据权利要求1所述的方法，其特征在于，所述多光谱影像由无人机采集。",
  "",
  "## 技术领域",
  "本发明涉及农业遥感技术领域。",
  "",
  "## 具体实施方式",
  FORMULA_ANCHOR,
].join("\n");
const BAD_TEX = "V = \\frac{a - b}{a + b";
const GOOD_TEX = "V = \\frac{a - b}{a + b}";
function formulaEmbodiment(tex: string): string {
  return FORMULA_ANCHOR + "\n实施例2：归一化植被指数按 $" + tex + "$ 计算，式中，V为归一化植被指数，a为近红外波段反射率，b为红光波段反射率。";
}
function addFormula(tex: string): string {
  return JSON.stringify({ summary: "新增实施例2", patches: [{ find: FORMULA_ANCHOR, replace: formulaEmbodiment(tex), reason: "新增实施例2" }] });
}

test("formula retry helpers name only the formula errors the revision introduced", () => {
  assert.equal(isFormulaRejection("会使公式形式错误从 0 处增加到 2 处"), true);
  assert.equal(isFormulaRejection("权利要求编号或引用关系出错：缺少权利要求3"), false);
  const bad = FORMULA_DRAFT.replace(FORMULA_ANCHOR, formulaEmbodiment(BAD_TEX));
  const good = FORMULA_DRAFT.replace(FORMULA_ANCHOR, formulaEmbodiment(GOOD_TEX));
  const lines = newFormulaErrorLines(FORMULA_DRAFT, bad);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /【公式语法】[\s\S]*花括号/);
  assert.deepEqual(newFormulaErrorLines(FORMULA_DRAFT, good), []);
  // errors already in the original are not reported as new: only the newly broken W formula is named
  const both = bad.replace("实施例2：", "实施例3：反射率比按 $W = \\frac{c}{d$ 计算，式中，W为反射率比，c为绿光波段反射率，d为蓝光波段反射率。\n实施例2：");
  const onlyNew = newFormulaErrorLines(bad, both);
  assert.equal(onlyNew.length, 1, onlyNew.join("\n"));
  assert.match(onlyNew[0], /W=/);
  assert.doesNotMatch(onlyNew[0], /V=/);
  // documented fallback: with no new error, the remaining errors are listed so the model still gets concrete feedback
  const fallback = newFormulaErrorLines(bad, bad.replace("玉米田", "大豆田"));
  assert.equal(fallback.length, 1);
  assert.match(fallback[0], /V=/);
  const prompt = formulaRetryPrompt(lines);
  assert.ok(prompt.split("\n").length >= 7);
  assert.ok(prompt.includes("· " + lines[0]));
  assert.ok(prompt.includes("\\sum_{k=1}^{K}"));
  assert.match(prompt, /JSON/);
  assert.match(formulaRetryPrompt([]), /公式形式错误数量增加/);
});

test("runReviseTurn feeds new formula errors back to the model once and adopts a clean retry", async () => {
  const actions: Action[] = [];
  const { ask, calls } = askingSeq([addFormula(BAD_TEX), addFormula(GOOD_TEX)]);
  await runReviseTurn({ caseId: "c1", draft: stateOf(FORMULA_DRAFT), instruction: "补充一个带公式的实施例", dispatch: (action) => actions.push(action) }, { ask });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].length, 4);
  assert.equal(calls[1][2].role, "assistant");
  assert.match(calls[1][3].content, /公式形式检查新增[\s\S]*花括号/);
  const revised = actions.find((action) => action.type === "revise-invention-draft");
  assert.ok(revised, notes(actions, "assistant").join("\n"));
  assert.ok(revised.type === "revise-invention-draft" && revised.draft.text.includes("$" + GOOD_TEX + "$"));
  assert.ok(revised.type === "revise-invention-draft" && !revised.draft.text.includes("$" + BAD_TEX + "$"));
  assert.match(notes(actions, "trace").join("\n"), /公式形式检查新增错误[\s\S]*自动重试一次[\s\S]*复核通过/);
});

test("runReviseTurn keeps the original and lists the formula problems when the retry still breaks a formula", async () => {
  const actions: Action[] = [];
  const { ask, calls } = askingSeq([addFormula(BAD_TEX)]);
  const outcome = await runReviseTurn({ caseId: "c1", draft: stateOf(FORMULA_DRAFT), instruction: "补充一个带公式的实施例", dispatch: (action) => actions.push(action) }, { ask });
  assert.equal(outcome, "rejected");
  assert.equal(calls.length, 2);
  assert.equal(actions.some((action) => action.type === "revise-invention-draft"), false);
  assert.match(notes(actions, "trace").join("\n"), /重试后复核仍没有通过：会使公式形式错误/);
  const said = notes(actions, "assistant").join("\n");
  assert.match(said, /没有采用：会使公式形式错误从 0 处增加到 1 处/);
  assert.match(said, /新增的公式问题：\n· 【公式语法】[\s\S]*花括号/);
});

test("runReviseTurn does not retry when the first revision passes the formula check", async () => {
  const actions: Action[] = [];
  const { ask, calls } = askingSeq([addFormula(GOOD_TEX)]);
  await runReviseTurn({ caseId: "c1", draft: stateOf(FORMULA_DRAFT), instruction: "补充一个带公式的实施例", dispatch: (action) => actions.push(action) }, { ask });
  assert.equal(calls.length, 1);
  assert.ok(actions.some((action) => action.type === "revise-invention-draft"), notes(actions, "assistant").join("\n"));
});

test("formula retry context names the original meaning of a conflicting symbol and the existing formula numbers", () => {
  const draft = FORMULA_DRAFT.replace(FORMULA_ANCHOR, formulaEmbodiment(GOOD_TEX));
  const conflict = "【一个符号只有一个含义】符号 V 有 2 种含义：“归一化植被指数”（具体实施方式）、“番茄为喜温作物”（具体实施方式）；一个符号只能表示一个量";
  const context = formulaRetryContext(draft, [conflict]);
  assert.deepEqual(context.symbols, [{ key: "V", meaning: "归一化植被指数" }]);
  assert.deepEqual(context.labels, []);
  const prompt = formulaRetryPrompt([conflict], context);
  assert.match(prompt, /· V：归一化植被指数/);
  assert.match(prompt, /没有带编号的公式/);
  assert.match(prompt, /中文名称\+符号/);
  assert.match(formulaRetryPrompt([conflict], { symbols: [], labels: ["1", "2"] }), /（1）（2）；正文只能引用这些式号/);
  const numbered = [
    "# 发明名称：一种作物长势监测方法",
    "",
    "## 权利要求书",
    "1. 一种作物长势监测方法，其特征在于，按下式计算长势指数：",
    "$$Q = m + n$$（9）",
    "",
    "## 具体实施方式",
    "归一化植被指数按下式计算：",
    "$$V = \\frac{a - b}{a + b}$$（1）",
    "式中，V为归一化植被指数。",
    "$$W = \\frac{c}{d} \\tag{2}$$",
    "式中，W为比值。",
  ].join("\n");
  // description labels are listed; the claim's (9) is not
  assert.deepEqual(formulaRetryContext(numbered, []).labels, ["1", "2"]);
  // no conflict line: no symbol context, nothing invented
  assert.deepEqual(formulaRetryContext(draft, ["【公式语法】花括号不配对"]).symbols, []);
  assert.match(REVISE_SYSTEM, /中文名称\+符号/);
  assert.match(REVISE_SYSTEM, /不得写出原文没有的式号/);
});

test("a formula retry that still breaks formulas keeps the original and traces the remaining formula issues", async () => {
  const actions: Action[] = [];
  const { ask, calls } = askingSeq([addFormula(BAD_TEX), addFormula(BAD_TEX)]);
  await runReviseTurn({ caseId: "c1", draft: stateOf(FORMULA_DRAFT), instruction: "补充一个带公式的实施例", dispatch: (action) => actions.push(action) }, { ask });
  assert.equal(calls.length, 2);
  assert.match(calls[1][3].content, /没有带编号的公式/);
  assert.ok(!actions.some((action) => action.type === "revise-invention-draft"), "draft must stay unchanged");
  assert.match(notes(actions, "trace").join("\n"), /重试后复核仍没有通过[\s\S]*重试后仍有的公式问题：【公式语法】/);
});
