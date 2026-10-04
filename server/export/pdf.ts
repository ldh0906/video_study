import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import {
  LineCapStyle,
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
  PDFTextField,
  rgb,
  type PDFPage,
} from "pdf-lib";
import type { ExportOptions, ExportResult, Lecture } from "../../shared/types";
import { DATA_DIR, lectureDir, readJson, writeJson } from "../paths";
import { geometry } from "./document";

const SLOT = "https://slot.invalid/";
const MM = 72 / 25.4;

// ---------------------------------------------------------------------------
// browser: drive the Edge/Chrome already on the machine (no Chromium download)
// ---------------------------------------------------------------------------

function browserPath(): string {
  const candidates = [
    process.env.LECTURE_PDF_BROWSER,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ].filter(Boolean) as string[];
  const exe = candidates.find((p) => fs.existsSync(p));
  if (!exe) throw new Error("PDF를 만들려면 Microsoft Edge 또는 Chrome이 필요합니다. 설치되어 있다면 LECTURE_PDF_BROWSER 환경변수로 경로를 지정해 주세요.");
  return exe;
}

/** Chrome writes link targets as named destinations; map each id to its 1-based page. */
async function namedDestPages(bytes: Uint8Array): Promise<Record<string, number>> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const index = new Map(doc.getPages().map((p, i) => [p.ref.toString(), i + 1]));
  const out: Record<string, number> = {};
  const dests = doc.catalog.lookup(PDFName.of("Dests"));
  if (!(dests instanceof PDFDict)) return out;
  for (const [key, value] of dests.entries()) {
    const d = doc.context.lookup(value);
    const arr = d instanceof PDFArray ? d : d instanceof PDFDict ? d.lookup(PDFName.of("D"), PDFArray) : undefined;
    const pageRef = arr?.get(0)?.toString();
    if (pageRef && index.has(pageRef)) out[decodeName(key.asString().slice(1))] = index.get(pageRef)!;
  }
  return out;
}

