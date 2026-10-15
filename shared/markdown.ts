import { PAGE_RE, type AnchorUnit } from "./anchor";
import { TIMESTAMP_RE, parseTime } from "./time";

const CODE_RE = /(```[\s\S]*?```|`[^`\n]*`)/;
const MATH_RE = /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\))/;
/** A bracket right after an identifier is a bit field or index (imm[31:12], x[4:0]), not a time. */
const GLUED = /[A-Za-z0-9_\])}]/;

type TimestampFn = (sec: number, whole: string, time: string) => string;
type PageFn = (page: number, whole: string) => string;

/** Run `fn` over the prose parts of Markdown: outside code and math. */
function inProse(md: string, fn: (text: string) => string) {
  return md
    .split(CODE_RE)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .split(MATH_RE)
            .map((p, j) => (j % 2 === 1 ? p : fn(p)))
            .join(""),
    )
    .join("");
}

/**
 * Rewrite every timestamp that is meant as one: outside code and math, not
 * glued to an identifier and not already a Markdown link. `fn` gets the time
 * in seconds and returns the replacement text.
 */
export function replaceTimestamps(md: string, fn: TimestampFn) {
  return inProse(md, (text) =>
    text.replace(TIMESTAMP_RE, (whole, t: string, offset: number, str: string) => {
      if (str[offset + whole.length] === "(" || GLUED.test(str[offset - 1] ?? "")) return whole;
      return fn(parseTime(t), whole, t);
    }),
  );
}

/** The same for page citations like [p.12] in notes made from a PDF. */
export function replacePages(md: string, fn: PageFn) {
  return inProse(md, (text) =>
    text.replace(PAGE_RE, (whole, p: string, offset: number, str: string) => {
      if (str[offset + whole.length] === "(") return whole;
      return fn(Number(p), whole);
    }),
  );
}

/**
 * Normalise model Markdown before rendering (web and print share this):
 * [12:34] timestamps → links to "#t=<seconds>" (or [p.12] → "#p=12" for a
 * document), and \( \) / \[ \] math → $ / $$. Anchors past `max` (when known)
 * stay plain text: they can't point into this source.
 */
export function preprocessMarkdown(md: string, opts: { maxTime?: number; unit?: AnchorUnit } = {}) {
  const linked =
    opts.unit === "page"
      ? replacePages(md, (page, whole) => (page < 1 || (opts.maxTime && page > opts.maxTime) ? whole : `[${whole.slice(1, -1)}](#p=${page})`))
      : replaceTimestamps(md, (sec, whole) => (opts.maxTime && sec > opts.maxTime + 2 ? whole : `[${whole.slice(1, -1)}](#t=${sec})`));
  return linked
    .split(CODE_RE)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `\n$$\n${m.trim()}\n$$\n`)
            .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => `$${m.trim()}$`),
    )
    .join("");
}
