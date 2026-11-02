import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { AUTO_TRACE_PREFIX, SIMULATED_MARK, detectAutoRequest, parseAutoReply, runAutoPatent, type AutoDeps } from "./auto-flow.ts";
import { buildPackageZip, documentBytes, listPackage } from "./export-package.ts";
import { reduce, seed } from "./model.ts";
import type { Action } from "./model.ts";
import { OUTLINE_MATERIAL_NAME } from "./skill-turn.ts";

const S = SIMULATED_MARK;
const TITLE = "一种基于土壤墒情时空预测的分区精准灌溉方法及装置";

const POINTS = [
  { title: "一种基于作物冠层温度的灌溉启停方法", problem: "单点阈值启停滞后", feature: "冠层温差触发", effect: "预期响应更快", pending: "阈值待实验" },
  { title: TITLE, problem: "单点墒情阈值无法反映田块空间差异，导致局部过灌或欠灌", feature: "图卷积与门控循环单元串联的时空预测模型预测各分区含水率，并按预测值计算分区灌水量", effect: "预期减少过量灌溉", pending: "传感器布设间距" },
  { title: "一种水肥一体化配比自校正装置", problem: "配比漂移", feature: "电导率闭环", effect: "预期配比更稳", pending: "传感器选型" },
];

const CREATE_REPLY = [
  "检索了智慧农业灌溉方向的公开专利、论文和行业报道（均为检索线索，未核验）。现有做法主要是单点阈值启停和固定时间表灌溉，共性问题是田块空间差异大时过灌或欠灌。",
  "```json",
  JSON.stringify({ reply: "候选题目如下", patentPoints: POINTS, questions: [], recommended: 2 }),
  "```",
].join("\n");

const OUTLINE_REPLY = [
  `# ${TITLE}·大纲目录`,
  "## 一、技术方案",
  `按网格布设墒情传感节点，网格边长 30 米${S}，采集 10、30、50 厘米${S}三层含水率；时空预测模型预测各分区未来 24 小时${S}的含水率；按需水下限计算灌水量并控制电磁阀。`,
  "## 二、权利要求布局",
  "独立权利要求：方法、装置、电子设备、存储介质；从属权利要求细化模型结构、邻接权重、灌水量计算和模型更新。",
  "## 三、附图清单",
  "图1 方法流程图（待绘制）；图2 时空预测模型结构示意图（待绘制）；图3 装置原理框图（待绘制）。",
  "## 四、实施例安排",
  "实施例1 为大田滴灌场景，替代实施方式为温室场景。",
  "## 默认假设（可后续修改）",
  "作物为玉米；灌溉方式为滴灌。",
].join("\n");