/** PDF names escape non-regular characters as #xx. */
function decodeName(n: string) {
  return n.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

async function render(url: string, onStage: (s: string) => void) {
  const browser = await puppeteer.launch({
    executablePath: browserPath(),
    headless: true,
    userDataDir: path.join(DATA_DIR, "tmp", "pdf-profile"),
    args: ["--no-first-run", "--disable-extensions", "--disable-gpu"],
  });
  try {
    const page = await browser.newPage();
    onStage("조판 준비 중");
    await page.goto(url, { waitUntil: "networkidle0", timeout: 0 });
    await page.evaluate(() => document.fonts.ready);
    const labels = (await page.evaluate(() => JSON.parse(document.getElementById("lecture-lens-labels")?.textContent || "{}"))) as Record<string, string>;
    const opts = { preferCSSPageSize: true, printBackground: true, outline: true, tagged: true, timeout: 0 } as const;

    onStage("쪽 나누는 중 (1/2)");
    let pdf = await page.pdf(opts);
    let map = await namedDestPages(pdf);
    // Fill page numbers and print again until the layout stops moving (placeholders are fixed-width, so 1–2 rounds).
    for (let round = 0; round < 3; round++) {
      onStage(`쪽 번호 넣는 중 (${round + 2}/2)`);
      await page.evaluate((m: Record<string, number>) => {
        document.querySelectorAll<HTMLElement>("[data-pg]").forEach((el) => {
          el.textContent = m[el.dataset.pg!] ? String(m[el.dataset.pg!]) : "–";
        });
      }, map);
      pdf = await page.pdf(opts);
      const next = await namedDestPages(pdf);
      const same = JSON.stringify(next) === JSON.stringify(map);
      map = next;
      if (same) break;
    }
    return { pdf, labels };
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// post-processing with pdf-lib
// ---------------------------------------------------------------------------

interface Slot {
  name: string;
  pi: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Pull our marker/slot link annotations out of the PDF, returning their rectangles. */
function takeSlots(doc: PDFDocument): Slot[] {
  const ctx = doc.context;
  const slots: Slot[] = [];
  doc.getPages().forEach((page, pi) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let k = annots.size() - 1; k >= 0; k--) {
      const a = ctx.lookup(annots.get(k));
      if (!(a instanceof PDFDict)) continue;
      const action = a.lookup(PDFName.of("A"));
      const uri = action instanceof PDFDict ? action.lookup(PDFName.of("URI")) : undefined;
      const s = uri instanceof PDFString || uri instanceof PDFHexString ? uri.decodeText() : "";
      if (!s.startsWith(SLOT)) continue;
      const [x1, y1, x2, y2] = a
        .lookup(PDFName.of("Rect"), PDFArray)
        .asArray()
        .map((n) => (n as unknown as { asNumber(): number }).asNumber());
      slots.push({ name: decodeURIComponent(s.slice(SLOT.length)), pi, x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
      const ref = annots.get(k);
      annots.remove(k);
      if (ref && "objectNumber" in ref) ctx.delete(ref as never);
    }
  });
  return slots;
}

/** Dot grid drawn as dashed lines with round caps: one path per row keeps the file small. */
function dotGrid(page: PDFPage, x0: number, y0: number, x1: number, y1: number) {
  const step = 5 * MM;
  const color = rgb(0.7, 0.7, 0.77);
  const width = x1 - x0 - ((x1 - x0) % step);
  for (let y = y1; y >= y0; y -= step) {
    page.drawLine({
      start: { x: x0, y },
      end: { x: x0 + width + 0.01, y },
      thickness: 0.9,
      color,
      dashArray: [0.01, step - 0.01],
      lineCap: LineCapStyle.Round,
    });
  }
}

/** Register a non-embedded Adobe-Korea1 font so typed Hangul shows in viewers (embedded subsets don't work for typing). */
function koreanFieldFont(doc: PDFDocument) {
  const ctx = doc.context;
  const fd = ctx.register(
    ctx.obj({
      Type: "FontDescriptor",
      FontName: "HYGoThic-Medium",
      Flags: 6,
      FontBBox: [-6, -145, 1003, 880],
      ItalicAngle: 0,
      Ascent: 880,
      Descent: -120,
      CapHeight: 880,
      StemV: 93,
    }),
  );
  const cid = ctx.register(
    ctx.obj({
      Type: "Font",
      Subtype: "CIDFontType0",
      BaseFont: "HYGoThic-Medium",
      CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Korea1"), Supplement: 1 },
      FontDescriptor: fd,
      DW: 1000,
      W: [1, 95, 500, 8094, 8190, 500],
    }),
  );
  return ctx.register(ctx.obj({ Type: "Font", Subtype: "Type0", BaseFont: "HYGoThic-Medium", Encoding: "UniKS-UCS2-H", DescendantFonts: [cid] }));
}

async function postProcess(bytes: Uint8Array, lecture: Lecture, o: ExportOptions, labels: Record<string, string>, title: string) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages();
  const slots = takeSlots(doc);
  const g = geometry(o);
  const coverPages = new Set(slots.filter((s) => s.name === "mk.cover").map((s) => s.pi));
  const blankPages = new Set(slots.filter((s) => s.name === "mk.blank").map((s) => s.pi));
  const fieldSlots = slots.filter((s) => !s.name.startsWith("mk."));

  // ---- grids: blank/recall pages get a full dot grid, body pages a dotted note column ----
  for (const pi of blankPages) {
    const p = pages[pi];
    const W = p.getWidth();
    const H = p.getHeight();
    const m = g.blankMargin * MM;
    const fill = fieldSlots.find((s) => s.pi === pi);
    const top = fill ? fill.y + fill.h : H - m - 50 * MM;
    dotGrid(p, m + 1.5 * MM, m + 8 * MM, W - m, top);
  }
  const [, right, bottom] = g.margin;
  const notePages = pages.map((_, i) => i).filter((i) => !coverPages.has(i) && !blankPages.has(i));
  if (o.layout === "margin") {
    for (const pi of notePages) {
      const p = pages[pi];
      const W = p.getWidth();
      const H = p.getHeight();
      dotGrid(p, W - right * MM + 7 * MM, bottom * MM + 2 * MM, W - 9 * MM, H - g.margin[0] * MM - 2 * MM);
    }
  }

  // ---- typing edition: AcroForm fields ----
  let fieldCount = 0;
  if (o.fields) {
    const form = doc.getForm();
    const kr = koreanFieldFont(doc);
    const DA = "/HYGoThic 10 Tf 0.12 0.12 0.45 rg";
    const clear = { borderWidth: 0, borderColor: undefined, backgroundColor: undefined };
    const texts: PDFTextField[] = [];
    const used = new Set<string>();
    for (const s of fieldSlots) {
      if (used.has(s.name)) continue; // a slot split across pages: keep the first piece
      used.add(s.name);
      if (s.name.startsWith("cb.")) {
        form.createCheckBox(s.name).addToPage(pages[s.pi], { x: s.x, y: s.y, width: s.w, height: s.h, ...clear });
      } else {
        const tf = form.createTextField(s.name);
        tf.enableMultiline();
        tf.addToPage(pages[s.pi], { x: s.x + 1.5, y: s.y + 1, width: Math.max(4, s.w - 3), height: Math.max(4, s.h - 2), ...clear });
        texts.push(tf);
      }
      fieldCount++;
    }
    if (o.layout === "margin") {
      for (const pi of notePages) {
        const p = pages[pi];
        const W = p.getWidth();
        const H = p.getHeight();
        const name = `margin.p${pi + 1}`;
        labels[name] = `p.${pi + 1} 여백 메모`;
        const tf = form.createTextField(name);
        tf.enableMultiline();
        tf.addToPage(p, { x: W - right * MM + 6 * MM, y: bottom * MM + 2 * MM, width: right * MM - 14 * MM, height: H - (g.margin[0] + bottom) * MM - 4 * MM, ...clear });
        texts.push(tf);
        fieldCount++;
      }
    }
    // Field text uses the Korean CID font; pdf-lib's own appearances would fall back to Helvetica.
    const acro = doc.catalog.lookup(PDFName.of("AcroForm"), PDFDict);
    const ctx = doc.context;
    const dr = (acro.lookup(PDFName.of("DR")) as PDFDict | undefined) ?? ctx.obj({});
    const fonts = (dr.lookup(PDFName.of("Font")) as PDFDict | undefined) ?? ctx.obj({});
    fonts.set(PDFName.of("HYGoThic"), kr);
    dr.set(PDFName.of("Font"), fonts);
    acro.set(PDFName.of("DR"), dr);
    acro.set(PDFName.of("DA"), PDFString.of(DA));
    for (const tf of texts) {
      tf.acroField.setDefaultAppearance(DA);
      for (const w of tf.acroField.getWidgets()) {
        const ap = w.getNormalAppearance();
        const stream = ctx.lookup(ap) as { dict?: PDFDict } | undefined;
        stream?.dict?.set(PDFName.of("Resources"), ctx.obj({ Font: { HYGoThic: kr } }));
      }
    }
  }

  doc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
  doc.setTitle(`${title} — 학습서`, { showInWindowTitleBar: true });
  doc.setLanguage("ko-KR");
  doc.setAuthor("Lecture Lens");
  doc.setCreator("Lecture Lens");
  doc.setSubject(lecture.source.value);
  const out = await doc.save({ updateFieldAppearances: false });
  return { bytes: out, pages: pages.length, fields: fieldCount };
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export const exportsDir = (id: string) => lectureDir(id, "exports");

export async function exportStudyPdf(
  lecture: Lecture,
  title: string,
  options: ExportOptions,
  origin: string,
  onStage: (s: string) => void = () => {},
): Promise<ExportResult> {
  const t0 = Date.now();
  const q = Buffer.from(JSON.stringify(options)).toString("base64url");
  const { pdf, labels } = await render(`${origin}/api/lectures/${lecture.id}/print?o=${q}`, onStage);
  onStage(options.fields ? "입력 칸과 격자 넣는 중" : "격자 넣는 중");
  const done = await postProcess(pdf, lecture, options, labels, title);

  const dir = exportsDir(lecture.id);
  fs.mkdirSync(dir, { recursive: true });
  const kind = { full: "학습서", guided: "빈칸노트", review: "요약판", workbook: "문제집" }[options.preset];
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  const safe = title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60).trim();
  const file = `${safe} - ${kind}${options.fields ? "(타이핑)" : ""} ${stamp}.pdf`;
  fs.writeFileSync(path.join(dir, file), done.bytes);
  // field name → human label, so a filled-in PDF can come back into the app as notes
  writeJson(path.join(dir, "fields.json"), { ...readJson<Record<string, string>>(path.join(dir, "fields.json"), {}), ...labels });
  return { file, pages: done.pages, bytes: done.bytes.length, fields: done.fields, ms: Date.now() - t0 };
}

/** Read what the student typed into a study-book PDF. */
export async function readFilledPdf(lectureId: string, bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const labels = readJson<Record<string, string>>(path.join(exportsDir(lectureId), "fields.json"), {});
  const texts: { name: string; label: string; text: string }[] = [];
  let checked = 0;
  for (const f of doc.getForm().getFields()) {
    const name = f.getName();
    if (f instanceof PDFTextField) {
      const text = (f.getText() ?? "").trim();
      if (text) texts.push({ name, label: labels[name] ?? name, text });
    } else if (f instanceof PDFCheckBox && f.isChecked()) checked++;
  }
  return { texts, checked };
}
