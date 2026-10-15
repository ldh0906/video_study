// Types shared by the server and the web client.

export type Provider = "openai" | "anthropic";

export interface ModelChoice {
  provider: Provider;
  model: string;
  /** "default" means: don't send an effort parameter, let the model decide. */
  effort: string;
}

export type TranscriptionModel =
  | "local-whisper"
  | "gpt-4o-transcribe-diarize"
  | "whisper-1"
  | "gpt-transcribe"
  | "gpt-4o-transcribe"
  | "gpt-4o-mini-transcribe";

export type SubtitlePolicy = "prefer" | "ai" | "only";

/** "cli" runs the locally installed Claude Code / Codex CLI with the user's own account. */
export type Connection = "cli" | "api";

export type WhisperModel = "large-v3-turbo-q5_0" | "medium-q5_0" | "small-q5_1" | "base-q5_1";

export interface Settings {
  openaiApiKey: string;
  anthropicApiKey: string;
  connection: Record<Provider, Connection>;
  whisperModel: WhisperModel;
  analysis: ModelChoice;
  chat: ModelChoice;
  transcription: TranscriptionModel;
  /** Output language for notes & materials. "auto" = same as the lecture. */
  outputLanguage: string;
  /** Spoken language hint for transcription, ISO code or "" for auto-detect. */
  spokenLanguage: string;
  subtitlePolicy: SubtitlePolicy;
  visualAnalysis: boolean;
  framesPerSection: number;
  concurrency: number;
  downloadQuality: "480" | "720" | "1080";
  cookiesFromBrowser: "" | "chrome" | "edge" | "firefox" | "brave" | "whale";
  /** the model catalog the saved choices were last moved to */
  catalogVersion?: string;
}

/** What the client sees: keys are masked. */
export interface PublicSettings extends Omit<Settings, "openaiApiKey" | "anthropicApiKey"> {
  keys: {
    openai: { set: boolean; source: "settings" | "env" | null; hint: string };
    anthropic: { set: boolean; source: "settings" | "env" | null; hint: string };
  };
}

export interface ToolInfo {
  ok: boolean;
  path: string | null;
  version?: string;
}

export interface ToolStatus {
  ffmpeg: ToolInfo;
  ytdlp: ToolInfo;
  claude: ToolInfo;
  codex: ToolInfo;
  whisper: ToolInfo & { models: WhisperModel[] };
}

export interface ModelOption {
  id: string;
  label: string;
  blurb?: string;
  efforts: string[];
  defaultEffort: string;
}

export type StepId =
  | "fetch"
  | "audio"
  | "transcribe"
  | "frames"
  | "extract"
  | "analyze"
  | "synthesize"
  | "materials"
  | "pages";

export type StepStatus = "pending" | "running" | "done" | "skipped" | "error";

export interface Step {
  id: StepId;
  status: StepStatus;
  progress: number; // 0..1
  detail?: string;
  startedAt?: number;
  endedAt?: number;
}

export type LectureStatus = "queued" | "processing" | "ready" | "error" | "canceled" | "interrupted";

export interface LectureSource {
  kind: "upload" | "path" | "url";
  /** original file name, local path, or URL */
  value: string;
}

export interface LectureOptions {
  analysis: ModelChoice;
  transcription: TranscriptionModel;
  outputLanguage: string;
  spokenLanguage: string;
  subtitlePolicy: SubtitlePolicy;
  visualAnalysis: boolean;
  /** Extra context from the user, e.g. course name or what to focus on. */
  focus: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  audioSeconds: number;
}

/** What a PDF is for the course; the exam builder weighs sources by it. */
export type DocType = "textbook" | "slides" | "assignment" | "lab" | "exam" | "notes" | "other";

/**
 * A study item: a lecture video, or (kind "doc") a PDF. For documents every
 * `time`/`start`/`end` anchor in the analysis, cards and quizzes holds a
 * 1-based page number instead of seconds, so the study tabs work unchanged.
 */
