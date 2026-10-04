import { createContext, useContext } from "react";
import type { Analysis, Lecture } from "@shared/types";

export type TabId = "overview" | "notes" | "chat" | "cards" | "quiz" | "mindmap" | "materials" | "memo" | "transcript";

export interface StudyContextValue {
  lecture: Lecture;
  analysis: Analysis | null;
  tab: TabId;
  setTab: (t: TabId) => void;
  /** send a question to the chat tab (optionally anchored to a video time) */
  ask: (text: string, anchor?: number | null) => void;
  /** append a snippet to "my notes" */
  addToMemo: (text: string, time?: number | null) => void;
  /** open the add-card dialog prefilled */
  makeCard: (front: string, back?: string, time?: number | null) => void;
}

export const StudyContext = createContext<StudyContextValue | null>(null);

export function useStudy() {
  const ctx = useContext(StudyContext);
  if (!ctx) throw new Error("useStudy outside provider");
  return ctx;
}
