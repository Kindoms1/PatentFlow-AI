import { joinPages, pageText, type PdfPageText } from "./pdf-text.ts";

export async function readPdf(data: ArrayBuffer): Promise<string> {
  // The compatibility build supplies newer typed-array APIs that are not available
  // in every supported browser or in the Node runtime used by integration tests.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    const worker = await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  }
  const task = pdfjs.getDocument({ data: new Uint8Array(data) });
  try {
    const document = await task.promise;
    const pages: PdfPageText[] = [];
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      pages.push({ page: index, text: pageText(content.items) });
      page.cleanup();
    }
    return joinPages(pages);
  } finally {
    await task.destroy().catch(() => undefined);
  }
}
