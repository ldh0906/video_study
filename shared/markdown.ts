import { TIMESTAMP_RE, parseTime } from "./time";

const CODE_RE = /(```[\s\S]*?```|`[^`\n]*`)/;
const MATH_RE = /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\))/;
/** A bracket right after an identifier is a bit field or index (imm[31:12], x[4:0]), not a time. */
const GLUED = /[A-Za-z0-9_\])}]/;

type TimestampFn = (sec: number, whole: string, time: string) => string;

/**
 * Rewrite every timestamp that is meant as one: outside code and math, not
 * glued to an identifier and not already a Markdown link. `fn` gets the time
 * in seconds and returns the replacement text.
 */
export function replaceTimestamps(md: string, fn: TimestampFn) {
  return md
    .split(CODE_RE)
    .map((part, i) => (i % 2 === 1 ? part : replaceInProse(part, fn)))
    .join("");
}

function replaceInProse(text: string, fn: TimestampFn) {
  return text
    .split(MATH_RE)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(TIMESTAMP_RE, (whole, t: string, offset: number, str: string) => {
            if (str[offset + whole.length] === "(" || GLUED.test(str[offset - 1] ?? "")) return whole;
            return fn(parseTime(t), whole, t);
          }),
    )
    .join("");
}

/**
 * Normalise model Markdown before rendering (web and print share this):
 * [12:34] timestamps → links to "#t=<seconds>", and \( \) / \[ \] math → $ / $$.
 * Times past `maxTime` (when known) stay plain text: they can't be moments of this lecture.
 */
export function preprocessMarkdown(md: string, opts: { maxTime?: number } = {}) {
  const linked = replaceTimestamps(md, (sec, whole) => (opts.maxTime && sec > opts.maxTime + 2 ? whole : `[${whole.slice(1, -1)}](#t=${sec})`));
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
