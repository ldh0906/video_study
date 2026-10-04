import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fmtTime } from "../../shared/time";
import type { Analysis, Chapter, Frame, Lecture, Overview, SectionAnalysis, Segment } from "../../shared/types";
import { generateObject, strictJsonSchema, type LLMImage, type LLMUsage } from "../llm";
import { lectureDir, readJson, writeJson } from "../paths";
import { OverviewSchema, SectionSchema, overviewSystem, sectionSystem } from "../prompts";
import { mapLimit } from "./util";

export interface SectionRange {
  start: number;
  end: number;
  from: number; // segment index, inclusive
  to: number; // segment index, exclusive
}

/** Split the transcript into study-sized parts, cutting at natural pauses. */
export function buildSections(segs: Segment[], duration: number): SectionRange[] {
  if (!segs.length) return [];
  const total = Math.max(duration, segs[segs.length - 1].end);
  const T = total <= 15 * 60 ? 300 : total <= 60 * 60 ? 480 : 600;
  const sections: SectionRange[] = [];
  let startIdx = 0;
  while (startIdx < segs.length) {
    const s0 = segs[startIdx].start;
    let best = -1;
    let bestScore = -Infinity;
    let i = startIdx + 1;
    for (; i < segs.length; i++) {
      const offset = segs[i].start - s0;
      if (offset < 0.75 * T) continue;
      if (offset > 1.25 * T) break;
      const gap = segs[i].start - segs[i - 1].end;
      const sentence = /[.!?。？！]$/.test(segs[i - 1].text.trim()) ? 0.5 : 0;
      const score = gap + sentence - Math.abs(offset - T) / T;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    let endIdx = best > 0 ? best : Math.min(i, segs.length);
    if (endIdx <= startIdx) endIdx = startIdx + 1;
    if (endIdx < segs.length && segs[segs.length - 1].end - segs[endIdx].start < 0.4 * T) endIdx = segs.length;
    sections.push({
      start: startIdx === 0 ? 0 : s0,
      end: endIdx < segs.length ? segs[endIdx].start : total,
      from: startIdx,
      to: endIdx,
    });
    startIdx = endIdx;
  }
  return sections;
}

export function formatTranscript(segs: Segment[]) {
  return segs.map((s) => `[${fmtTime(s.start)}] ${s.text}`).join("\n");
}

function pickFrames(frames: Frame[], start: number, end: number, max: number): Frame[] {
  const inside = frames.filter((f) => f.time >= start && f.time < end);
  if (inside.length <= max) return inside;
  const step = inside.length / max;
  return Array.from({ length: max }, (_, k) => inside[Math.floor(k * step + step / 2)]);
}

interface Ctx {
  lecture: Lecture;
  segments: Segment[];
  frames: Frame[];
  framesPerSection: number;
  concurrency: number;
  signal: AbortSignal;
  onUsage: (u: LLMUsage) => void;
  onProgress: (p: number, detail: string) => void;
}

/** Resume only when the actual teaching inputs and instructions are unchanged. */
export function sectionCacheKey(
  lecture: Lecture,
  segments: Segment[],
  ranges: SectionRange[],
  frames: { time: number; file: string; hash: string }[],
  framesPerSection: number,
) {
  return createHash("sha256").update(JSON.stringify({
    // Bump when the assembly of section context changes.
    contextVersion: 2,
    system: sectionSystem(lecture.options.outputLanguage),
    schema: strictJsonSchema(SectionSchema),
    title: lecture.title,
    duration: lecture.durationSec,
    model: lecture.options.analysis,
    focus: lecture.options.focus,
    segments,
    ranges,
    frames,
    framesPerSection,
  })).digest("hex");
}

/** Whole timestamped segments around a boundary, with bounded context size. */
export function neighboringContext(segments: Segment[], range: SectionRange) {
  const before: Segment[] = [];
  const after: Segment[] = [];
  let chars = 0;
  for (let i = range.from - 1; i >= 0; i--) {
    const segment = segments[i];
    const length = formatTranscript([segment]).length + 1;
    if (segment.end < range.start - 120 || chars + length > 6000) break;
    before.unshift(segment);
    chars += length;
  }
  chars = 0;
  for (let i = range.to; i < segments.length; i++) {
    const segment = segments[i];
    const length = formatTranscript([segment]).length + 1;
    if (segment.start >= range.end + 60 || chars + length > 3000) break;
    after.push(segment);
    chars += length;
  }
  return { before: formatTranscript(before), after: formatTranscript(after) };
}

export async function analyzeSections(ctx: Ctx, ranges: SectionRange[]): Promise<SectionAnalysis[]> {
  const { lecture, segments } = ctx;
  const dir = lectureDir(lecture.id, "sections");
  fs.mkdirSync(dir, { recursive: true });
  const framesBySection = ranges.map(r => pickFrames(ctx.frames, r.start, r.end, ctx.framesPerSection));
  const frameInputs = [...new Map(framesBySection.flat().map(f => [f.file, f])).values()].map(f => ({
    ...f,
    hash: createHash("sha256").update(fs.readFileSync(lectureDir(lecture.id, "frames", f.file))).digest("hex"),
  }));
  const cacheKey = sectionCacheKey(lecture, segments, ranges, frameInputs, ctx.framesPerSection);
  const keyFile = path.join(dir, "key.txt");
  if (!fs.existsSync(keyFile) || fs.readFileSync(keyFile, "utf8") !== cacheKey) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keyFile, cacheKey);
  }

  const fileFor = (i: number) => path.join(dir, `${String(i).padStart(3, "0")}.json`);
  let done = ranges.filter((_, i) => fs.existsSync(fileFor(i))).length;
  const report = () => ctx.onProgress(done / ranges.length, `${done} / ${ranges.length} 파트`);
  report();

  const system = sectionSystem(lecture.options.outputLanguage);
  return mapLimit(ranges, ctx.concurrency, async (r, i) => {
    const cached = readJson<SectionAnalysis | null>(fileFor(i), null);
    if (cached) return cached;

    const segs = segments.slice(r.from, r.to);
    const context = neighboringContext(segments, r);
    const frames = framesBySection[i];
    const images: LLMImage[] = frames.map((f) => ({
      mime: "image/jpeg",
      data: fs.readFileSync(lectureDir(lecture.id, "frames", f.file)).toString("base64"),
      caption: `Video frame at [${fmtTime(f.time)}]:`,
    }));

    const prompt = [
      `Lecture: ${lecture.title}`,
      lecture.options.focus ? `Note from the student about this lecture: ${lecture.options.focus}` : "",
      `This is part ${i + 1} of ${ranges.length}, covering [${fmtTime(r.start)}]–[${fmtTime(r.end)}] of a ${fmtTime(lecture.durationSec)} lecture.`,
      images.length ? `${images.length} frames captured from the video during this part are attached above.` : "",
      "Analyze only the current transcript below. Neighboring context helps resolve terminology and relationships; do not summarize it as content of this part or cite its timestamps for this part's takeaways.",
      context.before ? `<previous-context>\n${context.before}\n</previous-context>` : "",
      `<transcript>\n${formatTranscript(segs)}\n</transcript>`,
      context.after ? `<next-context>\n${context.after}\n</next-context>` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const { object, usage } = await generateObject({
      choice: lecture.options.analysis,
      system,
      messages: [{ role: "user", content: prompt, images }],
      schema: SectionSchema,
      name: "section_notes",
      maxTokens: 32000,
      signal: ctx.signal,
    });
    ctx.onUsage(usage);
    const clamp = (t: number) => Math.min(Math.max(t, r.start), r.end);
    const result: SectionAnalysis = {
      index: i,
      start: r.start,
      end: r.end,
      ...object,
      keyPoints: object.keyPoints.map((k) => ({ ...k, time: clamp(k.time) })),
      difficult: object.difficult.map((d) => ({ ...d, time: clamp(d.time) })),
      cards: object.cards.map((c) => ({ ...c, time: clamp(c.time) })),
    };
    writeJson(fileFor(i), result);
    done++;
    report();
    return result;
  });
}

