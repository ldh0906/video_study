import { useMemo, useState } from "react";
import { ChevronRight, Clock, Compass, GraduationCap, Lightbulb, Search, Target } from "lucide-react";
import { fmtDuration, fmtTime } from "@shared/time";
import type { Analysis, Lecture } from "@shared/types";
import { Markdown, TimeChip } from "@/components/Markdown";
import { Badge, Input } from "@/components/ui";
import { player, usePlayerSecond } from "@/lib/player";
import { cn, formatTokens } from "@/lib/utils";
import { useStudy } from "../study-context";

function Section({ icon, title, children, className }: { icon: React.ReactNode; title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("mt-9", className)}>
      <h3 className="mb-3.5 flex items-center gap-2 text-[13px] font-semibold tracking-wide text-muted uppercase [&>svg]:size-4 [&>svg]:text-accent">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

function Difficulty({ level }: { level: number }) {
  const labels = ["", "입문", "기초", "중급", "고급", "전문"];
  return (
    <span className="inline-flex items-center gap-1.5" title={`난이도 ${level}/5`}>
      <span className="flex gap-[3px]">
        {[1, 2, 3, 4, 5].map((i) => (
          <span key={i} className={cn("h-2.5 w-1.5 rounded-full", i <= level ? "bg-accent" : "bg-surface-3")} />
        ))}
      </span>
      {labels[level]}
    </span>
  );
}

export function OverviewTab({ lecture, analysis }: { lecture: Lecture; analysis: Analysis }) {
  const o = analysis.overview;
  const { ask } = useStudy();
  const second = usePlayerSecond();
  const [gq, setGq] = useState("");
  const [openTerm, setOpenTerm] = useState<string | null>(null);
  const difficult = useMemo(() => analysis.sections.flatMap((s) => s.difficult), [analysis]);
  const glossary = useMemo(
    () => o.glossary.filter((g) => !gq || `${g.term} ${g.definition}`.toLowerCase().includes(gq.toLowerCase())),
    [o.glossary, gq],
  );

  return (
    <div className="mx-auto max-w-[720px] px-1 pb-16">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12.5px] text-muted">
        <span className="flex items-center gap-1.5">
          <Clock className="size-3.5" />
          {fmtDuration(lecture.durationSec)}
        </span>
        <Difficulty level={o.difficulty} />
        <span>{o.chapters.length}개 챕터</span>
        {o.tags.map((t) => (
          <Badge key={t}>{t}</Badge>
        ))}
      </div>
      <h2 className="mt-4 font-serif text-[28px] leading-[1.3] font-semibold tracking-tight">{o.title}</h2>
      <p className="mt-2.5 text-[15.5px] leading-relaxed text-muted">{o.oneLiner}</p>

      <div className="mt-7 rounded-2xl border border-border bg-surface p-5 shadow-soft">
        <Markdown>{o.summary}</Markdown>
      </div>

      {o.objectives.length ? (
        <Section icon={<Target />} title="학습 목표">
          <ul className="space-y-2.5">
            {o.objectives.map((x, i) => (
              <li key={i} className="flex gap-3 text-[14.5px] leading-relaxed">
                <span className="mt-[3px] flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-bold text-accent">{i + 1}</span>
                <span>{x}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section icon={<Compass />} title="강의 흐름">
        <ol className="relative ml-[7px] border-l border-border">
          {o.chapters.map((c, i) => {
            const active = second >= c.start && second < c.end;
            return (
              <li key={i} className="relative pb-5 pl-6 last:pb-0">
                <span className={cn("absolute top-[7px] -left-[5px] size-[9px] rounded-full border-2 border-bg", active ? "bg-accent ring-4 ring-accent-soft" : "bg-border-strong")} />
                <button onClick={() => player.seek(c.start)} className="group text-left">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[12px] font-semibold text-accent tabular-nums">{fmtTime(c.start)}</span>
                    <span className="text-[15px] font-semibold group-hover:text-accent">{c.title}</span>
                  </div>
                  <p className="mt-1 text-[13.5px] leading-relaxed text-muted">{c.summary}</p>
                </button>
              </li>
            );
          })}
        </ol>
      </Section>

      {difficult.length ? (
        <Section icon={<Lightbulb />} title="막히기 쉬운 지점">
          <div className="space-y-3">
            {difficult.map((d, i) => (
              <details key={i} className="group rounded-2xl border border-border bg-surface open:shadow-soft">
                <summary className="flex cursor-pointer list-none items-start gap-3 p-4 [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="mt-0.5 size-4 shrink-0 text-faint transition-transform group-open:rotate-90" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[14.5px] font-semibold">{d.topic}</span>
                      <TimeChip time={d.time} />
                    </div>
                    <p className="mt-1 text-[13px] text-muted">{d.why}</p>
                  </div>
                </summary>
                <div className="border-t border-border px-4 pt-3 pb-4 pl-11">
                  <Markdown>{d.explanation}</Markdown>
                  <button onClick={() => ask(`“${d.topic}” 부분이 아직 헷갈려요. 다른 방식으로 한 번 더 설명해 주세요.`, d.time)} className="mt-3 text-[12.5px] font-medium text-accent hover:underline">
                    그래도 헷갈린다면 → 튜터에게 물어보기
                  </button>
                </div>
              </details>
            ))}
          </div>
        </Section>
      ) : null}

      {o.prerequisites.length ? (
        <Section icon={<GraduationCap />} title="미리 알면 좋은 것">
          <div className="grid gap-2.5 sm:grid-cols-2">
            {o.prerequisites.map((p, i) => (
              <button
                key={i}
                onClick={() => ask(`이 강의를 이해하는 데 필요한 선수 지식 “${p.topic}”을 핵심만 빠르게 정리해 주세요.`)}
                className="rounded-xl border border-border bg-surface p-3.5 text-left transition-colors hover:border-accent"
              >
                <div className="text-[13.5px] font-semibold">{p.topic}</div>
                <div className="mt-1 text-[12.5px] leading-relaxed text-muted">{p.why}</div>
              </button>
            ))}
          </div>
        </Section>
      ) : null}

      {o.glossary.length ? (
        <Section icon={<Search />} title={`용어집 · ${o.glossary.length}`}>
          {o.glossary.length > 8 ? <Input value={gq} onChange={(e) => setGq(e.target.value)} placeholder="용어 찾기" className="mb-3 h-9" /> : null}
          <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
            {glossary.map((g) => (
              <button key={g.term} onClick={() => setOpenTerm(openTerm === g.term ? null : g.term)} className="block w-full px-4 py-3 text-left hover:bg-surface-2/60">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[14px] font-semibold">{g.term}</span>
                  <span className="text-[11.5px] text-faint tabular-nums">{fmtTime(g.time)}</span>
                </div>
                <div className={cn("mt-1 text-[13.5px] leading-relaxed text-muted", openTerm !== g.term && "line-clamp-1")}>{g.definition}</div>
                {openTerm === g.term ? (
                  <div className="mt-2">
                    <TimeChip time={g.time}>처음 등장한 장면</TimeChip>
                  </div>
                ) : null}
              </button>
            ))}
          </div>
        </Section>
      ) : null}

      <p className="mt-12 text-center text-[11.5px] text-faint">
        {analysis.model} 로 분석 · 토큰 {formatTokens(lecture.usage.inputTokens)} 입력 / {formatTokens(lecture.usage.outputTokens)} 출력
      </p>
    </div>
  );
}
