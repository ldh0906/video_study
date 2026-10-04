import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BIN_DIR } from "../paths";
import { FFMPEG } from "./ffmpeg";

interface Cmd {
  bin: string;
  pre: string[];
}

const LOCAL_BIN = path.join(BIN_DIR, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
let cached: Cmd | null | undefined;

function exec(bin: string, args: string[], signal?: AbortSignal, onLine?: (l: string) => void) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
    let stdout = "";
    let stderr = "";
    let partial = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
      if (!onLine) return;
      partial += d;
      const lines = partial.split(/\r\n|\r|\n/);
      partial = lines.pop() ?? "";
      lines.forEach(onLine);
    });
    child.stderr.on("data", (d: string) => {
      if (stderr.length < 200_000) stderr += d;
    });
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function works(cmd: Cmd): Promise<string | null> {
  try {
    const r = await exec(cmd.bin, [...cmd.pre, "--version"]);
    return r.code === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

export async function resolveYtdlp(force = false): Promise<{ cmd: Cmd; version: string } | null> {
  if (cached !== undefined && !force) {
    if (!cached) return null;
    const version = await works(cached);
    return version ? { cmd: cached, version } : null;
  }
  const candidates: Cmd[] = [
    ...(process.env.YTDLP_PATH ? [{ bin: process.env.YTDLP_PATH, pre: [] }] : []),
    { bin: LOCAL_BIN, pre: [] },
    { bin: "yt-dlp", pre: [] },
    { bin: "python", pre: ["-m", "yt_dlp"] },
    { bin: "py", pre: ["-m", "yt_dlp"] },
    { bin: "python3", pre: ["-m", "yt_dlp"] },
  ];
  for (const c of candidates) {
    if (c.bin === LOCAL_BIN && !fs.existsSync(LOCAL_BIN)) continue;
    const version = await works(c);
    if (version) {
      cached = c;
      return { cmd: c, version };
    }
  }
  cached = null;
  return null;
}

/** Download the official yt-dlp release binary into data/bin. */
export async function installYtdlp() {
  const asset =
    process.platform === "win32" ? "yt-dlp.exe" : process.platform === "darwin" ? "yt-dlp_macos" : "yt-dlp_linux";
  const res = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`);
  if (!res.ok || !res.body) throw new Error(`yt-dlp 다운로드 실패: HTTP ${res.status}`);
  const tmp = `${LOCAL_BIN}.part`;
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), fs.createWriteStream(tmp));
  fs.renameSync(tmp, LOCAL_BIN);
  if (process.platform !== "win32") fs.chmodSync(LOCAL_BIN, 0o755);
  return resolveYtdlp(true);
}

export interface VideoInfo {
  title: string;
  duration: number;
  language?: string;
  subtitles: Record<string, unknown[]>;
  automatic_captions: Record<string, unknown[]>;
  webpage_url?: string;
  uploader?: string;
}

function commonArgs(cookiesFromBrowser: string) {
  // YouTube needs a JS runtime for its player challenges; the Node running this app works.
  const args = ["--no-playlist", "--no-warnings", "--encoding", "utf-8", "--js-runtimes", `node:${process.execPath}`];
  if (FFMPEG) args.push("--ffmpeg-location", FFMPEG);
  if (cookiesFromBrowser) args.push("--cookies-from-browser", cookiesFromBrowser);
  return args;
}

async function need() {
  const y = await resolveYtdlp();
  if (!y) throw new Error("URL을 가져오려면 yt-dlp가 필요합니다. 설정 → 도구에서 설치해 주세요.");
  return y.cmd;
}

function errorFrom(stderr: string) {
  const line = stderr.split(/\r?\n/).filter((l) => /ERROR/.test(l)).pop() || stderr.trim().split(/\r?\n/).pop() || "";
  const hint = /403|Forbidden|Sign in|confirm you|bot/i.test(line)
    ? "\n→ 사이트가 다운로드를 막았습니다. 설정 → 도구에서 yt-dlp를 최신 버전으로 업데이트하거나, 로그인이 필요한 사이트라면 브라우저 쿠키 사용을 켜 보세요."
    : "";
  return new Error(`yt-dlp: ${line.replace(/^ERROR:\s*/, "").slice(0, 400)}${hint}`);
}

export async function videoInfo(url: string, cookiesFromBrowser: string, signal?: AbortSignal): Promise<VideoInfo> {
  const cmd = await need();
  const r = await exec(cmd.bin, [...cmd.pre, ...commonArgs(cookiesFromBrowser), "-J", url], signal);
  if (r.code !== 0) throw errorFrom(r.stderr);
  const info = JSON.parse(r.stdout);
  return {
    title: info.title ?? url,
    duration: Number(info.duration) || 0,
    language: info.language ?? undefined,
    subtitles: info.subtitles ?? {},
    automatic_captions: info.automatic_captions ?? {},
    webpage_url: info.webpage_url,
    uploader: info.uploader,
  };
}

export async function downloadVideo(
  url: string,
  outDir: string,
  opts: { quality: string; cookiesFromBrowser: string },
  onProgress: (p: number, detail: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const cmd = await need();
  fs.mkdirSync(outDir, { recursive: true });
  const h = opts.quality;
  const format = `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/b[height<=${h}][ext=mp4]/bv*[height<=${h}]+ba/b[height<=${h}]/b`;
  let pass = 0;
  let last = 0;
  const r = await exec(
    cmd.bin,
    [
      ...cmd.pre,
      ...commonArgs(opts.cookiesFromBrowser),
      "-f",
      format,
      "--merge-output-format",
      "mp4",
      "--newline",
      "--no-part",
      "-o",
      path.join(outDir, "source.%(ext)s"),
      url,
    ],
    signal,
    (line) => {
      const m = line.match(/\[download\]\s+([\d.]+)%(?:\s+of\s+~?\s*([\d.]+\S+))?(?:.*?at\s+(\S+))?/);
      if (!m) return;
      const pct = Number(m[1]) / 100;
      if (pct < last - 0.5) pass++; // second stream (audio) started
      last = pct;
      onProgress(Math.min(1, (pass + pct) / (pass + 1)), [m[2], m[3]].filter(Boolean).join(" · "));
    },
  );
  if (r.code !== 0) throw errorFrom(r.stderr);
  const file = fs.readdirSync(outDir).find((f) => f.startsWith("source.") && !f.endsWith(".part"));
  if (!file) throw new Error("다운로드된 파일을 찾을 수 없습니다.");
  return path.join(outDir, file);
}

function pickLang(keys: string[], prefs: string[]): string | undefined {
  for (const p of prefs.filter(Boolean)) {
    const exact = keys.find((k) => k === p);
    if (exact) return exact;
    const prefixed = keys.find((k) => k.split("-")[0] === p);
    if (prefixed) return prefixed;
  }
  return undefined;
}

/**
 * Fetch the best available subtitle track. Manual (creator-made) subtitles are
 * returned with kind "manual"; YouTube auto captions with kind "auto".
 */
export async function downloadSubtitles(
  url: string,
  info: VideoInfo,
  outDir: string,
  opts: { spokenLanguage: string; cookiesFromBrowser: string; allowAuto: boolean },
  signal?: AbortSignal,
): Promise<{ file: string; kind: "manual" | "auto"; lang: string } | null> {
  const prefs = [opts.spokenLanguage, info.language ?? "", "ko", "en"];
  const manualKeys = Object.keys(info.subtitles).filter((k) => k !== "live_chat");
  let lang: string | undefined = pickLang(manualKeys, prefs) ?? manualKeys[0];
  let kind: "manual" | "auto" = "manual";
  if (!lang) {
    if (!opts.allowAuto) return null;
    const autoKeys = Object.keys(info.automatic_captions);
    lang = autoKeys.find((k) => k.endsWith("-orig")) ?? pickLang(autoKeys, prefs);
    kind = "auto";
  }
  if (!lang) return null;
  const cmd = await need();
  fs.mkdirSync(outDir, { recursive: true });
  const r = await exec(
    cmd.bin,
    [
      ...cmd.pre,
      ...commonArgs(opts.cookiesFromBrowser),
      "--skip-download",
      kind === "manual" ? "--write-subs" : "--write-auto-subs",
      "--sub-langs",
      lang,
      "--sub-format",
      "vtt/srt/best",
      "-o",
      path.join(outDir, "subs.%(ext)s"),
      url,
    ],
    signal,
  );
  if (r.code !== 0) throw errorFrom(r.stderr);
  const file = fs.readdirSync(outDir).find((f) => f.startsWith("subs.") && /\.(vtt|srt)$/.test(f));
  return file ? { file: path.join(outDir, file), kind, lang: lang.replace(/-orig$/, "") } : null;
}
