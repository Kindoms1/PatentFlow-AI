/**
 * 附图资源：把草稿里的结构化附图数据排成 SVG，并生成 Word 和申请文件压缩包使用的 PNG。
 *
 * - 排版（renderFigure）是确定性的纯函数，按解析结果对象记忆，形式检查和 Word 导出共用同一份排版结果；
 * - PNG 需要异步栅格化（浏览器 <canvas>，Node 中 @napi-rs/canvas），按 SVG 内容缓存。
 *   导出前先 await ensureFigureImages(app)，之后同步构建 Word 文档时由 cachedFigureImages(app) 直接取用；
 *   没有缓存的图在 Word 中显示为占位，并在形式检查里列出。
 */
import type { ParsedApplication } from "./cnipa-format.ts";
import { mmToDocxPixels, renderFigure } from "./figure-render.ts";
import type { RenderedFigure } from "./figure-render.ts";
import { rasterizeFigure } from "./figure-raster.ts";

/** 栅格化分辨率：300 dpi，缩小到三分之二后线条和文字仍清晰。 */
export const FIGURE_DPI = 300;

export interface FigureImage {
  no: number;
  /** SVG 原图（UTF-8），Word 2016 及以后版本直接显示矢量图。 */
  svg: Uint8Array;
  /** 白底黑线 PNG，旧版 Word 的回退图，也是压缩包里的附图图片。 */
  png: Uint8Array;
  /** Word 中的显示尺寸（docx 按 96 dpi 像素换算）。 */
  displayWidth: number;
  displayHeight: number;
  widthMm: number;
  heightMm: number;
  pixelWidth: number;
  pixelHeight: number;
  dpi: number;
}

export interface FigureImageFailure {
  no: number;
  message: string;
}

export interface PreparedFigureImages {
  /** 图号 → 图像，只含附图说明中列出且有绘图数据的图。 */
  images: Map<number, FigureImage>;
  failed: FigureImageFailure[];
}

type CachedImage = Omit<FigureImage, "no">;

const CACHE_LIMIT = 64;
const renderedByApp = new WeakMap<ParsedApplication, RenderedFigure[]>();
const imageBySvg = new Map<string, CachedImage>();

/** 草稿里每份附图数据的排版结果（按图号排序；同一解析结果只排版一次）。 */
export function renderedFiguresOf(app: ParsedApplication): RenderedFigure[] {
  const known = renderedByApp.get(app);
  if (known) return known;
  const rendered = [...(app.figureSpecs ?? [])].sort((a, b) => a.no - b.no).map((spec) => renderFigure(spec));
  renderedByApp.set(app, rendered);
  return rendered;
}

/** 附图说明中列出、并且有绘图数据的图（导出到说明书附图的图）。 */
export function drawableFigures(app: ParsedApplication): RenderedFigure[] {
  const listed = new Set(app.figures.map((figure) => figure.no));
  return renderedFiguresOf(app).filter((figure) => listed.has(figure.no));
}

function remember(svg: string, image: CachedImage): void {
  if (imageBySvg.has(svg)) imageBySvg.delete(svg);
  imageBySvg.set(svg, image);
  while (imageBySvg.size > CACHE_LIMIT) {
    const oldest = imageBySvg.keys().next().value;
    if (oldest === undefined) break;
    imageBySvg.delete(oldest);
  }
}

function withNo(no: number, image: CachedImage): FigureImage {
  return { no, ...image };
}

/** 已经生成过图像的附图（同步，供构建 Word 文档时使用）。 */
export function cachedFigureImages(app: ParsedApplication): Map<number, FigureImage> {
  const out = new Map<number, FigureImage>();
  for (const figure of drawableFigures(app)) {
    const image = imageBySvg.get(figure.svg);
    if (image) out.set(figure.no, withNo(figure.no, image));
  }
  return out;
}

export interface FigureImageHooks {
  /** 开始处理每一幅图之前调用：done 为已处理的幅数，total 为总幅数，no 为图号。回调抛出的异常原样抛出（用于及时取消）。 */
  onFigure?: (done: number, total: number, no: number) => void | Promise<void>;
  /** 取消后不再处理剩余的图，已生成的图仍然返回。 */
  signal?: AbortSignal;
}

/** 为每幅可绘制的附图生成 SVG/PNG 图像；单幅失败不影响其他图，失败原因在 failed 中返回。自身不抛异常。 */
export async function ensureFigureImages(app: ParsedApplication, dpi = FIGURE_DPI, hooks: FigureImageHooks = {}): Promise<PreparedFigureImages> {
  const images = new Map<number, FigureImage>();
  const failed: FigureImageFailure[] = [];
  const encoder = new TextEncoder();
  const list = drawableFigures(app);
  for (const [index, figure] of list.entries()) {
    if (hooks.signal?.aborted) break;
    await hooks.onFigure?.(index, list.length, figure.no);
    const cached = imageBySvg.get(figure.svg);
    if (cached && cached.dpi === dpi) {
      images.set(figure.no, withNo(figure.no, cached));
      continue;
    }
    try {
      const raster = await rasterizeFigure(figure, dpi);
      const image: CachedImage = {
        svg: encoder.encode(figure.svg),
        png: raster.png,
        displayWidth: mmToDocxPixels(figure.widthMm),
        displayHeight: mmToDocxPixels(figure.heightMm),
        widthMm: figure.widthMm,
        heightMm: figure.heightMm,
        pixelWidth: raster.width,
        pixelHeight: raster.height,
        dpi: raster.dpi,
      };
      remember(figure.svg, image);
      images.set(figure.no, withNo(figure.no, image));
    } catch (error) {
      failed.push({ no: figure.no, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { images, failed };
}
