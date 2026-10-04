import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline as pipe } from "node:stream/promises";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { MODEL_CATALOG, effortOptions } from "../shared/catalog";
import { presetOptions } from "../shared/export";
import { fmtTime } from "../shared/time";
import type { ExportFile, ExportOptions, Flashcard, Lecture, LectureOptions, MaterialKind, ModelChoice, ModelOption, Provider, Settings, ToolStatus, WhisperModel } from "../shared/types";
import { buildDocument } from "./export/document";
import { exportStudyPdf, exportsDir, readFilledPdf } from "./export/pdf";
import { generateText, LLMError } from "./llm";
import { listAnthropicModels } from "./llm/anthropic";
import { cliStatus, codexModels } from "./llm/cli";
import { listOpenAIModels } from "./llm/openai";
import { DATA_DIR, ROOT, WEB_DIST, lectureDir } from "./paths";
import { cancel, enqueue, isBusy, recoverOnBoot, resetAnalysis, resetTranscript } from "./pipeline";
import { getSettings, publicSettings, saveSettings } from "./settings";
import { deleteLecture, docs, freshSteps, getLecture, listLectures, newId, saveLecture, updateLecture } from "./store";
import { chat, generateMoreCards, generateQuiz, gradeAnswer, newCard, startMaterial } from "./study";
import { FFMPEG, ffmpegVersion } from "./tools/ffmpeg";
import { installYtdlp, resolveYtdlp } from "./tools/ytdlp";
import { WHISPER_MODELS, downloads, installModel, installWhisper, resolveWhisper, whisperStatus } from "./tools/whisper";

const port = Number(process.env.LECTURE_API_PORT ?? 5178);
const ORIGIN = `http://127.0.0.1:${port}`;
const UPLOADS = path.join(DATA_DIR, "uploads");
fs.mkdirSync(UPLOADS, { recursive: true });

const app = new Hono();

app.onError((err, c) => {
  console.error(err);
  const status = err instanceof LLMError && err.kind === "auth" ? 401 : ((err as { status?: number }).status ?? 500);
  return c.json({ error: err.message || String(err) }, status as 400 | 401 | 404 | 500);
});

function must(id: string): Lecture {
  const l = getLecture(id);
  if (!l) throw Object.assign(new Error("강의를 찾을 수 없습니다."), { status: 404 });
  return l;
}

// --- settings & tools --------------------------------------------------------

app.get("/api/settings", (c) => c.json(publicSettings()));

app.put("/api/settings", async (c) => {
  const body = (await c.req.json()) as Partial<Settings> & { openaiApiKey?: string | null; anthropicApiKey?: string | null };
  const patch: Partial<Settings> = { ...body } as Partial<Settings>;
  for (const k of ["openaiApiKey", "anthropicApiKey"] as const) {
    if (body[k] === undefined) delete patch[k];
    else patch[k] = (body[k] ?? "").trim();
  }
  saveSettings(patch);
  return c.json(publicSettings());
});

app.get("/api/tools", async (c) => {
  const refresh = c.req.query("refresh") === "1";
  const [y, cli, whisper] = await Promise.all([resolveYtdlp(refresh), cliStatus(), (refresh ? resolveWhisper(true) : Promise.resolve()).then(whisperStatus)]);
  const status: ToolStatus = {
    ffmpeg: { ok: Boolean(FFMPEG && fs.existsSync(FFMPEG)), path: FFMPEG, version: await ffmpegVersion() },
    ytdlp: { ok: Boolean(y), path: y ? [y.cmd.bin, ...y.cmd.pre].join(" ") : null, version: y?.version },
    claude: cli.claude,
    codex: cli.codex,
    whisper,
  };
  return c.json({ ...status, downloads: Object.fromEntries(downloads) });
});

app.post("/api/tools/ytdlp/install", async (c) => {
  const y = await installYtdlp();
  return c.json({ ok: Boolean(y), version: y?.version });
});

app.post("/api/tools/whisper/install", async (c) => {
  const bin = await installWhisper();
  return c.json({ ok: Boolean(bin) });
});

app.post("/api/tools/whisper/models/:model", (c) => {
  const model = c.req.param("model") as WhisperModel;
  if (!WHISPER_MODELS.some((m) => m.id === model)) return c.json({ error: "unknown model" }, 400);
  installModel(model);
  return c.json({ ok: true });
});