export interface Lecture {
  id: string;
  /** absent on items made before documents existed */
  kind?: "video" | "doc";
  /** documents only: the AI's guess, which the student can change */
  docType?: DocType;
  pageCount?: number;
  /** the student's own labels, for filtering the library */
  tags?: string[];
  title: string;
  createdAt: number;
  updatedAt: number;
  source: LectureSource;
  /** absolute path of the playable media file */
  mediaPath?: string;
  hasVideo: boolean;
  hasThumbnail: boolean;
  durationSec: number;
  status: LectureStatus;
  steps: Step[];
  error?: string;
  options: LectureOptions;
  usage: Usage;
  transcriptSource?: string;
  /** set once analysis.json exists */
  analyzed: boolean;
  /** folder in the library; absent = top level */
  folderId?: string;
}

/** A library folder; in practice one course, so exams are built per folder. */
export interface Folder {
  id: string;
  name: string;
  createdAt: number;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface Transcript {
  source: string;
  language?: string;
  segments: Segment[];
}

export interface Frame {
  time: number;
  file: string;
}

export interface KeyPoint {
  time: number;
  point: string;
}

export interface Concept {
  term: string;
  definition: string;
  /** seconds; absent in analyses made before concepts were timed */
  time?: number;
}

export interface SelfCheck {
  question: string;
  answer: string;
  time: number;
}

/** A claim the notes mark as uncertain, or a correction of the lecturer. */
export interface Flag {
  time: number;
  kind: "verify" | "correction";
  text: string;
}

export interface DifficultPart {
  time: number;
  topic: string;
  why: string;
  explanation: string;
}

export interface SectionAnalysis {
  index: number;
  start: number;
  end: number;
  title: string;
  summary: string;
  notes: string; // markdown
  keyPoints: KeyPoint[];
  concepts: Concept[];
  difficult: DifficultPart[];
  cards: { front: string; back: string; time: number }[];
  /** absent in older analyses, whose self-checks live inside `notes` */
  selfCheck?: SelfCheck[];
  flags?: Flag[];
}

export interface Chapter {
  title: string;
  start: number;
  end: number;
  summary: string;
  sections: number[];
}

export interface Overview {
  title: string;
  oneLiner: string;
  summary: string; // markdown
  objectives: string[];
  prerequisites: { topic: string; why: string }[];
  chapters: Chapter[];
  glossary: { term: string; definition: string; time: number }[];
  mindmap: string; // markdown outline
  difficulty: number; // 1..5
  /** topic tags the AI suggests; the student adopts them into Lecture.tags */
  tags: string[];
  /** documents only */
  docType?: DocType;
  /** documents only: what the author marks as important or exam-relevant, and each assignment/lab task */
  emphasis?: { time: number; text: string }[];
  /** claims to verify, carried over from the parts */
  issues?: { time: number; text: string }[];
}

export interface Analysis {
  overview: Overview;
  sections: SectionAnalysis[];
  model: string;
  createdAt: number;
}

export interface Flashcard {
  id: string;
  front: string;
  back: string;
  time: number | null;
  /** SRS state. `ease` is the legacy SM-2 factor, only read to migrate older cards to FSRS. */
  due: number;
  interval: number; // days
  ease: number;
  reps: number;
  lapses: number;
  createdAt: number;
  /** FSRS memory state; absent until the card's first FSRS review */
  stability?: number;
  difficulty?: number;
  state?: 0 | 1 | 2 | 3; // new, learning, review, relearning
  learningSteps?: number;
  lastReview?: number;
  /** when the card was first studied, for the daily new-card limit */
  introducedAt?: number;
}

export interface QuizQuestion {
  id: string;
  type: "mcq" | "short";
  question: string;
  options: string[]; // mcq only
  answerIndex: number; // mcq only, -1 for short
  answer: string; // model answer / correct option text
  explanation: string;
  time: number | null;
  difficulty: "easy" | "medium" | "hard";
}

export interface Quiz {
  id: string;
  title: string;
  createdAt: number;
  questions: QuizQuestion[];
}

export type MaterialKind = "cheatsheet" | "deepdive" | "practice" | "exam" | "faq" | "custom";

export interface Material {
  id: string;
  kind: MaterialKind;
  title: string;
  prompt: string;
  content: string; // markdown
  status: "generating" | "done" | "error";
  error?: string;
  model: string;
  createdAt: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  /** optional time anchor the question was asked about */
  anchor?: number | null;
  error?: boolean;
}

export interface GradeResult {
  score: number; // 0..100
  verdict: "correct" | "partial" | "incorrect";
  feedback: string;
}

// --- interactive study pages ---------------------------------------------------

/** A self-contained HTML lesson for one chapter, shown in a sandboxed frame. */
export interface StudyPage {
  id: string;
  /** index into overview.chapters */
  chapter: number;
  title: string;
  /** body HTML using the Lens Kit elements (lk-*) */
  html: string;
  prompt: string;
  status: "generating" | "done" | "error";
  /** characters written so far, while generating */
  progress?: number;
  error?: string;
  model: string;
  createdAt: number;
}

// --- course exams --------------------------------------------------------------

export type Bloom = "remember" | "understand" | "apply" | "analyze" | "evaluate";

export interface ExamConfig {
  /** study items the exam covers */
  lectureIds: string[];
  style: "quiz" | "midterm" | "final";
  count: number;
  minutes: number;
  difficulty: "easy" | "mixed" | "hard";
  /** share of multiple-choice questions, 0..1; the rest are written answers */
  mcqShare: number;
  focus: string;
}

/** One row of the coverage plan: a topic, how much of the exam it gets and why. */
export interface BlueprintRow {
  topic: string;
  questions: number;
  bloom: Bloom[];
  why: string;
  sources: { lectureId: string; anchor: number }[];
}

export interface ExamQuestion {
  id: string;
  type: "mcq" | "short" | "essay";
  question: string;
  options: string[];
  answerIndex: number;
  answer: string;
  explanation: string;
  /** what a grader checks, one point per line */
  rubric: string[];
  points: number;
  topic: string;
  bloom: Bloom;
  difficulty: "easy" | "medium" | "hard";
  source: { lectureId: string; anchor: number } | null;
}

export interface ExamAttempt {
  id: string;
  startedAt: number;
  submittedAt?: number;
  answers: Record<string, string>;
  grades: Record<string, GradeResult & { points: number }>;
  score: number;
  maxScore: number;
  status: "taking" | "grading" | "graded";
}

export interface Exam {
  id: string;
  folderId: string | null;
  title: string;
  createdAt: number;
  status: "planning" | "writing" | "ready" | "error";
  progress?: string;
  error?: string;
  config: ExamConfig;
  blueprint: BlueprintRow[];
  questions: ExamQuestion[];
  attempts: ExamAttempt[];
  model: string;
}

// --- study-book PDF export ---------------------------------------------------

export type ExportPreset = "full" | "guided" | "review" | "workbook";

export interface ExportOptions {
  preset: ExportPreset;
  /** margin: wide note column · cornell: cue/notes/summary · compact: paper-saving */
  layout: "margin" | "cornell" | "compact";
  paper: "A4" | "B5";
  /** add fillable AcroForm fields (typing edition) */
  fields: boolean;
  /** include section notes at all (off for a pure workbook) */
  notes: boolean;
  /** full notes, or key points only */
  depth: "full" | "key";
  /** guided notes: blank out bolded key terms */
  blanks: "off" | "some" | "all";
  cover: boolean;
  guide: boolean;
  overview: boolean;
  toc: boolean;
  checks: boolean;
  summaryBox: boolean;
  recall: boolean;
  frames: boolean;
  qr: boolean;
  quiz: boolean;
  glossary: boolean;
  conceptMap: boolean;
  /** ids of generated materials to include */
  materials: string[];
  cards: boolean;
  memo: boolean;
  transcript: boolean;
  blankPages: number;
}

export interface ExportResult {
  file: string;
  pages: number;
  bytes: number;
  fields: number;
  ms: number;
}

export interface ExportFile {
  file: string;
  bytes: number;
  createdAt: number;
}
