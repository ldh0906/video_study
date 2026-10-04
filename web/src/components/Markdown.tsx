import { memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkCjkFriendly from "remark-cjk-friendly";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { Play } from "lucide-react";
import { TIMESTAMP_RE, fmtTime, parseTime } from "@shared/time";
import { player } from "@/lib/player";
import { cn } from "@/lib/utils";

/** Turn [12:34] into seek links and normalise \( \) / \[ \] math delimiters, leaving code untouched. */
function preprocess(md: string) {
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

export function TimeChip({ time, className, children }: { time: number; className?: string; children?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        player.seek(time);
      }}
      className={cn(
        "group/chip mx-0.5 inline-flex translate-y-[-1px] items-center gap-1 rounded-md bg-accent-soft px-1.5 py-[1px] align-middle font-sans text-[0.8em] font-semibold text-accent tabular-nums transition-colors hover:bg-accent hover:text-accent-fg",
        className,
      )}
      title="이 장면으로 이동"
    >
      <Play className="size-[0.8em] fill-current" />
      {children ?? fmtTime(time)}
    </button>
  );
}

const components: Components = {
  a({ href, children }) {
    if (href?.startsWith("#t=")) return <TimeChip time={Number(href.slice(3))}>{children}</TimeChip>;
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
};

export const Markdown = memo(function Markdown({ children, className, streaming }: { children: string; className?: string; streaming?: boolean }) {
  return (
    <div className={cn("prose-study", streaming && "is-streaming", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkCjkFriendly, [remarkMath, { singleDollarTextMath: true }]]}
        rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }], [rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={components}
      >
        {preprocess(children)}
      </ReactMarkdown>
    </div>
  );
});
