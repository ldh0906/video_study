import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BIN_DIR, DATA_DIR, readJson } from "../paths";
import type { Segment, ToolInfo, WhisperModel } from "../../shared/types";

/**
 * Local speech recognition with whisper.cpp — runs on the user's machine, so
 * transcription needs no API key or account.
 */

const WHISPER_DIR = path.join(BIN_DIR, "whisper");
const GPU_DIR = path.join(BIN_DIR, "whisper-vulkan");
const MODELS_DIR = path.join(DATA_DIR, "models");
fs.mkdirSync(MODELS_DIR, { recursive: true });

export const WHISPER_MODELS: { id: WhisperModel; label: string; sizeMB: number; blurb: string }[] = [
  { id: "large-v3-turbo-q5_0", label: "Large v3 Turbo", sizeMB: 547, blurb: "가장 정확함 · 한국어/전문용어에 추천" },
  { id: "medium-q5_0", label: "Medium", sizeMB: 514, blurb: "정확도와 속도의 균형" },
  { id: "small-q5_1", label: "Small", sizeMB: 181, blurb: "빠름 · 영어 강의에 적당" },
  { id: "base-q5_1", label: "Base", sizeMB: 57, blurb: "매우 빠름 · 정확도 낮음" },
];

const modelFile = (m: WhisperModel) => path.join(MODELS_DIR, `ggml-${m}.bin`);

export function installedModels(): WhisperModel[] {
  return WHISPER_MODELS.map((m) => m.id).filter((m) => fs.existsSync(modelFile(m)));
}

function findExe(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const name = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name === name) return path.join(entry.parentPath, entry.name);
  }
  return null;
}

async function exeWorks(bin: string) {
  return new Promise<boolean>((resolve) => {
    const child = spawn(bin, ["--help"], { windowsHide: true });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0 || code === 1));
  });
}

let resolved: string | null | undefined;

function gpuRuntime() {
  const config = readJson<{ device: number; label: string } | null>(path.join(GPU_DIR, "accelerator.json"), null);
  const bin = path.join(GPU_DIR, "whisper-cli.exe");
  if (process.platform !== "win32" || !config || !Number.isInteger(config.device) || config.device < 0 || !fs.existsSync(bin)) return null;
  return { ...config, bin };
}

// A single GPU worker avoids loading two large models into laptop VRAM.
export function localParallelism() {
  return resolved && resolved === gpuRuntime()?.bin ? 1 : 2;
}

export async function resolveWhisper(force = false): Promise<string | null> {
  if (resolved !== undefined && !force) return resolved;
  const candidates = [process.env.WHISPER_CLI_PATH, gpuRuntime()?.bin, findExe(WHISPER_DIR), "whisper-cli"].filter(Boolean) as string[];
  for (const c of candidates) if (await exeWorks(c)) return (resolved = c);
  return (resolved = null);
}

export async function whisperStatus(): Promise<ToolInfo & { models: WhisperModel[] }> {
  const bin = await resolveWhisper();
  const gpu = gpuRuntime();
  return { ok: Boolean(bin), path: bin, models: installedModels(), version: gpu && bin === gpu.bin ? `${gpu.label} · GPU 가속` : undefined };
}

// --- installation (user-initiated from settings) -----------------------------

export interface DownloadState {
  status: "downloading" | "done" | "error";
  received: number;
  total: number;
  error?: string;
}

export const downloads = new Map<string, DownloadState>();

async function downloadTo(url: string, file: string, key: string) {
  const state: DownloadState = { status: "downloading", received: 0, total: 0 };
  downloads.set(key, state);
  try {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    state.total = Number(res.headers.get("content-length") ?? 0);
    const tmp = `${file}.part`;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        state.received += chunk.byteLength;
        ctrl.enqueue(chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body.pipeThrough(counter) as import("node:stream/web").ReadableStream), fs.createWriteStream(tmp));
    fs.renameSync(tmp, file);
    state.status = "done";
  } catch (err) {
    state.status = "error";
    state.error = (err as Error).message;
    throw err;
  }
}

