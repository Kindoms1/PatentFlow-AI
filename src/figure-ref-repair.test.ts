import test from "node:test";
import assert from "node:assert/strict";
import { formalCheck, parseApplication } from "./cnipa-format.ts";
import type { FormalReport } from "./cnipa-format.ts";
import { draftBody, FORMAL_REPAIR_ROUNDS, formalRepairPrompt, runDraftTurn } from "./draft-run.ts";
import type { DraftDeps } from "./draft-run.ts";
import { repairFigureRefs } from "./figure-ref-repair.ts";
import { textReferences } from "./figure-audit.ts";
import type { Action } from "./model.ts";

const MATERIAL = "一种带自清洁刮板的雨水井截污装置：井口下方设倾斜弧形截污格栅，下泄水流冲动叶轮，叶轮通过曲柄连杆带动刮板沿格栅表面往复刮扫，杂物被推入集污斗。";
const LIST = "1-截污格栅；2-叶轮；3-刮板；4-集污斗。";

type Shape = Record<string, unknown>;

const BASE_SHAPES: Shape[] = [
  { kind: "rect", x: 20, y: 20, w: 80, h: 20, ref: "1" },
  { kind: "circle", cx: 60, cy: 80, r: 15, ref: "2" },
  { kind: "rect", x: 110, y: 20, w: 60, h: 10, ref: "3" },
  { kind: "rect", x: 180, y: 70, w: 40, h: 40, ref: "4" },
];
const AXES: Shape[] = [
  { kind: "line", points: [[10, 130], [230, 130]], ref: "410" },
  { kind: "line", points: [[10, 10], [10, 130]], ref: "411" },
];

/** 结构完整、带一幅结构示意图的申请文件草稿；只有附图、附图标记列表和实施例补充句随用例变化。 */
function draft(options: { shapes?: Shape[]; list?: string; extra?: string; claimExtra?: string } = {}): string {
  const { shapes = BASE_SHAPES, list = LIST, extra = "", claimExtra = "" } = options;
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

function report(text: string): FormalReport {
  return formalCheck(parseApplication(text));
}

function figureErrors(text: string): string[] {
  return (report(text).figureAudit?.checks ?? []).filter((check) => check.level === "error").map((check) => check.id);
}

function figureBlock(text: string): { no: number; kind: string; shapes: Shape[] } {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.trim() === "```附图");
  assert.ok(at >= 0, "figure block present");
  return JSON.parse(lines[at + 1]);
}

function listLine(text: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.trim() === "### 附图标记");
  return lines.slice(at + 1).filter((line) => line.trim()).join("\n").split("\n```")[0];
}

test("fixture: the base draft with consistent figures is exportable", () => {
  const base = report(draft());
  assert.equal(base.exportable, true, base.fatal);
  assert.deepEqual(figureErrors(draft()), []);
});

test("unnamed, unreferenced axis refs (410/411) lose their ref, keep their lines, and the draft becomes exportable", () => {
  const text = draft({ shapes: [...BASE_SHAPES, ...AXES] });
  assert.ok(figureErrors(text).includes("ref-figure-unlisted"));
  assert.equal(report(text).exportable, false);

  const repaired = repairFigureRefs(text);
  assert.deepEqual(repaired.stripped, [{ ref: "410", figures: [1] }, { ref: "411", figures: [1] }]);
  assert.deepEqual(repaired.added, []);
  assert.deepEqual(repaired.removed, []);
  assert.match(repaired.changes.join(""), /图1中的 410、411/);
  assert.deepEqual(figureErrors(repaired.text), []);
  const after = report(repaired.text);
  assert.equal(after.exportable, true, after.fatal);

  const block = figureBlock(repaired.text);
  assert.equal(block.shapes.length, BASE_SHAPES.length + AXES.length, "the axis lines are still drawn");
  assert.deepEqual(block.shapes.slice(-2), [
    { kind: "line", points: [[10, 130], [230, 130]] },
    { kind: "line", points: [[10, 10], [10, 130]] },
  ]);
  assert.deepEqual(block.shapes.slice(0, 4).map((shape) => shape.ref), ["1", "2", "3", "4"]);
  assert.equal(listLine(repaired.text), LIST, "the reference list is untouched");
  assert.equal(repairFigureRefs(repaired.text).changes.length, 0, "a second pass changes nothing");
  assert.doesNotMatch(repaired.text, /审核|待确认/);
});

