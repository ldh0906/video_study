import fs from "node:fs";
import path from "node:path";
import type { Lecture, Segment, Step, StepId } from "../../shared/types";
import { lectureDir } from "../paths";
import { apiKey, getSettings } from "../settings";
import { docs, getLecture, listLectures, updateLecture } from "../store";
import { parseSubtitles } from "../subtitles";
import { addUsage, generateQuiz, newCard } from "../study";
import { extractAudio, extractKeyframes, probe, thumbnail } from "../tools/ffmpeg";
import { downloadSubtitles, downloadVideo, videoInfo } from "../tools/ytdlp";
import { installedModels, resolveWhisper } from "../tools/whisper";
import { analyzeSections, buildSections, synthesize } from "./analyze";
import { transcribeAudio } from "./transcribe";
import { throttle } from "./util";

const queue: string[] = [];
const running = new Map<string, AbortController>();
const MAX_PARALLEL = 1;

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
  for (const l of listLectures()) {
    if (l.status === "processing" || l.status === "queued") {
      updateLecture(l.id, (x) => {
        x.status = "interrupted";
        for (const s of x.steps) if (s.status === "running") s.status = "pending";
      });
    }
  }
}

function pump() {
  while (running.size < MAX_PARALLEL && queue.length) {
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

async function run(id: string, signal: AbortSignal) {
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

  // 5. per-section analysis ----------------------------------------------------
  let analysis = docs.analysis.get(id);
  if (!analysis) {
    step.start("analyze");
    const segments: Segment[] = transcript.segments;
    const ranges = buildSections(segments, info.duration);
    const sections = await analyzeSections(
      {
        lecture,
        segments,
        frames: lecture.options.visualAnalysis ? frames : [],
        framesPerSection: settings.framesPerSection,
        concurrency: settings.concurrency,
        signal,
        onUsage,
        onProgress: (p, d) => step.progress("analyze", p, d),
      },
      ranges,
    );
    step.done("analyze", `${sections.length}개 파트`);

    // 6. synthesis -------------------------------------------------------------
    step.start("synthesize", "전체 구조와 개념 정리 중");
    analysis = await synthesize(lecture, sections, signal, onUsage);
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

/** Throw away analysis artifacts so the lecture is re-analyzed (e.g. with another model). */
export function resetAnalysis(lecture: Lecture, keepStudy: boolean) {
  const dir = lectureDir(lecture.id);
  for (const f of ["analysis.json", "sections"]) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  if (!keepStudy) for (const f of ["flashcards.json", "quizzes.json"]) fs.rmSync(path.join(dir, f), { force: true });
  updateLecture(lecture.id, (l) => {
    l.analyzed = false;
    for (const s of l.steps) if (["analyze", "synthesize", "materials"].includes(s.id)) Object.assign(s, { status: "pending", progress: 0, detail: undefined });
  });
}

export function resetTranscript(lecture: Lecture) {
  const dir = lectureDir(lecture.id);
  for (const f of ["transcript.json", "audio"]) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  resetAnalysis(lecture, false);
}
