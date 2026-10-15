import { useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Hash, Plus, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover } from "./ui";

/** A tag as a small rounded chip; `onRemove` adds an ×. */
export function TagChip({ tag, active, onClick, onRemove, className }: { tag: string; active?: boolean; onClick?: () => void; onRemove?: () => void; className?: string }) {
  return (
    <motion.span
      layout
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.85 }}
      transition={{ type: "spring", stiffness: 500, damping: 32 }}
      onClick={onClick}
      className={cn(
        "inline-flex h-6 max-w-[180px] shrink-0 items-center gap-0.5 rounded-full border px-2 text-[12px] font-medium transition-colors",
        active ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface-2 text-muted",
        onClick && !active && "cursor-pointer hover:border-accent hover:text-accent",
        onClick && "cursor-pointer",
        className,
      )}
    >
      <Hash className="size-3 shrink-0 opacity-60" />
      <span className="truncate">{tag}</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={`${tag} 태그 빼기`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="-mr-1 ml-0.5 rounded-full p-0.5 hover:bg-black/10"
        >
          <X className="size-3" />
        </button>
      ) : null}
    </motion.span>
  );
}

/**
 * Add and remove tags in one popover: type and press Enter (or comma), or
 * click one of the existing library tags or the AI's suggestions.
 */
export function TagEditor({
  tags,
  allTags,
  suggested = [],
  onChange,
  trigger,
  align = "start",
}: {
  tags: string[];
  allTags: string[];
  suggested?: string[];
  onChange: (tags: string[]) => void;
  trigger: ReactNode;
  align?: "start" | "center" | "end";
}) {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const has = (t: string) => tags.some((x) => x.toLowerCase() === t.toLowerCase());
  const add = (raw: string) => {
    const t = raw.replace(/^#+/, "").trim().slice(0, 30);
    if (t && !has(t)) onChange([...tags, t]);
    setText("");
  };
  const q = text.trim().toLowerCase();
  const options = useMemo(() => {
    const pool = [...new Set([...suggested, ...allTags])].filter((t) => !has(t));
    return q ? pool.filter((t) => t.toLowerCase().includes(q)) : pool;
  }, [suggested, allTags, tags, q]);

  return (
    <Popover trigger={trigger} align={align} className="w-[300px] p-3">
      <div onClick={() => input.current?.focus()} className="flex min-h-9 flex-wrap items-center gap-1 rounded-lg border border-border bg-surface-2 p-1.5 focus-within:border-accent">
        <AnimatePresence initial={false}>
          {tags.map((t) => (
            <TagChip key={t} tag={t} className="bg-surface" onRemove={() => onChange(tags.filter((x) => x !== t))} />
          ))}
        </AnimatePresence>
        <input
          ref={input}
          autoFocus
          value={text}
          onChange={(e) => {
            const v = e.target.value;
            if (/[,，]$/.test(v)) add(v.slice(0, -1));
            else setText(v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              add(options.length && q && !options.some((o) => o.toLowerCase() === q) && options[0].toLowerCase().startsWith(q) ? options[0] : text);
            } else if (e.key === "Backspace" && !text && tags.length) onChange(tags.slice(0, -1));
          }}
          placeholder={tags.length ? "" : "태그 입력 후 Enter"}
          className="min-w-[80px] flex-1 bg-transparent px-1 text-[13px] outline-none placeholder:text-faint"
        />
      </div>
      {options.length ? (
        <div className="mt-2.5">
          <div className="mb-1.5 text-[11.5px] font-semibold text-faint">{q ? "일치하는 태그" : "눌러서 추가"}</div>
          <div className="flex max-h-[140px] flex-wrap gap-1 overflow-y-auto">
            {options.slice(0, 24).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => add(t)}
                className={cn(
                  "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[12px] transition-colors hover:border-accent hover:text-accent",
                  suggested.includes(t) ? "border-dashed border-accent/50 text-accent" : "border-border text-muted",
                )}
              >
                {suggested.includes(t) ? <Sparkles className="size-3" /> : <Plus className="size-3" />}
                {t}
              </button>
            ))}
          </div>
        </div>
      ) : q ? (
        <p className="mt-2 text-[12px] text-muted">Enter를 누르면 “{text.trim()}” 태그를 만들어요.</p>
      ) : null}
    </Popover>
  );
}
