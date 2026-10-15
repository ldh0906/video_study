import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { Check, Expand, MoreHorizontal, RefreshCcw, Shrink, Sparkles, Trash2, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { unitOf } from "@shared/anchor";
import { studyPageDocument } from "@shared/studypage";
import type { Analysis, Lecture, StudyPage } from "@shared/types";
import { Button, Dialog, EmptyState, Menu, MenuItem, MenuSeparator, Spinner, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { player } from "@/lib/player";
import { cn } from "@/lib/utils";

function useDark() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const mo = new MutationObserver(() => setDark(document.documentElement.classList.contains("dark")));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  return dark;
}

/**
 * Interactive study pages: one explorable lesson per chapter, written by the
 * model from the chapter's notes and run in a sandboxed frame.
 */
export function ExploreTab({ lecture, analysis }: { lecture: Lecture; analysis: Analysis }) {
  const qc = useQueryClient();
  const chapters = analysis.overview.chapters;
  const { data: pages = [] } = useQuery({
    queryKey: ["studyPages", lecture.id],
    queryFn: () => api.studyPages(lecture.id),
    refetchInterval: (q) => (q.state.data?.some((p) => p.status === "generating") ? 2000 : false),
  });
  const byChapter = useMemo(() => new Map(pages.map((p) => [p.chapter, p])), [pages]);
  const [chapter, setChapter] = useState(() => Number(localStorage.getItem(`explore:${lecture.id}`)) || 0);
  const [asking, setAsking] = useState(false);
  const [request, setRequest] = useState("");
  const [full, setFull] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; correct: number } | null>(null);
  const page = byChapter.get(chapter);

  const choose = (i: number) => {
    setChapter(i);
    setProgress(null);
    try {
      localStorage.setItem(`explore:${lecture.id}`, String(i));
    } catch {}
  };

  const make = async (i: number, prompt = "") => {
    try {
      await api.createStudyPage(lecture.id, i, prompt);
      void qc.invalidateQueries({ queryKey: ["studyPages", lecture.id] });
      choose(i);
      toast.success("학습 페이지를 만들기 시작했어요", { description: "1~3분쯤 걸려요. 다른 탭을 보고 있어도 괜찮아요." });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const remove = async (p: StudyPage) => {
    await api.deleteStudyPage(lecture.id, p.id);
    void qc.invalidateQueries({ queryKey: ["studyPages", lecture.id] });
  };

  const missing = chapters.map((_, i) => i).filter((i) => !byChapter.has(i));

  return (
    <div className={cn("flex h-full min-h-0 flex-col", full && "fixed inset-0 z-50 bg-bg p-3 sm:p-5")}>
      <div className="mb-2 flex shrink-0 items-center gap-2">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto pb-1 [scrollbar-width:thin]">
          {chapters.map((c, i) => {
            const p = byChapter.get(i);
            return (
              <button
                key={i}
                onClick={() => choose(i)}
                title={c.title}
                className={cn(
                  "flex max-w-[220px] shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] font-medium transition-colors",
                  i === chapter ? "border-accent bg-accent-soft text-accent" : "border-border bg-surface text-muted hover:border-border-strong hover:text-text",
                )}
              >
                {p?.status === "generating" ? <Spinner className="size-3" /> : p?.status === "done" ? <Check className="size-3" /> : <span className="size-1.5 rounded-full bg-border-strong" />}
                <span className="truncate">
                  {i + 1}. {c.title}
                </span>
              </button>
            );
          })}
        </div>
        {page?.status === "done" ? (
          <>
            {progress ? (
              <span className="hidden shrink-0 text-[12px] text-muted tabular-nums sm:inline">
                연습 {progress.done}/{progress.total} · 정답 {progress.correct}
              </span>
            ) : null}
            <Button size="icon-sm" variant="ghost" aria-label={full ? "작게 보기" : "크게 보기"} onClick={() => setFull((v) => !v)}>
              {full ? <Shrink className="size-4" /> : <Expand className="size-4" />}
            </Button>
          </>
        ) : null}
        <Menu
          trigger={
            <Button size="icon-sm" variant="ghost" aria-label="학습 페이지 메뉴">
              <MoreHorizontal className="size-4" />
            </Button>
          }
        >
          <MenuItem icon={<Wand2 />} onSelect={() => setAsking(true)}>
            요청을 담아 {page ? "다시" : ""} 만들기…
          </MenuItem>
          {page && page.status !== "generating" ? (
            <MenuItem icon={<RefreshCcw />} onSelect={() => make(chapter)}>
              이 챕터 다시 만들기
            </MenuItem>
          ) : null}
          {missing.length > 1 ? (
            <MenuItem
              icon={<Sparkles />}
              onSelect={async () => {
                // two at a time on the server would be nicer; the CLI handles these one request each
                for (const i of missing) await api.createStudyPage(lecture.id, i).catch(() => {});
                void qc.invalidateQueries({ queryKey: ["studyPages", lecture.id] });
                toast.success(`${missing.length}개 챕터의 페이지를 만들기 시작했어요`);
              }}
            >
              남은 챕터 {missing.length}개 모두 만들기
            </MenuItem>
          ) : null}
          {page ? (
            <>
              <MenuSeparator />
              <MenuItem danger icon={<Trash2 />} onSelect={() => remove(page)}>
                이 페이지 삭제
              </MenuItem>
            </>
          ) : null}
        </Menu>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-border bg-bg">
        {/* keyed fade-in only: an exit transition here could leave the old view stuck when data arrives mid-animation */}
        <motion.div key={`${chapter}:${page?.id ?? "none"}:${page?.status}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }} className="absolute inset-0">
            {!page ? (
              <div className="flex h-full items-center justify-center p-6">
                <EmptyState
                  icon={<Sparkles />}
                  title={chapters[chapter]?.title ?? "학습 페이지"}
                  description="이 챕터를 직접 만져 보며 이해하는 페이지예요. 슬라이더로 바뀌는 그래프, 단계별 풀이, 빈칸 채우기, 즉석 퀴즈로 구성돼요."
                  action={
                    <Button variant="primary" onClick={() => make(chapter)}>
                      <Sparkles className="size-4" /> 학습 페이지 만들기
                    </Button>
                  }
                />
              </div>
            ) : page.status === "generating" ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                <Spinner className="size-6" />
                <div className="text-[15px] font-semibold">“{page.title}” 학습 페이지를 만드는 중</div>
                <p className="max-w-[360px] text-[13px] text-muted">노트를 바탕으로 예제·시뮬레이션·퀴즈를 설계하고 있어요{page.progress ? ` · ${Math.round(page.progress / 1000)}천 자 작성` : ""}.</p>
              </div>
            ) : page.status === "error" ? (
              <div className="flex h-full items-center justify-center p-6">
                <EmptyState
                  icon={<Sparkles />}
                  title="페이지를 만들지 못했어요"
                  description={page.error}
                  action={
                    <Button variant="primary" onClick={() => make(chapter, page.prompt)}>
                      <RefreshCcw className="size-4" /> 다시 시도
                    </Button>
                  }
                />
              </div>
            ) : (
              <StudyFrame page={page} lecture={lecture} onProgress={setProgress} />
            )}
        </motion.div>
      </div>

      <Dialog
        open={asking}
        onOpenChange={setAsking}
        title={`“${chapters[chapter]?.title ?? ""}” 학습 페이지 ${page ? "다시 " : ""}만들기`}
        description="원하는 방식을 적으면 반영해서 만들어요. 비워 두면 기본 구성으로 만듭니다."
        footer={
          <Button
            variant="primary"
            onClick={() => {
              setAsking(false);
              void make(chapter, request.trim());
            }}
          >
            <Sparkles className="size-4" /> 만들기
          </Button>
        }
      >
        <Textarea rows={4} value={request} onChange={(e) => setRequest(e.target.value)} placeholder="예) 그래프로 직관을 먼저 보여 주고, 계산 문제를 더 많이 넣어 줘 / 시험 직전에 보기 좋게 짧게" />
      </Dialog>
    </div>
  );
}

function StudyFrame({ page, lecture, onProgress }: { page: StudyPage; lecture: Lecture; onProgress: (p: { done: number; total: number; correct: number }) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const dark = useDark();
  const unit = unitOf(lecture);
  const { data: kit } = useQuery({ queryKey: ["kitBundle"], queryFn: api.kitBundle, staleTime: Infinity });
  // built once per page; theme changes go over postMessage so answers survive
  const srcDoc = useMemo(() => (kit ? studyPageDocument({ body: page.html, kit, dark: document.documentElement.classList.contains("dark"), unit }) : ""), [page.html, unit, kit]);

  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ lk: 1, type: "theme", dark }, "*");
  }, [dark]);

  useEffect(() => {
    const on = (e: MessageEvent) => {
      // the sandboxed frame has an opaque origin; trust only our own frame's messages, by source
      if (e.source !== frame.current?.contentWindow) return;
      const d = e.data as { lk?: number; type?: string; unit?: string; value?: number; done?: number; total?: number; correct?: number; message?: string };
      if (!d || d.lk !== 1) return;
      if (d.type === "seek" && typeof d.value === "number" && d.unit === unit) player.seek(d.value);
      else if (d.type === "progress" && typeof d.total === "number") onProgress({ done: d.done ?? 0, total: d.total, correct: d.correct ?? 0 });
      else if (d.type === "error") console.warn("[study page]", d.message);
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [unit, onProgress]);

  if (!kit) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  return <iframe ref={frame} title={page.title} sandbox="allow-scripts" srcDoc={srcDoc} className="size-full border-0" />;
}