export function sectionDigest(s: SectionAnalysis) {
  return [
    `### Part ${s.index + 1}: ${s.title} [${fmtTime(s.start)}–${fmtTime(s.end)}] (starts at ${Math.round(s.start)}s)`,
    s.summary,
    "Key points:",
    ...s.keyPoints.map((k) => `- [${fmtTime(k.time)}] (${Math.round(k.time)}s) ${k.point}`),
    "Concepts:",
    ...s.concepts.map((c) => `- ${c.term}: ${c.definition}`),
    "Conceptual bottlenecks and explanations:",
    ...s.difficult.map(d => `- [${fmtTime(d.time)}] ${d.topic}\n  Why this is difficult: ${d.why}\n${d.explanation}`),
    "Applications and reasoning checks:",
    ...s.cards.map(c => `- [${fmtTime(c.time)}] ${c.front}\n  ${c.back}`),
  ].join("\n");
}

export async function synthesize(
  lecture: Lecture,
  sections: SectionAnalysis[],
  signal: AbortSignal,
  onUsage: (u: LLMUsage) => void,
): Promise<Analysis> {
  const prompt = [
    `Lecture: ${lecture.title} (duration ${fmtTime(lecture.durationSec)}, ${Math.round(lecture.durationSec)}s)`,
    lecture.options.focus ? `Note from the student: ${lecture.options.focus}` : "",
    "Per-part analyses:",
    sections.map(sectionDigest).join("\n\n"),
  ]
    .filter(Boolean)
    .join("\n\n");

  const { object, usage } = await generateObject({
    choice: lecture.options.analysis,
    system: overviewSystem(lecture.options.outputLanguage),
    messages: [{ role: "user", content: prompt }],
    schema: OverviewSchema,
    name: "lecture_overview",
    maxTokens: 32000,
    signal,
  });
  onUsage(usage);

  const total = Math.max(lecture.durationSec, sections.at(-1)?.end ?? 0);
  const starts = object.chapters
    .map((c) => ({ ...c, start: Math.min(Math.max(0, c.start), total) }))
    .sort((a, b) => a.start - b.start)
    .filter((c, i, arr) => i === 0 || c.start - arr[i - 1].start > 5);
  if (starts.length) starts[0].start = 0;
  const chapters: Chapter[] = (starts.length ? starts : [{ title: object.title, start: 0, summary: object.oneLiner }]).map(
    (c, i, arr) => {
      const end = i + 1 < arr.length ? arr[i + 1].start : total;
      return {
        title: c.title,
        summary: c.summary,
        start: c.start,
        end,
        sections: sections.filter((s) => s.start < end && s.end > c.start).map((s) => s.index),
      };
    },
  );

  const overview: Overview = {
    ...object,
    difficulty: Math.min(5, Math.max(1, Math.round(object.difficulty))),
    chapters,
  };
  return { overview, sections, model: `${lecture.options.analysis.model}`, createdAt: Date.now() };
}
