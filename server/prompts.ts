import { z } from "zod";
import { LANGUAGE_NAMES } from "../shared/catalog";
import type { MaterialKind } from "../shared/types";

export function languageDirective(code: string) {
  if (!code || code === "auto") {
    return "Write in the same language the lecturer speaks.";
  }
  const name = LANGUAGE_NAMES[code] ?? code;
  return `Write everything in ${name}. When a technical term is commonly used in its original language (usually English), give it once in parentheses after the translated term, e.g. "경사 하강법(gradient descent)".`;
}

const FORMAT_RULES = `Formatting rules (the output is rendered as Markdown):
- Math uses LaTeX: $...$ inline, $$...$$ on its own lines for display equations. Never put math in code blocks.
- Code goes in fenced blocks with a language tag.
- Refer to moments in the lecture with timestamps written exactly like [12:34] or [1:02:03]; they become clickable links that seek the video. Only use timestamps that exist in the provided transcript.
- Use tables for comparisons, bold for key terms on first use. Do not use H1/H2 headings (#, ##); start at ### when headings are needed.`;

// --------------------------------------------------------------------------
// Section analysis (map step)
// --------------------------------------------------------------------------

export const SectionSchema = z.object({
  title: z.string().describe("Short descriptive title for this part of the lecture"),
  summary: z.string().describe("2–4 sentence summary of what this part teaches"),
  notes: z
    .string()
    .describe("Complete, well-structured Markdown study notes for this part"),
  keyPoints: z
    .array(z.object({ time: z.number().describe("seconds from lecture start"), point: z.string() }))
    .describe("The most important takeaways, each anchored to the moment it is explained"),
  concepts: z
    .array(z.object({ term: z.string(), definition: z.string() }))
    .describe("Terms, symbols and named ideas introduced or used in this part"),
  difficult: z
    .array(
      z.object({
        time: z.number(),
        topic: z.string(),
        why: z.string().describe("why students typically struggle here"),
        explanation: z.string().describe("clear Markdown explanation: intuition, analogy, step-by-step"),
      }),
    )
    .describe("The parts most likely to confuse a student (0–3 items)"),
  cards: z
    .array(z.object({ front: z.string(), back: z.string(), time: z.number() }))
    .describe("Flashcards testing understanding of this part"),
});

export function sectionSystem(outputLanguage: string) {
  return `You are an expert teaching assistant and meticulous note-taker. You receive one part of a recorded lecture (a timestamped transcript, sometimes with frames captured from the video such as slides or a whiteboard) and turn it into study material for a serious student who wants to truly master the subject, including hard technical content.

What to produce:
- notes: rigorous, complete notes for this part. Capture every definition, claim, formula, derivation step, algorithm, example, caveat, and anything the lecturer emphasizes ("this is important", "on the exam"). Preserve the lecturer's reasoning chain, not just conclusions. Reconstruct equations and diagrams shown on slides or the board (describe diagrams in words or tables). Organize with ### subheadings and bullet hierarchies, and start each subtopic with the timestamp where it begins. Length should scale with the density of the content; never pad, never omit substance.
- When you add background the lecturer did not say (to fill a gap or fix an obvious slip), mark it with "💡 보충:" (or the equivalent in the output language) so the student can tell it apart.
- keyPoints: 3–8 takeaways with the time (in seconds) they are explained.
- concepts: the terms and symbols a student must know, with precise definitions in the context of this lecture.
- difficult: the 0–3 places a student is most likely to get stuck. Explain each one better than the lecturer did: build intuition first, then the formal idea, then a small worked example or analogy.
- cards: 3–8 flashcards that test understanding (why/how/compare/apply), not trivia. Fronts are specific questions; backs are concise but complete answers.

The transcript comes from automatic speech recognition: technical terms, names and formulas may be misheard. Silently correct them using context and the frames. Ignore filler, logistics and off-topic chatter unless it matters for studying (e.g. exam hints, assignment deadlines — keep those).

${FORMAT_RULES}
${languageDirective(outputLanguage)}`;
}

// --------------------------------------------------------------------------
// Synthesis (reduce step)
// --------------------------------------------------------------------------

export const OverviewSchema = z.object({
  title: z.string().describe("Clear title of the lecture"),
  oneLiner: z.string().describe("One sentence: what this lecture is about"),
  summary: z.string().describe("Markdown executive summary, 2–5 short paragraphs, covering the arc of the lecture"),
  objectives: z.array(z.string()).describe("What a student should be able to do after studying this lecture"),
  prerequisites: z
    .array(z.object({ topic: z.string(), why: z.string() }))
    .describe("Background knowledge the lecture assumes"),
  chapters: z
    .array(z.object({ title: z.string(), start: z.number().describe("seconds"), summary: z.string() }))
    .describe("Logical chapters in chronological order; the first starts at 0"),
  glossary: z
    .array(z.object({ term: z.string(), definition: z.string(), time: z.number() }))
    .describe("Merged, de-duplicated glossary of the whole lecture, ordered by first appearance"),
  mindmap: z
    .string()
    .describe("Markdown outline for a mind map: one '# Root' line, then nested '-' bullets, 3–4 levels deep, short labels"),
  difficulty: z.number().describe("1 (introductory) to 5 (very advanced)"),
  tags: z.array(z.string()).describe("3–6 subject tags"),
});

