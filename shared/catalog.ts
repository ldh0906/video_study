import type { Provider, TranscriptionModel } from "./types";

export interface ModelInfo {
  id: string;
  provider: Provider;
  label: string;
  blurb: string;
  efforts: string[];
  defaultEffort: string;
  vision: boolean;
  /** USD per 1M tokens, for rough cost display only */
  price?: { input: number; output: number };
}

const OPENAI_5X = ["none", "low", "medium", "high", "xhigh"];
const OPENAI_56 = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_5X = ["low", "medium", "high", "xhigh", "max"];

export const MODEL_CATALOG: ModelInfo[] = [
  {
    id: "claude-opus-5-5",
    provider: "anthropic",
    label: "Claude Opus 5.5",
    blurb: "깊이 있는 분석과 긴 맥락에 강한 기본 추천 모델",
    efforts: CLAUDE_5X,
    defaultEffort: "high",
    vision: true,
    price: { input: 4, output: 20 },
  },
  {
    id: "claude-sonnet-5-5",
    provider: "anthropic",
    label: "Claude Sonnet 5.5",
    blurb: "빠르고 똑똑한 균형형",
    efforts: CLAUDE_5X,
    defaultEffort: "medium",
    vision: true,
    price: { input: 2, output: 10 },
  },
  {
    id: "claude-fable-5-1",
    provider: "anthropic",
    label: "Claude Fable 5.1",
    blurb: "가장 강력한 추론 — 매우 어려운 강의용",
    efforts: CLAUDE_5X,
    defaultEffort: "high",
    vision: true,
    price: { input: 10, output: 50 },
  },
  {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    label: "Claude Haiku 4.5",
    blurb: "가볍고 빠른 저비용 모델",
    efforts: ["none", "low", "medium", "high"],
    defaultEffort: "none",
    vision: true,
    price: { input: 1, output: 5 },
  },
  {
    id: "gpt-5.6-sol",
    provider: "openai",
    label: "GPT-5.6 Sol",
    blurb: "OpenAI 최상위 추론 모델",
    efforts: OPENAI_56,
    defaultEffort: "high",
    vision: true,
    price: { input: 5, output: 30 },
  },
  {
    id: "gpt-5.6-terra",
    provider: "openai",
    label: "GPT-5.6 Terra",
    blurb: "일상 작업용 균형형",
    efforts: OPENAI_56,
    defaultEffort: "medium",
    vision: true,
    price: { input: 2.5, output: 15 },
  },
  {
    id: "gpt-5.6-luna",
    provider: "openai",
    label: "GPT-5.6 Luna",
    blurb: "빠르고 저렴한 경량 모델",
    efforts: OPENAI_56,
    defaultEffort: "low",
    vision: true,
    price: { input: 1, output: 6 },
  },
  {
    id: "gpt-5.5",
    provider: "openai",
    label: "GPT-5.5",
    blurb: "이전 세대 플래그십",
    efforts: OPENAI_5X,
    defaultEffort: "medium",
    vision: true,
    price: { input: 5, output: 30 },
  },
  {
    id: "gpt-5.4-mini",
    provider: "openai",
    label: "GPT-5.4 mini",
    blurb: "저비용 경량 모델",
    efforts: OPENAI_5X,
    defaultEffort: "low",
    vision: true,
  },
];

export const EFFORT_LABELS: Record<string, string> = {
  default: "자동",
  none: "끔",
  minimal: "최소",
  low: "낮음",
  medium: "보통",
  high: "높음",
  xhigh: "매우 높음",
  max: "최대",
  ultra: "울트라",
};

export function findModel(provider: Provider, id: string): ModelInfo | undefined {
  return MODEL_CATALOG.find((m) => m.provider === provider && m.id === id);
}

/** Effort levels to offer for a model, including ones we only know from the provider's model list. */
export function effortOptions(provider: Provider, id: string): string[] {
  const known = findModel(provider, id);
  if (known) return ["default", ...known.efforts];
  if (provider === "anthropic") {
    if (/haiku|claude-3|sonnet-4-5|opus-4-1|opus-4-0|sonnet-4-0/.test(id)) return ["default", "none", "low", "medium", "high"];
    return ["default", ...CLAUDE_5X];
  }
  if (/^(gpt-5|o\d)/.test(id)) return ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"];
  return ["default"];
}

export const TRANSCRIPTION_MODELS: { id: TranscriptionModel; label: string; blurb: string }[] = [
  { id: "local-whisper", label: "로컬 Whisper", blurb: "내 PC에서 실행 · 무료 · 계정/키 불필요 (추천)" },
  {
    id: "gpt-4o-transcribe-diarize",
    label: "GPT-4o Transcribe Diarize",
    blurb: "OpenAI API · 정확도 높음 · 화자 구분",
  },
  { id: "whisper-1", label: "Whisper API", blurb: "OpenAI API · 저렴함 · 정밀한 타임스탬프" },
  { id: "gpt-transcribe", label: "GPT Transcribe", blurb: "OpenAI API · 최고 정확도 · 30초 단위 타임스탬프" },
  { id: "gpt-4o-transcribe", label: "GPT-4o Transcribe", blurb: "OpenAI API · 30초 단위 타임스탬프" },
  { id: "gpt-4o-mini-transcribe", label: "GPT-4o mini Transcribe", blurb: "OpenAI API · 저렴함 · 30초 단위 타임스탬프" },
];

export const OUTPUT_LANGUAGES: { id: string; label: string }[] = [
  { id: "ko", label: "한국어" },
  { id: "en", label: "English" },
  { id: "ja", label: "日本語" },
  { id: "zh", label: "中文" },
  { id: "auto", label: "강의 언어와 동일" },
];

export const LANGUAGE_NAMES: Record<string, string> = {
  ko: "Korean (한국어)",
  en: "English",
  ja: "Japanese (日本語)",
  zh: "Simplified Chinese (中文)",
};
