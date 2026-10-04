import fs from "node:fs";
import path from "node:path";
import { openaiClient } from "../llm/openai";
import { cutAudio, cutAudioWav, detectSilences, planChunks } from "../tools/ffmpeg";
import { defaultThreads, localParallelism, resolveWhisper, transcribeLocal } from "../tools/whisper";
import { readJson, writeJson } from "../paths";
import { mergeCues } from "../subtitles";
import type { Segment, TranscriptionModel, WhisperModel } from "../../shared/types";
import { mapLimit, retry } from "./util";

/** Models that only return plain text: we cut audio into short pieces and use each piece as a segment. */
const TEXT_ONLY = new Set<TranscriptionModel>(["gpt-transcribe", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"]);

interface ChunkPlan {
  model: TranscriptionModel;
  chunks: { start: number; end: number }[];
}

export async function transcribeAudio(opts: {
  audio: string;
  workDir: string;
  duration: number;
  model: TranscriptionModel;
  whisperModel: WhisperModel;
  language: string;
  prompt: string;
  concurrency: number;
  onProgress: (p: number, detail: string) => void;
  signal: AbortSignal;
}): Promise<Segment[]> {
  const { audio, workDir, model, signal } = opts;
  fs.mkdirSync(workDir, { recursive: true });
  const planFile = path.join(workDir, "plan.json");
  let plan = readJson<ChunkPlan | null>(planFile, null);
  if (!plan || plan.model !== model) {
    opts.onProgress(0, "무음 구간 분석 중…");
    const silences = await detectSilences(audio, signal);
    const textOnly = TEXT_ONLY.has(model);
    const chunks = textOnly ? planChunks(opts.duration, silences, 30, 10) : planChunks(opts.duration, silences, 600, 90);
    plan = { model, chunks };
    for (const f of fs.readdirSync(workDir)) if (f !== "plan.json") fs.rmSync(path.join(workDir, f), { force: true });
    writeJson(planFile, plan);
  }

  const total = plan.chunks.length;
  let done = plan.chunks.filter((_, i) => fs.existsSync(path.join(workDir, `${pad(i)}.json`))).length;
  const partial = new Map<number, number>(); // in-flight chunk progress (local whisper reports it)
  const report = () => {
    const inflight = [...partial.values()].reduce((a, b) => a + b, 0);
    opts.onProgress((done + inflight) / total, `${done} / ${total} 조각`);
  };
  report();

  const local = model === "local-whisper";
  if (local) await resolveWhisper();
  // CPU workers can share cores; GPU workers share the same limited VRAM.
  const parallel = local ? localParallelism() : opts.concurrency;
  const results = await mapLimit(plan.chunks, parallel, async (chunk, i) => {
    const out = path.join(workDir, `${pad(i)}.json`);
    const cached = readJson<Segment[] | null>(out, null);
    if (cached) return cached;
    let segs: Segment[];
    if (local) {
      const wav = path.join(workDir, `${pad(i)}.wav`);
      await cutAudioWav(audio, chunk.start, chunk.end, wav, signal);
      segs = await transcribeLocal({
        wav,
        offset: chunk.start,
        model: opts.whisperModel,
        language: opts.language,
        prompt: opts.prompt,
        threads: defaultThreads(),
        onProgress: (p) => {
          partial.set(i, p);
          report();
        },
        signal,
      });
      fs.rmSync(wav, { force: true });
    } else {
      const piece = path.join(workDir, `${pad(i)}.mp3`);
      await cutAudio(audio, chunk.start, chunk.end, piece, signal);
      segs = await retry(() => transcribeChunk(piece, chunk.start, chunk.end, model, opts.language, opts.prompt, signal), signal);
      fs.rmSync(piece, { force: true });
    }
    writeJson(out, segs);
    partial.delete(i);
    done++;
    report();
    return segs;
  });

  const all = results.flat().filter((s) => s.text.trim());
  // Short diarized utterances read better merged into sentence-sized segments.
  return model === "gpt-4o-transcribe-diarize" ? mergeCues(all, 4, 20) : all;
}

function pad(i: number) {
  return String(i).padStart(4, "0");
}

async function transcribeChunk(
  file: string,
  offset: number,
  end: number,
  model: TranscriptionModel,
  language: string,
  prompt: string,
  signal: AbortSignal,
): Promise<Segment[]> {
  const openai = openaiClient();
  const stream = () => fs.createReadStream(file);
  const lang = language || undefined;

  if (model === "whisper-1") {
    const res = await openai.audio.transcriptions.create(
      {
        file: stream(),
        model,
        response_format: "verbose_json",
        timestamp_granularities: ["segment"],
        ...(lang ? { language: lang } : {}),
        ...(prompt ? { prompt: prompt.slice(0, 800) } : {}),
      },
      { signal },
    );
    return (res.segments ?? []).map((s) => ({ start: offset + s.start, end: offset + s.end, text: s.text.trim() }));
  }

  if (model === "gpt-4o-transcribe-diarize") {
    const res = (await openai.audio.transcriptions.create(
      {
        file: stream(),
        model,
        response_format: "diarized_json",
        chunking_strategy: "auto",
        ...(lang ? { language: lang } : {}),
      },
      { signal },
    )) as unknown as { segments?: { start: number; end: number; text: string; speaker?: string }[]; text?: string };
    if (!res.segments?.length) return res.text ? [{ start: offset, end, text: res.text.trim() }] : [];
    return res.segments.map((s) => ({
      start: offset + s.start,
      end: offset + s.end,
      text: s.text.trim(),
      speaker: s.speaker,
    }));
  }

  // text-only models: the whole (short) chunk becomes one segment
  const res = await openai.audio.transcriptions.create(
    {
      file: stream(),
      model,
      response_format: "json",
      ...(model === "gpt-transcribe" ? (lang ? { languages: [lang] } : {}) : lang ? { language: lang } : {}),
      ...(prompt ? { prompt: prompt.slice(0, 800) } : {}),
    },
    { signal },
  );
  const text = (res as { text: string }).text.trim();
  return text ? [{ start: offset, end, text }] : [];
}
