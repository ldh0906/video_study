import { createContext, memo, useContext, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkCjkFriendly from "remark-cjk-friendly";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { FileText, Play } from "lucide-react";
import { fmtAnchor, type AnchorUnit } from "@shared/anchor";
import { preprocessMarkdown } from "@shared/markdown";
import { player, usePlayer } from "@/lib/player";
import { cn } from "@/lib/utils";

/**
 * Where anchors point when there is no player on the page (an exam built from
 * several sources): each question names its own source and how to open it.
 */
const AnchorTarget = createContext<{ unit: AnchorUnit; seek: (value: number) => void; plain?: boolean } | null>(null);
export const AnchorProvider = AnchorTarget.Provider;

/** A clickable source anchor: plays the video there, or opens the PDF at that page. */
export function TimeChip({ time, className, children }: { time: number; className?: string; children?: ReactNode }) {
  const target = useContext(AnchorTarget);
  const playerUnit = usePlayer((s) => s.unit);
  const unit = target?.unit ?? playerUnit;
  // generic labels like "관련 장면" read better as the page itself
  const label = unit === "page" && (children === undefined || typeof children === "string") ? fmtAnchor(unit, time) : (children ?? fmtAnchor(unit, time));
  // e.g. during an exam: showing where the answer is would give it away
  if (target?.plain) return <span className={cn("mx-0.5 text-[0.85em] text-faint tabular-nums", className)}>{label}</span>;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (target) target.seek(time);
        else player.seek(time);
      }}
      className={cn(
        "group/chip mx-0.5 inline-flex translate-y-[-1px] items-center gap-1 rounded-md bg-accent-soft px-1.5 py-[1px] align-middle font-sans text-[0.8em] font-semibold text-accent tabular-nums transition-colors hover:bg-accent hover:text-accent-fg",
        className,
      )}
      title={unit === "page" ? "이 페이지 열기" : "이 장면으로 이동"}
    >
      {unit === "page" ? <FileText className="size-[0.85em]" /> : <Play className="size-[0.8em] fill-current" />}
      {label}
    </button>
  );
}

const components: Components = {
  a({ href, children }) {
    if (href?.startsWith("#t=") || href?.startsWith("#p=")) return <TimeChip time={Number(href.slice(3))}>{children}</TimeChip>;
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
};

export const Markdown = memo(function Markdown({ children, className, streaming }: { children: string; className?: string; streaming?: boolean }) {
  // a "timestamp" past the end of the video (or a page past the end of the PDF) is something else
  const target = useContext(AnchorTarget);
  const playerDuration = usePlayer((s) => Math.round(s.duration));
  const playerUnit = usePlayer((s) => s.unit);
  const unit = target?.unit ?? playerUnit;
  const duration = target ? 0 : playerDuration;
  return (
    <div className={cn("prose-study", streaming && "is-streaming", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkCjkFriendly, [remarkMath, { singleDollarTextMath: true }]]}
        rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }], [rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={components}
      >
        {preprocessMarkdown(children, { maxTime: duration || undefined, unit })}
      </ReactMarkdown>
    </div>
  );
});
