import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { AlertCircle, AudioLines, Layers, MoreHorizontal, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { fmtDuration } from "@shared/time";
import type { Lecture } from "@shared/types";
import { ImportPanel } from "@/components/ImportPanel";
import { Badge, Button, Input, Menu, MenuItem } from "@/components/ui";
import { api, type LectureSummary } from "@/lib/api";
import { cn, relativeDate } from "@/lib/utils";

const STATUS_LABEL: Record<Lecture["status"], string> = {
  queued: "대기 중",
  processing: "분석 중",
  ready: "완료",
  error: "오류",
  canceled: "취소됨",
  interrupted: "중단됨",
};

export function overallProgress(l: Lecture) {
  const weights: Record<string, number> = { fetch: 1, audio: 0.5, transcribe: 3, frames: 0.5, analyze: 4, synthesize: 1, materials: 1 };
  let total = 0;
  let done = 0;
  for (const s of l.steps) {
    const w = weights[s.id] ?? 1;
    total += w;
    done += w * (s.status === "done" || s.status === "skipped" ? 1 : s.status === "running" ? s.progress : 0);
  }
  return total ? done / total : 0;
}

function greeting() {
  const h = new Date().getHours();
  if (h < 6) return "늦은 밤에도 배우는 중이군요";
  if (h < 12) return "좋은 아침이에요";
  if (h < 18) return "오늘은 무엇을 배워볼까요?";
  return "오늘 하루도 수고했어요";
}

export function Library() {
  const qc = useQueryClient();
  const { data: lectures } = useQuery({
    queryKey: ["lectures"],
    queryFn: api.lectures,
    refetchInterval: (q) => (q.state.data?.some((l) => l.status === "processing" || l.status === "queued") ? 2000 : false),
  });
  const [q, setQ] = useState("");
  const filtered = useMemo(
    () => (lectures ?? []).filter((l) => !q || l.title.toLowerCase().includes(q.toLowerCase())),
    [lectures, q],
  );
  const due = (lectures ?? []).reduce((n, l) => n + l.cardsDue, 0);

  const del = useMutation({
    mutationFn: api.deleteLecture,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lectures"] });
      toast.success("강의를 삭제했습니다.");
    },
  });

  return (
    <div className="mx-auto w-full max-w-[1180px] px-4 pb-24 sm:px-8">
      <section className="mx-auto max-w-[760px] pt-10 pb-12 sm:pt-16">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }}>
          <p className="mb-3 text-center text-[13px] font-medium tracking-wide text-accent">{greeting()}</p>
          <h1 className="text-center font-serif text-[29px] leading-[1.3] font-semibold tracking-tight sm:text-[44px] sm:leading-[1.25]">
            긴 강의도, 어려운 강의도
            <br />
            <span className="text-muted">내 것이 될 때까지.</span>
          </h1>
          <p className="mx-auto mt-4 max-w-[520px] text-center text-[15px] leading-relaxed text-muted">
            영상이나 링크를 넣으면 받아쓰기부터 화면 분석, 노트·개념·퀴즈·플래시카드까지 공부에 필요한 모든 것을 만들어 드려요.
          </p>
        </motion.div>
        <motion.div className="mt-9" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, delay: 0.08, ease: [0.2, 0.8, 0.2, 1] }}>
          <ImportPanel />
        </motion.div>
      </section>

      {lectures && lectures.length > 0 ? (
        <section>
          <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="font-serif text-[22px] font-semibold tracking-tight">내 강의</h2>
              <p className="mt-0.5 text-[13px] text-muted">
                {lectures.length}개의 강의{due > 0 ? ` · 오늘 복습할 카드 ${due}장` : ""}
              </p>
            </div>
            {lectures.length > 3 ? (
              <div className="relative w-full sm:w-64">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="강의 검색" className="h-9 pl-9" />
              </div>
            ) : null}
          </div>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((l, i) => (
              <motion.div key={l.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.04, 0.3) }}>
                <LectureCard lecture={l} onDelete={() => confirm(`“${l.title}” 강의와 모든 학습 기록을 삭제할까요?`) && del.mutate(l.id)} />
              </motion.div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function LectureCard({ lecture: l, onDelete }: { lecture: LectureSummary; onDelete: () => void }) {
  const processing = l.status === "processing" || l.status === "queued";
  const running = l.steps.find((s) => s.status === "running");
  return (
    <Link
      to={`/lecture/${l.id}`}
      className="group block overflow-hidden rounded-2xl border border-border bg-surface shadow-soft transition-all duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-float"
    >
      <div className="relative aspect-video overflow-hidden bg-surface-2">
        {l.hasThumbnail ? (
          <img src={api.thumbUrl(l.id, l.updatedAt)} alt="" className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" loading="lazy" />
        ) : (
          <div className="flex size-full items-center justify-center bg-gradient-to-br from-accent-soft to-surface-2">
            <AudioLines className="size-10 text-accent/60" />
          </div>
        )}
        {l.durationSec ? (
          <span className="absolute right-2.5 bottom-2.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[11.5px] font-medium text-white tabular-nums backdrop-blur-sm">
            {fmtDuration(l.durationSec)}
          </span>
        ) : null}
        {processing ? (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/20">
            <div className="h-full bg-accent transition-[width] duration-700" style={{ width: `${overallProgress(l) * 100}%` }} />
          </div>
        ) : null}
        <div className="absolute top-2 right-2 opacity-0 transition-opacity group-hover:opacity-100" onClick={(e) => e.preventDefault()}>
          <Menu
            trigger={
              <Button size="icon-sm" variant="secondary" aria-label="더보기" className="bg-surface/90 backdrop-blur">
                <MoreHorizontal className="size-4" />
              </Button>
            }
          >
            <MenuItem danger icon={<Trash2 />} onSelect={onDelete}>
              삭제
            </MenuItem>
          </Menu>
        </div>
      </div>
      <div className="p-4">
        <h3 className="line-clamp-2 min-h-[2.6em] text-[15px] leading-snug font-semibold tracking-tight">{l.title}</h3>
        <div className="mt-3 flex items-center gap-2 text-xs text-muted">
          {processing ? (
            <>
              <span className="size-1.5 animate-pulse rounded-full bg-accent" />
              <span className="truncate">{running ? stepLabel(running.id) : STATUS_LABEL[l.status]}</span>
              <span className="ml-auto tabular-nums">{Math.round(overallProgress(l) * 100)}%</span>
            </>
          ) : l.status === "error" || l.status === "interrupted" || l.status === "canceled" ? (
            <Badge tone={l.status === "error" ? "danger" : "warning"}>
              <AlertCircle className="size-3" />
              {STATUS_LABEL[l.status]}
            </Badge>
          ) : (
            <>
              <span>{relativeDate(l.createdAt)}</span>
              {l.cardsTotal ? (
                <span className={cn("ml-auto flex items-center gap-1", l.cardsDue ? "font-medium text-accent" : "")}>
                  <Layers className="size-3.5" />
                  {l.cardsDue ? `복습 ${l.cardsDue}` : `카드 ${l.cardsTotal}`}
                </span>
              ) : null}
            </>
          )}
        </div>
      </div>
    </Link>
  );
}

export function stepLabel(id: string) {
  return (
    {
      fetch: "영상 가져오는 중",
      audio: "오디오 추출 중",
      transcribe: "받아쓰는 중",
      frames: "화면 캡처 중",
      analyze: "내용 분석 중",
      synthesize: "전체 구조 정리 중",
      materials: "학습 자료 만드는 중",
    } as Record<string, string>
  )[id];
}
