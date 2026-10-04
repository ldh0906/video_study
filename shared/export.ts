import type { ExportOptions, ExportPreset, Material } from "./types";

export const EXPORT_PRESETS: { id: ExportPreset; label: string; blurb: string }[] = [
  { id: "full", label: "완전 학습서", blurb: "노트 + 이해 확인 + 백지 복습 + 종합 문제 + 카드, 정답은 부록" },
  { id: "guided", label: "빈칸 노트", blurb: "핵심 용어를 빈칸으로 비운 노트 — 채우면서 공부" },
  { id: "review", label: "시험 직전 요약판", blurb: "핵심 정리·용어집·요약 노트만 담은 얇은 판" },
  { id: "workbook", label: "문제집", blurb: "이해 확인·종합 문제·연습 문제와 해설만" },
];

export function presetOptions(preset: ExportPreset, materials: Material[]): ExportOptions {
  const done = materials.filter((m) => m.status === "done");
  const base: ExportOptions = {
    preset,
    layout: "margin",
    paper: "A4",
    fields: false,
    notes: true,
    depth: "full",
    blanks: "off",
    cover: true,
    guide: true,
    overview: true,
    toc: true,
    checks: true,
    summaryBox: true,
    recall: true,
    frames: true,
    qr: false,
    quiz: true,
    glossary: true,
    conceptMap: true,
    materials: done.map((m) => m.id),
    cards: true,
    memo: true,
    transcript: false,
    blankPages: 2,
  };
  switch (preset) {
    case "guided":
      return { ...base, blanks: "all", quiz: false, glossary: false, conceptMap: false, cards: false, materials: [], memo: false };
    case "review":
      return {
        ...base,
        layout: "compact",
        depth: "key",
        guide: false,
        checks: false,
        summaryBox: false,
        recall: false,
        frames: false,
        quiz: false,
        memo: false,
        blankPages: 0,
        materials: done.filter((m) => m.kind === "cheatsheet").map((m) => m.id),
      };
    case "workbook":
      return {
        ...base,
        notes: false,
        recall: false,
        frames: false,
        glossary: false,
        conceptMap: false,
        cards: false,
        memo: false,
        blankPages: 1,
        materials: done.filter((m) => ["practice", "exam"].includes(m.kind)).map((m) => m.id),
      };
    default:
      return base;
  }
}
