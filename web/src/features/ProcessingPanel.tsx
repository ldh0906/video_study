import { motion } from "motion/react";
import { AlertTriangle, AudioLines, Brain, Check, Download, Film, Layers, Mic, Pause, Play, RotateCcw, Settings2, Sparkles } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Lecture, StepId } from "@shared/types";
import { useOpenSettings } from "@/App";
import { Button, Progress } from "@/components/ui";
import { api } from "@/lib/api";
import { cn, formatTokens } from "@/lib/utils";
import { overallProgress } from "@/pages/Library";

const STEPS: Record<StepId, { label: string; icon: React.ReactNode; hint: string }> = {
  fetch: { label: "영상 준비", icon: <Download />, hint: "파일을 확인하거나 링크에서 영상을 내려받습니다" },
  audio: { label: "오디오 추출", icon: <AudioLines />, hint: "음성만 가볍게 뽑아냅니다" },
  transcribe: { label: "받아쓰기", icon: <Mic />, hint: "무음 구간에서 나눠 정확하게 받아씁니다" },
  frames: { label: "화면 캡처", icon: <Film />, hint: "슬라이드·판서가 바뀌는 장면을 찾습니다" },
  analyze: { label: "파트별 심층 분석", icon: <Brain />, hint: "노트, 개념, 어려운 부분, 카드를 만듭니다" },
  synthesize: { label: "전체 구조 정리", icon: <Sparkles />, hint: "챕터, 요약, 용어집, 마인드맵을 만듭니다" },
  materials: { label: "학습 자료", icon: <Layers />, hint: "플래시카드와 퀴즈를 준비합니다" },
};

function elapsed(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 ${s % 60}초`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

export function ProcessingPanel({ lecture, busy }: { lecture: Lecture; busy: boolean }) {
  const openSettings = useOpenSettings();
  const qc = useQueryClient();
  const progress = overallProgress(lecture);
  const failed = lecture.status === "error";
  const stopped = lecture.status === "canceled" || lecture.status === "interrupted";

  const act = async (fn: () => Promise<unknown>, msg?: string) => {
    try {
      await fn();
      if (msg) toast.success(msg);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      // polling stops while a lecture is idle, so kick it back on
      qc.invalidateQueries({ queryKey: ["lecture", lecture.id] });
    }
  };

  return (
    <div className="mx-auto w-full max-w-[520px] px-2 py-6">
      <div className="mb-7">
        <div className="mb-1 text-[13px] font-medium text-accent">
          {failed ? "문제가 생겼어요" : stopped ? "잠시 멈춤" : lecture.status === "queued" ? "차례를 기다리는 중" : "강의를 분석하고 있어요"}
        </div>
        <h2 className="font-serif text-[24px] leading-snug font-semibold tracking-tight">
          {failed ? "분석을 마치지 못했습니다" : stopped ? "이어서 분석할 수 있어요" : "공부할 준비를 하는 중…"}
        </h2>
        {!failed && !stopped ? (
          <div className="mt-4 flex items-center gap-3">
            <Progress value={progress} className="h-2 flex-1" />
            <span className="text-[13px] font-semibold text-muted tabular-nums">{Math.round(progress * 100)}%</span>
          </div>
        ) : null}
      </div>

      {failed && lecture.error ? (
        <div className="mb-6 rounded-2xl border border-danger/30 bg-danger-soft p-4">
          <div className="flex gap-3">
            <AlertTriangle className="mt-0.5 size-[18px] shrink-0 text-danger" />
            <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap text-text">{lecture.error}</p>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 pl-[30px]">
            <Button size="sm" variant="primary" onClick={() => act(() => api.resume(lecture.id))}>
              <RotateCcw className="size-3.5" /> 이어서 다시 시도
            </Button>
            <Button size="sm" onClick={() => openSettings()}>
              <Settings2 className="size-3.5" /> 설정 열기
            </Button>
          </div>
        </div>
      ) : null}

      <ol className="relative space-y-1">
        {lecture.steps.map((s, i) => {
          const meta = STEPS[s.id];
          const running = s.status === "running";
          const done = s.status === "done" || s.status === "skipped";
          return (
            <motion.li
              key={s.id}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.04 }}
              className={cn("relative flex gap-3.5 rounded-2xl px-3 py-3 transition-colors", running && "bg-surface shadow-soft")}
            >
              <div
                className={cn(
                  "relative z-10 flex size-9 shrink-0 items-center justify-center rounded-xl transition-colors [&>svg]:size-[18px]",
                  done ? "bg-success-soft text-success" : running ? "bg-accent text-accent-fg" : s.status === "error" ? "bg-danger-soft text-danger" : "bg-surface-2 text-faint",
                )}
              >
                {done ? <Check /> : meta.icon}
                {running ? <span className="absolute inset-0 animate-ping rounded-xl bg-accent opacity-20" /> : null}
              </div>
              <div className="min-w-0 flex-1 pt-0.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className={cn("text-[14px] font-medium", !done && !running && "text-muted")}>{meta.label}</span>
                  <span className="shrink-0 text-xs text-faint tabular-nums">
                    {s.status === "skipped"
                      ? s.detail ?? "건너뜀"
                      : done && s.startedAt && s.endedAt
                        ? `${s.detail ? `${s.detail} · ` : ""}${elapsed(s.endedAt - s.startedAt)}`
                        : done
                          ? s.detail ?? ""
                          : running && s.progress > 0
                            ? `${Math.round(s.progress * 100)}%`
                            : ""}
                  </span>
                </div>
                {running ? (
                  <>
                    <p className="mt-0.5 text-[12.5px] text-muted">{s.detail || meta.hint}</p>
                    <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-3">
                      {s.progress > 0 ? (
                        <div className="h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${s.progress * 100}%` }} />
                      ) : (
                        <div className="shimmer h-full w-full" />
                      )}
                    </div>
                  </>
                ) : null}
              </div>
            </motion.li>
          );
        })}
      </ol>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
        <div className="text-xs leading-relaxed text-faint">
          {lecture.options.analysis.model} · 추론 {lecture.options.analysis.effort}
          {lecture.usage.inputTokens ? ` · 토큰 ${formatTokens(lecture.usage.inputTokens)} 입력 / ${formatTokens(lecture.usage.outputTokens)} 출력` : ""}
        </div>
        {busy ? (
          <Button size="sm" variant="ghost" onClick={() => act(() => api.cancel(lecture.id), "분석을 멈췄습니다. 언제든 이어서 할 수 있어요.")}>
            <Pause className="size-3.5" /> 멈추기
          </Button>
        ) : stopped ? (
          <Button size="sm" variant="primary" onClick={() => act(() => api.resume(lecture.id))}>
            <Play className="size-3.5" /> 이어서 분석
          </Button>
        ) : null}
      </div>
      {!failed && !stopped ? (
        <p className="mt-4 rounded-xl bg-surface-2 px-3.5 py-3 text-[12.5px] leading-relaxed text-muted">
          창을 닫아도 분석은 계속됩니다. 받아쓰기가 끝나면 왼쪽에서 대본을 먼저 읽을 수 있고, 중간에 멈춰도 완료된 부분부터 이어서 진행해요.
        </p>
      ) : null}
    </div>
  );
}
