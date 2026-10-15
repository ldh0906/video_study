import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../paths";

/**
 * PDF reading with Mozilla's pdf.js: page text for the analysis, the PDF's own
 * bookmarks as an outline, and page images (via @napi-rs/canvas, a prebuilt
 * binary) for pages whose figures or formulas the text layer cannot carry.
 */

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type LoadingTask = ReturnType<Pdfjs["getDocument"]>;
type PdfDocument = Awaited<LoadingTask["promise"]>;

let lib: Promise<Pdfjs> | null = null;
const pdfjs = () => (lib ??= import("pdfjs-dist/legacy/build/pdf.mjs"));

const PDFJS_DIR = path.join(ROOT, "node_modules", "pdfjs-dist");
// pdf.js wants directory paths ending in "/"; CJK fonts need the CMaps
const CMAPS = `${path.join(PDFJS_DIR, "cmaps").replace(/\\/g, "/")}/`;
const FONTS = `${path.join(PDFJS_DIR, "standard_fonts").replace(/\\/g, "/")}/`;

export interface PdfPage {
  page: number; // 1-based
  text: string;
  /** embedded images drawn on the page */
  images: number;
  /** vector paths drawn (diagrams, plots, tables) */
  paths: number;
}

export interface PdfOutlineItem {
  title: string;
  page: number;
  level: number;
}

export interface PdfInfo {
  pageCount: number;
  title: string;
  outline: PdfOutlineItem[];
  pages: PdfPage[];
}

/** Open a PDF; call `close` when done (it ends pdf.js's worker for this document). */
async function open(file: string): Promise<{ doc: PdfDocument; close: () => Promise<void> }> {
  const { getDocument } = await pdfjs();
  const data = new Uint8Array(fs.readFileSync(file));
  const task: LoadingTask = getDocument({ data, cMapUrl: CMAPS, cMapPacked: true, standardFontDataUrl: FONTS, verbosity: 0 });
  return { doc: await task.promise, close: () => task.destroy() };
}

/** Text items joined in reading order; pdf.js marks line ends with hasEOL. */
function pageText(items: { str?: string; hasEOL?: boolean }[]) {
  let out = "";
  for (const it of items) {
    if (typeof it.str !== "string") continue;
    out += it.str;
    out += it.hasEOL ? "\n" : it.str && !/\s$/.test(it.str) ? " " : "";
  }
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function outlineOf(doc: PdfDocument): Promise<PdfOutlineItem[]> {
  const root = await doc.getOutline().catch(() => null);
  if (!root) return [];
  const out: PdfOutlineItem[] = [];
  const walk = async (items: typeof root, level: number) => {
    for (const it of items) {
      try {
        const dest = typeof it.dest === "string" ? await doc.getDestination(it.dest) : it.dest;
        const ref = dest?.[0];
        const index = ref && typeof ref === "object" ? await doc.getPageIndex(ref) : typeof ref === "number" ? ref : -1;
        if (index >= 0 && it.title.trim()) out.push({ title: it.title.trim(), page: index + 1, level });
      } catch {
        // a broken bookmark is just skipped
      }
      if (it.items?.length && level < 2) await walk(it.items, level + 1);
    }
  };
  await walk(root, 0);
  return out;
}

export async function readPdf(file: string, onProgress: (p: number) => void, signal?: AbortSignal): Promise<PdfInfo> {
  const { OPS } = await pdfjs();
  const imageOps = new Set<number>([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat]);
  const { doc, close } = await open(file);
  try {
    const meta = await doc.getMetadata().catch(() => null);
    const pages: PdfPage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      signal?.throwIfAborted();
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const ops = await page.getOperatorList().catch(() => null);
      const images = ops ? ops.fnArray.filter((f) => imageOps.has(f)).length : 0;
      const paths = ops ? ops.fnArray.filter((f) => f === OPS.constructPath).length : 0;
      pages.push({ page: n, text: pageText(content.items as { str?: string; hasEOL?: boolean }[]), images, paths });
      page.cleanup();
      if (n % 5 === 0 || n === doc.numPages) onProgress(n / doc.numPages);
    }
    const title = String((meta?.info as { Title?: string } | undefined)?.Title ?? "").trim();
    // exporters often leave a placeholder or the source file name as the title
    const junk = !title || /^(about:blank|untitled|제목 없음|microsoft (word|powerpoint) - )|\.(docx?|pptx?|hwpx?|pdf)$/i.test(title);
    return { pageCount: doc.numPages, title: junk ? "" : title, outline: await outlineOf(doc), pages };
  } finally {
    await close();
  }
}

/** Render pages to JPEG files `<dir>/p<page>.jpg`, at most `width` pixels wide. Existing files are kept. */
export async function renderPages(file: string, pageNumbers: number[], dir: string, width = 1400, signal?: AbortSignal) {
  const todo = pageNumbers.filter((n) => !fs.existsSync(pageImage(dir, n)));
  if (!todo.length) return;
  fs.mkdirSync(dir, { recursive: true });
  const { doc, close } = await open(file);
  try {
    for (const n of todo) {
      signal?.throwIfAborted();
      if (n < 1 || n > doc.numPages) continue;
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(3, width / base.width) });
      const factory = doc.canvasFactory as { create(w: number, h: number): { canvas: { toBuffer(mime: string, quality?: number): Buffer }; context: unknown } };
      const { canvas, context } = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
      // white paper behind transparent pages
      const ctx = context as { fillStyle: string; fillRect(x: number, y: number, w: number, h: number): void };
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: context as CanvasRenderingContext2D, viewport }).promise;
      fs.writeFileSync(pageImage(dir, n), canvas.toBuffer("image/jpeg", 82));
      page.cleanup();
    }
  } finally {
    await close();
  }
}

export const pageImage = (dir: string, page: number) => path.join(dir, `p${page}.jpg`);

/** Pages worth showing the model as images: figures, diagrams, or too little text to stand alone. */
export function isVisualPage(p: PdfPage) {
  return p.images > 0 || p.paths > 12 || p.text.replace(/\s/g, "").length < 250;
}
