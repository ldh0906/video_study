import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import rehypeStringify from "rehype-stringify";
import { preprocessMarkdown } from "../../shared/markdown";
import { fmtTime } from "../../shared/time";

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
}

/**
 * Print-specific tree tweaks:
 * - "#t=754" timestamp links → real video links (or plain text when there is no link)
 * - headings inside notes are demoted so the PDF outline stays part > chapter > section
 */
function rehypePrint(opts: { linkFor: (sec: number) => string | null; headingOffset: number }) {
  return () => (tree: HastNode) => {
    const walk = (node: HastNode) => {
      if (node.type === "element") {
        const m = node.tagName?.match(/^h([1-6])$/);
        if (m) node.tagName = `h${Math.min(6, Number(m[1]) + opts.headingOffset)}`;
        const href = node.properties?.href;
        if (node.tagName === "a" && typeof href === "string" && href.startsWith("#t=")) {
          const sec = Number(href.slice(3));
          const link = opts.linkFor(sec);
          const label: HastNode = { type: "text", value: `▶${fmtTime(sec)}` };
          node.properties = { className: ["ts"], ...(link ? { href: link } : {}) };
          if (!link) node.tagName = "span";
          node.children = [label];
        }
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

export function createRenderer(linkFor: (sec: number) => string | null) {
  const make = (headingOffset: number) =>
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkCjkFriendly)
      .use(remarkMath, { singleDollarTextMath: true })
      .use(remarkRehype)
      .use(rehypeKatex, { strict: false, throwOnError: false, output: "html" } as never)
      .use(rehypeHighlight, { detect: false })
      .use(rehypePrint({ linkFor, headingOffset }))
      .use(rehypeStringify);
  const processors = new Map<number, ReturnType<typeof make>>();
  return (md: string, headingOffset = 2): string => {
    if (!md?.trim()) return "";
    let p = processors.get(headingOffset);
    if (!p) processors.set(headingOffset, (p = make(headingOffset)));
    return String(p.processSync(preprocessMarkdown(md)));
  };
}
