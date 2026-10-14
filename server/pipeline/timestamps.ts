import { replaceTimestamps } from "../../shared/markdown";
import { fmtTime } from "../../shared/time";
import type { Segment } from "../../shared/types";

/** How far a model-written time may be from a real transcript moment and still be snapped to it. */
const SNAP_SEC = 15;

/**
 * Check the timestamps a model wrote against the transcript. A time past the
 * end of the lecture is not a moment at all (usually a bit range like [31:12]),
 * so it becomes inline code; a time near a segment start snaps to it so the
 * link lands where the sentence begins.
 */
export function timestampFixer(segments: Segment[], duration: number) {
  const starts = segments.map((s) => s.start);
  const nearest = (t: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    const candidates = [starts[lo], starts[lo - 1]].filter((x) => x !== undefined);
    return candidates.sort((a, b) => Math.abs(a - t) - Math.abs(b - t))[0];
  };
  return (md: string) =>
    replaceTimestamps(md, (sec, whole, time) => {
      if (sec > duration + 2) return `\`${whole}\``;
      const near = nearest(sec);
      if (near === undefined || Math.abs(near - sec) > SNAP_SEC) return whole;
      const fixed = fmtTime(near);
      return fixed === time ? whole : whole.replace(time, fixed);
    });
}

/** Apply a string fix to every string inside a generated object. */
export function fixStrings<T>(value: T, fix: (s: string) => string): T {
  if (typeof value === "string") return fix(value) as T;
  if (Array.isArray(value)) return value.map((v) => fixStrings(v, fix)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fixStrings(v, fix)])) as T;
  }
  return value;
}