function draftText(): string {
  const zones = Array.from(
    { length: 12 },
    (_, index) =>
      `第${index + 1}灌溉分区：面积为${20 + index}亩${S}，根区深度取40厘米${S}，目标含水率取田间持水量的75%${S}。预测模块输出该分区预测时段末的含水率后，决策模块按预测含水率与目标含水率之差、根区深度和分区面积计算灌水量，控制模块把灌水量换算为电磁阀开启时长，并在灌溉结束后回采实际含水率用于模型更新。`,
  );
  return [
    `# 发明名称：${TITLE}`,
    "",
    "## 说明书摘要",
    `本发明公开了一种基于土壤墒情时空预测的分区精准灌溉方法及装置，属于智慧农业技术领域。该方法布设墒情传感节点采集多深度土壤含水率，结合气象预报构建时空预测模型，预测各灌溉分区的含水率，按作物需水阈值计算各分区灌水量并控制分区电磁阀，在传感节点稀疏时仍能按分区差异灌溉，预期减少过量灌溉${S}。`,
    "摘要附图：图1",
    "",
    "## 权利要求书",
    "1. 一种基于土壤墒情时空预测的分区精准灌溉方法，其特征在于，包括：",
    "S1、在灌溉区域内布设多个墒情传感节点，采集各节点多个深度的土壤体积含水率；",
    "S2、根据所述土壤体积含水率和气象预报数据构建时空预测模型，预测各灌溉分区在预测时段末的土壤含水率；",
    "S3、将预测的土壤含水率与作物需水下限阈值比较，计算各灌溉分区的灌水量；",
    "S4、按所述灌水量控制各灌溉分区的电磁阀开启时长。",
    "2. 根据权利要求1所述的方法，其特征在于，所述时空预测模型由图卷积层和门控循环单元串联构成，所述图卷积层的邻接关系按墒情传感节点之间的距离确定。",
    "3. 根据权利要求2所述的方法，其特征在于，所述邻接关系的权重随节点间距离按高斯核衰减。",
    "4. 根据权利要求1所述的方法，其特征在于，步骤S3中，灌水量按预测含水率与目标含水率之差、根区深度和灌溉分区面积的乘积确定。",
    "5. 根据权利要求1所述的方法，其特征在于，还包括：在灌溉结束后采集实际含水率，按预测误差更新所述时空预测模型的参数。",
    "6. 一种基于土壤墒情时空预测的分区精准灌溉装置，其特征在于，包括：采集模块，用于执行权利要求1中的步骤S1；预测模块，用于执行步骤S2；决策模块，用于执行步骤S3；控制模块，用于执行步骤S4。",
    "7. 一种电子设备，其特征在于，包括处理器和存储器，所述存储器存储有计算机程序，所述处理器执行所述计算机程序时实现权利要求1至5任一项所述的方法。",
    "8. 一种计算机可读存储介质，其上存储有计算机程序，其特征在于，所述计算机程序被处理器执行时实现权利要求1至5任一项所述的方法。",
    "",
    "## 技术领域",
    "本发明涉及智慧农业技术领域，具体涉及一种基于土壤墒情时空预测的分区精准灌溉方法及装置。",
    "",
    "## 背景技术",
    "现有灌溉控制多按单点墒情阈值启停或按固定时间表灌溉，单点读数无法反映田块内的空间差异，容易造成局部过灌或欠灌。【待检索补充对比文件】",
    "",
    "## 发明内容",
    "### 要解决的技术问题",
    "解决单点墒情阈值无法反映空间差异、灌溉决策滞后的问题。",
    "### 技术方案",
    "采集多节点多深度含水率，用时空预测模型预测各分区含水率，按预测值计算分区灌水量并控制电磁阀。",
    "### 有益效果",
    `按分区差异提前灌溉，预期减少过量灌溉约15%${S}。`,
    "",
    "## 附图说明",
    "图1为本发明实施例的分区精准灌溉方法流程图。",
    "图2为本发明实施例的时空预测模型结构示意图。",
    "图3为本发明实施例的分区精准灌溉装置的原理框图。",
    "",
    "## 具体实施方式",
    "### 实施例1",
    `如图1所示，在灌溉区域内按边长30米${S}的网格布设墒情传感节点，每个节点采集10厘米、30厘米和50厘米${S}三个深度的体积含水率，采样周期为15分钟${S}。`,
    `如图2所示，时空预测模型由两层图卷积层${S}和一层门控循环单元串联构成，邻接权重按高斯核计算，核宽取60米${S}，预测时段取24小时${S}。`,
    ...zones,
    "### 装置实施例",
    "如图3所示，装置包括采集模块、预测模块、决策模块和控制模块，分别执行步骤S1至S4。",
    "### 附图标记",
    "本申请为方法类申请，附图以步骤号和模块名称标注。",
    "",
    "```json",
    JSON.stringify({ distinguishing: [{ feature: "时空预测模型预测分区含水率", problem: "单点阈值滞后", effect: "预期减少过灌" }], pending: ["传感节点布设间距需实测确定"], closestArt: "单点阈值启停灌溉（检索线索，未核验）" }),
    "```",
  ].join("\n");
}

/** Read one entry of a zip (docx) through its central directory. */
function readZipEntry(bytes: Uint8Array, name: string): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  assert.ok(eocd >= 0, "zip 缺少中央目录");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  for (let entry = 0; entry < count; entry += 1) {
    assert.equal(view.getUint32(offset, true), 0x02014b50);
    const method = view.getUint16(offset + 10, true);
    const size = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const entryName = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (entryName === name) {
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + size);
      return decoder.decode(method === 0 ? data : inflateRawSync(data));
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`zip 里没有 ${name}`);
}