app.get("/api/models", async (c) => {
  const provider = c.req.query("provider") as Provider;
  const connection = getSettings().connection[provider];
  const fromCatalog = (ids?: string[]): ModelOption[] => {
    const known = MODEL_CATALOG.filter((m) => m.provider === provider).map((m) => ({
      id: m.id,
      label: m.label,
      blurb: m.blurb,
      efforts: m.efforts,
      defaultEffort: m.defaultEffort,
    }));
    const extra = (ids ?? [])
      .filter((id) => !known.some((k) => k.id === id))
      .map((id) => ({ id, label: id, efforts: effortOptions(provider, id).filter((e) => e !== "default"), defaultEffort: "default" }));
    return [...known, ...extra];
  };
  if (connection === "cli") {
    if (provider === "openai") {
      const models = codexModels();
      return c.json({ models, connection, error: models.length ? undefined : "Codex 모델 목록을 읽지 못했습니다. `codex`를 한 번 실행해 로그인해 주세요." });
    }
    return c.json({ models: fromCatalog(), connection });
  }
  try {
    const ids = provider === "openai" ? await listOpenAIModels() : await listAnthropicModels();
    return c.json({ models: fromCatalog(ids), connection });
  } catch (err) {
    return c.json({ models: fromCatalog(), connection, error: (err as Error).message });
  }
});

app.post("/api/models/test", async (c) => {
  const choice = (await c.req.json()) as ModelChoice;
  const t0 = Date.now();
  const res = await generateText({
    choice,
    system: "You are a connectivity check.",
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    maxTokens: 2000,
  });
  return c.json({ ok: true, text: res.text.trim().slice(0, 60), ms: Date.now() - t0 });
});

// --- uploads -------------------------------------------------------------------

/** Raw-body streaming upload, so multi-GB lecture files never sit in memory. */
app.post("/api/uploads", async (c) => {
  const name = c.req.query("name") ?? "video.mp4";
  const ext = (path.extname(name) || ".mp4").toLowerCase().replace(/[^.\w]/g, "");
  const id = newId();
  const file = path.join(UPLOADS, `${id}${ext}`);
  const body = c.req.raw.body;
  if (!body) return c.json({ error: "empty body" }, 400);
  await pipe(Readable.fromWeb(body as import("node:stream/web").ReadableStream), fs.createWriteStream(file));
  return c.json({ uploadId: `${id}${ext}`, name });
});

// --- lectures -------------------------------------------------------------------

app.get("/api/lectures", (c) => {
  const lectures = listLectures().map((l) => {
    const cards = docs.flashcards.get(l.id);
    return { ...l, cardsDue: cards.filter((x) => x.due <= Date.now()).length, cardsTotal: cards.length };
  });
  return c.json(lectures);
});

app.post("/api/lectures", async (c) => {
  const body = (await c.req.json()) as {
    source: { kind: "upload" | "path" | "url"; value: string; uploadId?: string };
    title?: string;
    subtitleUploadId?: string;
    options?: Partial<LectureOptions>;
  };
  const s = getSettings();
  const id = newId();
  const dir = lectureDir(id);
  fs.mkdirSync(dir, { recursive: true });

  let mediaPath: string | undefined;
  const value = body.source.value.trim().replace(/^"(.*)"$/, "$1");
  if (body.source.kind === "upload") {
    const src = path.join(UPLOADS, path.basename(body.source.uploadId ?? ""));
    if (!fs.existsSync(src)) return c.json({ error: "업로드된 파일을 찾을 수 없습니다." }, 400);
    fs.mkdirSync(path.join(dir, "media"), { recursive: true });
    mediaPath = path.join(dir, "media", `source${path.extname(src)}`);
    fs.renameSync(src, mediaPath);
  } else if (body.source.kind === "path") {
    if (!fs.existsSync(value)) return c.json({ error: `파일을 찾을 수 없습니다: ${value}` }, 400);
  } else if (!/^https?:\/\//i.test(value)) {
    return c.json({ error: "http(s) URL을 입력해 주세요." }, 400);
  }
  if (body.subtitleUploadId) {
    const src = path.join(UPLOADS, path.basename(body.subtitleUploadId));
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.join(dir, "subs"), { recursive: true });
      fs.renameSync(src, path.join(dir, "subs", `user${path.extname(src)}`));
    }
  }

  const defaultTitle =
    body.title?.trim() ||
    (body.source.kind === "url" ? value : path.basename(value).replace(/\.[^.]+$/, ""));
  const lecture: Lecture = {
    id,
    title: defaultTitle,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    source: { kind: body.source.kind, value },
    mediaPath,
    hasVideo: true,
    hasThumbnail: false,
    durationSec: 0,
    status: "queued",
    steps: freshSteps(),
    options: {
      analysis: s.analysis,
      transcription: s.transcription,
      outputLanguage: s.outputLanguage,
      spokenLanguage: s.spokenLanguage,
      subtitlePolicy: s.subtitlePolicy,
      visualAnalysis: s.visualAnalysis,
      focus: "",
      ...body.options,
    },
    usage: { inputTokens: 0, outputTokens: 0, audioSeconds: 0 },
    analyzed: false,
  };
  saveLecture(lecture);
  enqueue(id);
  return c.json(lecture);
});