test("a drawn ref whose name the description gives is added to the list in its own format", () => {
  const text = draft({ shapes: [...BASE_SHAPES, { kind: "rect", x: 120, y: 100, w: 30, h: 10, ref: "50" }], extra: "导流板50设置在所述截污格栅的上方。" });
  assert.ok(figureErrors(text).includes("ref-figure-unlisted"));
  const repaired = repairFigureRefs(text);
  assert.deepEqual(repaired.added, [{ ref: "50", name: "导流板" }]);
  assert.deepEqual(repaired.stripped, []);
  assert.equal(listLine(repaired.text), "1-截污格栅；2-叶轮；3-刮板；4-集污斗；50-导流板。");
  assert.deepEqual(figureErrors(repaired.text), []);
  assert.equal(figureBlock(repaired.text).shapes.at(-1)?.ref, "50", "the named ref stays on the figure");
});

test("a listed ref that no figure draws and the description never mentions is removed (inline list)", () => {
  const text = draft({ list: "1-截污格栅；2-叶轮；3-刮板；4-集污斗；60-溢流管。" });
  assert.ok(figureErrors(text).includes("ref-list-undrawn"));
  const repaired = repairFigureRefs(text);
  assert.deepEqual(repaired.removed, [{ ref: "60", name: "溢流管" }]);
  assert.equal(listLine(repaired.text), LIST);
  assert.deepEqual(figureErrors(repaired.text), []);
});

test("a listed ref is removed from a one-entry-per-line list and the full stop moves up", () => {
  const text = draft({ list: "1-截污格栅；\n2-叶轮；\n3-刮板；\n4-集污斗；\n60-溢流管。" });
  const repaired = repairFigureRefs(text);
  assert.deepEqual(repaired.removed, [{ ref: "60", name: "溢流管" }]);
  assert.equal(listLine(repaired.text), "1-截污格栅；\n2-叶轮；\n3-刮板；\n4-集污斗。");
  assert.deepEqual(figureErrors(repaired.text), []);
});

test("refs the description mentions are left to the model", () => {
  const mentioned = draft({ shapes: [...BASE_SHAPES, AXES[0]], extra: "叶轮额定转速为410转每分钟。" });
  const kept = repairFigureRefs(mentioned);
  assert.deepEqual(kept.changes, []);
  assert.equal(kept.text, mentioned);

  const named = draft({ list: "1-截污格栅；2-叶轮；3-刮板；4-集污斗；50-导流板。", extra: "导流板50设置在所述截污格栅的上方。" });
  assert.ok(figureErrors(named).includes("ref-list-undrawn"));
  const undrawn = repairFigureRefs(named);
  assert.deepEqual(undrawn.removed, [], "a part the description names is not dropped from the list");
  assert.equal(undrawn.text, named);
});

test("a consistent draft is returned unchanged", () => {
  const text = draft();
  const repaired = repairFigureRefs(text);
  assert.deepEqual(repaired.changes, []);
  assert.equal(repaired.text, text);
});

// ── runDraftTurn：导出前形式修正最多 FORMAL_REPAIR_ROUNDS 轮 ──

const DRAW_5: Shape = { kind: "rect", x: 120, y: 100, w: 30, h: 10, ref: "5" };
const DRAW_8: Shape = { kind: "rect", x: 160, y: 120, w: 20, h: 10, ref: "8" };
const LIST_5 = "1-截污格栅；2-叶轮；3-刮板；4-集污斗；5-导流板";
const EXTRA = "导流板5设置在所述截污格栅的上方。检修时参见8所指部位。";