const plain = (xml: string) => xml.replace(/<[^>]+>/g, "");
const reply = (text: string) => ({ ok: Boolean(text), text, detail: text ? "" : "空回答", model: "mock-model", aborted: false, sources: [] });

function mockDeps(calls: Array<{ intent: string; system: string; user: string }>): AutoDeps {
  return {
    ask: async (messages, intent) => {
      calls.push({ intent, system: messages[0]?.content ?? "", user: messages.at(-1)?.content ?? "" });
      return reply(intent === "create" ? CREATE_REPLY : intent === "outline" ? OUTLINE_REPLY : "");
    },
    draft: {
      ask: async (messages) => {
        calls.push({ intent: "draft", system: messages[0]?.content ?? "", user: messages.at(-1)?.content ?? "" });
        return reply(draftText());
      },
      search: async () => ({ ok: true, detail: "", results: [] }),
      extract: async () => ({ ok: false, content: "" }),
    },
  };
}

test("detectAutoRequest recognises 'do it without asking' and leaves technical text alone", () => {
  for (const text of [
    "按照你的想法来进行，不要询问我，直接帮我做",
    "不要问我，直接给我一份初稿",
    "先按合理建议值完成，未知处标待确认",
    "帮我写一个智慧农业领域的发明专利，你看着办",
    "一键成稿",
  ]) {
    assert.equal(detectAutoRequest(text), true, text);
  }
  for (const text of ["帮我写一个智慧农业领域的发明专利", "本方法直接加热反应釜至设定温度", "能不能直接做成一体式结构？", "/创作 不要问我", "权利要求怎么写"]) {
    assert.equal(detectAutoRequest(text), false, text);
  }
});