app.get("/api/lectures/:id", (c) => c.json({ ...must(c.req.param("id")), busy: isBusy(c.req.param("id")) }));

app.patch("/api/lectures/:id", async (c) => {
  const body = (await c.req.json()) as { title?: string; options?: Partial<LectureOptions> };
  const l = updateLecture(c.req.param("id"), (x) => {
    if (body.title?.trim()) x.title = body.title.trim();
    if (body.options) x.options = { ...x.options, ...body.options };
  });
  return c.json(l);
});

app.delete("/api/lectures/:id", (c) => {
  const id = c.req.param("id");
  if (isBusy(id)) cancel(id);
  deleteLecture(id);
  return c.json({ ok: true });
});

app.post("/api/lectures/:id/resume", (c) => {
  enqueue(must(c.req.param("id")).id);
  return c.json({ ok: true });
});

app.post("/api/lectures/:id/cancel", (c) => {
  cancel(must(c.req.param("id")).id);
  return c.json({ ok: true });
});

app.post("/api/lectures/:id/reprocess", async (c) => {
  const body = (await c.req.json()) as { from: "analysis" | "transcript"; options?: Partial<LectureOptions> };
  const id = c.req.param("id");
  if (isBusy(id)) return c.json({ error: "처리 중에는 다시 분석할 수 없습니다." }, 409);
  const l = updateLecture(id, (x) => {
    if (body.options) x.options = { ...x.options, ...body.options };
  });
  if (body.from === "transcript") resetTranscript(l);
  else resetAnalysis(l, false);
  enqueue(id);
  return c.json({ ok: true });
});

