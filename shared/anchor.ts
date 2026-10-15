import { fmtTime } from "./time";

/**
 * Where a note, card or question points into its source: a moment of a video
 * (seconds) or a page of a PDF (1-based). Both live in the same `time` fields.
 */
export type AnchorUnit = "time" | "page";

export function unitOf(item: { kind?: "video" | "doc" }): AnchorUnit {
  return item.kind === "doc" ? "page" : "time";
}

export function fmtAnchor(unit: AnchorUnit, value: number): string {
  return unit === "page" ? `p.${Math.max(1, Math.round(value))}` : fmtTime(value);
}

/** Matches [p.12], [p. 12] and ranges like [p.12–14] / [p.12-p.14] (first page wins). */
export const PAGE_RE = /\[p\.\s?(\d{1,4})(?:\s*[-–~]\s*(?:p\.\s?)?\d{1,4})?\]/g;
