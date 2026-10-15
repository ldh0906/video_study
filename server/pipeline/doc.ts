import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { z } from "zod";
import { replacePages } from "../../shared/markdown";
import type { Analysis, Chapter, DocType, Lecture, Overview, SectionAnalysis, Segment } from "../../shared/types";
import { generateObject, generateText, strictJsonSchema, type LLMImage, type LLMUsage } from "../llm";
import { lectureDir, readJson, writeJson } from "../paths";
import {
  DocOutlineSchema,
  DocOverviewSchema,
  DocSectionSchema,
  docFieldsSystem,
  docNotesSystem,
  docOutlineSystem,
  docOverviewSystem,
} from "../prompts-doc";
import { isVisualPage, pageImage, readPdf, renderPages, type PdfInfo, type PdfPage } from "../tools/pdf";
import { fixStrings } from "./timestamps";
import { estimateTokens, mapLimit } from "./util";

/**
 * Analysis of a PDF. Same shape of result as a lecture (sections, overview),
 * with page numbers wherever a lecture has seconds. A section covers pages
 * [start, end), so `end` is the first page after it.
 */

export type DocOutline = z.infer<typeof DocOutlineSchema>;

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

export const pagesFile = (id: string) => lectureDir(id, "pages.json");
export const pageImagesDir = (id: string) => lectureDir(id, "pages");

export function getPages(id: string): PdfInfo | null {
  return readJson<PdfInfo | null>(pagesFile(id), null);
}

/** Read the PDF once; later runs reuse pages.json. The transcript copy lets the tutor search pages like transcript lines. */
export async function extractDoc(lecture: Lecture, onProgress: (p: number) => void, signal: AbortSignal): Promise<PdfInfo> {
  const cached = getPages(lecture.id);
  if (cached) return cached;
  const info = await readPdf(lecture.mediaPath!, onProgress, signal);
  if (!info.pages.some((p) => p.text.trim())) {
    // scanned PDFs have no text layer; the page images still carry the content
    console.warn(`[doc ${lecture.id}] no text layer, relying on page images`);
  }
  writeJson(pagesFile(lecture.id), info);
  return info;
}

export function pagesAsSegments(info: PdfInfo): Segment[] {
  return info.pages.map((p) => ({ start: p.page, end: p.page + 1, text: p.text }));
}

export function formatPages(pages: PdfPage[], images: Set<number> = new Set()) {
  return pages
    .map((p) => `<page n="${p.page}">${images.has(p.page) ? " (page image attached)" : ""}\n${p.text || "(no extractable text; see the page image)"}\n</page>`)
    .join("\n");
}

/** Citations of pages that don't exist become plain text. */
export function pageFixer(pageCount: number) {
  return (md: string) => replacePages(md, (page, whole) => (page >= 1 && page <= pageCount ? whole : whole.slice(1, -1)));
}

// --- parts ----------------------------------------------------------------------

export interface PageRange {
  start: number; // first page
  end: number; // page after the last
}

const PART_TOKENS = 6500;
const PART_PAGES = 24;

/** Split pages into study-sized parts, preferring to cut where a topic starts. */
export function buildDocSections(pages: PdfPage[], topicStarts: number[]): PageRange[] {
  const starts = new Set(topicStarts);
  const ranges: PageRange[] = [];
  let first = 0;
  let tokens = 0;
  for (let i = 0; i < pages.length; i++) {
    const t = estimateTokens(pages[i].text) + 120;
    const count = i - first;
    const full = count > 0 && (tokens + t > PART_TOKENS || count >= PART_PAGES);
    const goodCut = count > 0 && starts.has(pages[i].page) && (tokens > PART_TOKENS * 0.5 || count >= PART_PAGES / 2);
    if (full || goodCut) {
      ranges.push({ start: pages[first].page, end: pages[i].page });
      first = i;
      tokens = 0;
    }
    tokens += t;
  }
  if (pages.length) ranges.push({ start: pages[first].page, end: pages.at(-1)!.page + 1 });
  // a tiny tail joins the part before it
  if (ranges.length > 1) {
    const last = ranges.at(-1)!;
    const tail = pages.filter((p) => p.page >= last.start).reduce((n, p) => n + estimateTokens(p.text), 0);
    const prev = ranges.at(-2)!;
    if (tail < PART_TOKENS * 0.25 && last.end - last.start < 4 && last.end - prev.start <= PART_PAGES) {
      ranges.pop();
      ranges.at(-1)!.end = last.end;
    }
  }
  return ranges;
}

