import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Lecture, Segment, Step, StepId } from "../../shared/types";
import { lectureDir } from "../paths";
import { apiKey, getSettings } from "../settings";
import { docs, getLecture, listLectures, updateLecture } from "../store";
import { parseSubtitles } from "../subtitles";
import { addUsage, generateQuiz, newCard } from "../study";
import { extractAudio, extractKeyframes, probe, thumbnail } from "../tools/ffmpeg";
import { downloadSubtitles, downloadVideo, videoInfo } from "../tools/ytdlp";
import { installedModels, resolveWhisper } from "../tools/whisper";
import { analyzeSections, buildOutline, buildSections, synthesize } from "./analyze";
import { analyzeDocSections, buildDocOutline, buildDocSections, extractDoc, pageImagesDir, pagesAsSegments, synthesizeDoc } from "./doc";
import { pageImage, renderPages } from "../tools/pdf";
import { autoStudyPages, recoverStudyPages } from "../studypages";
import { transcribeAudio } from "./transcribe";
import { throttle } from "./util";

const queue: string[] = [];
const running = new Map<string, AbortController>();

/**
 * A FIFO line that `capacity()` lectures at a time may hold. Lectures run
 * through two lanes: "media" (download, audio, whisper, frames — the GPU/disk
 * heavy part) and "ai" (analysis and study materials over the network). The
 * next lecture can transcribe while the previous one is being analyzed, but two
 * lectures never fight over the GPU.
 */
class Lane {
  private active = 0;
  private waiters: { resolve: () => void; signal: AbortSignal; onAbort: () => void }[] = [];

