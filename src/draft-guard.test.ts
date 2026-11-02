import test from "node:test";
import assert from "node:assert/strict";
import { auditInvention, draftShape, legalHeading, normalizeDraftHeadings, safePreview, splitSections } from "./invention-draft.ts";
import { draftBody, parseDraftTail, runDraftTurn } from "./draft-run.ts";
import type { DraftDeps } from "./draft-run.ts";
import type { Action } from "./model.ts";

const MATERIAL = "一种带自清洁刮板的雨水井截污装置：井口下方设倾斜弧形截污格栅，下泄水流冲动叶轮，叶轮通过曲柄连杆带动刮板沿格栅表面往复刮扫，杂物被推入集污斗。";
const HEADINGS = ["说明书摘要", "权利要求书", "技术领域", "背景技术", "发明内容", "附图说明", "具体实施方式"];

function fullDraft(heading: (name: string) => string = (name) => `## ${name}`): string {
  const claims = Array.from({ length: 9 }, (_, index) =>
    index === 0
      ? "1. 一种雨水井截污装置，其特征在于，包括截污格栅(1)、叶轮(2)和刮板(3)，所述叶轮(2)由下泄水流驱动并带动所述刮板(3)沿所述截污格栅(1)表面往复运动。"
      : `${index + 1}. 根据权利要求${index}所述的雨水井截污装置，其特征在于，所述刮板(3)通过曲柄连杆与所述叶轮(2)连接。`,
  ).join("\n");
  const embodiment = "截污格栅(1)倾斜设置在井口下方，叶轮(2)位于下泄水流路径上，叶轮(2)通过曲柄连杆带动刮板(3)沿截污格栅(1)表面往复刮扫，刮下的杂物被推入集污斗(4)。".repeat(30);
  return [
    "# 发明名称：一种雨水井截污装置",
    "",
    heading("说明书摘要"),
    "本发明公开了一种雨水井截污装置，利用下泄水流驱动刮板清理截污格栅，防止格栅堵塞。",
    "摘要附图：图1",
    "",
    heading("权利要求书"),
    claims,
    "",
    heading("技术领域"),
    "本发明涉及市政排水领域，具体涉及一种雨水井截污装置。",
    "",
    heading("背景技术"),
    "现有雨水井截污装置采用固定滤网，容易被落叶和塑料袋堵塞。",
    "",
    heading("发明内容"),
    "### 要解决的技术问题",
    "截污格栅容易堵塞。",
    "### 技术方案",
    "设置由水流驱动的刮板。",
    "### 有益效果",
    "格栅不易堵塞，无需供电。",
    "",
    heading("附图说明"),
    "图1为本发明实施例提供的雨水井截污装置的结构示意图。",
    "",
    heading("具体实施方式"),
    "### 实施例1",
    embodiment,
    "### 附图标记",
    "1-截污格栅；2-叶轮；3-刮板；4-集污斗。",
    "",
    "```json",
    '{"distinguishing":[{"feature":"水流驱动刮板","problem":"格栅堵塞","effect":"自清洁"}],"pending":["叶轮直径"],"closestArt":""}',
    "```",
  ].join("\n");
}

type Seen = Array<Array<{ role: string; content: string }>>;

function stubDeps(replies: string[], seen: Seen): DraftDeps {
  return {
    ask: async (messages) => {
      seen.push(messages);
      const text = replies[Math.min(seen.length - 1, replies.length - 1)];
      return { ok: true, text, detail: "", model: "stub-model", aborted: false };
    },
    search: async () => ({
      ok: true,
      detail: "",
      results: [{ title: "CN104074262B - 一种雨水检查井智能截污装置 - Google Patents", url: "https://patents.google.com/patent/CN104074262B/zh", snippet: "" }],
    }),
  };
}

function notes(actions: Action[], role: "trace" | "assistant"): string[] {
  return actions.flatMap((action) => (action.type === "chat-note" && action.role === role ? [action.text] : []));
}

const INPUT = { caseId: "c1", materials: [{ name: "交底.md", kind: "text" as const, text: MATERIAL }], userText: "" };

test("legalHeading recognises decorated statutory headings and leaves everything else alone", () => {
  assert.equal(legalHeading("# 权利要求书"), "权利要求书");
  assert.equal(legalHeading("**技术领域**"), "技术领域");
  assert.equal(legalHeading("**技术领域**："), "技术领域");
  assert.equal(legalHeading("【背景技术】"), "背景技术");
  assert.equal(legalHeading("一、发明内容："), "发明内容");
  assert.equal(legalHeading("### 摘要"), "说明书摘要");
  assert.equal(legalHeading("## 具体实施方式"), "具体实施方式");
  assert.equal(legalHeading("### 要解决的技术问题"), null);
  assert.equal(legalHeading("# 发明名称：一种雨水井截污装置"), null);
  assert.equal(legalHeading("本发明的权利要求书以说明书为依据。"), null);
  assert.equal(legalHeading("2. 根据权利要求1所述的装置。"), null);
  assert.equal(legalHeading("摘要"), null, "an undecorated alias is body text, not a heading");
});