function traces(actions: Action[]): string[] {
  return actions.flatMap((action) => (action.type === "chat-note" && action.role === "trace" ? [action.text] : []));
}

/** 按提示词分流的模拟模型：形式修正请求依次返回 fixes，其余请求返回最近一版稿子。 */
function formalStub(base: string, fixes: string[]): { deps: DraftDeps; formalAsks: () => number } {
  const marker = formalRepairPrompt(draftBody(base), report(base)).split("\n")[0].slice(0, 16);
  let asked = 0;
  let current = base;
  const deps: DraftDeps = {
    ask: async (messages) => {
      const content = messages.at(-1)?.content ?? "";
      if (content.startsWith(marker)) {
        current = fixes[Math.min(asked, fixes.length - 1)];
        asked += 1;
      }
      return { ok: true, text: current, detail: "", model: "stub-model", aborted: false };
    },
    search: async () => ({
      ok: true,
      detail: "",
      results: [{ title: "CN104074262B - 一种雨水检查井智能截污装置 - Google Patents", url: "https://patents.google.com/patent/CN104074262B/zh", snippet: "" }],
    }),
  };
  return { deps, formalAsks: () => asked };
}

const INPUT = { caseId: "c1", materials: [{ name: "交底.md", kind: "text" as const, text: MATERIAL }], userText: "" };

test("formal repair continues to a second round when the first one only fixes part of the figure problems", async () => {
  const base = draft({ shapes: [...BASE_SHAPES, DRAW_8], list: `${LIST_5}。`, extra: EXTRA });
  const round1 = draft({ shapes: [...BASE_SHAPES, DRAW_5, DRAW_8], list: `${LIST_5}。`, extra: EXTRA });
  const round2 = draft({ shapes: [...BASE_SHAPES, DRAW_5, DRAW_8], list: `${LIST_5}；8-检修口。`, extra: EXTRA });
  assert.deepEqual(figureErrors(base).sort(), ["ref-figure-unlisted", "ref-list-undrawn"]);
  assert.deepEqual(figureErrors(round1), ["ref-figure-unlisted"]);
  assert.equal(report(round2).exportable, true, report(round2).fatal);
  assert.deepEqual(repairFigureRefs(base).changes, [], "nothing here is deterministic");

  const actions: Action[] = [];
  const stub = formalStub(base, [round1, round2]);
  await runDraftTurn({ ...INPUT, dispatch: (action) => actions.push(action) }, stub.deps);
  assert.equal(stub.formalAsks(), 2);
  const stored = actions.find((action) => action.type === "set-invention-draft");
  assert.ok(stored && stored.type === "set-invention-draft");
  const final = report(stored.draft.text);
  assert.equal(final.exportable, true, final.fatal);
  const lines = traces(actions);
  assert.ok(lines.some((line) => line.includes(`第 1/${FORMAL_REPAIR_ROUNDS} 轮`)));
  assert.ok(lines.some((line) => line.includes(`第 2/${FORMAL_REPAIR_ROUNDS} 轮`)));
  assert.ok(lines.some((line) => line.includes("第 2 轮形式修正后核查通过")));
});

