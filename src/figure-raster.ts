/**
 * 附图 SVG → PNG（Word 中 SVG 的兼容回退图，以及压缩包里单独的附图图片）。
 *
 * 浏览器里用 <canvas> 栅格化；Node（测试、命令行导出）里用 @napi-rs/canvas，它随 pdfjs-dist 作为可选依赖安装，
 * 用变量形式的动态 import，Vite 不会把它打进前端包。两者都画在白底上，输出黑白线条图。
 */
import type { RenderedFigure } from "./figure-render.ts";
import { rasterSize } from "./figure-render.ts";
import { crc32 } from "./zip.ts";

export interface RasterFigure {
  no: number;
  png: Uint8Array;
  width: number;
  height: number;
  dpi: number;
}

interface NodeCanvasModule {
  createCanvas(width: number, height: number): {
    getContext(kind: "2d"): {
      fillStyle: string;
      fillRect(x: number, y: number, w: number, h: number): void;
      drawImage(image: unknown, x: number, y: number, w: number, h: number): void;
    };
    toBuffer(mime: "image/png"): Uint8Array;
  };
  loadImage(source: Uint8Array): Promise<unknown>;
}

let nodeCanvas: Promise<NodeCanvasModule | null> | null = null;

function loadNodeCanvas(): Promise<NodeCanvasModule | null> {
  if (!nodeCanvas) {
    const specifier = "@napi-rs/canvas";
    nodeCanvas = import(/* @vite-ignore */ specifier).then((mod: unknown) => mod as NodeCanvasModule).catch(() => null);
  }
  return nodeCanvas;
}

async function browserPng(svg: string, width: number, height: number): Promise<Uint8Array> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image(width, height);
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("附图 SVG 无法在浏览器中解码。"));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器不支持 canvas，无法生成附图图片。");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("附图 PNG 编码失败。");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function nodePng(svg: string, width: number, height: number): Promise<Uint8Array> {
  const mod = await loadNodeCanvas();
  if (!mod) throw new Error("当前环境没有可用的栅格化组件（@napi-rs/canvas），无法生成附图图片。");
  const image = await mod.loadImage(new TextEncoder().encode(svg));
  const canvas = mod.createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return new Uint8Array(canvas.toBuffer("image/png"));
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index += 1) chunk[4 + index] = type.charCodeAt(index);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

/**
 * 在 PNG 中写入 pHYs 分辨率块（像素/米），使单独打开或插入的附图图片按实际 dpi 呈现尺寸。
 * canvas 编码的 PNG 不带 pHYs，查看器会按 72/96 dpi 理解为超大图片。已有 pHYs 时替换；输入不是完整 PNG 时原样返回。
 */
export function withPngDpi(png: Uint8Array, dpi: number): Uint8Array {
  if (png.length < 33 || !PNG_SIGNATURE.every((byte, index) => png[index] === byte)) return png;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const pixelsPerMetre = Math.round(dpi / 0.0254);
  const phys = new Uint8Array(9);
  const physView = new DataView(phys.buffer);
  physView.setUint32(0, pixelsPerMetre);
  physView.setUint32(4, pixelsPerMetre);
  phys[8] = 1;
  const parts: Uint8Array[] = [png.subarray(0, 8)];
  let offset = 8;
  let inserted = false;
  let ended = false;
  while (offset + 12 <= png.length) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > png.length) return png;
    const type = String.fromCharCode(png[offset + 4], png[offset + 5], png[offset + 6], png[offset + 7]);
    if (type !== "pHYs") parts.push(png.subarray(offset, end));
    if (type === "IHDR" && !inserted) {
      parts.push(pngChunk("pHYs", phys));
      inserted = true;
    }
    offset = end;
    if (type === "IEND") {
      ended = true;
      break;
    }
  }
  if (!inserted || !ended) return png;
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

/** 把一幅附图栅格化为 PNG；默认 300 dpi。 */
export async function rasterizeFigure(figure: RenderedFigure, dpi = 300): Promise<RasterFigure> {
  const { width, height } = rasterSize(figure, dpi);
  const inBrowser = typeof window !== "undefined" && typeof document !== "undefined" && typeof Image !== "undefined";
  const raw = inBrowser ? await browserPng(figure.svg, width, height) : await nodePng(figure.svg, width, height);
  const png = withPngDpi(raw, dpi);
  return { no: figure.no, png, width, height, dpi };
}

export async function rasterizeFigures(figures: RenderedFigure[], dpi = 300): Promise<Map<number, RasterFigure>> {
  const out = new Map<number, RasterFigure>();
  for (const figure of figures) out.set(figure.no, await rasterizeFigure(figure, dpi));
  return out;
}