// media with HTTP range support so the player can seek in multi-GB files
app.get("/api/lectures/:id/media", (c) => {
  const l = must(c.req.param("id"));
  if (!l.mediaPath || !fs.existsSync(l.mediaPath)) return c.json({ error: "media not ready" }, 404);
  const size = fs.statSync(l.mediaPath).size;
  const ext = path.extname(l.mediaPath).toLowerCase();
  const type =
    ({ ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg", ".flac": "audio/flac" } as Record<string, string>)[ext] ??
    "application/octet-stream";
  const range = c.req.header("range");
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    const start = m?.[1] ? Number(m[1]) : 0;
    const end = m?.[2] ? Math.min(Number(m[2]), size - 1) : Math.min(start + 8 * 1024 * 1024 - 1, size - 1);
    if (start >= size) return c.body(null, 416, { "Content-Range": `bytes */${size}` });
    const stream = Readable.toWeb(fs.createReadStream(l.mediaPath, { start, end })) as ReadableStream;
    return c.body(stream, 206, {
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": String(end - start + 1),
      "Content-Type": type,
    });
  }
  const stream = Readable.toWeb(fs.createReadStream(l.mediaPath)) as ReadableStream;
  return c.body(stream, 200, { "Content-Length": String(size), "Content-Type": type, "Accept-Ranges": "bytes" });
});

function sendFile(c: import("hono").Context, file: string, type: string) {
  if (!fs.existsSync(file)) return c.json({ error: "not found" }, 404);
  return c.body(fs.readFileSync(file), 200, { "Content-Type": type, "Cache-Control": "max-age=3600" });
}

app.get("/api/lectures/:id/thumb", (c) => sendFile(c, lectureDir(c.req.param("id"), "thumb.jpg"), "image/jpeg"));
app.get("/api/lectures/:id/frames/:file", (c) =>
  sendFile(c, lectureDir(c.req.param("id"), "frames", path.basename(c.req.param("file"))), "image/jpeg"),
);
app.get("/api/lectures/:id/frames", (c) => c.json(docs.frames.get(c.req.param("id")) ?? []));
app.get("/api/lectures/:id/transcript", (c) => c.json(docs.transcript.get(c.req.param("id"))));
app.get("/api/lectures/:id/analysis", (c) => c.json(docs.analysis.get(c.req.param("id"))));

// --- my notes -------------------------------------------------------------------

app.get("/api/lectures/:id/notes", (c) => c.json({ content: docs.notes.get(must(c.req.param("id")).id) }));
app.put("/api/lectures/:id/notes", async (c) => {
  const { content } = (await c.req.json()) as { content: string };
  docs.notes.set(must(c.req.param("id")).id, content);
  return c.json({ ok: true });
});

// --- flashcards -------------------------------------------------------------------

app.get("/api/lectures/:id/flashcards", (c) => c.json(docs.flashcards.get(c.req.param("id"))));

app.post("/api/lectures/:id/flashcards", async (c) => {
  const id = must(c.req.param("id")).id;
  const { front, back, time } = (await c.req.json()) as { front: string; back: string; time?: number | null };
  const card = newCard(front, back, time ?? null);
  docs.flashcards.set(id, [...docs.flashcards.get(id), card]);
  return c.json(card);
});

app.put("/api/lectures/:id/flashcards/:cardId", async (c) => {
  const id = must(c.req.param("id")).id;
  const patch = (await c.req.json()) as Partial<Flashcard>;
  const cards = docs.flashcards.get(id).map((x) => (x.id === c.req.param("cardId") ? { ...x, ...patch, id: x.id } : x));
  docs.flashcards.set(id, cards);
  return c.json({ ok: true });
});

app.delete("/api/lectures/:id/flashcards/:cardId", (c) => {
  const id = must(c.req.param("id")).id;
  docs.flashcards.set(id, docs.flashcards.get(id).filter((x) => x.id !== c.req.param("cardId")));
  return c.json({ ok: true });
});

app.post("/api/lectures/:id/flashcards/generate", async (c) => {
  const l = must(c.req.param("id"));
  const { count, focus } = (await c.req.json()) as { count?: number; focus?: string };
  const cards = await generateMoreCards(l, Math.min(40, Math.max(1, count ?? 10)), focus ?? "");
  return c.json(cards);
});

// --- quizzes -------------------------------------------------------------------

app.get("/api/lectures/:id/quizzes", (c) => c.json(docs.quizzes.get(c.req.param("id"))));

app.post("/api/lectures/:id/quizzes/generate", async (c) => {
  const l = must(c.req.param("id"));
  const body = (await c.req.json()) as { count?: number; difficulty?: string; focus?: string };
  const quiz = await generateQuiz(l, {
    count: Math.min(40, Math.max(3, body.count ?? 10)),
    difficulty: body.difficulty ?? "mixed",
    focus: body.focus ?? "",
  });
  return c.json(quiz);
});

app.delete("/api/lectures/:id/quizzes/:quizId", (c) => {
  const id = must(c.req.param("id")).id;
  docs.quizzes.set(id, docs.quizzes.get(id).filter((q) => q.id !== c.req.param("quizId")));
  return c.json({ ok: true });
});

app.post("/api/lectures/:id/quizzes/:quizId/grade", async (c) => {
  const l = must(c.req.param("id"));
  const { questionId, answer } = (await c.req.json()) as { questionId: string; answer: string };
  const q = docs.quizzes
    .get(l.id)
    .find((x) => x.id === c.req.param("quizId"))
    ?.questions.find((x) => x.id === questionId);
  if (!q) return c.json({ error: "문제를 찾을 수 없습니다." }, 404);
  return c.json(await gradeAnswer(l, q, answer));
});

// --- materials -------------------------------------------------------------------

app.get("/api/lectures/:id/materials", (c) => c.json(docs.materials.get(c.req.param("id"))));

app.post("/api/lectures/:id/materials", async (c) => {
  const l = must(c.req.param("id"));
  const { kind, prompt } = (await c.req.json()) as { kind: MaterialKind; prompt?: string };
  return c.json(startMaterial(l, kind, prompt ?? ""));
});

app.delete("/api/lectures/:id/materials/:mid", (c) => {
  const id = must(c.req.param("id")).id;
  docs.materials.set(id, docs.materials.get(id).filter((m) => m.id !== c.req.param("mid")));
  return c.json({ ok: true });
});

// --- chat -------------------------------------------------------------------

app.get("/api/lectures/:id/chat", (c) => c.json(docs.chat.get(c.req.param("id"))));
app.delete("/api/lectures/:id/chat", (c) => {
  docs.chat.set(must(c.req.param("id")).id, []);
  return c.json({ ok: true });
});

app.post("/api/lectures/:id/chat", async (c) => {
  const l = must(c.req.param("id"));
  const { message, anchor } = (await c.req.json()) as { message: string; anchor?: number | null };
  return streamSSE(c, async (stream) => {
    const ac = new AbortController();
    stream.onAbort(() => ac.abort());
    try {
      const reply = await chat(l, message, anchor ?? null, (delta) => void stream.writeSSE({ event: "delta", data: JSON.stringify(delta) }), ac.signal);
      await stream.writeSSE({ event: "done", data: JSON.stringify(reply) });
    } catch (err) {
      const msg = (err as Error).message || String(err);
      docs.chat.set(l.id, [
        ...docs.chat.get(l.id),
        { id: newId(), role: "assistant", content: msg, createdAt: Date.now(), error: true },
      ]);
      await stream.writeSSE({ event: "error", data: JSON.stringify(msg) });
    }
  });
});

// --- export -------------------------------------------------------------------

app.get("/api/lectures/:id/export", (c) => {
  const l = must(c.req.param("id"));
  const format = c.req.query("format") ?? "md";
  const safe = l.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
  if (format === "anki") {
    const rows = docs.flashcards
      .get(l.id)
      .map((x) => [x.front, x.back, x.time !== null ? fmtTime(x.time) : ""].map((v) => v.replace(/\t/g, " ").replace(/\r?\n/g, "<br>")).join("\t"));
    return c.body(`#separator:tab\n#html:true\n${rows.join("\n")}\n`, 200, {
      "Content-Type": "text/tab-separated-values; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(safe)}-flashcards.txt`,
    });
  }
  const a = docs.analysis.get(l.id);
  if (!a) return c.json({ error: "아직 분석이 끝나지 않았습니다." }, 400);
  const o = a.overview;
  const md = [
    `# ${o.title}`,
    `> ${o.oneLiner}`,
    `## 요약\n\n${o.summary}`,
    o.objectives.length ? `## 학습 목표\n\n${o.objectives.map((x) => `- ${x}`).join("\n")}` : "",
    o.prerequisites.length ? `## 선수 지식\n\n${o.prerequisites.map((p) => `- **${p.topic}** — ${p.why}`).join("\n")}` : "",
    `## 목차\n\n${o.chapters.map((ch) => `- [${fmtTime(ch.start)}] ${ch.title}`).join("\n")}`,
    `## 노트\n\n${a.sections.map((s) => `### ${s.title} [${fmtTime(s.start)}]\n\n${s.notes}`).join("\n\n")}`,
    `## 용어집\n\n${o.glossary.map((g) => `- **${g.term}** — ${g.definition}`).join("\n")}`,
    `## 플래시카드\n\n${docs.flashcards.get(l.id).map((x) => `- **Q.** ${x.front}\n  **A.** ${x.back}`).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return c.body(md, 200, {
    "Content-Type": "text/markdown; charset=utf-8",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(safe)}.md`,
  });
});

