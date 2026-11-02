/**
 * 附图接入申请文件导出的端到端测试：解析 ```附图 数据 → 形式检查 → 生成图像 → Word（SVG + PNG 回退）→ 申请文件压缩包。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { Packer } from "docx";
import { formalCheck, parseApplication } from "./cnipa-format.ts";
import { buildApplicationDocument } from "./export-docx.ts";
import { buildPackageZip, documentBytes, listPackage } from "./export-package.ts";
import { cachedFigureImages, ensureFigureImages, renderedFiguresOf } from "./figure-assets.ts";
import { FIGURE_SAMPLE } from "./figure-sample.ts";

/** 读 zip 中央目录，返回 文件名 → 解压后的内容（支持 stored 与 deflate）。 */
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

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function text(bytes: Uint8Array | undefined): string {
  return bytes ? new TextDecoder().decode(bytes) : "";
}

test("附图代码块进入结构化数据，不进入说明书正文", () => {
  const app = parseApplication(FIGURE_SAMPLE);
  assert.deepEqual((app.figureSpecs ?? []).map((spec) => `${spec.no}:${spec.kind}`), ["1:block", "2:flow"]);
  assert.deepEqual(app.figureSpecIssues, []);
  assert.deepEqual(app.figures.map((figure) => figure.no), [1, 2]);
  assert.equal(app.abstractFigure, 1);
  assert.deepEqual((app.references ?? []).map((entry) => `${entry.ref}${entry.name}`), ["10土壤墒情监测单元", "30数据处理与决策控制器", "40灌溉执行单元"]);
  const printed = app.description.flatMap((part) => part.paragraphs.map((item) => item.text)).join("\n");
  assert.doesNotMatch(printed, /```|"kind"|"nodes"|"steps"/);
  assert.ok(printed.includes("如图1所示"));
});

test("形式检查带出附图核查，一致的附图可以导出", () => {
  const report = formalCheck(parseApplication(FIGURE_SAMPLE));
  assert.ok(report.figureAudit, "应有附图核查结果");
  assert.equal(report.figureAudit?.errorCount, 0, JSON.stringify(report.figureAudit?.checks.filter((check) => check.level === "error")));
  assert.equal(report.exportable, true, report.fatal);
  const byId = new Map(report.checks.map((check) => [check.id, check]));
  assert.equal(byId.get("figure-data")?.level, "ok");
  assert.equal(byId.get("ref-consistency")?.level, "ok");
  assert.equal(byId.get("figure-form")?.level, "ok");
  assert.equal(report.checks.filter((check) => check.id === "figure-numbering").length, 0, "图号连续性已由“附图引用一致”一类旧检查覆盖，附图核查不重复列出");
});

test("附图标记三方不一致时阻止导出，并说明原因", () => {
  const broken = FIGURE_SAMPLE.replace("10—土壤墒情监测单元；", "");
  const report = formalCheck(parseApplication(broken));
  assert.ok((report.figureAudit?.errorCount ?? 0) > 0);
  assert.equal(report.exportable, false);
  assert.match(report.fatal, /附图核查/);
  assert.match(report.fatal, /10/);
  const listing = listPackage(broken, "测试");
  assert.equal(listing.files.length, 0);
  assert.match(listing.error, /附图核查/);
});

test("没有附图数据的旧稿照常导出，附图页为占位并提示补充", async () => {
  const legacy = FIGURE_SAMPLE.replace(/```附图[\s\S]*?```\n/g, "");
  const app = parseApplication(legacy);
  assert.deepEqual(app.figureSpecs, []);
  const report = formalCheck(app);
  assert.equal(report.exportable, true);
  assert.equal(report.figureAudit, undefined);
  assert.equal(report.checks.find((check) => check.id === "figure-data")?.level, "warn");
  const listing = listPackage(legacy, "测试");
  const drawings = listing.files.find((file) => file.key === "drawings");
  assert.ok(drawings);
  const xml = text(readZip(await documentBytes(drawings.build())).get("word/document.xml"));
  // 正式附图件：缺图处只有不可拆分的黑色空白虚线框，不写任何占位/审核文字，也不用审核颜色
  assert.doesNotMatch(xml, /缺少绘图数据|此处为占位|待绘制|提交前删除/);
  assert.match(xml, /<w:keepLines\/>/, "空白框不得跨页拆开");
  assert.match(xml, /w:val="dashed"/);
  assert.deepEqual([...xml.matchAll(/<w:color w:val="([0-9A-Fa-f]{6}|auto)"/g)].map((m) => m[1]).filter((c) => c !== "000000" && c !== "auto"), []);
  // 缺图原因只记在内部审核单
  const review = listing.files.find((file) => file.key === "review");
  assert.ok(review);
  const reviewXml = text(readZip(await documentBytes(review.build())).get("word/document.xml"));
  assert.match(reviewXml, /附图待补/);
  assert.match(reviewXml, /图1[\s\S]{0,200}?缺少绘图数据，请按附图说明用黑色线条绘制/);
});

test("Word 中嵌入真实附图（SVG + PNG 回退），摘要附图同为真实图", async () => {
  const app = parseApplication(FIGURE_SAMPLE);
  const report = formalCheck(app);
  assert.equal(cachedFigureImages(app).size, 0, "未生成图像前没有缓存");
  const prepared = await ensureFigureImages(app);
  assert.deepEqual(prepared.failed, []);
  assert.deepEqual([...prepared.images.keys()], [1, 2]);
  for (const image of prepared.images.values()) {
    assert.deepEqual([...image.png.subarray(0, 8)], PNG_SIGNATURE);
    assert.match(text(image.svg), /^<svg /);
    assert.ok(image.widthMm <= 165 && image.heightMm <= 245);
    assert.equal(image.dpi, 300);
    assert.equal(image.pixelWidth, Math.round((image.widthMm / 25.4) * 300));
  }
  assert.equal(cachedFigureImages(app).size, 2, "生成后同步构建可直接取用");

  const files = readZip(new Uint8Array(await Packer.toBuffer(buildApplicationDocument(app, report))));
  const media = [...files.keys()].filter((name) => name.startsWith("word/media/"));
  assert.ok(media.filter((name) => name.endsWith(".png")).length >= 2, `PNG 回退图：${media.join(", ")}`);
  assert.ok(media.filter((name) => name.endsWith(".svg")).length >= 2, `SVG 矢量图：${media.join(", ")}`);
  for (const name of media.filter((item) => item.endsWith(".png"))) assert.deepEqual([...(files.get(name) ?? new Uint8Array()).subarray(0, 8)], PNG_SIGNATURE);
  const xml = text(files.get("word/document.xml"));
  assert.ok((xml.match(/<wp:inline/g) ?? []).length >= 3, "说明书附图 2 幅 + 摘要附图 1 幅");
  assert.doesNotMatch(xml, /待绘制|缺少绘图数据|摘要附图位置/);
  assert.ok(xml.includes("svgBlip"), "Word 用 asvg:svgBlip 引用矢量图");
  // 合订稿是正式申请文件，不含内部审核单
  assert.doesNotMatch(xml, /内部审核单|形式检查结果|提交前核对清单/);
});

test("分件导出：附图件和摘要附图件含真实图，压缩包附带 300 dpi PNG", async () => {
  const listing = listPackage(FIGURE_SAMPLE, "测试");
  assert.equal(listing.error, "");
  assert.ok(listing.app);
  const drawings = listing.files.find((file) => file.key === "drawings");
  const abstractFigure = listing.files.find((file) => file.key === "abstract-figure");
  assert.ok(drawings && abstractFigure);
  assert.doesNotMatch(drawings.note, /占位|待绘制/);
  assert.doesNotMatch(abstractFigure.note, /占位|待绘制/);
  await drawings.prepare?.();
  const drawingFiles = readZip(await documentBytes(drawings.build()));
  assert.ok([...drawingFiles.keys()].some((name) => /^word\/media\/.+\.png$/.test(name)));
  const figures = (await ensureFigureImages(listing.app)).images;
  const zip = readZip(await buildPackageZip(listing.files, listing.title, listing.report, figures));
  const names = [...zip.keys()];
  assert.ok(names.some((name) => name.endsWith("/附图/图1.png")), names.join(", "));
  assert.ok(names.some((name) => name.endsWith("/附图/图2.png")), names.join(", "));
  assert.deepEqual([...(zip.get(names.find((name) => name.endsWith("/附图/图1.png")) ?? "") ?? new Uint8Array()).subarray(0, 8)], PNG_SIGNATURE);
  const readme = text(zip.get(names.find((name) => name.endsWith("00-提交说明.txt")) ?? ""));
  assert.match(readme, /附图\/图1\.png/);
  const request = text(readZip(await documentBytes((listing.files.find((file) => file.key === "request") ?? listing.files[0]).build())).get("word/document.xml"));
  assert.doesNotMatch(request, /待绘制/);
});

test("排版结果按解析对象记忆，形式检查与导出共用", () => {
  const app = parseApplication(FIGURE_SAMPLE);
  assert.equal(renderedFiguresOf(app), renderedFiguresOf(app));
  assert.equal(renderedFiguresOf(app).length, 2);
});