/** Official whisper.cpp Windows build (OpenBLAS, CPU) from the project's GitHub releases. */
export async function installWhisper() {
  if (process.platform !== "win32") {
    throw new Error("macOS/Linux에서는 `brew install whisper-cpp` 등으로 whisper-cli를 설치해 주세요.");
  }
  const res = await fetch("https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=15", {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`릴리스 정보를 가져오지 못했습니다 (HTTP ${res.status})`);
  const releases = (await res.json()) as { assets: { name: string; browser_download_url: string }[] }[];
  const asset =
    releases.flatMap((r) => r.assets).find((a) => a.name === "whisper-blas-bin-x64.zip") ??
    releases.flatMap((r) => r.assets).find((a) => a.name === "whisper-bin-x64.zip");
  if (!asset) throw new Error("whisper.cpp Windows 빌드를 찾지 못했습니다.");
  fs.mkdirSync(WHISPER_DIR, { recursive: true });
  const zip = path.join(BIN_DIR, asset.name);
  await downloadTo(asset.browser_download_url, zip, "whisper-bin");
  await new Promise<void>((resolve, reject) => {
    // bsdtar ships with Windows 10+ and extracts zip files
    const child = spawn("tar", ["-xf", zip, "-C", WHISPER_DIR], { windowsHide: true });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`압축 해제 실패 (code ${code})`))));
  });
  fs.rmSync(zip, { force: true });
  return resolveWhisper(true);
}

export function installModel(model: WhisperModel) {
  if (downloads.get(model)?.status === "downloading") return;
  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`;
  downloadTo(url, modelFile(model), model).catch(() => {});
}

// --- transcription ---------------------------------------------------------------

export async function transcribeLocal(opts: {
  wav: string;
  offset: number;
  model: WhisperModel;
  language: string;
  prompt: string;
  threads: number;
  onProgress: (p: number) => void;
  signal: AbortSignal;
}): Promise<Segment[]> {
  const bin = await resolveWhisper();
  if (!bin) throw new Error("로컬 Whisper가 설치되지 않았습니다. 설정 → 받아쓰기에서 설치해 주세요.");
  const model = fs.existsSync(modelFile(opts.model)) ? opts.model : installedModels()[0];
  if (!model) throw new Error("Whisper 모델이 없습니다. 설정 → 받아쓰기에서 모델을 내려받아 주세요.");
  const outPrefix = opts.wav.replace(/\.wav$/, "");
  const args = [
    "-m", modelFile(model),
    "-f", opts.wav,
    "-l", opts.language || "auto",
    "-t", String(opts.threads),
    "-oj", "-of", outPrefix,
    "-pp",
  ];
  const gpu = gpuRuntime();
  if (gpu && bin === gpu.bin) args.push("-dev", String(gpu.device));
  if (opts.prompt) args.push("--prompt", opts.prompt.slice(0, 400));

  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let tail = "";
    const onData = (d: Buffer) => {
      const s = d.toString();
      tail = (tail + s).slice(-2000);
      const m = [...s.matchAll(/progress\s*=\s*(\d+)%/g)].pop();
      if (m) opts.onProgress(Number(m[1]) / 100);
    };
    child.stderr.on("data", onData);
    child.stdout.on("data", onData);
    const onAbort = () => child.kill();
    opts.signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      opts.signal.removeEventListener("abort", onAbort);
      if (opts.signal.aborted) return reject(new DOMException("aborted", "AbortError"));
      if (code === 0) resolve();
      else reject(new Error(`whisper.cpp 실패 (code ${code}): ${tail.trim().split(/\r?\n/).slice(-2).join(" ")}`));
    });
  });

  const json = JSON.parse(fs.readFileSync(`${outPrefix}.json`, "utf8")) as {
    transcription: { offsets: { from: number; to: number }; text: string }[];
  };
  fs.rmSync(`${outPrefix}.json`, { force: true });
  return json.transcription
    .map((t) => ({ start: opts.offset + t.offsets.from / 1000, end: opts.offset + t.offsets.to / 1000, text: t.text.trim() }))
    .filter((s) => s.text && !/^\[.*\]$|^\(.*\)$/.test(s.text)); // drop "[음악]" style annotations
}

export const defaultThreads = () => Math.max(2, Math.floor(os.cpus().length / 2));
