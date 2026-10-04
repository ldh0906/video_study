import { useCallback, useMemo } from "react";
import { Crosshair, Download, FileDown, FileText, Sparkle } from "lucide-react";
import { fmtTime } from "@shared/time";
import type { Analysis, Lecture } from "@shared/types";
import { Markdown, TimeChip } from "@/components/Markdown";
import { Button, Menu, MenuItem, Tooltip } from "@/components/ui";
import { api } from "@/lib/api";
import { usePlayerSecond } from "@/lib/player";
import { cn } from "@/lib/utils";
import { SelectionActions } from "../SelectionActions";
import { useStudy } from "../study-context";

export function NotesTab({ lecture, analysis, scroller }: { lecture: Lecture; analysis: Analysis; scroller: React.RefObject<HTMLDivElement | null> }) {
  const second = usePlayerSecond();
  const { openExport } = useStudy();
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
          {fmtTime(s.start)}–{fmtTime(s.end)}
        </TimeChip>
        <h4 className="text-[16.5px] font-semibold tracking-tight">{s.title}</h4>
        {activeSection === s.index ? <span className="ml-auto text-[11.5px] font-medium text-accent">지금 보는 부분</span> : null}
      </header>
      <Markdown>{s.notes}</Markdown>
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
                <span className="w-11 shrink-0 text-xs text-faint tabular-nums">{fmtTime(s.start)}</span>
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
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => window.open(api.exportUrl(lecture.id, "md"))}>
          <Download className="size-3.5" /> Markdown
        </Button>
        <Button size="sm" variant="soft" onClick={openExport}>
          <FileDown className="size-3.5" /> 학습서 PDF
        </Button>
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
