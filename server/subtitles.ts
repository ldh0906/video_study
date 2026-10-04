import type { Segment } from "../shared/types";

function toSeconds(ts: string): number {
  const parts = ts.trim().replace(",", ".").split(":");
  let s = 0;
  for (const p of parts) s = s * 60 + Number(p);
  return s;
}

function clean(line: string) {
  return line
    .replace(/<\d{1,2}:\d{2}[:.\d]*>/g, "") // inline word timings
    .replace(/<\/?[^>]+>/g, "") // <c>, <i>, <v Speaker>
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse WebVTT or SRT into cues, dropping the rolling duplicates of YouTube auto captions. */
export function parseSubtitles(text: string): Segment[] {
  const blocks = text.replace(/\r/g, "").split(/\n{2,}/);
  const cues: Segment[] = [];
  let prevLines: string[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const tIdx = lines.findIndex((l) => l.includes("-->"));
    if (tIdx < 0) continue;
    const [a, b] = lines[tIdx].split("-->");
    const start = toSeconds(a);
    const end = toSeconds(b.trim().split(/\s+/)[0]);
    const textLines = lines.slice(tIdx + 1).map(clean).filter(Boolean);
    // auto captions repeat the previous cue's line at the top of the next one
    const fresh = textLines.filter((l) => !prevLines.includes(l));
    if (textLines.length) prevLines = textLines;
    if (!fresh.length || end - start < 0.05) continue;
    cues.push({ start, end, text: fresh.join(" ") });
  }
  return mergeCues(cues);
}

/** Merge tiny cues into readable sentence-ish segments (~6–15 s). */
export function mergeCues(cues: Segment[], minLen = 6, maxLen = 15): Segment[] {
  const out: Segment[] = [];
  let cur: Segment | null = null;
  for (const c of cues) {
    if (!cur) {
      cur = { ...c };
      continue;
    }
    const len = cur.end - cur.start;
    const endsSentence = /[.!?。！？]$|[다요죠까]\.?$/.test(cur.text);
    const gap = c.start - cur.end;
    if (len >= maxLen || gap > 2 || (len >= minLen && endsSentence)) {
      out.push(cur);
      cur = { ...c };
    } else {
      cur.end = c.end;
      cur.text = `${cur.text} ${c.text}`;
    }
  }
  if (cur) out.push(cur);
  return out;
}
