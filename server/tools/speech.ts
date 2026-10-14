import fs from "node:fs";
import type { Silence } from "./ffmpeg";
import type { Segment } from "../../shared/types";

/**
 * Skip long silences before local transcription. Lectures have breaks and
 * dead air that cost whisper a full 30 s encoder pass each and come back as
 * invented lines ("감사합니다."). We drop them from the chunk's WAV and map the
 * timestamps back afterwards. whisper.cpp's own --vad does the same but its
 * Silero pass is slower than the time it saves on Vulkan builds.
 */

const MIN_GAP = 2; // only silences at least this long are removed
const PAD = 0.3; // keep a little audio around speech so word edges survive

/** A piece of the original chunk, [from, to) in chunk seconds, placed at `at` in the compacted audio. */
export interface Span {
  from: number;
  to: number;
  at: number;
}

export function speechSpans(chunkStart: number, chunkEnd: number, silences: Silence[]): Span[] {
  const len = chunkEnd - chunkStart;
  const spans: Span[] = [];
  let cursor = 0;
  let at = 0;
  const keep = (from: number, to: number) => {
    if (to - from < 0.05) return;
    spans.push({ from, to, at });
    at += to - from;
  };
  for (const s of silences) {
    const from = Math.max(0, s.start - chunkStart + PAD);
    const to = Math.min(len, s.end - chunkStart - PAD);
    if (to - from < MIN_GAP - 2 * PAD || to <= cursor) continue;
    keep(cursor, Math.max(cursor, from));
    cursor = to;
  }
  keep(cursor, len);
  return spans;
}

/** Rewrite a 16 kHz mono s16le WAV keeping only `spans`. */
export function compactWav(file: string, spans: Span[]) {
  const buf = fs.readFileSync(file);
  let pos = 12;
  let fmt: { channels: number; rate: number; bits: number } | null = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") fmt = { channels: buf.readUInt16LE(pos + 10), rate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
    if (id === "data" && fmt) {
      const frame = (fmt.channels * fmt.bits) / 8;
      const data = buf.subarray(pos + 8, Math.min(buf.length, pos + 8 + size));
      const at = (t: number) => Math.min(data.length, Math.round(t * fmt!.rate) * frame);
      const pcm = Buffer.concat(spans.map((s) => data.subarray(at(s.from), at(s.to))));
      const header = Buffer.alloc(44);
      header.write("RIFF", 0, "ascii");
      header.writeUInt32LE(36 + pcm.length, 4);
      header.write("WAVEfmt ", 8, "ascii");
      header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20);
      header.writeUInt16LE(fmt.channels, 22);
      header.writeUInt32LE(fmt.rate, 24);
      header.writeUInt32LE(fmt.rate * frame, 28);
      header.writeUInt16LE(frame, 32);
      header.writeUInt16LE(fmt.bits, 34);
      header.write("data", 36, "ascii");
      header.writeUInt32LE(pcm.length, 40);
      fs.writeFileSync(file, Buffer.concat([header, pcm]));
      return;
    }
    pos += 8 + size + (size % 2);
  }
  throw new Error(`WAV 형식을 읽지 못했습니다: ${file}`);
}

/** Map segments timed against the compacted audio back to the original timeline. */
export function restoreTimes(segs: Segment[], spans: Span[], offset: number): Segment[] {
  const map = (t: number, isEnd: boolean) => {
    let span = spans[0];
    for (const s of spans) {
      if (isEnd ? s.at < t : s.at <= t) span = s;
      else break;
    }
    return offset + Math.min(span.to, span.from + (t - span.at));
  };
  return segs.map((s) => ({ ...s, start: map(s.start, false), end: Math.max(map(s.start, false), map(s.end, true)) }));
}