test("formal repair stops after FORMAL_REPAIR_ROUNDS rounds even when problems remain", async () => {
  const conflict = "；6-挡板；6-隔板";
  const DRAW_6: Shape = { kind: "rect", x: 20, y: 110, w: 30, h: 10, ref: "6" };
  const base = draft({ shapes: [...BASE_SHAPES, DRAW_6, DRAW_8], list: `${LIST_5}${conflict}。`, extra: EXTRA });
  const round1 = draft({ shapes: [...BASE_SHAPES, DRAW_5, DRAW_6, DRAW_8], list: `${LIST_5}${conflict}。`, extra: EXTRA });
  const round2 = draft({ shapes: [...BASE_SHAPES, DRAW_5, DRAW_6, DRAW_8], list: `${LIST_5}${conflict}；8-检修口。`, extra: EXTRA });
  const round3 = draft({ shapes: [...BASE_SHAPES, DRAW_5, DRAW_6, DRAW_8], list: `${LIST_5}；6-挡板；8-检修口。`, extra: EXTRA });
  assert.equal(figureErrors(base).length, 3, figureErrors(base).join(","));
  assert.equal(figureErrors(round1).length, 2);
  assert.equal(figureErrors(round2).length, 1);
  assert.equal(report(round3).exportable, true, report(round3).fatal);

  const actions: Action[] = [];
  const stub = formalStub(base, [round1, round2, round3]);
  await runDraftTurn({ ...INPUT, dispatch: (action) => actions.push(action) }, stub.deps);
  assert.equal(stub.formalAsks(), FORMAL_REPAIR_ROUNDS, "the model is asked at most FORMAL_REPAIR_ROUNDS times");
  const stored = actions.find((action) => action.type === "set-invention-draft");
  assert.ok(stored && stored.type === "set-invention-draft");
  assert.deepEqual(figureErrors(stored.draft.text), ["ref-conflict"], "the best draft so far is kept");
  assert.ok(!traces(actions).some((line) => line.includes(`第 3/`)));
});

