/**
 * 缺图补绘与尾块泄漏的回归测试：附图说明列出了图但没有 ```附图 数据、元数据 json 块混在正文中间、提示词被回显时，
 * 成稿应补齐可解析、可渲染、可嵌入 Word 与压缩包的附图，正式文件不含泄漏内容和审核标注。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { Packer } from "docx";
import { formalCheck, parseApplication } from "./cnipa-format.ts";
import { draftBody, parseDraftTail, runDraftTurn } from "./draft-run.ts";
import type { DraftDeps } from "./draft-run.ts";
import { buildApplicationDocument } from "./export-docx.ts";
import { buildPackageZip, documentBytes, listPackage } from "./export-package.ts";
import { ensureFigureImages } from "./figure-assets.ts";
import { FIGURE_FILL_MARKER, FIGURE_FILL_SYSTEM, figureFillPlan, figureFillPrompt, insertFigureBlocks, parseFigureFill } from "./figure-fill.ts";
import { FIGURE_SAMPLE } from "./figure-sample.ts";
import { extractFigureSpecs, stripDraftJsonTail } from "./figure-spec.ts";
import type { Action } from "./model.ts";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes ?? new Uint8Array());
const fence = (label: string, body: string): string => "```" + label + "\n" + body + "\n```";

function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  assert.ok(end >= 0, "zip 缺少中央目录结束记录");
  const count = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  const out = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index += 1) {
    assert.equal(view.getUint32(cursor, true), 0x02014b50, "zip 中央目录记录损坏");
    const method = view.getUint16(cursor + 10, true);
    const compressed = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const local = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(dataStart, dataStart + compressed);
    out.set(name, method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw.slice());
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

const SAMPLE = [FIGURE_SAMPLE].flat().join("\n");
const SAMPLE_SPECS = extractFigureSpecs(SAMPLE).specs;
const TAIL = '{"distinguishing":[{"feature":"分层墒情反馈","problem":"灌水量不准","effect":"节水"}],"pending":["电磁阀型号"],"closestArt":""}';
const ECHO = "最后另起一个 json 代码块，给出：";
const ANNOTATED = "土壤墒情监测单元10的采样周期为10 min（模拟值，待实验验证）。";

/** 补足权利要求和实施例篇幅，使样稿通过成稿完整性检查（FIGURE_SAMPLE 本身只有约一千字）。 */
const MORE_CLAIMS = [
  "3. 根据权利要求1所述的智能灌溉控制系统，其特征在于，所述土壤墒情监测单元包括按不同深度布置的多个含水率传感器。",
  "4. 根据权利要求3所述的智能灌溉控制系统，其特征在于，所述数据处理与决策控制器按各土层的根系分布比例对各土层缺水量加权求和得到补水量。",
  "5. 根据权利要求1所述的智能灌溉控制系统，其特征在于，所述数据处理与决策控制器在含水率低于目标含水区间下限时下发灌溉指令。",
  "6. 根据权利要求5所述的智能灌溉控制系统，其特征在于，所述目标含水区间按作物生育期分别设定。",
  "7. 根据权利要求2所述的智能灌溉控制系统，其特征在于，所述电磁阀的开启时长按补水量与管路流量之比确定。",
  "8. 一种灌溉控制方法，采用权利要求1至7任一项所述的智能灌溉控制系统，其特征在于，包括采集各土层体积含水率、判断含水率是否低于目标含水区间下限以及计算补水量并下发灌溉指令的步骤。",
  "9. 根据权利要求8所述的灌溉控制方法，其特征在于，含水率不低于目标含水区间下限时返回采集步骤。",
].join("\n");
const NUMERALS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四"];
const FILLER = NUMERALS.map(
  (n) =>
    `在第${n}种工况下，土壤墒情监测单元10按设定周期采集各土层体积含水率，并将采集结果发送给数据处理与决策控制器30；数据处理与决策控制器30将各土层含水率与目标含水区间比较，按根系分布比例计算补水量，再向灌溉执行单元40下发灌溉指令，灌溉执行单元40按指令开启电磁阀并在补水完成后关闭，从而使各土层含水率回到目标含水区间内，减少深层渗漏和表层积水。`,
).join("\n");

/** 复现 E2E 中的稿子：附图说明列出 2 幅图、没有任何 ```附图 块；元数据 json 块夹在正文中间，文末是提示词回显。 */
const NO_FIGURES = SAMPLE.replace(/```附图[ \t]*\n[\s\S]*?\n```[ \t]*\n?/g, "")
  .replace("## 具体实施方式", `${fence("json", TAIL)}\n\n## 具体实施方式`)
  .replace("\n\n## 技术领域", `\n${MORE_CLAIMS}\n\n## 技术领域`)
  .replace("### 附图标记", `${FILLER}\n${ANNOTATED}\n### 附图标记`)
  .replace(/\s*$/, `\n\n${ECHO}\n`);

