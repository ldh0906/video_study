export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "12:34" or "1:02:03" → seconds */
export function parseTime(t: string): number {
  return t.split(":").reduce((acc, p) => acc * 60 + Number(p), 0);
}

/** Matches [12:34], [1:02:03] and ranges like [12:34–13:10] (first time wins). */
export const TIMESTAMP_RE = /\[(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*[-–~]\s*\d{1,2}:\d{2}(?::\d{2})?)?\]/g;

export function fmtDuration(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}시간 ${m % 60}분` : `${h}시간`;
}