// --- study-book PDF ------------------------------------------------------------------

const PRINT_ASSETS: Record<string, string> = {
  fonts: path.join(ROOT, "node_modules", "pretendard", "dist", "web", "static", "woff2"),
  katex: path.join(ROOT, "node_modules", "katex", "dist"),
};

app.get("/print-assets/:kind/*", (c) => {
  const base = PRINT_ASSETS[c.req.param("kind")];
  const rel = decodeURIComponent(new URL(c.req.url).pathname).split(`/print-assets/${c.req.param("kind")}/`)[1] ?? "";
  const file = base && path.normalize(path.join(base, rel));
  if (!file || !file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return c.json({ error: "not found" }, 404);
  const type = { ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".css": "text/css" }[path.extname(file)] ?? "application/octet-stream";
  return c.body(fs.readFileSync(file), 200, { "Content-Type": type, "Cache-Control": "max-age=86400" });
});

function exportOptions(l: Lecture, raw: Partial<ExportOptions> | undefined): ExportOptions {
  const base = presetOptions(raw?.preset ?? "full", docs.materials.get(l.id));
  const o = { ...base, ...raw };
  o.blankPages = Math.min(20, Math.max(0, Math.round(Number(o.blankPages) || 0)));
  o.materials = Array.isArray(o.materials) ? o.materials : base.materials;
  return o;
}

/** The print HTML that Edge/Chrome lays out — also handy to preview in a browser. */
app.get("/api/lectures/:id/print", async (c) => {
  const l = must(c.req.param("id"));
  const analysis = docs.analysis.get(l.id);
  if (!analysis) return c.text("아직 분석이 끝나지 않았습니다.", 400);
  let raw: Partial<ExportOptions> | undefined;
  try {
    const q = c.req.query("o");
    raw = q ? JSON.parse(Buffer.from(q, "base64url").toString("utf8")) : undefined;
  } catch {
    raw = undefined;
  }
  const { html } = await buildDocument({
    lecture: l,
    analysis,
    options: exportOptions(l, raw),
    cards: docs.flashcards.get(l.id),
    quizzes: docs.quizzes.get(l.id),
    materials: docs.materials.get(l.id),
    memo: docs.notes.get(l.id),
    transcript: docs.transcript.get(l.id),
    frames: docs.frames.get(l.id) ?? [],
    origin: ORIGIN,
  });
  return c.html(html);
});

app.post("/api/lectures/:id/exports", async (c) => {
  const l = must(c.req.param("id"));
  const analysis = docs.analysis.get(l.id);
  if (!analysis) return c.json({ error: "아직 분석이 끝나지 않았습니다." }, 400);
  const raw = (await c.req.json().catch(() => ({}))) as Partial<ExportOptions>;
  const result = await exportStudyPdf(l, analysis.overview.title || l.title, exportOptions(l, raw), ORIGIN, (s) => console.log(`[pdf ${l.id}] ${s}`));
  return c.json(result);
});

app.get("/api/lectures/:id/exports", (c) => {
  const dir = exportsDir(must(c.req.param("id")).id);
  if (!fs.existsSync(dir)) return c.json([]);
  const files: ExportFile[] = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".pdf"))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { file: f, bytes: st.size, createdAt: st.mtimeMs };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
  return c.json(files);
});

