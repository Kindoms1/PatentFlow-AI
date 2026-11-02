/**
 * 轻量 ZIP 读写（浏览器与 Node 通用，无第三方依赖）。
 * - readZip：读取 Office Open XML 容器（docx / pptx / xlsx），支持“存储”和“deflate”两种条目；
 *   deflate 用平台自带的 DecompressionStream("deflate-raw") 解压。
 * - writeZip：把生成好的多个文件打成一个 zip（存储方式，文件名 UTF-8）。docx 本身已压缩，再压缩收益很小。
 */

export interface ZipInput {
  name: string;
  data: Uint8Array;
  date?: Date;
}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) crc = CRC_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosStamp(date: Date): { time: number; day: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) return name;
  const dot = name.lastIndexOf(".");
  for (let index = 2; ; index += 1) {
    const candidate = dot > 0 ? `${name.slice(0, dot)}(${index})${name.slice(dot)}` : `${name}(${index})`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Build a zip archive with stored (uncompressed) entries and UTF-8 file names. */
export function writeZip(entries: ZipInput[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  const used = new Set<string>();
  let offset = 0;
  for (const entry of entries) {
    const name = uniqueName(entry.name.replace(/\\/g, "/").replace(/^\/+/, "") || "file", used);
    used.add(name);
    const nameBytes = encoder.encode(name);
    const { time, day } = dosStamp(entry.date ?? new Date());
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, day, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, day, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    parts.push(local, entry.data);
    centrals.push(central);
    offset += local.length + size;
  }
  const centralSize = centrals.reduce((sum, item) => sum + item.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + end.length);
  let cursor = 0;
  for (const part of [...parts, ...centrals, end]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

function viewOf(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function bytesOf(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

/** Read the central directory. Throws for data that is not a zip container. */
export function listZip(input: ArrayBuffer | Uint8Array): ZipEntry[] {
  const data = bytesOf(input);
  if (data.length < 22) throw new Error("不是有效的 ZIP 或 Office 文件。");
  const view = viewOf(data);
  let eocd = -1;
  for (let index = data.length - 22; index >= Math.max(0, data.length - 65557); index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 ZIP 或 Office 文件。");
  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n += 1) {
    if (cursor + 46 > data.length || view.getUint32(cursor, true) !== 0x02014b50) throw new Error("ZIP 目录已损坏。");
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    entries.push({
      name: decoder.decode(data.subarray(cursor + 46, cursor + 46 + nameLength)),
      method: view.getUint16(cursor + 10, true),
      compressedSize: view.getUint32(cursor + 20, true),
      size: view.getUint32(cursor + 24, true),
      offset: view.getUint32(cursor + 42, true),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new Error("当前浏览器不支持解压 Office 文件，请升级浏览器后再试。");
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Extract the entries `accept` asks for (all by default). Directories are skipped. */
export async function readZip(input: ArrayBuffer | Uint8Array, accept: (name: string) => boolean = () => true): Promise<Map<string, Uint8Array>> {
  const data = bytesOf(input);
  const view = viewOf(data);
  const out = new Map<string, Uint8Array>();
  for (const entry of listZip(data)) {
    if (entry.name.endsWith("/") || !accept(entry.name)) continue;
    if (entry.offset + 30 > data.length || view.getUint32(entry.offset, true) !== 0x04034b50) throw new Error("ZIP 条目已损坏。");
    const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
    const raw = data.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) out.set(entry.name, raw.slice());
    else if (entry.method === 8) out.set(entry.name, await inflateRaw(raw));
    else throw new Error(`不支持的压缩方式（${entry.method}）。`);
  }
  return out;
}
