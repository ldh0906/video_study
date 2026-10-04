import type {
  Analysis,
  ChatMessage,
  Flashcard,
  Frame,
  GradeResult,
  Lecture,
  LectureOptions,
  Material,
  MaterialKind,
  ModelChoice,
  ModelOption,
  Provider,
  PublicSettings,
  Quiz,
  Settings,
  ToolStatus,
  Transcript,
} from "@shared/types";

export type LectureSummary = Lecture & { cardsDue: number; cardsTotal: number };

export type SettingsPatch = Omit<Partial<Settings>, "openaiApiKey" | "anthropicApiKey"> & { openaiApiKey?: string | null; anthropicApiKey?: string | null };

export interface DownloadState {
  status: "downloading" | "done" | "error";
  received: number;
  total: number;
  error?: string;
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `요청 실패 (${res.status})`);
  return data as T;
}

const L = (id: string, rest = "") => `/api/lectures/${id}${rest}`;

export const api = {
  settings: () => req<PublicSettings>("GET", "/api/settings"),
  saveSettings: (patch: SettingsPatch) =>
    req<PublicSettings>("PUT", "/api/settings", patch),
  tools: (refresh = false) => req<ToolStatus & { downloads: Record<string, DownloadState> }>("GET", `/api/tools${refresh ? "?refresh=1" : ""}`),
  installYtdlp: () => req<{ ok: boolean; version?: string }>("POST", "/api/tools/ytdlp/install"),
  installWhisper: () => req<{ ok: boolean }>("POST", "/api/tools/whisper/install"),
  installWhisperModel: (model: string) => req<{ ok: boolean }>("POST", `/api/tools/whisper/models/${model}`),
  models: (provider: Provider) => req<{ models: ModelOption[]; connection: "cli" | "api"; error?: string }>("GET", `/api/models?provider=${provider}`),
  testModel: (choice: ModelChoice) => req<{ ok: boolean; text: string; ms: number }>("POST", "/api/models/test", choice),

  lectures: () => req<LectureSummary[]>("GET", "/api/lectures"),
  lecture: (id: string) => req<Lecture & { busy: boolean }>("GET", L(id)),
  createLecture: (body: {
    source: { kind: "upload" | "path" | "url"; value: string; uploadId?: string };
    title?: string;
    subtitleUploadId?: string;
    options?: Partial<LectureOptions>;
  }) => req<Lecture>("POST", "/api/lectures", body),
  updateLecture: (id: string, patch: { title?: string; options?: Partial<LectureOptions> }) => req<Lecture>("PATCH", L(id), patch),
  deleteLecture: (id: string) => req("DELETE", L(id)),
  resume: (id: string) => req("POST", L(id, "/resume")),
  cancel: (id: string) => req("POST", L(id, "/cancel")),
  reprocess: (id: string, from: "analysis" | "transcript", options?: Partial<LectureOptions>) =>
    req("POST", L(id, "/reprocess"), { from, options }),

  transcript: (id: string) => req<Transcript | null>("GET", L(id, "/transcript")),
  analysis: (id: string) => req<Analysis | null>("GET", L(id, "/analysis")),
  frames: (id: string) => req<Frame[]>("GET", L(id, "/frames")),

  notes: (id: string) => req<{ content: string }>("GET", L(id, "/notes")),
  saveNotes: (id: string, content: string) => req("PUT", L(id, "/notes"), { content }),

  flashcards: (id: string) => req<Flashcard[]>("GET", L(id, "/flashcards")),
  addCard: (id: string, card: { front: string; back: string; time?: number | null }) => req<Flashcard>("POST", L(id, "/flashcards"), card),
  updateCard: (id: string, cardId: string, patch: Partial<Flashcard>) => req("PUT", L(id, `/flashcards/${cardId}`), patch),
  deleteCard: (id: string, cardId: string) => req("DELETE", L(id, `/flashcards/${cardId}`)),
  generateCards: (id: string, count: number, focus: string) => req<Flashcard[]>("POST", L(id, "/flashcards/generate"), { count, focus }),

  quizzes: (id: string) => req<Quiz[]>("GET", L(id, "/quizzes")),
  generateQuiz: (id: string, body: { count: number; difficulty: string; focus: string }) => req<Quiz>("POST", L(id, "/quizzes/generate"), body),
  deleteQuiz: (id: string, quizId: string) => req("DELETE", L(id, `/quizzes/${quizId}`)),
  grade: (id: string, quizId: string, questionId: string, answer: string) =>
    req<GradeResult>("POST", L(id, `/quizzes/${quizId}/grade`), { questionId, answer }),

  materials: (id: string) => req<Material[]>("GET", L(id, "/materials")),
  createMaterial: (id: string, kind: MaterialKind, prompt: string) => req<Material>("POST", L(id, "/materials"), { kind, prompt }),
  deleteMaterial: (id: string, mid: string) => req("DELETE", L(id, `/materials/${mid}`)),

  chat: (id: string) => req<ChatMessage[]>("GET", L(id, "/chat")),
  clearChat: (id: string) => req("DELETE", L(id, "/chat")),

  mediaUrl: (id: string) => L(id, "/media"),
  thumbUrl: (id: string, v?: number) => L(id, `/thumb${v ? `?v=${v}` : ""}`),
  frameUrl: (id: string, file: string) => L(id, `/frames/${file}`),
  exportUrl: (id: string, format: "md" | "anki") => L(id, `/export?format=${format}`),
};

/** Stream a chat reply over SSE. */
export async function streamChat(
  id: string,
  message: string,
  anchor: number | null,
  handlers: { onDelta: (t: string) => void; signal?: AbortSignal },
): Promise<{ ok: true; reply: ChatMessage } | { ok: false; error: string }> {
  const res = await fetch(L(id, "/chat"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, anchor }),
    signal: handlers.signal,
  });
  if (!res.ok || !res.body) return { ok: false, error: `요청 실패 (${res.status})` };
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const event = raw.match(/^event: (.*)$/m)?.[1];
      const data = raw
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      if (!data) continue;
      const parsed = JSON.parse(data);
      if (event === "delta") handlers.onDelta(parsed);
      else if (event === "done") return { ok: true, reply: parsed };
      else if (event === "error") return { ok: false, error: parsed };
    }
  }
  return { ok: false, error: "연결이 끊겼습니다." };
}

/** Upload with progress (fetch can't report upload progress). */
export function uploadFile(file: File, onProgress: (p: number) => void): Promise<{ uploadId: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/uploads?name=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
      else reject(new Error(`업로드 실패 (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("업로드 중 연결이 끊겼습니다."));
    xhr.send(file);
  });
}