export function overviewSystem(outputLanguage: string) {
  return `You are an expert educator. You receive per-part analyses of one long lecture (titles, summaries, key points with timestamps, concepts) and synthesize the big picture a student needs to study it.

- chapters: group the parts into 3–15 meaningful chapters that follow the lecture's real structure (topic shifts), not equal time slices. Each chapter's start (in seconds) must be one of the provided part starts or key-point times. The first chapter starts at 0.
- glossary: merge duplicates across parts, keep the most precise definition, keep the time of first appearance.
- mindmap: a hierarchical outline of the lecture's ideas (not of its timeline), concise labels of a few words.
- summary: explain how the ideas connect and build on each other.

${FORMAT_RULES}
${languageDirective(outputLanguage)}`;
}

// --------------------------------------------------------------------------
// Quiz
// --------------------------------------------------------------------------

export const QuizSchema = z.object({
  questions: z.array(
    z.object({
      type: z.enum(["mcq", "short"]),
      question: z.string(),
      options: z.array(z.string()).describe("exactly 4 options for mcq, empty for short"),
      answerIndex: z.number().describe("index of the correct option for mcq, -1 for short"),
      answer: z.string().describe("for mcq the correct option text; for short a model answer"),
      explanation: z.string().describe("why the answer is right and why tempting wrong answers are wrong"),
      time: z.number().describe("seconds: where in the lecture this is explained"),
      difficulty: z.enum(["easy", "medium", "hard"]),
    }),
  ),
});

export function quizSystem(outputLanguage: string) {
  return `You write high-quality exam questions from lecture notes. Test understanding, application and reasoning — not recall of trivial wording.
- Mix multiple-choice (about 70%, exactly 4 options, one clearly correct answer, plausible distractors based on real misconceptions, no "all of the above") and short-answer questions (about 30%, answerable in 1–4 sentences or a short calculation).
- Include calculation or derivation questions when the material is quantitative.
- Spread questions across the whole material and across difficulty levels.
- Every explanation teaches: it says why the answer is right and addresses the most tempting wrong option.

${FORMAT_RULES}
${languageDirective(outputLanguage)}`;
}

export const CardsSchema = z.object({
  cards: z.array(z.object({ front: z.string(), back: z.string(), time: z.number() })),
});

export const GradeSchema = z.object({
  score: z.number().describe("0–100"),
  verdict: z.enum(["correct", "partial", "incorrect"]),
  feedback: z.string().describe("Markdown feedback: what is right, what is missing or wrong, and the key idea to remember"),
});

// --------------------------------------------------------------------------
// Study materials
// --------------------------------------------------------------------------

export const MATERIAL_PRESETS: Record<MaterialKind, { title: string; instruction: string }> = {
  cheatsheet: {
    title: "한 장 요약 노트",
    instruction:
      "Create a dense one-to-two page cheat sheet for exam review: the essential definitions, formulas (with what each symbol means), procedures/algorithms as numbered steps, comparison tables, and a short 'common mistakes' list. Organize by topic with ### headings. Maximize information density; no fluff.",
  },
  deepdive: {
    title: "심화 해설",
    instruction:
      "Write a deep-dive explanation of the hardest ideas in this lecture (or of the topic the student specifies). For each: build intuition first (analogy or picture), then the precise/formal statement, then a fully worked example step by step, common misconceptions, how it connects to other ideas in the lecture, and 2–3 self-check questions with answers. Go beyond the lecture where it helps understanding, and mark additions with 💡.",
  },
  practice: {
    title: "연습 문제",
    instruction:
      "Create 8–12 practice problems that build from basic to challenging, in the style of a good problem set for this course (calculations, derivations, short proofs, coding or conceptual questions as appropriate). List all numbered problems first under a ### heading meaning 'Problems'. Then give complete step-by-step solutions under a ### heading meaning 'Solutions', matching the numbering, explaining the reasoning, not just results.",
  },
  exam: {
    title: "예상 시험 문제",
    instruction:
      "Predict what an exam on this lecture would ask. Prioritize what the lecturer emphasized. Include a mix of short-answer, explanation/essay and problem-solving questions. For each question give a model answer and the grading points (what earns full marks). End with a 'last-minute review' checklist.",
  },
  faq: {
    title: "자주 묻는 질문",
    instruction:
      "Write an FAQ of 10–15 questions a student would realistically ask after this lecture (confusions, 'why' questions, edge cases, how ideas relate), each with a clear answer that cites lecture timestamps.",
  },
  custom: {
    title: "맞춤 자료",
    instruction: "Create exactly what the student asks for below.",
  },
};

export function materialSystem(outputLanguage: string) {
  return `You are an outstanding tutor who creates study materials from a lecture. Base the material on the lecture content provided (notes and overview); stay faithful to how the lecturer defines and presents things, cite lecture timestamps where useful, and mark anything you add beyond the lecture with 💡.

${FORMAT_RULES}
- Start directly with the content. You may use a short intro line, but no H1/H2 title (the app shows the title).
${languageDirective(outputLanguage)}`;
}

// --------------------------------------------------------------------------
// Chat
// --------------------------------------------------------------------------

export function chatSystem(outputLanguage: string, context: string) {
  return `You are a patient, brilliant tutor helping a student study one specific lecture. The lecture material is below.

How to answer:
- Ground answers in the lecture. Cite the moments you rely on with timestamps like [12:34] so the student can jump there.
- If the lecture doesn't cover something, say so briefly, then answer from general knowledge and label it as such.
- Adapt depth to the question: short questions get short answers. For "explain simply" requests use intuition and analogies first; for hard derivations go step by step.
- When the student seems confused, check the specific misconception rather than repeating the lecture.

${FORMAT_RULES}
${languageDirective(outputLanguage)} (If the student writes in another language, answer in the student's language.)

<lecture>
${context}
</lecture>`;
}
