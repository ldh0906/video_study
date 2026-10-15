import type { DocType } from "./types";

/** How each kind of course document is named and colored in the library. */
export const DOC_TYPE_INFO: Record<DocType, { label: string; color: string }> = {
  textbook: { label: "교재", color: "#5b5bd6" },
  slides: { label: "강의자료", color: "#2f8f5b" },
  assignment: { label: "과제", color: "#c4453c" },
  lab: { label: "실습", color: "#b7791f" },
  exam: { label: "기출·시험", color: "#a347b8" },
  notes: { label: "필기", color: "#2b7fb5" },
  other: { label: "기타", color: "#716d65" },
};

export const DOC_TYPE_ORDER: DocType[] = ["slides", "textbook", "assignment", "lab", "exam", "notes", "other"];
