/**
 * PDF text keeps a 【第 N 页】 marker at the top of every page (see read-pdf.ts). The page count shown on
 * attachment chips is read back from those markers, so it needs no extra field in older saved cases.
 */
const PAGE_MARK = /【第\s*(\d+)\s*页】/g;

/** Highest page number marked in the text; 0 when the text carries no page markers (Word, Markdown, pasted text). */
export function pageCount(text: string): number {
  let max = 0;
  for (const match of (text || "").matchAll(PAGE_MARK)) max = Math.max(max, Number(match[1]));
  return max;
}

/** "9 页 · 40813 字" for paged material, "5 字" otherwise. An explicit `pages` wins over counting markers in `text`. */
export function sizeLabel(item: { chars: number; pages?: number; text?: string }): string {
  const pages = item.pages ?? (item.text ? pageCount(item.text) : 0);
  return pages > 0 ? `${pages} 页 · ${item.chars} 字` : `${item.chars} 字`;
}