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
  | "analyze"
  | "synthesize"
  | "materials";

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

export interface Lecture {
  id: string;
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
  tags: string[];
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
  /** SRS state (SM-2 style) */
  due: number;
  interval: number; // days
  ease: number;
  reps: number;
  lapses: number;
  createdAt: number;
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
