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

const OPENAI_6 = ["low", "medium", "high", "xhigh", "max"];
const OPENAI_6_LUNA = ["none", "low", "medium", "high", "xhigh", "max"];
const CLAUDE_5X = ["low", "medium", "high", "xhigh", "max"];

// Checked against the providers' model pages on 2026-10-15.
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
    id: "claude-fable-5-1",
    provider: "anthropic",
    label: "Claude Fable 5.1",
    blurb: "가장 강력한 추론 — 매우 어려운 강의·교재용",
    efforts: CLAUDE_5X,
    defaultEffort: "high",
    vision: true,
    price: { input: 10, output: 50 },
  },
  {
    id: "claude-sonnet-5-5",
    provider: "anthropic",
    label: "Claude Sonnet 5.5",
    blurb: "빠르고 똑똑한 균형형 — 튜터·채점에 좋아요",
    efforts: CLAUDE_5X,
    defaultEffort: "medium",
    vision: true,
    price: { input: 2, output: 10 },
  },
  {
    id: "claude-haiku-5-5",
    provider: "anthropic",
    label: "Claude Haiku 5.5",
    blurb: "가볍고 빠른 저비용 모델",
    efforts: CLAUDE_5X,
    defaultEffort: "medium",
    vision: true,
    price: { input: 0.1, output: 0.5 },
  },
  {
    id: "gpt-6.1-sol",
    provider: "openai",
    label: "GPT-6.1 Sol",
    blurb: "OpenAI 최신 주력 모델",
    efforts: OPENAI_6,
    defaultEffort: "medium",
    vision: true,
  },
  {
    id: "gpt-6-astra",
    provider: "openai",
    label: "GPT-6 Astra",
    blurb: "OpenAI 최상위 추론 모델 — 가장 어려운 작업용",
    efforts: OPENAI_6,
    defaultEffort: "high",
    vision: true,
  },
  {
    id: "gpt-6-luna",
    provider: "openai",
    label: "GPT-6 Luna",
    blurb: "빠르고 저렴한 경량 모델",
    efforts: OPENAI_6_LUNA,
    defaultEffort: "low",
    vision: true,
  },
];

/**
 * Retired models, mapped to their successors. Lectures keep the model they
 * were analyzed with, and these are gone (GPT-5.5 left ChatGPT sign-in Codex
 * on 2026-10-14), so requests made for those lectures use the successor.
 */
export const RETIRED_MODELS: Record<string, string> = {
  "gpt-5.5": "gpt-6.1-sol",
  "gpt-5.4-mini": "gpt-6-luna",
  "claude-haiku-4-5": "claude-haiku-5-5",
};

/** Older generations still served; saved settings move to the successor once per catalog version. */
export const MODEL_UPGRADES: Record<string, string> = {
  ...RETIRED_MODELS,
  "gpt-6-sol": "gpt-6.1-sol",
  "gpt-5.6-sol": "gpt-6.1-sol",
  "gpt-5.6-terra": "gpt-6.1-sol",
  "gpt-5.6-luna": "gpt-6-luna",
};

export const CATALOG_VERSION = "2026-10";

/** The successor of a model choice in `map`, with an effort the new model accepts. */
export function currentChoice<T extends { provider: Provider; model: string; effort: string }>(choice: T, map: Record<string, string> = RETIRED_MODELS): T {
  const next = map[choice.model];
  if (!next) return choice;
  const info = findModel(choice.provider, next);
  const effort = choice.effort === "default" || info?.efforts.includes(choice.effort) ? choice.effort : (info?.defaultEffort ?? "default");
  return { ...choice, model: next, effort };
}

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
  if (/^gpt-6/.test(id)) return ["default", ...OPENAI_6_LUNA];
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
  { id: "gpt-transcribe", label: "GPT Transcribe", blurb: "OpenAI API · 최신·최고 정확도 · 30초 단위 타임스탬프" },
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