app.get("/api/lectures/:id/exports/:file", (c) => {
  const dir = exportsDir(must(c.req.param("id")).id);
  const name = path.basename(c.req.param("file"));
  const file = path.join(dir, name);
  if (!name.endsWith(".pdf") || !fs.existsSync(file)) return c.json({ error: "파일이 없습니다." }, 404);
  const disposition = c.req.query("download") ? "attachment" : "inline";
  return c.body(fs.readFileSync(file), 200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
});

app.delete("/api/lectures/:id/exports/:file", (c) => {
  const dir = exportsDir(must(c.req.param("id")).id);
  fs.rmSync(path.join(dir, path.basename(c.req.param("file"))), { force: true });
  return c.json({ ok: true });
});

/** Upload a study-book PDF the student typed into; its fields become a memo entry. */
app.post("/api/lectures/:id/exports/import", async (c) => {
  const l = must(c.req.param("id"));
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (!bytes.length) return c.json({ error: "PDF 파일이 비어 있습니다." }, 400);
  const { texts, checked } = await readFilledPdf(l.id, bytes).catch(() => {
    throw Object.assign(new Error("PDF를 읽지 못했습니다. Lecture Lens에서 만든 타이핑용 학습서인지 확인해 주세요."), { status: 400 });
  });
  if (texts.length) {
    const when = new Date().toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });
    const block = [`## 📄 PDF에서 가져온 메모 · ${when}`, ...texts.map((t) => `### ${t.label}\n\n${t.text}`)].join("\n\n");
    const memo = docs.notes.get(l.id).trimEnd();
    docs.notes.set(l.id, `${memo}${memo ? "\n\n" : ""}${block}\n`);
  }
  return c.json({ imported: texts.length, checked, labels: texts.map((t) => t.label) });
});

// --- static web app (production) ------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

app.get("*", (c) => {
  if (!fs.existsSync(WEB_DIST)) return c.text("Web UI not built. Run `npm run build`, or use `npm run dev`.", 404);
  const rel = decodeURIComponent(new URL(c.req.url).pathname).replace(/^\/+/, "");
  let file = path.join(WEB_DIST, rel);
  if (!file.startsWith(WEB_DIST) || !rel || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(WEB_DIST, "index.html");
  }
  const type = MIME[path.extname(file)] ?? "application/octet-stream";
  const cache = file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache";
  return c.body(fs.readFileSync(file), 200, { "Content-Type": type, "Cache-Control": cache });
});

recoverOnBoot();
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
  console.log(`\n  Lecture Lens API  →  http://localhost:${port}\n`);
});
