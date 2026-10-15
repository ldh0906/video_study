import fs from "node:fs";
import { customAlphabet } from "nanoid";
import path from "node:path";
import { DATA_DIR, LECTURES_DIR, lectureDir, readJson, writeJson } from "./paths";
import type {
  Analysis,
  ChatMessage,
  Flashcard,
  Folder,
  Frame,
  Lecture,
  Material,
  Quiz,
  Step,
  StudyPage,
  StepId,
  Transcript,
} from "../shared/types";

export const newId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

const STEP_ORDER: StepId[] = ["fetch", "audio", "transcribe", "frames", "analyze", "synthesize", "materials"];
const DOC_STEP_ORDER: StepId[] = ["extract", "analyze", "synthesize", "materials", "pages"];

export function freshSteps(kind: Lecture["kind"] = "video"): Step[] {
  return (kind === "doc" ? DOC_STEP_ORDER : STEP_ORDER).map((id) => ({ id, status: "pending", progress: 0 }));
}

export function listLectures(): Lecture[] {
  if (!fs.existsSync(LECTURES_DIR)) return [];
  return fs
    .readdirSync(LECTURES_DIR)
    .map((id) => readJson<Lecture | null>(lectureDir(id, "lecture.json"), null))
    .filter((l): l is Lecture => l !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function getLecture(id: string): Lecture | null {
  return readJson<Lecture | null>(lectureDir(id, "lecture.json"), null);
}

export function saveLecture(lecture: Lecture) {
  lecture.updatedAt = Date.now();
  writeJson(lectureDir(lecture.id, "lecture.json"), lecture);
}

export function updateLecture(id: string, fn: (l: Lecture) => void): Lecture {
  const lecture = getLecture(id);
  if (!lecture) throw new Error(`lecture ${id} not found`);
  fn(lecture);
  saveLecture(lecture);
  return lecture;
}

export function deleteLecture(id: string) {
  fs.rmSync(lectureDir(id), { recursive: true, force: true });
}

// --- library folders ---------------------------------------------------------

const FOLDERS_FILE = path.join(DATA_DIR, "folders.json");

export function listFolders(): Folder[] {
  return readJson<Folder[]>(FOLDERS_FILE, []);
}

export function saveFolders(folders: Folder[]) {
  writeJson(FOLDERS_FILE, folders);
}

// --- per-lecture documents -------------------------------------------------

export const docs = {
  transcript: {
    get: (id: string) => readJson<Transcript | null>(lectureDir(id, "transcript.json"), null),
    set: (id: string, v: Transcript) => writeJson(lectureDir(id, "transcript.json"), v),
  },
  frames: {
    get: (id: string) => readJson<Frame[] | null>(lectureDir(id, "frames.json"), null),
    set: (id: string, v: Frame[]) => writeJson(lectureDir(id, "frames.json"), v),
  },
  analysis: {
    get: (id: string) => readJson<Analysis | null>(lectureDir(id, "analysis.json"), null),
    set: (id: string, v: Analysis) => writeJson(lectureDir(id, "analysis.json"), v),
  },
  flashcards: {
    get: (id: string) => readJson<Flashcard[]>(lectureDir(id, "flashcards.json"), []),
    set: (id: string, v: Flashcard[]) => writeJson(lectureDir(id, "flashcards.json"), v),
  },
  quizzes: {
    get: (id: string) => readJson<Quiz[]>(lectureDir(id, "quizzes.json"), []),
    set: (id: string, v: Quiz[]) => writeJson(lectureDir(id, "quizzes.json"), v),
  },
  materials: {
    get: (id: string) => readJson<Material[]>(lectureDir(id, "materials.json"), []),
    set: (id: string, v: Material[]) => writeJson(lectureDir(id, "materials.json"), v),
  },
  chat: {
    get: (id: string) => readJson<ChatMessage[]>(lectureDir(id, "chat.json"), []),
    set: (id: string, v: ChatMessage[]) => writeJson(lectureDir(id, "chat.json"), v),
  },
  studyPages: {
    get: (id: string) => readJson<StudyPage[]>(lectureDir(id, "study-pages.json"), []),
    set: (id: string, v: StudyPage[]) => writeJson(lectureDir(id, "study-pages.json"), v),
  },
  notes: {
    get: (id: string) => {
      try {
        return fs.readFileSync(lectureDir(id, "my-notes.md"), "utf8");
      } catch {
        return "";
      }
    },
    set: (id: string, v: string) => fs.writeFileSync(lectureDir(id, "my-notes.md"), v),
  },
};