  constructor(private capacity: () => number = () => 1) {}

  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    // wake() counts a woken waiter's seat for it, so nobody slips in between
    if (!this.waiters.length && this.active < this.seats()) this.active++;
    else {
      await new Promise<void>((resolve, reject) => {
        const waiter = {
          resolve,
          signal,
          onAbort: () => {
            this.waiters.splice(this.waiters.indexOf(waiter), 1);
            reject(new DOMException("aborted", "AbortError"));
          },
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
        this.waiters.push(waiter);
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.wake();
    };
  }

  /** Hand free seats straight to the next lectures in line (also after the seat count went up). */
  wake() {
    while (this.waiters.length && this.active < this.seats()) {
      const next = this.waiters.shift()!;
      next.signal.removeEventListener("abort", next.onAbort);
      this.active++;
      next.resolve();
    }
  }

  private seats() {
    return Math.max(1, Math.floor(this.capacity()) || 1);
  }
}

const mediaLane = new Lane();
/** API-key analysis: one lecture at a time, so a key's rate limit and spend stay predictable. */
const apiAiLane = new Lane();
/** CLI analysis (claude / codex on the signed-in account): several lectures side by side. */
const cliAiLane = new Lane(() => getSettings().cliParallel);

function aiLaneFor(id: string) {
  const provider = getLecture(id)?.options.analysis.provider;
  return provider && getSettings().connection[provider] === "cli" ? cliAiLane : apiAiLane;
}

/** Settings changed: lectures waiting for analysis may now fit. */
export function settingsChanged() {
  cliAiLane.wake();
}

export function enqueue(id: string) {
  if (running.has(id) || queue.includes(id)) return;
  updateLecture(id, (l) => {
    l.status = "queued";
    l.error = undefined;
  });
  queue.push(id);
  pump();
}

export function cancel(id: string) {
  const idx = queue.indexOf(id);
  if (idx >= 0) queue.splice(idx, 1);
  running.get(id)?.abort();
  updateLecture(id, (l) => {
    if (l.status === "queued" || l.status === "processing") l.status = "canceled";
    for (const s of l.steps) if (s.status === "running") s.status = "pending";
  });
}

export function isBusy(id: string) {
  return running.has(id) || queue.includes(id);
}

/** After a restart, anything that was mid-flight is marked interrupted; the user can resume it. */
export function recoverOnBoot() {
  recoverStudyPages(listLectures().map((l) => l.id));
  for (const l of listLectures()) {
    const pages = l.steps.find((s) => s.id === "pages");
    if (pages?.status === "running") updateLecture(l.id, (x) => Object.assign(x.steps.find((s) => s.id === "pages")!, { status: "done", detail: "필요할 때 만들 수 있어요" }));
    if (l.status === "processing" || l.status === "queued") {
      updateLecture(l.id, (x) => {
        x.status = "interrupted";
        for (const s of x.steps) if (s.status === "running") s.status = "pending";
      });
    }
  }
}

// Every queued lecture starts right away and waits in the lanes, which keep queue order.
function pump() {
  while (queue.length) {
    const id = queue.shift()!;
    const ac = new AbortController();
    running.set(id, ac);
    run(id, ac.signal)
      .catch((err: Error) => {
        if (ac.signal.aborted) return;
        console.error(`[pipeline ${id}]`, err);
        updateLecture(id, (l) => {
          l.status = "error";
          l.error = err.message || String(err);
          for (const s of l.steps) if (s.status === "running") s.status = "error";
        });
      })
      .finally(() => {
        running.delete(id);
        pump();
      });
  }
}

/** Whether we can produce our own transcript (local whisper installed, or an OpenAI key for API models). */
async function canTranscribe(lecture: Lecture) {
  if (lecture.options.transcription === "local-whisper") {
    return Boolean(await resolveWhisper()) && installedModels().length > 0;
  }
  return Boolean(apiKey("openai"));
}

function stepUpdater(id: string) {
  const write = (stepId: StepId, patch: Partial<Step>) =>
    updateLecture(id, (l) => {
      const s = l.steps.find((x) => x.id === stepId)!;
      Object.assign(s, patch);
    });
  const progress = throttle(
    (stepId: StepId, progress: number, detail?: string) =>
      updateLecture(id, (l) => {
        const s = l.steps.find((x) => x.id === stepId)!;
        if (s.status === "running") Object.assign(s, { progress, detail });
      }),
    500,
  );
  return {
    start: (s: StepId, detail?: string) => write(s, { status: "running", progress: 0, detail, startedAt: Date.now() }),
    progress,
    done: (s: StepId, detail?: string) => write(s, { status: "done", progress: 1, detail, endedAt: Date.now() }),
    skip: (s: StepId, detail?: string) => write(s, { status: "skipped", progress: 1, detail, endedAt: Date.now() }),
  };
}

/** Media work is already on disk (e.g. a re-analysis), so the lecture needn't wait behind another's transcription. */
function hasMediaWork(id: string) {
  const l = getLecture(id);
  if (!l?.mediaPath || !fs.existsSync(l.mediaPath) || !docs.transcript.get(id)) return true;
  return l.hasVideo && l.options.visualAnalysis && !docs.frames.get(id);
}

async function run(id: string, signal: AbortSignal) {
  let release = null as (() => void) | null; // set inside enter(), so TS can't narrow it
  const enter = async (lane: Lane) => {
    release?.();
    release = null;
    release = await lane.acquire(signal);
  };
  try {
    if (getLecture(id)?.kind === "doc") return await runDocSteps(id, signal, enter);
    if (hasMediaWork(id)) await enter(mediaLane);
    await runSteps(id, signal, enter);
  } finally {
    release?.();
  }
}

async function runSteps(id: string, signal: AbortSignal, enter: (lane: Lane) => Promise<void>) {
  const settings = getSettings();
  const step = stepUpdater(id);
  let lecture = updateLecture(id, (l) => {
    l.status = "processing";
    l.error = undefined;
  });
  const dir = lectureDir(id);
  const onUsage = (u: { input: number; output: number }) => addUsage(id, u);

  // 1. fetch ----------------------------------------------------------------
  const subsDir = path.join(dir, "subs");
  let subtitle: { file: string; kind: "manual" | "auto" | "user" } | null = null;
  const userSubs = fs.existsSync(subsDir) ? fs.readdirSync(subsDir).find((f) => f.startsWith("user.")) : undefined;
  if (userSubs) subtitle = { file: path.join(subsDir, userSubs), kind: "user" };

  if (!lecture.mediaPath || !fs.existsSync(lecture.mediaPath)) {
    step.start("fetch");
    if (lecture.source.kind === "url") {
      const url = lecture.source.value;
      step.progress("fetch", 0, "영상 정보 확인 중…");
      const info = await videoInfo(url, settings.cookiesFromBrowser, signal);
      updateLecture(id, (l) => {
        if (l.title === l.source.value) l.title = info.title;
        l.durationSec = info.duration || l.durationSec;
      });
      if (!subtitle && lecture.options.subtitlePolicy !== "ai") {
        const allowAuto = lecture.options.subtitlePolicy === "only" || !(await canTranscribe(lecture));
        const subs = await downloadSubtitles(url, info, subsDir, {
          spokenLanguage: lecture.options.spokenLanguage,
          cookiesFromBrowser: settings.cookiesFromBrowser,
          allowAuto,
        }, signal).catch(() => null);
        if (subs) subtitle = { file: subs.file, kind: subs.kind };
      }
      const media = await downloadVideo(
        url,
        path.join(dir, "media"),
        { quality: settings.downloadQuality, cookiesFromBrowser: settings.cookiesFromBrowser },
        (p, detail) => step.progress("fetch", p, detail),
        signal,
      );
      updateLecture(id, (l) => (l.mediaPath = media));
    } else if (lecture.source.kind === "path") {
      if (!fs.existsSync(lecture.source.value)) throw new Error(`파일을 찾을 수 없습니다: ${lecture.source.value}`);
      updateLecture(id, (l) => (l.mediaPath = l.source.value));
    } else {
      throw new Error("업로드된 파일이 없습니다.");
    }
  } else if (lecture.source.kind === "url" && !subtitle && fs.existsSync(subsDir)) {
    const f = fs.readdirSync(subsDir).find((x) => x.startsWith("subs."));
    if (f) subtitle = { file: path.join(subsDir, f), kind: "manual" };
  }
  lecture = getLecture(id)!;
  const media = lecture.mediaPath!;
  const info = await probe(media);
  if (!info.hasAudio) throw new Error("이 파일에는 오디오 트랙이 없습니다.");
  const thumb = path.join(dir, "thumb.jpg");
  if (info.hasVideo && !fs.existsSync(thumb)) await thumbnail(media, Math.min(info.duration * 0.15, 120), thumb).catch(() => {});
  lecture = updateLecture(id, (l) => {
    l.durationSec = info.duration || l.durationSec;
    l.hasVideo = info.hasVideo;
    l.hasThumbnail = fs.existsSync(thumb);
  });
  step.done("fetch");

  // 2–3. audio + transcript ---------------------------------------------------
  let transcript = docs.transcript.get(id);
  if (!transcript) {
    const useSubs =
      subtitle &&
      (lecture.options.subtitlePolicy === "only" ||
        (lecture.options.subtitlePolicy === "prefer" && (subtitle.kind !== "auto" || !(await canTranscribe(lecture)))));
    if (lecture.options.subtitlePolicy === "only" && !subtitle) throw new Error("사용할 수 있는 자막이 없습니다.");
    if (useSubs && subtitle) {
      step.skip("audio", "자막 사용");
      step.start("transcribe", "자막 불러오는 중");
      const segments = parseSubtitles(fs.readFileSync(subtitle.file, "utf8"));
      if (!segments.length) throw new Error("자막 파일을 해석하지 못했습니다.");
      const label = subtitle.kind === "user" ? "업로드한 자막" : subtitle.kind === "manual" ? "제작자 자막" : "자동 생성 자막";
      transcript = { source: label, segments };
    } else {
      if (lecture.options.transcription !== "local-whisper" && !apiKey("openai")) {
        throw new Error("OpenAI 받아쓰기 모델을 쓰려면 OpenAI API 키가 필요합니다. 설정에서 '로컬 Whisper'를 선택하거나 자막 파일을 함께 올려 주세요.");
      }
      const audio = path.join(dir, "audio", "audio.mp3");
      if (!fs.existsSync(audio)) {
        step.start("audio");
        fs.mkdirSync(path.dirname(audio), { recursive: true });
        await extractAudio(media, audio, info.duration, (p) => step.progress("audio", p), signal);
      }
      step.done("audio");
      step.start("transcribe");
      const segments = await transcribeAudio({
        audio,
        workDir: path.join(dir, "audio", "chunks"),
        duration: info.duration,
        model: lecture.options.transcription,
        whisperModel: settings.whisperModel,
        language: lecture.options.spokenLanguage,
        prompt: [lecture.title, lecture.options.focus].filter(Boolean).join(". "),
        concurrency: Math.max(2, settings.concurrency * 2),
        onProgress: (p, d) => step.progress("transcribe", p, d),
        signal,
      });
      if (!segments.length) throw new Error("음성에서 텍스트를 인식하지 못했습니다.");
      transcript = { source: lecture.options.transcription, segments };
      updateLecture(id, (l) => (l.usage.audioSeconds += info.duration));
    }
    docs.transcript.set(id, transcript);
  } else {
    step.done("audio");
  }
  updateLecture(id, (l) => (l.transcriptSource = transcript!.source));
  step.done("transcribe", `${transcript.segments.length}개 구간`);

  // 4. frames ----------------------------------------------------------------
  let frames = docs.frames.get(id) ?? [];
  if (!docs.frames.get(id)) {
    if (info.hasVideo && lecture.options.visualAnalysis) {
      step.start("frames");
      const framesDir = path.join(dir, "frames");
      fs.rmSync(framesDir, { recursive: true, force: true });
      frames = await extractKeyframes(media, framesDir, info.duration, (p) => step.progress("frames", p), signal);
      docs.frames.set(id, frames);
      step.done("frames", `${frames.length}장`);
    } else {
      step.skip("frames", info.hasVideo ? "화면 분석 꺼짐" : "오디오 전용");
    }
  } else {
    step.done("frames", `${frames.length}장`);
  }

  // the GPU is free for the next lecture from here on
  updateLecture(id, (l) => {
    const s = l.steps.find((x) => x.id === "analyze")!;
    if (s.status === "pending") s.detail = "앞 강의 분석이 끝나길 기다리는 중";
  });
  await enter(aiLaneFor(id));

  // 5. per-section analysis ----------------------------------------------------
  let analysis = docs.analysis.get(id);
  if (!analysis) {
    step.start("analyze", "강의 전체 흐름과 개념 파악 중");
    const segments: Segment[] = transcript.segments;
    const ranges = buildSections(segments, info.duration);
    // Without the outline each part still works, just without knowing what came before.
    const outline = await buildOutline(lecture, segments, signal, onUsage).catch((err: Error) => {
      if (signal.aborted) throw err;
      console.warn(`[pipeline ${id}] outline failed, continuing without it:`, err.message);
      return null;
    });
    const sections = await analyzeSections(
      {
        lecture,
        segments,
        frames: lecture.options.visualAnalysis ? frames : [],
        framesPerSection: settings.framesPerSection,
        concurrency: settings.concurrency,
        outline,
        signal,
        onUsage,
        onProgress: (p, d) => step.progress("analyze", p, d),
      },
      ranges,
    );
    step.done("analyze", `${sections.length}개 파트`);

    // 6. synthesis -------------------------------------------------------------
    step.start("synthesize", "전체 구조와 개념 정리 중");
    analysis = await synthesize(lecture, sections, segments, outline, signal, onUsage);
    docs.analysis.set(id, analysis);
    updateLecture(id, (l) => {
      l.analyzed = true;
      if (l.title === l.source.value || /\.[a-z0-9]{2,4}$/i.test(l.title)) l.title = analysis!.overview.title;
    });
  } else {
    step.done("analyze", `${analysis.sections.length}개 파트`);
  }
  step.done("synthesize");

  // 7. starter study materials ------------------------------------------------
  step.start("materials", "플래시카드와 퀴즈 만드는 중");
  if (!docs.flashcards.get(id).length) {
    docs.flashcards.set(
      id,
      analysis.sections.flatMap((s) => s.cards.map((c) => newCard(c.front, c.back, c.time))),
    );
  }
  if (!docs.quizzes.get(id).length) {
    const count = Math.round(Math.min(30, Math.max(8, info.duration / 60 / 4)));
    await generateQuiz(getLecture(id)!, { count, difficulty: "mixed", focus: "", title: "기본 퀴즈" }, signal);
  }
  step.done("materials");
  updateLecture(id, (l) => (l.status = "ready"));
}

/** A PDF: read the pages, then the same analysis as a lecture with pages for times. */
async function runDocSteps(id: string, signal: AbortSignal, enter: (lane: Lane) => Promise<void>) {
  const settings = getSettings();
  const step = stepUpdater(id);
  let lecture = updateLecture(id, (l) => {
    l.status = "processing";
    l.error = undefined;
  });
  const onUsage = (u: { input: number; output: number }) => addUsage(id, u);
  if (!lecture.mediaPath && lecture.source.kind === "url") {
    step.start("extract", "PDF 내려받는 중");
    const target = lectureDir(id, "media", "source.pdf");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const res = await fetch(lecture.source.value, { signal, redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`PDF를 내려받지 못했습니다 (${res.status}). 로그인이 필요한 링크라면 파일을 받아서 올려 주세요.`);
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), fs.createWriteStream(target));
    if (!fs.readFileSync(target).subarray(0, 5).toString().startsWith("%PDF")) throw new Error("링크가 PDF 파일이 아닙니다(로그인 페이지일 수 있어요). 파일을 받아서 올려 주세요.");
    lecture = updateLecture(id, (l) => (l.mediaPath = target));
  }
  const file = lecture.mediaPath;
  if (!file || !fs.existsSync(file)) throw new Error(`PDF 파일을 찾을 수 없습니다: ${file ?? lecture.source.value}`);

  // 1. extract ----------------------------------------------------------------
  step.start("extract", "페이지 읽는 중");
  const info = await extractDoc(lecture, (p) => step.progress("extract", p, "페이지 읽는 중"), signal);
  if (!docs.transcript.get(id)) docs.transcript.set(id, { source: "pdf", segments: pagesAsSegments(info) });
  const thumb = lectureDir(id, "thumb.jpg");
  if (!fs.existsSync(thumb)) {
    await renderPages(file, [1], pageImagesDir(id), 1400, signal).catch(() => {});
    if (fs.existsSync(pageImage(pageImagesDir(id), 1))) fs.copyFileSync(pageImage(pageImagesDir(id), 1), thumb);
  }
  lecture = updateLecture(id, (l) => {
    l.pageCount = info.pageCount;
    l.hasThumbnail = fs.existsSync(thumb);
    if (info.title && /\.pdf$/i.test(l.title)) l.title = info.title;
  });
  step.done("extract", `${info.pageCount}쪽`);

  updateLecture(id, (l) => {
    const s = l.steps.find((x) => x.id === "analyze")!;
    if (s.status === "pending") s.detail = "앞 자료 분석이 끝나길 기다리는 중";
  });
  await enter(aiLaneFor(id));

  // 2–3. analysis --------------------------------------------------------------
  let analysis = docs.analysis.get(id);
  if (!analysis) {
    step.start("analyze", "문서 구조와 개념 파악 중");
    const outline = await buildDocOutline(lecture, info, signal, onUsage);
    lecture = updateLecture(id, (l) => {
      l.docType ??= outline.docType;
    });
    const docType = lecture.docType ?? outline.docType;
    const ranges = buildDocSections(info.pages, [...outline.topics.map((t) => t.page), ...info.outline.map((b) => b.page)]);
    const sections = await analyzeDocSections(
      {
        lecture,
        info,
        outline,
        docType,
        maxImages: docType === "slides" ? 24 : Math.min(10, Math.max(4, settings.framesPerSection)),
        concurrency: settings.concurrency,
        signal,
        onUsage,
        onProgress: (p, d) => step.progress("analyze", p, d),
      },
      ranges,
    );
    step.done("analyze", `${sections.length}개 파트`);
    step.start("synthesize", "전체 구조와 개념 정리 중");
    analysis = await synthesizeDoc(lecture, info, sections, outline, signal, onUsage);
    docs.analysis.set(id, analysis);
    updateLecture(id, (l) => {
      l.analyzed = true;
      if (/\.pdf$/i.test(l.title) || l.title === l.source.value) l.title = analysis!.overview.title;
    });
  } else {
    step.done("analyze", `${analysis.sections.length}개 파트`);
  }
  step.done("synthesize");

  // 4. starter study materials ------------------------------------------------
  step.start("materials", "플래시카드와 퀴즈 만드는 중");
  if (!docs.flashcards.get(id).length) {
    docs.flashcards.set(id, analysis.sections.flatMap((s) => s.cards.map((c) => newCard(c.front, c.back, c.time))));
  }
  if (!docs.quizzes.get(id).length) {
    const graded = ["assignment", "lab"].includes(getLecture(id)!.docType ?? "");
    const count = Math.round(Math.min(30, Math.max(6, info.pageCount / 3)));
    await generateQuiz(
      getLecture(id)!,
      { count, difficulty: "mixed", focus: graded ? "the concepts and methods the tasks need, never the tasks' own answers" : "", title: "기본 퀴즈" },
      signal,
    );
  }
  step.done("materials");

  // 5. interactive study pages, in the background: the document is ready to study now
  updateLecture(id, (l) => (l.status = "ready"));
  step.start("pages", "인터랙티브 학습 페이지 만드는 중");
  autoStudyPages(
    getLecture(id)!,
    (p, d) => step.progress("pages", p, d),
    (made) => {
      // the item may have been deleted or re-analyzed meanwhile
      if (getLecture(id)?.steps.find((s) => s.id === "pages")?.status === "running") step.done("pages", made ? `${made}개 페이지` : "필요할 때 만들 수 있어요");
    },
  );
}

/** Throw away analysis artifacts so the lecture is re-analyzed (e.g. with another model). */
export function resetAnalysis(lecture: Lecture, keepStudy: boolean) {
  const dir = lectureDir(lecture.id);
  for (const f of ["analysis.json", "sections", "outline.json"]) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  if (!keepStudy) for (const f of ["flashcards.json", "quizzes.json", "study-pages.json"]) fs.rmSync(path.join(dir, f), { force: true });
  updateLecture(lecture.id, (l) => {
    l.analyzed = false;
    for (const s of l.steps) if (["analyze", "synthesize", "materials", "pages"].includes(s.id)) Object.assign(s, { status: "pending", progress: 0, detail: undefined });
  });
}

export function resetTranscript(lecture: Lecture) {
  const dir = lectureDir(lecture.id);
  // for a PDF the "transcript" is its extracted pages
  for (const f of ["transcript.json", "audio", "pages.json", "pages"]) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  resetAnalysis(lecture, false);
}