test("normalizeDraftHeadings rewrites headings, unwraps a whole-document fence and keeps the json tail", () => {
  const raw = ["```markdown", fullDraft((name) => `**${name}**`), "```"].join("\n");
  const normalized = normalizeDraftHeadings(raw);
  assert.doesNotMatch(normalized, /^```markdown/m);
  for (const name of HEADINGS) assert.match(normalized, new RegExp(`^## ${name}$`, "m"));
  assert.match(normalized, /^### 要解决的技术问题$/m);
  assert.equal(parseDraftTail(normalized).distinguishing[0].feature, "水流驱动刮板");
  assert.doesNotMatch(draftBody(normalized), /```/);
});

test("normalizeDraftHeadings drops a chat lead-in before a whole-document fence, closed or not", () => {
  const lead = "完整申请文件草稿已写好。权利要求1以水流驱动叶轮为核心，共若干条，未知参数均标为待确认。";
  for (const closing of ["```", ""]) {
    const raw = [lead, "", "```markdown", fullDraft(), closing].join("\n");
    const normalized = normalizeDraftHeadings(raw);
    assert.doesNotMatch(normalized, /```markdown/, `closing=${JSON.stringify(closing)}`);
    assert.doesNotMatch(normalized, /草稿已写好/, "the lead-in is chat, not part of the draft");
    for (const name of HEADINGS) assert.match(normalized, new RegExp(`^## ${name}$`, "m"));
    assert.equal(parseDraftTail(normalized).distinguishing[0].feature, "水流驱动刮板");
    assert.doesNotMatch(draftBody(normalized), /```/);
  }
});

test("normalizeDraftHeadings keeps a fenced example that is not a whole-document wrapper", () => {
  const raw = ["先说明一下格式：", "", "```markdown", "这只是一段示例文字。", "```", "", fullDraft()].join("\n");
  const normalized = normalizeDraftHeadings(raw);
  assert.match(normalized, /^```markdown$/m);
  assert.match(normalized, /先说明一下格式/);
});

test("the audit sees the sections of a draft whose headings are bold instead of '## '", () => {
  const bold = fullDraft((name) => `**${name}**`);
  assert.equal(splitSections(bold).size, 0, "the raw splitter alone finds nothing");
  const audit = auditInvention(draftBody(bold), { domain: "civil-municipal" });
  assert.equal(audit.checks.find((item) => item.id === "sections")?.ok, true);
  assert.ok(audit.score > 0);
});

test("draftShape flags short or unstructured replies and accepts a full draft", () => {
  const short = draftShape("好的，我先确认几个问题：叶轮直径是多少？");
  assert.equal(short.complete, false);
  assert.match(short.reason, /正文只有/);
  assert.match(short.reason, /0\/7/);
  const full = draftShape(draftBody(fullDraft()));
  assert.equal(full.complete, true, full.reason);
  assert.deepEqual(full.found, HEADINGS);
  assert.equal(full.claims, 9);
});

test("safePreview is one short line and masks key-like strings", () => {
  const preview = safePreview("前言\n\n sk-abcdefgh" + "ijklmnop1234 之后还有很多内容。".repeat(5), 40);
  assert.doesNotMatch(preview, /sk-abcdefgh/);
  assert.doesNotMatch(preview, /\n/);
  assert.ok(preview.length <= 41);
  assert.equal(safePreview("   "), "（空）");
});

test("runDraftTurn regenerates once when the first reply is not a full application", async () => {
  const actions: Action[] = [];
  const seen: Seen = [];
  await runDraftTurn({ ...INPUT, dispatch: (action) => actions.push(action) }, stubDeps(["我先确认几个问题：叶轮直径是多少？", fullDraft()], seen));
  assert.ok(seen.length >= 2);
  assert.match(seen[1].at(-1)?.content || "", /上一次回复不是完整的申请文件/);
  assert.equal(seen[1].at(-2)?.role, "assistant");
  const stored = actions.find((action) => action.type === "set-invention-draft");
  assert.ok(stored && stored.type === "set-invention-draft");
  assert.match(stored.draft.text, /^## 具体实施方式$/m);
  assert.ok(stored.draft.score > 0);
  const traces = notes(actions, "trace");
  assert.ok(traces.some((line) => line.startsWith("初稿 ") && line.includes("0/7")));
  assert.ok(traces.some((line) => line.startsWith("初稿不完整")));
});

test("runDraftTurn stores nothing when both attempts are incomplete", async () => {
  const actions: Action[] = [];
  const seen: Seen = [];
  await runDraftTurn({ ...INPUT, dispatch: (action) => actions.push(action) }, stubDeps(["好的。", "还需要补充材料。"], seen));
  assert.equal(seen.length, 2);
  assert.equal(actions.some((action) => action.type === "set-invention-draft"), false);
  assert.match(notes(actions, "assistant").at(-1) || "", /没有写成/);
});

test("runDraftTurn normalises headings instead of regenerating a structurally complete draft", async () => {
  const actions: Action[] = [];
  const seen: Seen = [];
  await runDraftTurn({ ...INPUT, dispatch: (action) => actions.push(action) }, stubDeps([fullDraft((name) => `**${name}**`)], seen));
  assert.ok(seen.every((messages) => !/上一次回复不是完整的申请文件/.test(messages.at(-1)?.content || "")));
  const stored = actions.find((action) => action.type === "set-invention-draft");
  assert.ok(stored && stored.type === "set-invention-draft");
  assert.match(stored.draft.text, /^## 权利要求书$/m);
  assert.equal(stored.draft.claimCount, 9);
  assert.ok(stored.draft.score > 0);
});