test("formal repair stops at once when a round does not reduce the figure problems", async () => {
  const base = draft({ shapes: [...BASE_SHAPES, DRAW_8], list: `${LIST_5}。`, extra: EXTRA });
  const actions: Action[] = [];
  const stub = formalStub(base, [base]);
  await runDraftTurn({ ...INPUT, dispatch: (action) => actions.push(action) }, stub.deps);
  assert.equal(stub.formalAsks(), 1);
  assert.ok(traces(actions).some((line) => line.includes("保留当前稿")));
  const stored = actions.find((action) => action.type === "set-invention-draft");
  assert.ok(stored && stored.type === "set-invention-draft");
  assert.deepEqual(figureErrors(stored.draft.text), ["ref-figure-unlisted"], "the undrawn 5-导流板 is unreferenced as the last resort; the unlisted 8 stays for the model");
  assert.ok(traces(actions).some((line) => line.includes("形式修正后附图标记确定性修复") && line.includes("5—导流板")));
  assert.doesNotMatch(stored.draft.text, /导流板\s*[（(]?\s*5(?!\d)/);
});

test("runDraftTurn repairs unnamed axis refs deterministically without asking the model for a formal fix", async () => {
  const base = draft({ shapes: [...BASE_SHAPES, ...AXES] });
  const actions: Action[] = [];
  const stub = formalStub(base, [base]);
  await runDraftTurn({ ...INPUT, dispatch: (action) => actions.push(action) }, stub.deps);
  assert.equal(stub.formalAsks(), 0);
  const stored = actions.find((action) => action.type === "set-invention-draft");
  assert.ok(stored && stored.type === "set-invention-draft");
  const final = report(stored.draft.text);
  assert.equal(final.exportable, true, final.fatal);
  assert.ok(traces(actions).some((line) => line.includes("附图标记确定性修复") && line.includes("410、411")));
});

// ── 兜底：没有附图画出、正文只以“部件名+标记”引用的部件，去掉标记引用并从列表删去 ──

const LIST_70 = "1-截污格栅；2-叶轮；3-刮板；4-集污斗；70-控制箱。";

test("an undrawn listed part the description names is left to the model unless unrefUndrawn is set", () => {
  const text = draft({ list: LIST_70, extra: "控制箱(70)安装在井壁上，所述控制箱(70)内设有蓄电池，设计流量为60-70 L/s。" });
  assert.deepEqual(figureErrors(text), ["ref-list-undrawn"]);
  const kept = repairFigureRefs(text);
  assert.deepEqual(kept.changes, []);
  assert.equal(kept.text, text);

  const repaired = repairFigureRefs(text, { unrefUndrawn: true });
  assert.deepEqual(repaired.unreferenced, [{ ref: "70", name: "控制箱" }]);
  assert.deepEqual(repaired.removed, []);
  assert.deepEqual(repaired.added, []);
  assert.deepEqual(repaired.stripped, []);
  assert.equal(listLine(repaired.text), LIST);
  assert.match(repaired.text, /控制箱安装在井壁上，所述控制箱内设有蓄电池，设计流量为60-70 L\/s。/, "the part name and the unrelated value 60-70 stay");
  assert.doesNotMatch(repaired.text, /控制箱\s*[（(]?\s*70/);
  assert.match(repaired.changes.join(""), /70—控制箱/);
  assert.deepEqual(figureErrors(repaired.text), []);
  const after = report(repaired.text);
  assert.equal(after.exportable, true, after.fatal);
  assert.deepEqual(figureBlock(repaired.text).shapes, BASE_SHAPES, "the figures are untouched");
  assert.equal(repairFigureRefs(repaired.text, { unrefUndrawn: true }).changes.length, 0, "a second pass changes nothing");
});

test("the last-resort unreferencing also updates the claims and keeps claim numbers equal to the ref", () => {
  const text = draft({
    list: "1-截污格栅；2-叶轮；3-刮板；4-集污斗；5-控制箱。",
    extra: "控制箱5安装在井壁上。",
    claimExtra: "还包括控制箱（5），所述控制箱（5）固定在井壁上。",
  });
  assert.deepEqual(figureErrors(text), ["ref-list-undrawn"]);
  assert.deepEqual(repairFigureRefs(text).changes, [], "off by default");

  const repaired = repairFigureRefs(text, { unrefUndrawn: true });
  assert.deepEqual(repaired.unreferenced, [{ ref: "5", name: "控制箱" }]);
  assert.match(repaired.text, /9\. 根据权利要求8所述的雨水井截污装置，其特征在于，还包括控制箱，所述控制箱固定在井壁上。/);
  assert.match(repaired.text, /控制箱安装在井壁上。/);
  assert.match(repaired.text, /5\. 根据权利要求4所述/, "the claim number 5 stays");
  assert.match(repaired.text, /6\. 根据权利要求5所述/, "the reference to claim 5 stays");
  assert.doesNotMatch(repaired.text, /控制箱\s*[（(]?\s*5(?!\d)/);
  assert.equal(listLine(repaired.text), LIST);
  assert.deepEqual(figureErrors(repaired.text), []);
  const after = report(repaired.text);
  assert.equal(after.exportable, true, after.fatal);
});

test("the last-resort unreferencing leaves a ref alone when it also follows another word or appears in list form", () => {
  for (const extra of [
    "控制箱(70)安装在井壁上，挡板70设在入口处。",
    "控制箱(70)安装在井壁上（附注：70—控制箱为可选部件）。",
  ]) {
    const text = draft({ list: LIST_70, extra });
    const repaired = repairFigureRefs(text, { unrefUndrawn: true });
    assert.deepEqual(repaired.unreferenced, [], extra);
    assert.deepEqual(repaired.changes, [], extra);
    assert.equal(repaired.text, text, extra);
  }
});

test("runDraftTurn asks the model first and unreferences an undrawn described part only as the last resort", async () => {
  const base = draft({ list: LIST_70, extra: "控制箱(70)安装在井壁上。", claimExtra: "还包括控制箱(70)。" });
  assert.deepEqual(figureErrors(base), ["ref-list-undrawn"]);
  assert.match(formalRepairPrompt(draftBody(base), report(base)), /同时修改附图绘图数据中该部件图元的 ref/);

  const actions: Action[] = [];
  const stub = formalStub(base, [base]);
  await runDraftTurn({ ...INPUT, dispatch: (action) => actions.push(action) }, stub.deps);
  assert.equal(stub.formalAsks(), 1, "the model gets one chance to draw the part first");
  const stored = actions.find((action) => action.type === "set-invention-draft");
  assert.ok(stored && stored.type === "set-invention-draft");
  const final = report(stored.draft.text);
  assert.equal(final.exportable, true, final.fatal);
  assert.doesNotMatch(stored.draft.text, /控制箱\s*[（(]?\s*70/);
  assert.match(stored.draft.text, /还包括控制箱。/);
  const lines = traces(actions);
  const asked = lines.findIndex((line) => line.includes(`第 1/${FORMAL_REPAIR_ROUNDS} 轮`));
  const fallback = lines.findIndex((line) => line.includes("形式修正后附图标记确定性修复") && line.includes("70—控制箱"));
  assert.ok(asked >= 0 && fallback > asked, lines.join("\n"));
});

// ── 回归：未绘制的 15-激活函数层、32-全连接层可确定性修复，普通数值不受影响 ──

test("undrawn refs 15 and 32 are unreferenced while plain values such as 设为32, 15层 and 32个通道 stay", () => {
  const list = "1-截污格栅；2-叶轮；3-刮板；4-集污斗；15-激活函数层；32-全连接层。";
  const extra = "识别模块中，激活函数层(15)采用ReLU函数，所述激活函数层15的输出送入全连接层(32)，全连接层32输出堵塞等级。学习率衰减周期设为32，网络共堆叠15层，卷积核为32个通道。";
  const text = draft({ list, extra });
  assert.ok(figureErrors(text).includes("ref-list-undrawn"), JSON.stringify(figureErrors(text)));
  assert.deepEqual(repairFigureRefs(text).changes, [], "off by default");

  const repaired = repairFigureRefs(text, { unrefUndrawn: true });
  const unref = [...repaired.unreferenced].sort((a, b) => Number(a.ref) - Number(b.ref));
  assert.deepEqual(unref, [{ ref: "15", name: "激活函数层" }, { ref: "32", name: "全连接层" }]);
  assert.equal(listLine(repaired.text), LIST);
  assert.doesNotMatch(repaired.text, /激活函数层s*[（(]?s*15/);
  assert.doesNotMatch(repaired.text, /全连接层s*[（(]?s*32/);
  assert.match(repaired.text, /学习率衰减周期设为32，网络共堆叠15层，卷积核为32个通道。/, "plain values stay");
  assert.deepEqual(figureErrors(repaired.text), []);
  const after = report(repaired.text);
  assert.equal(after.exportable, true, after.fatal);
  assert.deepEqual(figureBlock(repaired.text).shapes, BASE_SHAPES, "the figures are untouched");
  assert.equal(repairFigureRefs(repaired.text, { unrefUndrawn: true }).changes.length, 0, "a second pass changes nothing");
});

// ---- 合写附图标记（“5、6、7-滚轮”）----

const GROUP_LIST = `${LIST.replace(/。$/, "")}；5、6、7-滚轮。`;
const allCheckIds = (text: string): string[] => (report(text).figureAudit?.checks ?? []).map((check) => check.id);

test("合写标记只画出一个时，按同类未标注图元的左右位置补标", () => {
  const shapes = [
    ...BASE_SHAPES,
    { kind: "circle", cx: 100, cy: 160, r: 8, ref: "5" },
    { kind: "circle", cx: 180, cy: 160, r: 8 },
    { kind: "circle", cx: 140, cy: 160, r: 8 },
  ];
  const text = draft({ shapes, list: GROUP_LIST });
  const refs = parseApplication(text).references ?? [];
  assert.deepEqual(refs.find((entry) => entry.ref === "6")?.group, ["5", "6", "7"]);
  assert.ok(allCheckIds(text).includes("ref-list-undrawn"));
  const result = repairFigureRefs(text);
  assert.deepEqual(result.assigned, [{ ref: "6", figure: 1 }, { ref: "7", figure: 1 }]);
  const circles = figureBlock(result.text).shapes.filter((shape) => shape.kind === "circle" && shape.cy === 160);
  assert.deepEqual(circles.map((shape) => [shape.cx, shape.ref]), [[100, "5"], [180, "7"], [140, "6"]]);
  assert.ok(!allCheckIds(result.text).includes("ref-list-undrawn"));
  assert.ok(!allCheckIds(result.text).includes("ref-double"));
  assert.deepEqual(parseApplication(result.text).references, refs);
  const again = repairFigureRefs(result.text);
  assert.deepEqual(again.changes, []);
  assert.equal(again.text, result.text);
});

test("合写标记补标也支持竖直线条", () => {
  const shapes = [
    ...BASE_SHAPES,
    { kind: "line", points: [[150, 150], [150, 190]] },
    { kind: "line", points: [[110, 150], [110, 190]] },
    { kind: "line", points: [[190, 150], [190, 190]], ref: "7" },
  ];
  const result = repairFigureRefs(draft({ shapes, list: GROUP_LIST }));
  assert.deepEqual(result.assigned, [{ ref: "5", figure: 1 }, { ref: "6", figure: 1 }]);
  const lines = figureBlock(result.text).shapes.filter((shape) => shape.kind === "line");
  assert.deepEqual(lines.map((shape) => shape.ref), ["6", "5", "7"]);
});

test("同类未标注图元数与缺少的标记数不等时不补标", () => {
  const shapes = [
    ...BASE_SHAPES,
    { kind: "circle", cx: 100, cy: 160, r: 8, ref: "5" },
    { kind: "circle", cx: 140, cy: 160, r: 8 },
    { kind: "circle", cx: 180, cy: 160, r: 8 },
    { kind: "circle", cx: 220, cy: 160, r: 8 },
  ];
  const text = draft({ shapes, list: GROUP_LIST });
  const result = repairFigureRefs(text);
  assert.equal(result.assigned, undefined);
  assert.deepEqual(figureBlock(result.text).shapes, figureBlock(text).shapes);
  assert.ok(allCheckIds(result.text).includes("ref-list-undrawn"));
});

test("补标后左右顺序与列表顺序不一致时不补标", () => {
  const shapes = [
    ...BASE_SHAPES,
    { kind: "circle", cx: 160, cy: 160, r: 8, ref: "5" },
    { kind: "circle", cx: 100, cy: 160, r: 8 },
    { kind: "circle", cx: 220, cy: 160, r: 8 },
  ];
  const text = draft({ shapes, list: GROUP_LIST });
  const result = repairFigureRefs(text);
  assert.equal(result.assigned, undefined);
  assert.deepEqual(figureBlock(result.text).shapes, figureBlock(text).shapes);
});

test("合写条目即使没有画出、也没有引用，也不会被自动从列表删去其中一个", () => {
  const text = draft({ list: GROUP_LIST });
  const result = repairFigureRefs(text);
  const refs = (parseApplication(result.text).references ?? []).map((entry) => entry.ref);
  for (const ref of ["5", "6", "7"]) assert.ok(refs.includes(ref), ref);
  assert.ok(!result.removed.some((entry) => ["5", "6", "7"].includes(entry.ref)));
  assert.ok(result.text.includes("5、6、7-滚轮"));
});

test("正文中的数量单位不当作附图标记，部件名加标记仍然识别", () => {
  const refs = textReferences("包括第一隐藏层（512节点）、第二隐藏层（256节点），输入层256维，控制器（30）与传感器20位于上方。").map((entry) => entry.ref);
  assert.ok(!refs.includes("512") && !refs.includes("256"));
  assert.ok(refs.includes("30") && refs.includes("20"));
});
