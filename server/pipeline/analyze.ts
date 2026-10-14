import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { z } from "zod";
import { fmtTime } from "../../shared/time";
import type { Analysis, Chapter, Flag, Frame, Lecture, Overview, SectionAnalysis, Segment } from "../../shared/types";
import { generateObject, generateText, strictJsonSchema, type LLMImage, type LLMUsage } from "../llm";
import { lectureDir, readJson, writeJson } from "../paths";
import {
  OutlineSchema,
  OverviewSchema,
  SectionSchema,
  VERIFY_LABEL,
  outlineSystem,
  overviewSystem,
  sectionFieldsSystem,
  sectionNotesSystem,
} from "../prompts";
import { fixStrings, timestampFixer } from "./timestamps";
import { mapLimit } from "./util";

export type Outline = z.infer<typeof OutlineSchema>;

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

/**
 * Timestamped transcript lines. Runs of an identical line (whisper's
 * "감사합니다." over silence) collapse into one marked line so they neither
 * eat context nor offer fake moments to cite.
 */
export function formatTranscript(segs: Segment[], frames: { time: number; label: string }[] = []) {
  const lines: { time: number; text: string }[] = [];
  for (let i = 0; i < segs.length; ) {
    let j = i;
    while (j + 1 < segs.length && segs[j + 1].text.trim() === segs[i].text.trim()) j++;
    const repeats = j - i + 1;
    lines.push({
      time: segs[i].start,
      text: repeats >= 3 ? `${segs[i].text} (repeated ${repeats}× — likely a speech-recognition artifact)` : segs[i].text,
    });
    for (let k = i + 1; k <= j && repeats < 3; k++) lines.push({ time: segs[k].start, text: segs[k].text });
    i = j + 1;
  }
  for (const f of frames) lines.push({ time: f.time, text: `〔${f.label}〕` });
  return lines
    .sort((a, b) => a.time - b.time)
    .map((l) => `[${fmtTime(l.time)}] ${l.text}`)
    .join("\n");
}

function pickFrames(frames: Frame[], start: number, end: number, max: number): Frame[] {
  const inside = frames.filter((f) => f.time >= start && f.time < end);
  if (inside.length <= max) return inside;
  const step = inside.length / max;
  return Array.from({ length: max }, (_, k) => inside[Math.floor(k * step + step / 2)]);
}

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

// --- outline -----------------------------------------------------------------

