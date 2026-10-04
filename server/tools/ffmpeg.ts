import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";

export const FFMPEG: string | null = process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string | null);

interface RunOptions {
  signal?: AbortSignal;
  /** called for every stderr line (ffmpeg uses \r for progress lines, those are split too) */
  onLine?: (line: string) => void;
  /** treat these exit codes as success (ffmpeg -i without output exits 1) */
  okCodes?: number[];
}

export function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<string> {
  if (!FFMPEG) return Promise.reject(new Error("ffmpeg 바이너리를 찾을 수 없습니다."));
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG!, ["-hide_banner", "-nostdin", ...args], { windowsHide: true });
    let stderr = "";
    let partial = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 2_000_000) stderr += chunk;
      partial += chunk;
      const lines = partial.split(/\r\n|\r|\n/);
      partial = lines.pop() ?? "";
      if (opts.onLine) for (const line of lines) opts.onLine(line);
    });
    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (partial && opts.onLine) opts.onLine(partial);
      if (opts.signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
      if (code === 0 || opts.okCodes?.includes(code ?? -1)) resolve(stderr);
      else reject(new Error(`ffmpeg 실패 (code ${code}): ${stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(" | ")}`));
    });
  });
}

export async function ffmpegVersion(): Promise<string | undefined> {
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(FFMPEG!, ["-version"], { windowsHide: true });
      let s = "";
      child.stdout.on("data", (d) => (s += d));
      child.on("error", reject);
      child.on("close", () => resolve(s));
    });
    return out.split("\n")[0]?.match(/version (\S+)/)?.[1];
  } catch {
    return undefined;
  }
}

function parseClock(s: string): number {
  const [h, m, sec] = s.split(":");
  return Number(h) * 3600 + Number(m) * 60 + Number(sec);
}

export interface ProbeResult {
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

export async function probe(file: string): Promise<ProbeResult> {
  const out = await runFfmpeg(["-i", file], { okCodes: [1] });
  const dur = out.match(/Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/);
  const videoLines = out.split(/\r?\n/).filter((l) => /Stream #.*Video:/.test(l));
  return {
    duration: dur ? parseClock(dur[1]) : 0,
    // cover art in audio files shows up as an "attached pic" video stream
    hasVideo: videoLines.some((l) => !/attached pic/.test(l)),
    hasAudio: /Stream #.*Audio:/.test(out),
  };
}

function progressFromLine(line: string, total: number): number | null {
  const m = line.match(/time=(\d+:\d+:\d+(?:\.\d+)?)/);
  if (!m || !total) return null;
  return Math.min(1, parseClock(m[1]) / total);
}

/** Mono 16 kHz low-bitrate mp3: small enough for API upload limits, plenty for speech. */
export async function extractAudio(
  input: string,
  output: string,
  duration: number,
  onProgress: (p: number) => void,
  signal?: AbortSignal,
) {
  const tmp = `${output}.part.mp3`;
  await runFfmpeg(["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", "-f", "mp3", tmp], {
    signal,
    onLine: (l) => {
      const p = progressFromLine(l, duration);
      if (p !== null) onProgress(p);
    },
  });
  fs.renameSync(tmp, output);
}

export interface Silence {
  start: number;
  end: number;
}

export async function detectSilences(audio: string, signal?: AbortSignal): Promise<Silence[]> {
  const silences: Silence[] = [];
  let start: number | null = null;
  await runFfmpeg(["-i", audio, "-af", "silencedetect=noise=-32dB:d=0.35", "-f", "null", "-"], {
    signal,
    onLine: (l) => {
      const s = l.match(/silence_start:\s*(-?[\d.]+)/);
      if (s) start = Math.max(0, Number(s[1]));
      const e = l.match(/silence_end:\s*([\d.]+)/);
      if (e && start !== null) {
        silences.push({ start, end: Number(e[1]) });
        start = null;
      }
    },
  });
  return silences;
}

/**
 * Plan cut points near every `target` seconds, snapping to the middle of the
 * longest nearby silence so words aren't split across chunks.
 */
export function planChunks(duration: number, silences: Silence[], target: number, tolerance: number) {
  const chunks: { start: number; end: number }[] = [];
  let start = 0;
  while (duration - start > target + tolerance * 0.5) {
    const ideal = start + target;
    const candidates = silences.filter((s) => {
      const mid = (s.start + s.end) / 2;
      return mid > ideal - tolerance && mid < ideal + tolerance;
    });
    let cut = ideal;
    if (candidates.length) {
      // prefer long silences close to the ideal point
      const best = candidates.reduce((a, b) => {
        const score = (s: Silence) => (s.end - s.start) * 2 - Math.abs((s.start + s.end) / 2 - ideal) / tolerance;
        return score(b) > score(a) ? b : a;
      });
      cut = (best.start + best.end) / 2;
    }
    chunks.push({ start, end: cut });
    start = cut;
  }
  chunks.push({ start, end: duration });
  return chunks;
}

export async function cutAudio(input: string, start: number, end: number, output: string, signal?: AbortSignal) {
  await runFfmpeg(
    ["-y", "-ss", start.toFixed(3), "-t", (end - start).toFixed(3), "-i", input, "-c", "copy", output],
    { signal },
  );
}

export async function thumbnail(input: string, at: number, output: string) {
  await runFfmpeg(["-y", "-ss", at.toFixed(2), "-i", input, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", output]);
}

/**
 * Grab frames where the picture changes (new slide, board update), plus at
 * least one frame every `maxGap` seconds. Decodes keyframes only, so it's fast
 * even for multi-hour videos.
 */
export async function extractKeyframes(
  input: string,
  outDir: string,
  duration: number,
  onProgress: (p: number) => void,
  signal?: AbortSignal,
): Promise<{ time: number; file: string }[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const times: number[] = [];
  const select = "isnan(prev_selected_t)+gt(scene,0.12)*gte(t-prev_selected_t,8)+gte(t-prev_selected_t,120)";
  await runFfmpeg(
    [
      "-y",
      "-skip_frame",
      "nokey",
      "-i",
      input,
      "-an",
      "-vf",
      `select='${select}',showinfo,scale='min(1280,iw)':-2`,
      "-fps_mode",
      "vfr",
      "-q:v",
      "5",
      path.join(outDir, "f_%05d.jpg"),
    ],
    {
      signal,
      onLine: (l) => {
        if (!l.includes("Parsed_showinfo")) return;
        const m = l.match(/pts_time:\s*([\d.]+)/);
        if (m) {
          times.push(Number(m[1]));
          if (duration) onProgress(Math.min(1, Number(m[1]) / duration));
        }
      },
    },
  );
  return times.map((time, i) => ({ time, file: `f_${String(i + 1).padStart(5, "0")}.jpg` }))
    .filter((f) => fs.existsSync(path.join(outDir, f.file)));
}

/** 16 kHz mono PCM WAV piece, the input format whisper.cpp expects. */
export async function cutAudioWav(input: string, start: number, end: number, output: string, signal?: AbortSignal) {
  await runFfmpeg(
    ["-y", "-ss", start.toFixed(3), "-t", (end - start).toFixed(3), "-i", input, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", output],
    { signal },
  );
}
