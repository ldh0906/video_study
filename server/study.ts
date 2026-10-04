import { fmtTime } from "../shared/time";
import type { Analysis, ChatMessage, Flashcard, Lecture, Material, MaterialKind, ModelChoice, Quiz, QuizQuestion, Segment } from "../shared/types";
import { generateObject, generateText, type LLMUsage } from "./llm";
import { CardsSchema, GradeSchema, MATERIAL_PRESETS, QuizSchema, chatSystem, materialSystem, quizSystem } from "./prompts";
import { getSettings } from "./settings";
import { docs, newId, updateLecture } from "./store";
import { formatTranscript } from "./pipeline/analyze";
import { estimateTokens, mapLimit, throttle } from "./pipeline/util";

export function addUsage(id: string, u: LLMUsage) {
  updateLecture(id, (l) => {
    l.usage.inputTokens += u.input;
    l.usage.outputTokens += u.output;
  });
}

function requireAnalysis(id: string): Analysis {
  const a = docs.analysis.get(id);
  if (!a) throw new Error("아직 분석이 끝나지 않았습니다.");
  return a;
}

/** Overview + full section notes: the main study context for generation. */
export function notesContext(a: Analysis, sectionIdx?: number[]) {
  const o = a.overview;
  const sections = sectionIdx ? a.sections.filter((s) => sectionIdx.includes(s.index)) : a.sections;
  return [
    `# ${o.title}`,
    o.summary,
    `Chapters:\n${o.chapters.map((c) => `- [${fmtTime(c.start)}] ${c.title}`).join("\n")}`,
    ...sections.map((s) =>
      [
        `## Part ${s.index + 1}: ${s.title} [${fmtTime(s.start)}–${fmtTime(s.end)}]`,
        s.notes,
        s.difficult.length ? `Difficult points:\n${s.difficult.map((d) => `- [${fmtTime(d.time)}] ${d.topic}: ${d.explanation}`).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    ),
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// Flashcards
// ---------------------------------------------------------------------------

export function newCard(front: string, back: string, time: number | null): Flashcard {
  const now = Date.now();
  return { id: newId(), front, back, time, due: now, interval: 0, ease: 2.5, reps: 0, lapses: 0, createdAt: now };
}

export async function generateMoreCards(lecture: Lecture, count: number, focus: string) {
  const a = requireAnalysis(lecture.id);
  const existing = docs.flashcards.get(lecture.id);
  const { object, usage } = await generateObject({
    choice: lecture.options.analysis,
    system: `${quizSystem(lecture.options.outputLanguage)}\n\nNow you write flashcards instead of quiz questions: one idea per card, specific question on the front, concise complete answer on the back.`,
    messages: [
      {
        role: "user",
        content: [
          notesContext(a),
          `Existing cards (do not duplicate):\n${existing.map((c) => `- ${c.front}`).join("\n")}`,
          `Write ${count} new flashcards.${focus ? ` Focus on: ${focus}` : ""} Give each card the time (seconds) where its content is explained.`,
        ].join("\n\n"),
      },
    ],
    schema: CardsSchema,
    name: "flashcards",
    maxTokens: 16000,
  });
  addUsage(lecture.id, usage);
  const cards = object.cards.map((c) => newCard(c.front, c.back, c.time));
  docs.flashcards.set(lecture.id, [...existing, ...cards]);
  return cards;
}

// ---------------------------------------------------------------------------
// Quiz
// ---------------------------------------------------------------------------

export async function generateQuiz(
  lecture: Lecture,
  opts: { count: number; difficulty: string; focus: string; title?: string },
  signal?: AbortSignal,
): Promise<Quiz> {
  const a = requireAnalysis(lecture.id);
  // Batch sections so each request stays a comfortable size, questions spread by duration.
  const batches: number[][] = [];
  let cur: number[] = [];
  let tokens = 0;
  for (const s of a.sections) {
    const t = estimateTokens(s.notes);
    if (cur.length && tokens + t > 40000) {
      batches.push(cur);
      cur = [];
      tokens = 0;
    }
    cur.push(s.index);
    tokens += t;
  }
  if (cur.length) batches.push(cur);

  const total = a.sections.reduce((n, s) => n + (s.end - s.start), 0) || 1;
  const counts = batches.map((b) => {
    const dur = b.reduce((n, i) => n + (a.sections[i].end - a.sections[i].start), 0);
    return Math.max(1, Math.round((opts.count * dur) / total));
  });

  const difficulty =
    opts.difficulty === "easy" ? "Lean towards easy and medium questions." : opts.difficulty === "hard" ? "Lean towards hard questions that require reasoning across ideas." : "Use a balanced mix of difficulties.";
  const results = await mapLimit(batches, 3, async (b, k) => {
    const { object, usage } = await generateObject({
      choice: lecture.options.analysis,
      system: quizSystem(lecture.options.outputLanguage),
      messages: [
        {
          role: "user",
          content: `${notesContext(a, b)}\n\nWrite ${counts[k]} questions about the material above. ${difficulty}${opts.focus ? ` Focus on: ${opts.focus}` : ""}`,
        },
      ],
      schema: QuizSchema,
      name: "quiz",
      maxTokens: 24000,
      signal,
    });
    addUsage(lecture.id, usage);
    return object.questions;
  });

  const questions: QuizQuestion[] = results.flat().map((q) => {
    const isMcq = q.type === "mcq" && q.options.length >= 2 && q.answerIndex >= 0 && q.answerIndex < q.options.length;
    return {
      id: newId(),
      type: isMcq ? "mcq" : "short",
      question: q.question,
      options: isMcq ? q.options : [],
      answerIndex: isMcq ? q.answerIndex : -1,
      answer: isMcq ? q.options[q.answerIndex] : q.answer,
      explanation: q.explanation,
      time: q.time ?? null,
      difficulty: q.difficulty,
    };
  });
  const quizzes = docs.quizzes.get(lecture.id);
  const quiz: Quiz = {
    id: newId(),
    title: opts.title ?? (opts.focus ? `퀴즈 · ${opts.focus}` : `퀴즈 ${quizzes.length + 1}`),
    createdAt: Date.now(),
    questions,
  };
  docs.quizzes.set(lecture.id, [quiz, ...quizzes]);
  return quiz;
}

export async function gradeAnswer(lecture: Lecture, question: QuizQuestion, answer: string) {
  const settings = getSettings();
  const { object, usage } = await generateObject({
    choice: settings.chat,
    system: `You grade a student's short answer to a lecture quiz question fairly: accept answers that are correct in substance even if worded differently; give partial credit for partially correct reasoning. Be encouraging but precise.\n${chatLanguage(lecture)}`,
    messages: [
      {
        role: "user",
        content: `Question: ${question.question}\n\nModel answer: ${question.answer}\n\nExplanation: ${question.explanation}\n\nStudent's answer: ${answer || "(blank)"}`,
      },
    ],
    schema: GradeSchema,
    name: "grade",
    maxTokens: 4000,
  });
  addUsage(lecture.id, usage);
  return { ...object, score: Math.round(Math.min(100, Math.max(0, object.score))) };
}

function chatLanguage(lecture: Lecture) {
  return lecture.options.outputLanguage && lecture.options.outputLanguage !== "auto"
    ? `Write the feedback in the language with code "${lecture.options.outputLanguage}".`
    : "Write the feedback in the student's language.";
}

// ---------------------------------------------------------------------------
// Materials (generated in the background, content saved progressively)
// ---------------------------------------------------------------------------

export function startMaterial(lecture: Lecture, kind: MaterialKind, prompt: string, choice?: ModelChoice): Material {
  const a = requireAnalysis(lecture.id);
  const preset = MATERIAL_PRESETS[kind];
  const model = choice ?? lecture.options.analysis;
  const material: Material = {
    id: newId(),
    kind,
    title: kind === "custom" ? prompt.slice(0, 40) || preset.title : prompt && kind === "deepdive" ? `${preset.title} · ${prompt.slice(0, 30)}` : preset.title,
    prompt,
    content: "",
    status: "generating",
    model: model.model,
    createdAt: Date.now(),
  };
  docs.materials.set(lecture.id, [material, ...docs.materials.get(lecture.id)]);

  const save = (patch: Partial<Material>) => {
    docs.materials.set(
      lecture.id,
      docs.materials.get(lecture.id).map((m) => (m.id === material.id ? { ...m, ...patch } : m)),
    );
  };
  const saveThrottled = throttle((content: string) => save({ content }), 800);

  let content = "";
  generateText({
    choice: model,
    system: materialSystem(lecture.options.outputLanguage),
    messages: [
      {
        role: "user",
        content: `${notesContext(a)}\n\n---\nTask: ${preset.instruction}${prompt ? `\n\nStudent's request: ${prompt}` : ""}`,
      },
    ],
    maxTokens: 48000,
    onDelta: (d) => {
      content += d;
      saveThrottled(content);
    },
  })
    .then((res) => {
      addUsage(lecture.id, res.usage);
      // let any pending throttled write land first
      setTimeout(() => save({ content: res.text || content, status: "done" }), 900);
    })
    .catch((err: Error) => {
      setTimeout(() => save({ status: "error", error: err.message, content }), 900);
    });
  return material;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

const FULL_TRANSCRIPT_BUDGET = 120_000; // tokens

function tokenize(s: string) {
  return s.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
}

/** Tiny BM25 over ~90 s transcript windows, for lectures too long to send whole. */
function retrieve(segments: Segment[], query: string, anchor: number | null, k = 10): Segment[][] {
  const windows: Segment[][] = [];
  let cur: Segment[] = [];
  for (const s of segments) {
    if (cur.length && s.start - cur[0].start > 90) {
      windows.push(cur);
      cur = [];
    }
    cur.push(s);
  }
  if (cur.length) windows.push(cur);
  const docsTokens = windows.map((w) => tokenize(w.map((s) => s.text).join(" ")));
  const avg = docsTokens.reduce((n, d) => n + d.length, 0) / (docsTokens.length || 1);
  const df = new Map<string, number>();
  for (const d of docsTokens) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const q = [...new Set(tokenize(query))];
  const scores = docsTokens.map((d, i) => {
    let score = 0;
    for (const t of q) {
      const f = d.filter((x) => x === t).length;
      if (!f) continue;
      const idf = Math.log(1 + (windows.length - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      score += (idf * f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (d.length / avg)));
    }
    if (anchor !== null && windows[i][0].start <= anchor + 90 && windows[i].at(-1)!.end >= anchor - 90) score += 100;
    return { i, score };
  });
  return scores
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .filter((s) => s.score > 0)
    .sort((a, b) => a.i - b.i)
    .map((s) => windows[s.i]);
}

export async function chat(
  lecture: Lecture,
  message: string,
  anchor: number | null,
  onDelta: (t: string) => void,
  signal: AbortSignal,
): Promise<ChatMessage> {
  const settings = getSettings();
  const a = docs.analysis.get(lecture.id);
  const transcript = docs.transcript.get(lecture.id);
  const segments = transcript?.segments ?? [];
  const fullTranscript = formatTranscript(segments);
  const base = a ? notesContext(a) : "";
  const sendFull = estimateTokens(base + fullTranscript) < FULL_TRANSCRIPT_BUDGET;
  // The system prompt stays byte-identical across turns so it can be cached.
  const context = sendFull ? `${base}\n\n# Full transcript\n${fullTranscript}` : base;

  const history = docs.chat.get(lecture.id);
  const userMsg: ChatMessage = { id: newId(), role: "user", content: message, createdAt: Date.now(), anchor };
  docs.chat.set(lecture.id, [...history, userMsg]);

  let content = message;
  if (anchor !== null) content = `(The student is watching the video at [${fmtTime(anchor)}].)\n\n${content}`;
  if (!sendFull) {
    const excerpts = retrieve(segments, message, anchor);
    if (excerpts.length) content = `Relevant transcript excerpts:\n${excerpts.map(formatTranscript).join("\n…\n")}\n\n---\n${content}`;
  }

  const recent = history.filter((m) => !m.error).slice(-16);
  const res = await generateText({
    choice: settings.chat,
    system: chatSystem(lecture.options.outputLanguage, context),
    cacheSystem: true,
    messages: [...recent.map((m) => ({ role: m.role, content: m.content })), { role: "user", content }],
    maxTokens: 16000,
    onDelta,
    signal,
  });
  addUsage(lecture.id, res.usage);
  const reply: ChatMessage = { id: newId(), role: "assistant", content: res.text, createdAt: Date.now() };
  docs.chat.set(lecture.id, [...docs.chat.get(lecture.id), reply]);
  return reply;
}