test("parseAutoReply takes the recommended candidate and falls back to the first", () => {
  const parsed = parseAutoReply(CREATE_REPLY);
  assert.equal(parsed.points.length, 3);
  assert.equal(parsed.points[parsed.recommended].title, TITLE);
  assert.doesNotMatch(parsed.visible, /```/);
  const outOfRange = parseAutoReply("说明\n```json\n" + JSON.stringify({ patentPoints: POINTS, recommended: 9 }) + "\n```");
  assert.equal(outOfRange.recommended, 0);
  assert.deepEqual(parseAutoReply("没有 json").points, []);
});

test("auto mode runs topic → outline → full draft → Word package without asking (mock model)", async () => {
  let state = seed();
  const dispatch = (action: Action) => {
    state = reduce(state, action);
  };
  dispatch({ type: "create-case", id: "case-auto", title: "智慧农业·发明专利创作", text: "", fileName: "对话.md", skill: true, materials: [] });
  const calls: Array<{ intent: string; system: string; user: string }> = [];
  const outcome = await runAutoPatent(
    { caseId: "case-auto", userText: "帮我写一个智慧农业领域的发明专利，按照你的想法来进行，不要询问我，直接帮我做", history: [], materials: [], dispatch },
    mockDeps(calls),
  );
  assert.equal(outcome.stage, "draft");
  assert.equal(outcome.outline, true);
  assert.equal(outcome.chosen?.title, TITLE);

  // ① 选题：候选入库，推荐题目自动选定
  const patentCase = state.cases.find((item) => item.id === "case-auto");
  assert.ok(patentCase);
  assert.equal(patentCase.ideas.length, 3);
  assert.equal(patentCase.ideas.find((idea) => idea.title === TITLE)?.status, "pursued");
  assert.deepEqual(calls.slice(0, 3).map((call) => call.intent), ["create", "outline", "draft"]);
  assert.match(calls[0].user, /全自动模式/);
  assert.match(calls[0].user, /recommended/);
  assert.match(calls[1].user, new RegExp(TITLE));
  assert.match(calls[1].user, /不要提问/);

  // ② 大纲：保存为《创作大纲.md》并进入成稿材料
  const outline = patentCase.materials.find((item) => item.name === OUTLINE_MATERIAL_NAME);
  assert.ok(outline);
  assert.match(outline.text, /附图清单/);
  const draftCall = calls.find((call) => call.intent === "draft");
  assert.ok(draftCall);
  assert.match(draftCall.system, /【全自动模式】例外/);
  assert.match(draftCall.user, /全自动模式/);
  assert.match(draftCall.user, /附图清单/);

  // ③ 成稿：完整申请文件、模拟值显式标注、没有向发明人提问
  const draft = patentCase.inventionDraft;
  assert.ok(draft);
  assert.ok(draft.claimCount >= 8, `claims ${draft.claimCount}`);
  assert.ok(draft.text.includes(S));
  assert.ok(patentCase.messages.some((message) => message.role === "trace" && message.text.startsWith(AUTO_TRACE_PREFIX)));
  const assistant = patentCase.messages.filter((message) => message.role === "assistant").map((message) => message.text);
  assert.ok(assistant.some((text) => text.includes("全自动成稿完成")));
  assert.ok(!assistant.some((text) => /你想选哪|请(?:先)?(?:告诉|回答)我|选哪一个/.test(text)), assistant.join("\n---\n"));

  // ④ Word：每个分件都是可读取的 OOXML，写到 .tmp-library/e2e-auto/
  const listing = listPackage(draft.text, patentCase.title, { draft });
  assert.equal(listing.error, "");
  const keys = listing.files.map((file) => file.key);
  for (const key of ["claims", "description", "drawings", "full"]) assert.ok(keys.includes(key as never), key);
  const outDir = fileURLToPath(new URL("../.tmp-library/e2e-auto/", import.meta.url));
  mkdirSync(outDir, { recursive: true });
  const texts = new Map<string, string>();
  for (const file of listing.files) {
    const bytes = await documentBytes(file.build());
    assert.equal(String.fromCharCode(bytes[0], bytes[1]), "PK", file.fileName);
    assert.match(readZipEntry(bytes, "[Content_Types].xml"), /wordprocessingml/);
    texts.set(file.key, plain(readZipEntry(bytes, "word/document.xml")));
    writeFileSync(join(outDir, file.fileName), bytes);
  }
  const full = texts.get("full") ?? "";
  // 合订稿只含申请文件正文（分件名称在页眉里）：权利要求按编号成段
  assert.match(full, /2\.根据权利要求1所述/);
  assert.match(full, /分区精准灌溉/);
  // 正式申请文件不带审核标注；模拟值清单只在内部审核单
  assert.doesNotMatch(full, /模拟值，待实验验证|推断，待确认/);
  assert.match(texts.get("review") ?? "", /推断与模拟值标注/);
  // 缺图时正式分件只留空白虚线框，缺图原因只在内部审核单
  assert.doesNotMatch(texts.get("drawings") ?? "", /占位|待绘制|提交前删除/);
  assert.match(texts.get("review") ?? "", /缺少绘图数据/);
  assert.doesNotMatch(full, /内部审核单|提交前删除|形式检查结果/);
  const zip = await buildPackageZip(listing.files, listing.title, listing.report);
  writeFileSync(join(outDir, "全套申请文件.zip"), zip);
  assert.equal(String.fromCharCode(zip[0], zip[1]), "PK");
});

test("auto mode with the inventor's own material skips topic and outline and drafts directly", async () => {
  let state = seed();
  const dispatch = (action: Action) => {
    state = reduce(state, action);
  };
  dispatch({ type: "create-case", id: "case-own", title: "灌溉", text: "", fileName: "交底.md", skill: true, materials: [] });
  const calls: Array<{ intent: string; system: string; user: string }> = [];
  const material = "我的方案：在田块里按网格布设墒情传感节点，采集多个深度的含水率，结合天气预报预测未来一天各分区的含水率，再按作物需水下限算出每个分区的灌水量，控制分区电磁阀。现在的做法是看一个传感器就启动全田灌溉，经常一边水多一边水少。我们想让每个分区按自己的预测值灌，灌完再用实测值修正模型。";
  const outcome = await runAutoPatent(
    { caseId: "case-own", userText: "不要问我，直接给我一份初稿", history: [], materials: [{ name: "交底.md", kind: "text", text: material }], dispatch },
    mockDeps(calls),
  );
  assert.equal(outcome.stage, "draft");
  assert.deepEqual([...new Set(calls.map((call) => call.intent))], ["draft"]);
  assert.ok(state.cases.find((item) => item.id === "case-own")?.inventionDraft);
});