const FILL_REPLY = ["下面是补写的附图数据。", ...SAMPLE_SPECS.map((spec) => fence("附图", JSON.stringify(spec)))].join("\n\n");

function figureBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```附图[ \t]*\n([\s\S]*?)\n```/g)].map((match) => match[1]);
}

test("复现稿件：没有附图数据、正文夹带尾块和提示词回显", () => {
  assert.equal(SAMPLE_SPECS.length, 2);
  assert.equal(extractFigureSpecs(NO_FIGURES).specs.length, 0);
  assert.deepEqual(figureFillPlan(NO_FIGURES).missing.map((figure) => figure.no), [1, 2]);
  assert.equal(formalCheck(parseApplication(NO_FIGURES)).exportable, true, "旧逻辑：全缺也能导出，只留空白框");
});

test("stripDraftJsonTail 去掉正文中间的元数据块和提示词回显，普通 json 示例与附图块不动", () => {
  const body = draftBody(NO_FIGURES);
  assert.doesNotMatch(body, /distinguishing|closestArt|另起一个|json 代码块/);
  assert.match(body, /## 具体实施方式/);
  assert.match(body, /S3、按各土层缺水量计算补水量/);
  assert.match(body, /10—土壤墒情监测单元/);
  assert.deepEqual(parseDraftTail(NO_FIGURES).pending, ["电磁阀型号"]);
  assert.equal(parseDraftTail(NO_FIGURES).distinguishing[0].feature, "分层墒情反馈");

  const example = ["## 附图说明", fence("json", '{"example":true}'), fence("附图", JSON.stringify(SAMPLE_SPECS[0])), "## 具体实施方式", "正文。"].join("\n");
  assert.equal(stripDraftJsonTail(example), example);
  const loose = `${example}\n${TAIL}\n尾段。`;
  assert.equal(stripDraftJsonTail(loose), `${example}\n尾段。`);
  assert.deepEqual(parseDraftTail(loose).pending, ["电磁阀型号"]);
  // 正常专利正文提到 JSON 数据格式时不误删
  const prose = "所述边缘网关以JSON格式上报各土层含水率。";
  assert.equal(stripDraftJsonTail(prose), prose);
});

test("补绘：只收下缺图，插回后 JSON 可解析、图号与标记一致、形式核查可导出，且幂等", () => {
  const plan = figureFillPlan(draftBody(NO_FIGURES));
  const prompt = figureFillPrompt(draftBody(NO_FIGURES), plan);
  assert.ok(prompt.startsWith(FIGURE_FILL_MARKER));
  assert.match(prompt, /图1：[^\n]*原理框图[^\n]*block/);
  assert.match(prompt, /图2：[^\n]*流程图[^\n]*flow/);
  assert.match(prompt, /10—土壤墒情监测单元/);

  const extra = fence("附图", JSON.stringify({ ...SAMPLE_SPECS[0], no: 7 }));
  const parsed = parseFigureFill(`${FILL_REPLY}\n${extra}`, plan.missing);
  assert.deepEqual(parsed.specs.map((spec) => spec.no), [1, 2]);
  assert.ok(parsed.notes.some((note) => note.includes("图7")));

  const filled = insertFigureBlocks(NO_FIGURES, parsed.specs);
  const blocks = figureBlocks(filled);
  assert.equal(blocks.length, 2);
  for (const block of blocks) assert.doesNotThrow(() => JSON.parse(block));
  assert.ok(filled.indexOf("```附图") > filled.indexOf("## 附图说明") && filled.indexOf("```附图") < filled.indexOf("## 具体实施方式"));
  const app = parseApplication(filled);
  assert.deepEqual((app.figureSpecs ?? []).map((spec) => spec.no), app.figures.map((figure) => figure.no));
  const report = formalCheck(app);
  assert.equal(report.exportable, true, report.fatal);
  assert.equal(report.figureAudit?.errorCount, 0);
  assert.deepEqual(figureFillPlan(filled).missing, []);
  assert.equal(insertFigureBlocks(filled, []), filled);
});

function fillStub(draft: string, reply: string): { deps: DraftDeps; fillAsks: () => number } {
  let asked = 0;
  const deps: DraftDeps = {
    ask: async (messages) => {
      if (messages[0]?.content === FIGURE_FILL_SYSTEM) {
        asked += 1;
        assert.ok((messages.at(-1)?.content ?? "").startsWith(FIGURE_FILL_MARKER));
        return { ok: true, text: reply, detail: "", model: "stub-model", aborted: false };
      }
      return { ok: true, text: draft, detail: "", model: "stub-model", aborted: false };
    },
    search: async () => ({ ok: true, detail: "", results: [] }),
  };
  return { deps, fillAsks: () => asked };
}

const INPUT = {
  caseId: "c1",
  materials: [{ name: "交底.md", kind: "text" as const, text: "分层墒情反馈的智能灌溉控制系统：土壤墒情监测单元采集各土层体积含水率，决策控制器计算补水量，灌溉执行单元开启电磁阀。" }],
  userText: "",
};

function storedDraft(actions: Action[]): string {
  const stored = actions.find((action) => action.type === "set-invention-draft");
  assert.ok(stored && stored.type === "set-invention-draft", "成稿已保存");
  return stored.draft.text;
}

test("runDraftTurn：缺附图数据时只多调一次补绘，成稿两幅图均有数据且无泄漏", async () => {
  const actions: Action[] = [];
  const stub = fillStub(NO_FIGURES, FILL_REPLY);
  await runDraftTurn({ ...INPUT, dispatch: (action) => actions.push(action) }, stub.deps);
  assert.equal(stub.fillAsks(), 1);
  const final = storedDraft(actions);
  assert.doesNotMatch(final, /distinguishing|closestArt|另起一个|json 代码块/);
  const app = parseApplication(final);
  assert.deepEqual((app.figureSpecs ?? []).map((spec) => spec.no), [1, 2]);
  const report = formalCheck(app);
  assert.equal(report.exportable, true, report.fatal);
  const traces = actions.flatMap((action) => (action.type === "chat-note" && action.role === "trace" ? [action.text] : []));
  assert.ok(traces.some((line) => line.includes("已补绘图1、图2")), traces.join("\n"));
});

test("runDraftTurn：补绘回复无可用数据时保留原稿，不重复调用", async () => {
  const actions: Action[] = [];
  const stub = fillStub(NO_FIGURES, "抱歉，无法绘制。");
  await runDraftTurn({ ...INPUT, dispatch: (action) => actions.push(action) }, stub.deps);
  assert.equal(stub.fillAsks(), 1);
  const final = storedDraft(actions);
  assert.equal(extractFigureSpecs(final).specs.length, 0);
  assert.doesNotMatch(final, /distinguishing|另起一个/);
  assert.equal(formalCheck(parseApplication(final)).exportable, true);
});

test("补绘后的成稿：Word 内嵌真实附图，压缩包含附图 PNG，正式文件无审核标注而审核单保留", async () => {
  const filled = insertFigureBlocks(NO_FIGURES, parseFigureFill(FILL_REPLY, figureFillPlan(NO_FIGURES).missing).specs);
  const app = parseApplication(filled);
  const report = formalCheck(app);
  const prepared = await ensureFigureImages(app);
  assert.deepEqual(prepared.failed, []);
  assert.deepEqual([...prepared.images.keys()], [1, 2]);

  const docx = readZip(new Uint8Array(await Packer.toBuffer(buildApplicationDocument(app, report))));
  const media = [...docx.keys()].filter((name) => name.startsWith("word/media/"));
  assert.ok(media.filter((name) => name.endsWith(".png")).length >= 2, media.join(", "));
  for (const name of media.filter((item) => item.endsWith(".png"))) assert.deepEqual([...(docx.get(name) ?? new Uint8Array()).subarray(0, 8)], PNG_SIGNATURE);
  const xml = text(docx.get("word/document.xml"));
  assert.ok((xml.match(/<w:drawing>/g) ?? []).length >= 3, "说明书附图 2 幅 + 摘要附图 1 幅");
  assert.doesNotMatch(xml, /待绘制|缺少绘图数据|模拟值|待实验验证|推断，待确认|内部审核单|distinguishing|closestArt|另起一个|json 代码块/);

  const listing = listPackage(filled, "测试");
  assert.equal(listing.error, "");
  for (const file of listing.files) await file.prepare?.();
  const figures = (await ensureFigureImages(listing.app ?? app)).images;
  const zip = readZip(await buildPackageZip(listing.files, listing.title, listing.report, figures));
  const names = [...zip.keys()];
  for (const no of [1, 2]) {
    const png = names.find((name) => name.endsWith(`/附图/图${no}.png`));
    assert.ok(png, names.join(", "));
    assert.deepEqual([...(zip.get(png) ?? new Uint8Array()).subarray(0, 8)], PNG_SIGNATURE);
  }
  let reviewSeen = false;
  for (const file of listing.files) {
    const body = text(readZip(await documentBytes(file.build())).get("word/document.xml"));
    assert.doesNotMatch(body, /distinguishing|closestArt|另起一个|json 代码块/, file.key);
    if (file.key === "review") {
      reviewSeen = true;
      assert.match(body, /模拟值，待实验验证/, "内部审核单保留审核标注");
    } else {
      assert.doesNotMatch(body, /模拟值|待实验验证|推断，待确认|内部审核单/, file.key);
    }
    if (file.key === "drawings") assert.ok([...readZip(await documentBytes(file.build())).keys()].some((name) => /^word\/media\/.+\.png$/.test(name)));
  }
  assert.ok(reviewSeen, "压缩包包含内部审核单");
});