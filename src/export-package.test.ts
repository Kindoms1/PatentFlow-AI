import test from "node:test";
import assert from "node:assert/strict";
import { buildPackageZip, documentBytes, listPackage } from "./export-package.ts";
import { listZip } from "./zip.ts";

const DRAFT = [
  "# 发明名称：一种雨水井截污装置",
  "",
  "## 说明书摘要",
  "本发明公开了一种雨水井截污装置，包括井框和弧形截污格栅，刮板由叶轮经曲柄连杆驱动沿格栅往复摆动，自动清除截留污物。",
  "",
  "## 权利要求书",
  "1. 一种雨水井截污装置，包括井框(1)，其特征在于，还包括截污格栅(2)和刮板(3)，所述刮板(3)由叶轮(4)驱动。",
  "2. 根据权利要求1所述的雨水井截污装置，其特征在于，所述截污格栅(2)呈弧形。",
  "",
  "## 技术领域",
  "本发明涉及市政排水设备技术领域。",
  "",
  "## 背景技术",
  "现有雨水井依赖人工清掐。【待检索补充对比文件】",
  "",
  "## 发明内容",
  "### 要解决的技术问题",
  "解决截污格栅易堵塞的问题。",
  "### 技术方案",
  "刮板由下泄水流驱动。",
  "### 有益效果",
  "无需外部电源即可自动清污。",
  "",
  "## 附图说明",
  "图1为本发明实施例的结构示意图。",
  "图2为截污格栅的剖视图。",
  "",
  "## 具体实施方式",
  "### 实施例1",
  "如图1所示，井框(1)下方设置截污格栅(2)。".repeat(30),
].join("\n");

test("listPackage splits a draft into the filing files in upload order", () => {
  const listing = listPackage(DRAFT, "测试");
  assert.equal(listing.error, "");
  const keys = listing.files.map((file) => file.key);
  for (const key of ["request", "abstract", "claims", "description", "review", "full"]) assert.ok(keys.includes(key as never), key);
  assert.equal(keys[0], "request");
  assert.ok(keys.indexOf("abstract") < keys.indexOf("claims"));
  assert.ok(keys.indexOf("claims") < keys.indexOf("description"));
  assert.deepEqual(listing.files.map((file) => file.no), listing.files.map((_, index) => String(index + 1).padStart(2, "0")));
  assert.ok(listing.files.every((file) => file.fileName.endsWith(".docx")));
});

test("every package file builds a real docx and the zip carries all of them", async () => {
  const listing = listPackage(DRAFT, "测试");
  for (const file of listing.files) {
    const bytes = await documentBytes(file.build());
    assert.equal(bytes[0], 0x50, file.fileName);
    assert.equal(bytes[1], 0x4b, file.fileName);
    assert.ok(bytes.length > 2000, file.fileName);
  }
  const zip = await buildPackageZip(listing.files, listing.title, listing.report);
  const names = listZip(zip).map((entry) => entry.name);
  assert.equal(names.length, listing.files.length + 1);
  assert.ok(names[0].endsWith("00-提交说明.txt"));
  assert.ok(names.some((name) => name.endsWith("权利要求书.docx")));
});

test("a text without claims is reported, not thrown", () => {
  const listing = listPackage("只是一段普通的聊天内容。", "测试");
  assert.equal(listing.files.length, 0);
  assert.ok(listing.error.length > 0);
});
