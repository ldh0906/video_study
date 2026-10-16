import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { Chapter, Segment, Transcript } from "@shared/types";
import { Button, EmptyState, Spinner } from "@/components/ui";
import { player, usePlayerSecond } from "@/lib/player";
import { cn } from "@/lib/utils";
import { SelectionActions } from "./SelectionActions";

function activeIndex(segs: Segment[], t: number) {
  let lo = 0;
  let hi = segs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].start <= t + 0.25) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

const Row = memo(function Row({ seg, idx, active, query }: { seg: Segment; idx: number; active: boolean; query: string }) {
  let text: React.ReactNode = seg.text;
  if (query) {
    const parts = seg.text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
    text = parts.map((p, i) => (i % 2 ? <mark key={i} className="rounded bg-highlight px-0.5 text-text">{p}</mark> : p));
  }
  return (
    <div
      data-idx={idx}
      data-time={seg.start}
      onClick={() => {
        if (!window.getSelection()?.toString()) player.seek(seg.start);
      }}
      className={cn(
        "group flex cursor-pointer gap-3 rounded-xl px-3 py-2 transition-colors [content-visibility:auto] [contain-intrinsic-size:auto_44px]",
        active ? "bg-accent-soft" : "hover:bg-surface-2",
      )}
    >
      <span className={cn("w-12 shrink-0 pt-[2px] text-right text-[11.5px] font-semibold tabular-nums", active ? "text-accent" : "text-faint group-hover:text-muted")}>
        {player.fmt(seg.start)}
      </span>
      <p className={cn("min-w-0 flex-1 text-[14px] leading-[1.7]", active ? "text-text" : "text-text/80")}>{text}</p>
    </div>
  );
});

export function TranscriptPanel({ transcript, chapters = [], loading }: { transcript: Transcript | null | undefined; chapters?: Chapter[]; loading?: boolean }) {
  const segs = useMemo(() => transcript?.segments ?? [], [transcript]);
  // segment index → chapter that begins there, so the transcript reads in sections
  const chapterAt = useMemo(() => {
    const map = new Map<number, Chapter>();
    for (const c of chapters) {
      const i = segs.findIndex((s) => s.start >= c.start - 1);
      if (i >= 0 && !map.has(i)) map.set(i, c);
    }
    return map;
  }, [segs, chapters]);
  const second = usePlayerSecond();
  const active = activeIndex(segs, second);
  const scroller = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [matchIdx, setMatchIdx] = useState(0);
  const programmatic = useRef(false);

  const matches = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return segs.map((s, i) => (s.text.toLowerCase().includes(q) ? i : -1)).filter((i) => i >= 0);
  }, [segs, query]);

  const scrollTo = useCallback((idx: number, smooth = true) => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-idx="${idx}"]`);
    if (!el || !scroller.current) return;
    programmatic.current = true;
    const top = el.offsetTop - scroller.current.clientHeight / 3;
    scroller.current.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
    setTimeout(() => (programmatic.current = false), 600);
  }, []);

  useEffect(() => {
    if (follow && active >= 0 && !query) scrollTo(active);
  }, [active, follow, query, scrollTo]);

  useEffect(() => {
    if (matches.length) scrollTo(matches[Math.min(matchIdx, matches.length - 1)]);
  }, [matches, matchIdx, scrollTo]);

  const timeOf = useCallback((node: Node) => {
    const el = (node instanceof HTMLElement ? node : node.parentElement)?.closest<HTMLElement>("[data-time]");
    return el ? Number(el.dataset.time) : null;
  }, []);

  if (!segs.length) {
    return loading ? (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted">
        <Spinner /> 받아쓰기가 끝나면 여기에 대본이 나타나요
      </div>
    ) : (
      <EmptyState icon={<Search />} title="대본이 없어요" description="‘다시 분석하기’에서 받아쓰기부터 다시 하거나, 자막 파일을 첨부하면 여기에 나타나요." />
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-1 pb-2">
        {searchOpen ? (
          <div className="flex h-9 flex-1 items-center gap-1.5 rounded-[10px] border border-border bg-surface pr-1 pl-3 focus-within:border-accent">
            <Search className="size-4 text-faint" />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setMatchIdx(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") setMatchIdx((i) => (matches.length ? (i + (e.shiftKey ? matches.length - 1 : 1)) % matches.length : 0));
                if (e.key === "Escape") {
                  setQuery("");
                  setSearchOpen(false);
                }
              }}
              placeholder="대본에서 찾기"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
            />
            {query ? <span className="text-xs text-faint tabular-nums">{matches.length ? `${Math.min(matchIdx, matches.length - 1) + 1}/${matches.length}` : "0"}</span> : null}
            <Button variant="ghost" size="icon-sm" onClick={() => setMatchIdx((i) => (i - 1 + matches.length) % Math.max(1, matches.length))} aria-label="이전">
              <ChevronUp className="size-4" />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => setMatchIdx((i) => (i + 1) % Math.max(1, matches.length))} aria-label="다음">
              <ChevronDown className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                setQuery("");
                setSearchOpen(false);
              }}
              aria-label="닫기"
            >
              <X className="size-4" />
            </Button>
          </div>
        ) : (
          <>
            <span className="flex-1 text-xs text-muted">
              {transcript?.source ? `${transcript.source} · ` : ""}
              {segs.length}개 구간 · 텍스트를 선택하면 질문할 수 있어요
            </span>
            <Button variant="ghost" size="icon-sm" onClick={() => setSearchOpen(true)} aria-label="대본 검색">
              <Search className="size-4" />
            </Button>
          </>
        )}
      </div>
      <div
        ref={scroller}
        onScroll={() => {
          if (!programmatic.current && follow) setFollow(false);
        }}
        className="relative min-h-0 flex-1 overflow-y-auto pr-1"
      >
        {segs.map((s, i) => {
          const chapter = chapterAt.get(i);
          return (
            <Fragment key={i}>
              {chapter ? (
                <button onClick={() => player.seek(chapter.start)} className="sticky top-0 z-[1] mt-3 mb-1 block w-full bg-surface/95 px-3 pt-2 pb-1.5 text-left backdrop-blur first:mt-0">
                  <span className="text-[11.5px] font-semibold text-accent tabular-nums">{player.fmt(chapter.start)}</span>
                  <span className="ml-2 text-[13.5px] font-semibold">{chapter.title}</span>
                </button>
              ) : null}
              <Row seg={s} idx={i} active={i === active} query={query.trim()} />
            </Fragment>
          );
        })}
        <div className="h-24" />
      </div>
      {!follow ? (
        <button
          onClick={() => {
            setFollow(true);
            if (active >= 0) scrollTo(active);
          }}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-surface px-3.5 py-1.5 text-[12.5px] font-medium shadow-float transition-transform hover:-translate-y-0.5"
        >
          <ArrowDownToLine className="size-3.5 text-accent" />
          현재 위치 따라가기
        </button>
      ) : null}
      <SelectionActions container={scroller} timeOf={timeOf} />
    </div>
  );
}