/** One pass over the whole transcript: topic sequence and where each concept is first taught. */
export async function buildOutline(
  lecture: Lecture,
  segments: Segment[],
  signal: AbortSignal,
  onUsage: (u: LLMUsage) => void,
): Promise<Outline> {
  const file = lectureDir(lecture.id, "outline.json");
  const system = outlineSystem(lecture.options.outputLanguage);
  const key = hash({ v: 1, system, schema: strictJsonSchema(OutlineSchema), model: lecture.options.analysis, segments });
  const cached = readJson<{ key: string; outline: Outline } | null>(file, null);
  if (cached?.key === key) return cached.outline;

  const { object, usage } = await generateObject({
    choice: lecture.options.analysis,
    system,
    messages: [
      {
        role: "user",
        content: [
          `<transcript>\n${formatTranscript(segments)}\n</transcript>`,
          `Lecture: ${lecture.title} (duration ${fmtTime(lecture.durationSec)})`,
          lecture.options.focus ? `Note from the student: ${lecture.options.focus}` : "",
          "List this lecture's topic sequence and the concepts it introduces, with times in seconds.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
    schema: OutlineSchema,
    name: "lecture_outline",
    maxTokens: 16000,
    signal,
  });
  onUsage(usage);
  writeJson(file, { key, outline: object });
  return object;
}

function outlineContext(outline: Outline | null, r: SectionRange) {
  if (!outline) return "";
  const topics = outline.topics
    .map((t) => `- [${fmtTime(t.start)}] ${t.title}${t.start >= r.start && t.start < r.end ? "  ← this part" : ""}`)
    .join("\n");
  const earlier = outline.concepts.filter((c) => c.time < r.start - 5);
  return [
    `<lecture-outline>\n${topics}\n</lecture-outline>`,
    earlier.length
      ? `<taught-earlier>\nConcepts the lecture already taught before this part; refer to them, don't define them again:\n${earlier.map((c) => `- ${c.term} [${fmtTime(c.time)}]: ${c.gist}`).join("\n")}\n</taught-earlier>`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// --- per-part analysis ---------------------------------------------------------

interface Ctx {
  lecture: Lecture;
  segments: Segment[];
  frames: Frame[];
  framesPerSection: number;
  concurrency: number;
  outline: Outline | null;
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
  outline: Outline | null,
) {
  return hash({
    // Bump when the assembly of section context changes.
    contextVersion: 3,
    notesSystem: sectionNotesSystem(lecture.options.outputLanguage),
    fieldsSystem: sectionFieldsSystem(lecture.options.outputLanguage),
    schema: strictJsonSchema(SectionSchema),
    title: lecture.title,
    duration: lecture.durationSec,
    model: lecture.options.analysis,
    focus: lecture.options.focus,
    segments,
    ranges,
    frames,
    framesPerSection,
    outline,
  });
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

/** Notes length target: a bit over half the part's transcript, within sane bounds. */
function notesBudget(segs: Segment[]) {
  const chars = segs.reduce((n, s) => n + s.text.length, 0);
  return Math.round(Math.min(Math.max(chars * 0.6, 1200), 6000) / 100) * 100;
}

/** Models sometimes wrap a whole Markdown answer in a code fence. */
function unwrapFence(text: string) {
  const m = text.trim().match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
  return (m ? m[1] : text).trim();
}

async function writeNotes(ctx: Ctx, system: string, prompt: string, images: LLMImage[]) {
  let maxTokens = 24000;
  for (let attempt = 0; ; attempt++) {
    const res = await generateText({
      choice: ctx.lecture.options.analysis,
      system,
      messages: [{ role: "user", content: prompt, images }],
      maxTokens,
      signal: ctx.signal,
    });
    ctx.onUsage(res.usage);
    if (!res.truncated || attempt === 1) return unwrapFence(res.text);
    maxTokens *= 1.5;
  }
}

export async function analyzeSections(ctx: Ctx, ranges: SectionRange[]): Promise<SectionAnalysis[]> {
  const { lecture, segments } = ctx;
  const dir = lectureDir(lecture.id, "sections");
  fs.mkdirSync(dir, { recursive: true });
  const framesBySection = ranges.map((r) => pickFrames(ctx.frames, r.start, r.end, ctx.framesPerSection));
  const frameInputs = [...new Map(framesBySection.flat().map((f) => [f.file, f])).values()].map((f) => ({
    ...f,
    hash: createHash("sha256").update(fs.readFileSync(lectureDir(lecture.id, "frames", f.file))).digest("hex"),
  }));
  const cacheKey = sectionCacheKey(lecture, segments, ranges, frameInputs, ctx.framesPerSection, ctx.outline);
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

  const notesSystem = sectionNotesSystem(lecture.options.outputLanguage);
  const fieldsSystem = sectionFieldsSystem(lecture.options.outputLanguage);
  const fixTimes = timestampFixer(segments, lecture.durationSec);
  return mapLimit(ranges, ctx.concurrency, async (r, i) => {
    const cached = readJson<SectionAnalysis | null>(fileFor(i), null);
    if (cached) return cached;

    const segs = segments.slice(r.from, r.to);
    const context = neighboringContext(segments, r);
    const frames = framesBySection[i];
    const images: LLMImage[] = frames.map((f, k) => ({
      mime: "image/jpeg",
      data: fs.readFileSync(lectureDir(lecture.id, "frames", f.file)).toString("base64"),
      caption: `Frame ${k + 1} at [${fmtTime(f.time)}]:`,
    }));
    const transcript = formatTranscript(
      segs,
      frames.map((f, k) => ({ time: f.time, label: `Frame ${k + 1} captured here (attached image ${k + 1})` })),
    );
    const partLine = `Lecture: ${lecture.title}. This is part ${i + 1} of ${ranges.length}, covering [${fmtTime(r.start)}]–[${fmtTime(r.end)}] of a ${fmtTime(lecture.durationSec)} lecture.`;

    // Long material first, the task last.
    const notesPrompt = [
      context.before ? `<previous-context>\n${context.before}\n</previous-context>` : "",
      `<transcript>\n${transcript}\n</transcript>`,
      context.after ? `<next-context>\n${context.after}\n</next-context>` : "",
      outlineContext(ctx.outline, r),
      partLine,
      lecture.options.focus ? `Note from the student about this lecture: ${lecture.options.focus}` : "",
      images.length ? `${images.length} frames from this part are attached; their capture points are marked in the transcript.` : "",
      `Write the teaching notes for the current transcript only. Character budget: about ${notesBudget(segs)} characters.`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const notes = await writeNotes(ctx, notesSystem, notesPrompt, images);

    const { object, usage } = await generateObject({
      choice: lecture.options.analysis,
      system: fieldsSystem,
      messages: [
        {
          role: "user",
          content: [
            `<transcript>\n${formatTranscript(segs)}\n</transcript>`,
            `<notes>\n${notes}\n</notes>`,
            partLine,
            "Fill in the study fields for this part.",
          ].join("\n\n"),
        },
      ],
      schema: SectionSchema,
      name: "section_fields",
      maxTokens: 16000,
      signal: ctx.signal,
    });
    ctx.onUsage(usage);

    const clamp = (t: number) => Math.min(Math.max(t, r.start), r.end);
    const timed = <T extends { time: number }>(items: T[]) => items.map((x) => ({ ...x, time: clamp(x.time) }));
    const result: SectionAnalysis = fixStrings(
      {
        index: i,
        start: r.start,
        end: r.end,
        ...object,
        notes,
        keyPoints: timed(object.keyPoints),
        concepts: timed(object.concepts),
        difficult: timed(object.difficult),
        selfCheck: timed(object.selfCheck),
        cards: timed(object.cards),
        flags: timed(object.flags),
      },
      fixTimes,
    );
    writeJson(fileFor(i), result);
    done++;
    report();
    return result;
  });
}

// --- synthesis -------------------------------------------------------------------

/** Uncertain claims of a part: the extracted flags, or for older analyses the labeled lines in the notes. */
function sectionFlags(s: SectionAnalysis): Flag[] {
  if (s.flags) return s.flags;
  return s.notes
    .split("\n")
    .filter((line) => line.includes(VERIFY_LABEL.replace(":", "")))
    .map((line) => ({ time: s.start, kind: "verify" as const, text: line.replace(/^[\s>*-]+/, "").trim() }));
}

export function sectionDigest(s: SectionAnalysis) {
  const flags = sectionFlags(s);
  return [
    `### Part ${s.index + 1}: ${s.title} [${fmtTime(s.start)}–${fmtTime(s.end)}] (starts at ${Math.round(s.start)}s)`,
    s.summary,
    "Key points:",
    ...s.keyPoints.map((k) => `- [${fmtTime(k.time)}] (${Math.round(k.time)}s) ${k.point}`),
    "Concepts:",
    ...s.concepts.map((c) => `- ${c.time !== undefined ? `(${Math.round(c.time)}s) ` : ""}${c.term}: ${c.definition}`),
    "Conceptual bottlenecks and explanations:",
    ...s.difficult.map((d) => `- [${fmtTime(d.time)}] ${d.topic}\n  Why this is difficult: ${d.why}\n${d.explanation}`),
    "Cards:",
    ...s.cards.map((c) => `- [${fmtTime(c.time)}] ${c.front}\n  ${c.back}`),
    ...(flags.length ? ["Flagged claims (keep them flagged):", ...flags.map((f) => `- (${Math.round(f.time)}s, ${f.kind}) ${f.text}`)] : []),
  ].join("\n");
}

export async function synthesize(
  lecture: Lecture,
  sections: SectionAnalysis[],
  segments: Segment[],
  outline: Outline | null,
  signal: AbortSignal,
  onUsage: (u: LLMUsage) => void,
): Promise<Analysis> {
  const prompt = [
    outline ? `<lecture-outline>\n${outline.topics.map((t) => `- (${Math.round(t.start)}s) ${t.title}`).join("\n")}\n</lecture-outline>` : "",
    `<part-analyses>\n${sections.map(sectionDigest).join("\n\n")}\n</part-analyses>`,
    `Lecture: ${lecture.title} (duration ${fmtTime(lecture.durationSec)}, ${Math.round(lecture.durationSec)}s)`,
    lecture.options.focus ? `Note from the student: ${lecture.options.focus}` : "",
    "Synthesize the overview of this lecture.",
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
  const clamp = (t: number) => Math.min(Math.max(0, t), total);
  const starts = object.chapters
    .map((c) => ({ ...c, start: clamp(c.start) }))
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

  const overview: Overview = fixStrings(
    {
      ...object,
      difficulty: Math.min(5, Math.max(1, Math.round(object.difficulty))),
      chapters,
      glossary: object.glossary.map((g) => ({ ...g, time: clamp(g.time) })),
      issues: object.issues.map((x) => ({ ...x, time: clamp(x.time) })),
    },
    timestampFixer(segments, lecture.durationSec),
  );
  return { overview, sections, model: `${lecture.options.analysis.model}`, createdAt: Date.now() };
}
