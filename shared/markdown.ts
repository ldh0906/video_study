import { TIMESTAMP_RE, parseTime } from "./time";

/**
 * Normalise model Markdown before rendering (web and print share this):
 * \( \) / \[ \] math → $ / $$, and [12:34] timestamps → links to "#t=<seconds>".
 * Code spans and fenced blocks are left untouched.
 */
export function preprocessMarkdown(md: string) {
  return md
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part
        .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `\n$$\n${m.trim()}\n$$\n`)
        .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => `$${m.trim()}$`)
        .replace(TIMESTAMP_RE, (whole, t: string, offset: number, str: string) =>
          str[offset + whole.length] === "(" ? whole : `[${t}](#t=${parseTime(t)})`,
        );
    })
    .join("");
}
