import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { crc32, listZip, readZip, writeZip } from "./zip.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

test("crc32 matches the reference value", () => {
  assert.equal(crc32(enc.encode("123456789")), 0xcbf43926);
});

test("writeZip → readZip keeps UTF-8 names and bytes, and dedupes names", async () => {
  const zip = writeZip([
    { name: "04-权利要求书.docx", data: enc.encode("claims") },
    { name: "提交说明.txt", data: enc.encode("说明") },
    { name: "提交说明.txt", data: enc.encode("again") },
  ]);
  assert.equal(zip[0], 0x50);
  assert.equal(zip[1], 0x4b);
  const names = listZip(zip).map((entry) => entry.name);
  assert.deepEqual(names, ["04-权利要求书.docx", "提交说明.txt", "提交说明(2).txt"]);
  const files = await readZip(zip);
  assert.equal(dec.decode(files.get("提交说明.txt")), "说明");
  assert.equal(dec.decode(files.get("提交说明(2).txt")), "again");
});

function deflatedZip(name: string, text: string): Uint8Array {
  const data = enc.encode(text);
  const packed = new Uint8Array(deflateRawSync(data));
  const nameBytes = enc.encode(name);
  const local = new Uint8Array(30 + nameBytes.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint16(8, 8, true);
  lv.setUint32(14, crc32(data), true);
  lv.setUint32(18, packed.length, true);
  lv.setUint32(22, data.length, true);
  lv.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  const central = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(10, 8, true);
  cv.setUint32(16, crc32(data), true);
  cv.setUint32(20, packed.length, true);
  cv.setUint32(24, data.length, true);
  cv.setUint16(28, nameBytes.length, true);
  central.set(nameBytes, 46);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length + packed.length, true);
  const out = new Uint8Array(local.length + packed.length + central.length + end.length);
  out.set(local, 0);
  out.set(packed, local.length);
  out.set(central, local.length + packed.length);
  out.set(end, local.length + packed.length + central.length);
  return out;
}

test("readZip inflates deflate entries", { skip: typeof DecompressionStream === "undefined" }, async () => {
  const text = "<w:document>一种雨水井截污装置</w:document>".repeat(20);
  const files = await readZip(deflatedZip("word/document.xml", text));
  assert.equal(dec.decode(files.get("word/document.xml")), text);
});

test("listZip rejects data that is not a zip", () => {
  assert.throws(() => listZip(enc.encode("not a zip file at all, just text")), /不是有效/);
});