// --- outline --------------------------------------------------------------------

/** Whole text when it fits, otherwise the head of every page (headings live there). */
function outlineInput(info: PdfInfo) {
  const full = formatPages(info.pages);
  if (estimateTokens(full) < 100_000) return full;
  return info.pages.map((p) => `<page n="${p.page}">\n${p.text.slice(0, 350)}\n</page>`).join("\n");
}

export async function buildDocOutline(lecture: Lecture, info: PdfInfo, signal: AbortSignal, onUsage: (u: LLMUsage) => void): Promise<DocOutline> {
  const file = lectureDir(lecture.id, "outline.json");
  const system = docOutlineSystem(lecture.options.outputLanguage);
  const key = hash({ v: 1, system, schema: strictJsonSchema(DocOutlineSchema), model: lecture.options.analysis, pages: info.pages.map((p) => p.text), outline: info.outline, focus: lecture.options.focus });
  const cached = readJson<{ key: string; outline: DocOutline } | null>(file, null);
  if (cached?.key === key) return cached.outline;
  const bookmarks = info.outline.length ? `<bookmarks>\n${info.outline.map((b) => `${"  ".repeat(b.level)}- p.${b.page} ${b.title}`).join("\n")}\n</bookmarks>` : "";
  const { object, usage } = await generateObject({
    choice: lecture.options.analysis,
    system,
    messages: [
      {
        role: "user",
        content: [
          `<document>\n${outlineInput(info)}\n</document>`,
          bookmarks,
          `Document: ${lecture.title} (${info.pageCount} pages)`,
          lecture.options.focus ? `Note from the student: ${lecture.options.focus}` : "",
          "Classify this document and list its topic sequence and the concepts it introduces, with page numbers.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
    schema: DocOutlineSchema,
    name: "document_outline",
    maxTokens: 16000,
    signal,
  });
  onUsage(usage);
  writeJson(file, { key, outline: object });
  return object;
}

function outlineContext(outline: DocOutline, r: PageRange) {
  const topics = outline.topics.map((t) => `- [p.${t.page}] ${t.title}${t.page >= r.start && t.page < r.end ? "  ← this part" : ""}`).join("\n");
  const earlier = outline.concepts.filter((c) => c.page < r.start);
  return [
    `<document-outline>\n${topics}\n</document-outline>`,
    earlier.length ? `<introduced-earlier>\nConcepts the document already introduced before this part; refer to them, don't define them again:\n${earlier.map((c) => `- ${c.term} [p.${c.page}]: ${c.gist}`).join("\n")}\n</introduced-earlier>` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// --- per-part analysis ------------------------------------------------------------

interface Ctx {
  lecture: Lecture;
  info: PdfInfo;
  outline: DocOutline;
  docType: DocType;
  maxImages: number;
  concurrency: number;
  signal: AbortSignal;
  onUsage: (u: LLMUsage) => void;
  onProgress: (p: number, detail: string) => void;
}

function notesBudget(pages: PdfPage[], docType: DocType) {
  const chars = pages.reduce((n, p) => n + p.text.length, 0);
  // slides are terse: their notes are longer than the slides themselves
  const factor = docType === "slides" ? 1.6 : 0.7;
  const floor = docType === "slides" ? 250 * pages.length : 1200;
  return Math.round(Math.min(Math.max(chars * factor, floor, 1200), 7000) / 100) * 100;
}

function unwrapFence(text: string) {
  const m = text.trim().match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
  return (m ? m[1] : text).trim();
}

/** Visual pages of a part, spread evenly when there are more than the cap. */
function pickImagePages(pages: PdfPage[], max: number) {
  const visual = pages.filter(isVisualPage).map((p) => p.page);
  if (visual.length <= max) return visual;
  const step = visual.length / max;
  return Array.from({ length: max }, (_, k) => visual[Math.floor(k * step + step / 2)]);
}

export async function analyzeDocSections(ctx: Ctx, ranges: PageRange[]): Promise<SectionAnalysis[]> {
  const { lecture, info, docType } = ctx;
  const dir = lectureDir(lecture.id, "sections");
  const imagesFor = ranges.map((r) => pickImagePages(info.pages.filter((p) => p.page >= r.start && p.page < r.end), ctx.maxImages));
  const key = hash({
    v: 1,
    notes: docNotesSystem(lecture.options.outputLanguage, docType),
    fields: docFieldsSystem(lecture.options.outputLanguage, docType),
    schema: strictJsonSchema(DocSectionSchema),
    model: lecture.options.analysis,
    title: lecture.title,
    focus: lecture.options.focus,
    pages: info.pages.map((p) => p.text),
    ranges,
    imagesFor,
    outline: ctx.outline,
  });
  const keyFile = path.join(dir, "key.txt");
  if (!fs.existsSync(keyFile) || fs.readFileSync(keyFile, "utf8") !== key) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keyFile, key);
  }
  const fileFor = (i: number) => path.join(dir, `${String(i).padStart(3, "0")}.json`);
  let done = ranges.filter((_, i) => fs.existsSync(fileFor(i))).length;
  const report = () => ctx.onProgress(done / ranges.length, `${done} / ${ranges.length} 파트`);
  report();

  const notesSystem = docNotesSystem(lecture.options.outputLanguage, docType);
  const fieldsSystem = docFieldsSystem(lecture.options.outputLanguage, docType);
  const fix = pageFixer(info.pageCount);

  return mapLimit(ranges, ctx.concurrency, async (r, i) => {
    const cached = readJson<SectionAnalysis | null>(fileFor(i), null);
    if (cached) return cached;
    const pages = info.pages.filter((p) => p.page >= r.start && p.page < r.end);
    const imagePages = imagesFor[i];
    await renderPages(lecture.mediaPath!, imagePages, pageImagesDir(lecture.id), 1400, ctx.signal);
    const images: LLMImage[] = imagePages
      .filter((n) => fs.existsSync(pageImage(pageImagesDir(lecture.id), n)))
      .map((n) => ({ mime: "image/jpeg", data: fs.readFileSync(pageImage(pageImagesDir(lecture.id), n)).toString("base64"), caption: `Page ${n}:` }));
    const before = info.pages.filter((p) => p.page >= r.start - 1 && p.page < r.start);
    const after = info.pages.filter((p) => p.page === r.end);
    const partLine = `Document: ${lecture.title} (${docType}). This is part ${i + 1} of ${ranges.length}, covering pages ${r.start}–${r.end - 1} of ${info.pageCount}.`;

    const notesPrompt = [
      before.length ? `<previous-page>\n${formatPages(before).slice(-3000)}\n</previous-page>` : "",
      `<pages>\n${formatPages(pages, new Set(imagePages))}\n</pages>`,
      after.length ? `<next-page>\n${formatPages(after).slice(0, 2000)}\n</next-page>` : "",
      outlineContext(ctx.outline, r),
      partLine,
      lecture.options.focus ? `Note from the student about this document: ${lecture.options.focus}` : "",
      images.length ? `Images of ${images.length} pages with figures or formulas are attached, in page order.` : "",
      `Write the study notes for these pages only. Character budget: about ${notesBudget(pages, docType)} characters.`,
    ]
      .filter(Boolean)
      .join("\n\n");

    let notes = "";
    let maxTokens = 24000;
    for (let attempt = 0; ; attempt++) {
      const res = await generateText({ choice: lecture.options.analysis, system: notesSystem, messages: [{ role: "user", content: notesPrompt, images }], maxTokens, signal: ctx.signal });
      ctx.onUsage(res.usage);
      notes = unwrapFence(res.text);
      if (!res.truncated || attempt === 1) break;
      maxTokens *= 1.5;
    }

    const { object, usage } = await generateObject({
      choice: lecture.options.analysis,
      system: fieldsSystem,
      messages: [{ role: "user", content: [`<pages>\n${formatPages(pages)}\n</pages>`, `<notes>\n${notes}\n</notes>`, partLine, "Fill in the study fields for this part."].join("\n\n") }],
      schema: DocSectionSchema,
      name: "document_section_fields",
      maxTokens: 16000,
      signal: ctx.signal,
    });
    ctx.onUsage(usage);

    const clamp = (p: number) => Math.min(Math.max(Math.round(p), r.start), r.end - 1);
    const paged = <T extends { page: number }>(items: T[]) => items.map(({ page, ...rest }) => ({ ...rest, time: clamp(page) }));
    const result: SectionAnalysis = fixStrings(
      {
        index: i,
        start: r.start,
        end: r.end,
        title: object.title,
        summary: object.summary,
        notes,
        keyPoints: paged(object.keyPoints),
        concepts: paged(object.concepts),
        difficult: paged(object.difficult),
        selfCheck: paged(object.selfCheck),
        cards: paged(object.cards),
        flags: paged(object.flags),
      },
      fix,
    );
    writeJson(fileFor(i), result);
    done++;
    report();
    return result;
  });
}

// --- synthesis --------------------------------------------------------------------

function digest(s: SectionAnalysis) {
  return [
    `### Part ${s.index + 1}: ${s.title} [p.${s.start}–${s.end - 1}]`,
    s.summary,
    "Key points:",
    ...s.keyPoints.map((k) => `- [p.${k.time}] ${k.point}`),
    "Concepts:",
    ...s.concepts.map((c) => `- [p.${c.time}] ${c.term}: ${c.definition}`),
    "Conceptual bottlenecks:",
    ...s.difficult.map((d) => `- [p.${d.time}] ${d.topic}: ${d.why}`),
    // the exam builder relies on these cues, so the overview sees them verbatim
    ...(s.notes.includes("**중요**") ? ["Marked important in the notes:", ...s.notes.split("\n").filter((l) => l.includes("**중요**")).map((l) => `- ${l.trim()}`)] : []),
    ...(s.flags?.length ? ["Flagged claims (keep them flagged):", ...s.flags.map((f) => `- [p.${f.time}] (${f.kind}) ${f.text}`)] : []),
  ].join("\n");
}

export async function synthesizeDoc(lecture: Lecture, info: PdfInfo, sections: SectionAnalysis[], outline: DocOutline, signal: AbortSignal, onUsage: (u: LLMUsage) => void): Promise<Analysis> {
  const { object, usage } = await generateObject({
    choice: lecture.options.analysis,
    system: docOverviewSystem(lecture.options.outputLanguage),
    messages: [
      {
        role: "user",
        content: [
          `<document-outline>\n${outline.topics.map((t) => `- [p.${t.page}] ${t.title}`).join("\n")}\n</document-outline>`,
          `<part-analyses>\n${sections.map(digest).join("\n\n")}\n</part-analyses>`,
          `Document: ${lecture.title} (${info.pageCount} pages; the outline pass classified it as ${outline.docType})`,
          lecture.options.focus ? `Note from the student: ${lecture.options.focus}` : "",
          "Synthesize the overview of this document.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
    schema: DocOverviewSchema,
    name: "document_overview",
    maxTokens: 32000,
    signal,
  });
  onUsage(usage);

  const last = info.pageCount;
  const clamp = (p: number) => Math.min(Math.max(1, Math.round(p)), last);
  const starts = object.chapters
    .map((c) => ({ ...c, page: clamp(c.page) }))
    .sort((a, b) => a.page - b.page)
    .filter((c, i, arr) => i === 0 || c.page > arr[i - 1].page);
  if (starts.length) starts[0].page = 1;
  const chapters: Chapter[] = (starts.length ? starts : [{ title: object.title, page: 1, summary: object.oneLiner }]).map((c, i, arr) => {
    const end = i + 1 < arr.length ? arr[i + 1].page : last + 1;
    return { title: c.title, summary: c.summary, start: c.page, end, sections: sections.filter((s) => s.start < end && s.end > c.page).map((s) => s.index) };
  });

  const overview: Overview = fixStrings(
    {
      title: object.title,
      oneLiner: object.oneLiner,
      summary: object.summary,
      objectives: object.objectives,
      prerequisites: object.prerequisites,
      chapters,
      glossary: object.glossary.map(({ page, ...g }) => ({ ...g, time: clamp(page) })),
      mindmap: object.mindmap,
      difficulty: Math.min(5, Math.max(1, Math.round(object.difficulty))),
      tags: object.tags,
      issues: object.issues.map(({ page, ...x }) => ({ ...x, time: clamp(page) })),
      docType: object.docType,
      emphasis: object.emphasis.map(({ page, ...x }) => ({ ...x, time: clamp(page) })),
    },
    pageFixer(last),
  );
  return { overview, sections, model: lecture.options.analysis.model, createdAt: Date.now() };
}
