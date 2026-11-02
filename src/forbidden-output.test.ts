/**
 * 正式输出的字节级回归测试：稿件中残留缺项占位和内部检索提示时，
 * Word 合订稿、导出包中的每一份文件都不得含禁用标记；内部审核单仍逐项列出待补充事实。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { Packer } from "docx";
import { formalCheck, parseApplication } from "./cnipa-format.ts";
import { findForbiddenMarkers } from "./draft-polish.ts";
import { buildApplicationDocument } from "./export-docx.ts";
import { documentBytes, listPackage } from "./export-package.ts";
import { FIGURE_SAMPLE } from "./figure-sample.ts";
import { LIBRARY_SAMPLES } from "./patent-library.ts";

/** Minimal ZIP reader (stored + deflate) over the central directory. */
function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const count = view.getUint16(eocd + 10, true);
  let ptr = view.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(ptr, true) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = view.getUint16(ptr + 10, true);
    const size = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const local = view.getUint32(ptr + 42, true);
    const name = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    out.set(name, method === 8 ? new Uint8Array(inflateRawSync(data)) : method === 0 ? data : (() => { throw new Error(`unsupported zip method ${method}`); })());
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** document.xml 的可见文字：去掉标签后拼接，避免一个词被拆在多个 run 里漏检。 */
function visibleText(zip: Map<string, Uint8Array>): string {
  const xml = new TextDecoder().decode(zip.get("word/document.xml") ?? new Uint8Array());
  assert.ok(xml.length > 0, "word/document.xml 存在");
  return xml.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

const INJECTED = "卷积核尺寸取【待发明人确认：卷积核尺寸】。作为【待发明人确认：驱动元件】的电机带动转轴转动。【待填写】现有方案存在滞后【待检索补充对比文件】。";

function markedDraft(): string {
  const heading = /^#{2,3}\s*具体实施方式[^\n]*\n/m.exec(FIGURE_SAMPLE);
  assert.ok(heading, "样例稿含具体实施方式一节");
  const at = heading.index + heading[0].length;
  return `${FIGURE_SAMPLE.slice(0, at)}${INJECTED}\n\n${FIGURE_SAMPLE.slice(at)}`;
}

const FORBIDDEN_VISIBLE = /【待|待发明人确认|待检索|待填写|模拟值，待实验验证|推断，待确认/;

test("解析：缺项原文列入 pendingMarks，正文改写为正式表述", () => {
  const app = parseApplication(markedDraft(), "测试");
  assert.ok(app.pendingMarks.includes("【待发明人确认：卷积核尺寸】"), app.pendingMarks.join("、"));
  assert.ok(app.pendingMarks.includes("【待发明人确认：驱动元件】"), app.pendingMarks.join("、"));
  const body = app.description.flatMap((part) => part.paragraphs.map((item) => item.text)).join("\n");
  assert.doesNotMatch(body, FORBIDDEN_VISIBLE);
  assert.match(body, /作为驱动元件的电机/);
  assert.match(body, /现有方案存在滞后/);
  assert.equal(findForbiddenMarkers(body).length, 0);
});

test("Word 合订稿：document.xml 不含任何禁用标记与审核内容", async () => {
  const app = parseApplication(markedDraft(), "测试");
  const report = formalCheck(app);
  const zip = readZip(new Uint8Array(await Packer.toBuffer(buildApplicationDocument(app, report))));
  const plain = visibleText(zip);
  assert.doesNotMatch(plain, FORBIDDEN_VISIBLE);
  assert.doesNotMatch(plain, /内部审核单|待补充事实/);
  assert.equal(findForbiddenMarkers(plain).length, 0);
  assert.match(plain, /作为驱动元件的电机/);
  for (const [name, data] of zip) {
    if (!/\.xml$/.test(name)) continue;
    assert.doesNotMatch(new TextDecoder().decode(data), /【待/, name);
  }
});

test("附内部审核单时：缺项逐项列出且不带方括号占位", async () => {
  const app = parseApplication(markedDraft(), "测试");
  const report = formalCheck(app);
  const plain = visibleText(readZip(new Uint8Array(await Packer.toBuffer(buildApplicationDocument(app, report, { includeReview: true })))));
  assert.match(plain, /内部审核单/);
  assert.match(plain, /待补充事实/);
  assert.match(plain, /卷积核尺寸/);
  assert.match(plain, /驱动元件/);
  assert.doesNotMatch(plain, /【待/);
  assert.doesNotMatch(plain, /待检索补充对比文件/);
});

test("导出包：每一份 Word 文件都不含方括号占位，正式分件不含审核内容", async () => {
  const listing = listPackage(markedDraft(), "测试");
  assert.equal(listing.error, "");
  assert.ok(listing.files.length > 0);
  let reviewSeen = false;
  for (const file of listing.files) {
    await file.prepare?.();
    const plain = visibleText(readZip(await documentBytes(file.build())));
    assert.doesNotMatch(plain, /【待|待检索补充/, file.key);
    if (file.key === "review") {
      reviewSeen = true;
      assert.match(plain, /卷积核尺寸/, "审核单列出待补充事实");
    } else {
      assert.doesNotMatch(plain, FORBIDDEN_VISIBLE, file.key);
      assert.doesNotMatch(plain, /内部审核单/, file.key);
      assert.equal(findForbiddenMarkers(plain).length, 0, file.key);
    }
  }
  assert.ok(reviewSeen, "导出包包含内部审核单");
});

test("知识库示范稿：预览原文不含缺项占位和撰写提示", () => {
  const raw = JSON.stringify(LIBRARY_SAMPLES);
  assert.ok(raw.length > 1000, "示范稿已加载");
  assert.doesNotMatch(raw, /【\s*待/);
  assert.doesNotMatch(raw, /待发明人确认|待检索补充|应注明型号|应以实验结果修改/);
});
