import { useCallback, useMemo, useState } from "react";
import { ChevronRight, Crosshair, Eye, FileText, PenLine, Sparkle } from "lucide-react";
import type { Analysis, Lecture, SelfCheck } from "@shared/types";
import { Markdown, TimeChip } from "@/components/Markdown";
import { Button, Menu, MenuItem, Textarea, Tooltip } from "@/components/ui";
import { player, usePlayerSecond } from "@/lib/player";
import { cn } from "@/lib/utils";
import { SelectionActions } from "../SelectionActions";

/** Older analyses wrote self-check questions, answers included, at the end of the notes. */
const LEGACY_SELF_CHECK = /^#{3,4} .*(자기 ?점검|자가 ?점검|스스로 (확인|점검|적용)|이해 점검|적용 확인|self-check)/im;

function NotesBody({ notes }: { notes: string }) {
  const m = LEGACY_SELF_CHECK.exec(notes);
  if (!m) return <Markdown>{notes}</Markdown>;
  // the self-check block runs until the next heading of the same or higher level
  const level = m[0].match(/^#+/)![0].length;
  const rest = notes.slice(m.index + m[0].length);
  const next = rest.search(new RegExp(`^#{3,${level}} `, "m"));
  const end = next < 0 ? notes.length : m.index + m[0].length + next;
  return (
    <>
      <Markdown>{notes.slice(0, m.index)}</Markdown>
      <details className="group mt-4 rounded-xl border border-border bg-surface-2/50">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-[13.5px] font-semibold [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-4 text-muted transition-transform group-open:rotate-90" />
          자기 점검 <span className="font-normal text-muted">· 먼저 스스로 답해 본 뒤 펼치세요</span>
        </summary>
        <div className="border-t border-border px-4 pt-2 pb-4">
          <Markdown>{notes.slice(m.index, end)}</Markdown>
        </div>
      </details>
      {end < notes.length ? <Markdown className="mt-4">{notes.slice(end)}</Markdown> : null}
    </>
  );
}

/** Answer first, then compare: retrieving the idea is what makes it stick. */
function SelfCheckList({ items }: { items: SelfCheck[] }) {
  return (
    <div className="mt-5 rounded-xl border border-border bg-surface-2/50 p-4">
      <div className="mb-3 flex items-center gap-1.5 text-[12.5px] font-semibold text-text">
        <PenLine className="size-3.5 text-accent" /> 자기 점검 <span className="font-normal text-muted">· 답을 먼저 써 본 뒤 확인하세요</span>
      </div>
      <ol className="space-y-4">
        {items.map((x, i) => (
          <SelfCheckItem key={i} n={i + 1} item={x} />
        ))}
      </ol>
    </div>
  );
}

function SelfCheckItem({ n, item }: { n: number; item: SelfCheck }) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  return (
    <li>
      <div className="flex gap-2 text-[14.5px] leading-relaxed font-medium">
        <span className="text-accent tabular-nums">{n}.</span>
        <Markdown className="min-w-0 flex-1 [&_p]:font-medium">{item.question}</Markdown>
      </div>
      <div className="mt-2 pl-5">
        {open ? (
          <div className="space-y-2">
            {draft.trim() ? <p className="rounded-lg bg-surface px-3 py-2 text-[13.5px] whitespace-pre-wrap text-muted">내 답: {draft}</p> : null}
            <div className="rounded-lg border-l-2 border-accent bg-surface px-3 py-2">
              <Markdown className="text-[14px]">{item.answer}</Markdown>
              <TimeChip time={item.time}>관련 장면</TimeChip>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <Textarea rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="내 답을 적어 보세요" className="min-h-0 flex-1 text-[13.5px]" />
            <Button size="sm" variant="soft" onClick={() => setOpen(true)} className="shrink-0">
              <Eye className="size-3.5" /> 답 확인
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

export function NotesTab({ analysis, scroller }: { lecture: Lecture; analysis: Analysis; scroller: React.RefObject<HTMLDivElement | null> }) {
  const second = usePlayerSecond();
  const chapters = analysis.overview.chapters;
  const grouped = useMemo(
    () =>
      chapters.map((c) => ({
        chapter: c,
        sections: analysis.sections.filter((s) => s.start >= c.start - 1 && s.start < c.end - 1),
      })),
    [chapters, analysis.sections],
  );
  const orphans = analysis.sections.filter((s) => !grouped.some((g) => g.sections.includes(s)));
  const activeSection = analysis.sections.find((s) => second >= s.start && second < s.end)?.index;

  const jumpToCurrent = () => {
    if (activeSection === undefined) return;
    document.getElementById(`sec-${activeSection}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const timeOf = useCallback((node: Node) => {
    const el = (node instanceof HTMLElement ? node : node.parentElement)?.closest<HTMLElement>("[data-start]");
    return el ? Number(el.dataset.start) : null;
  }, []);

  const renderSection = (s: Analysis["sections"][number]) => (
    <article
      key={s.index}
      id={`sec-${s.index}`}
      data-start={s.start}
      className={cn("scroll-mt-4 rounded-2xl border bg-surface p-5 transition-colors sm:p-6", activeSection === s.index ? "border-accent/40 shadow-soft" : "border-border")}
    >
      <header className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1">
        <TimeChip time={s.start}>
          {player.fmt(s.start)}–{player.fmt(player.state.unit === "page" ? Math.max(s.start, s.end - 1) : s.end)}
        </TimeChip>
        <h4 className="text-[16.5px] font-semibold tracking-tight">{s.title}</h4>
        {activeSection === s.index ? <span className="ml-auto text-[11.5px] font-medium text-accent">지금 보는 부분</span> : null}
      </header>
      <NotesBody notes={s.notes} />
      {s.selfCheck?.length ? <SelfCheckList items={s.selfCheck} /> : null}
      {s.keyPoints.length ? (
        <div className="mt-5 rounded-xl bg-accent-soft p-4">
          <div className="mb-2 flex items-center gap-1.5 text-[12.5px] font-semibold text-accent">
            <Sparkle className="size-3.5 fill-current" /> 핵심 정리
          </div>
          <ul className="space-y-1.5">
            {s.keyPoints.map((k, i) => (
              <li key={i} className="flex gap-2 text-[14px] leading-relaxed">
                <TimeChip time={k.time} className="shrink-0" />
                <span>{k.point}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  );

  return (
    <div className="mx-auto max-w-[760px] px-1 pb-16">
      <div className="no-print sticky top-0 z-10 -mx-1 mb-5 flex items-center gap-2 bg-bg/85 px-1 py-2 backdrop-blur">
        <Menu
          align="start"
          trigger={
            <Button size="sm" variant="secondary">
              <FileText className="size-3.5" /> 목차
            </Button>
          }
        >
          <div className="max-h-[60vh] overflow-y-auto">
            {analysis.sections.map((s) => (
              <MenuItem key={s.index} onSelect={() => document.getElementById(`sec-${s.index}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                <span className="w-11 shrink-0 text-xs text-faint tabular-nums">{player.fmt(s.start)}</span>
                <span className="truncate">{s.title}</span>
              </MenuItem>
            ))}
          </div>
        </Menu>
        <Tooltip content="재생 중인 부분으로">
          <Button size="sm" variant="ghost" onClick={jumpToCurrent} disabled={activeSection === undefined}>
            <Crosshair className="size-3.5" /> 현재 위치
          </Button>
        </Tooltip>
      </div>

      <div className="space-y-10">
        {grouped.map(({ chapter, sections }, ci) =>
          sections.length ? (
            <section key={ci}>
              <div className="mb-4 px-1">
                <div className="text-[12px] font-semibold tracking-wide text-accent">CHAPTER {ci + 1}</div>
                <h3 className="mt-1 font-serif text-[22px] leading-snug font-semibold tracking-tight">{chapter.title}</h3>
                <p className="mt-1.5 text-[14px] leading-relaxed text-muted">{chapter.summary}</p>
              </div>
              <div className="space-y-4">{sections.map(renderSection)}</div>
            </section>
          ) : null,
        )}
        {orphans.length ? <div className="space-y-4">{orphans.map(renderSection)}</div> : null}
      </div>
      <SelectionActions container={scroller} timeOf={timeOf} />
    </div>
  );
}
