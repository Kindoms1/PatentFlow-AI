/**
 * Rebuilds readable text from pdf.js text items.
 *
 * pdf.js returns one item per text run, each with its own position. Joining the runs with "" glued the
 * last word of every line to the first word of the next ("inRemote", "SegmentationAnonymous") and
 * flattened each page into a single line. Here each run's position restores word spaces, line breaks and
 * paragraph breaks; words hyphenated across a line end are rejoined, and CJK text gets no stray spaces.
 */

export interface PdfTextRun {
  str: string;
  /** pdf.js transform matrix [a, b, c, d, e, f]; (e, f) is the run origin in PDF space, where y grows upward. */
  transform?: number[];
  /** Advance width of the run in PDF space units. */
  width?: number;
  height?: number;
  /** pdf.js sets this when a line ends after the run. */
  hasEOL?: boolean;
}

export interface PdfPageText {
  /** 1-based page number in the PDF. */
  page: number;
  text: string;
}

interface Cursor {
  y: number | null;
  end: number | null;
  size: number;
  eol: boolean;
}

const CJK = /[\u2e80-\u9fff\u3000-\u303f\uf900-\ufaff\uff00-\uffef]/;

function isRun(item: unknown): item is PdfTextRun {
  return typeof item === "object" && item !== null && typeof (item as { str?: unknown }).str === "string";
}

function position(run: PdfTextRun): { x: number; y: number } | null {
  const t = run.transform;
  if (!Array.isArray(t) || t.length < 6 || !Number.isFinite(t[4]) || !Number.isFinite(t[5])) return null;
  return { x: t[4], y: t[5] };
}

function fontSize(run: PdfTextRun): number {
  const t = run.transform;
  if (Array.isArray(t) && t.length >= 4) {
    const size = Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1]);
    if (Number.isFinite(size) && size > 0) return size;
  }
  return run.height && run.height > 0 ? run.height : 10;
}

function needsSpace(out: string, next: string): boolean {
  const last = out.slice(-1);
  const first = next.charAt(0);
  if (!last || !first || /\s/.test(last) || /\s/.test(first)) return false;
  return !(CJK.test(last) && CJK.test(first));
}

function separator(prev: Cursor, at: { x: number; y: number } | null, size: number, out: string, next: string): string {
  if (!at || prev.y === null || prev.end === null) return prev.eol ? "\n" : "";
  const lineHeight = Math.max(prev.size, size);
  const dy = prev.y - at.y; // positive: moved down the page
  // A big drop is a new paragraph; jumping back up the page is a new column or a float.
  if (dy > lineHeight * 1.9 || dy < -lineHeight * 1.2) return "\n\n";
  if (Math.abs(dy) > lineHeight * 0.55) return "\n";
  if (prev.eol) return "\n";
  const gap = at.x - prev.end;
  if (gap < -lineHeight) return "\n";
  if (gap > lineHeight * 0.18) return needsSpace(out, next) ? " " : "";
  return "";
}

function tidy(text: string): string {
  return text
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/([A-Za-z])-\n([a-z])/g, "$1$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Text of one page from `page.getTextContent().items`; marked-content items are skipped. */
export function pageText(items: readonly unknown[]): string {
  let out = "";
  let prev: Cursor | null = null;
  for (const item of items) {
    if (!isRun(item)) continue;
    if (!item.str) {
      // Empty runs only carry line ends.
      if (item.hasEOL && prev) prev.eol = true;
      continue;
    }
    const at = position(item);
    const size = fontSize(item);
    if (prev) out += separator(prev, at, size, out, item.str);
    out += item.str;
    const width = Number.isFinite(item.width) ? (item.width as number) : 0;
    prev = at
      ? { y: at.y, end: at.x + width, size, eol: Boolean(item.hasEOL) }
      : { y: null, end: null, size, eol: Boolean(item.hasEOL) };
  }
  return tidy(out);
}

/**
 * Whole-document text with a 【第 N 页】 label before every page that has text, so answers can cite pages.
 * Returns "" when no page has text (a scanned PDF), which lets the caller report the missing text layer.
 */
export function joinPages(pages: readonly PdfPageText[]): string {
  return pages
    .filter((page) => page.text.trim())
    .map((page) => `【第 ${page.page} 页】\n${page.text.trim()}`)
    .join("\n\n");
}