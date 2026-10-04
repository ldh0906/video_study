import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  BookOpen,
  ClipboardCheck,
  Download,
  FileText,
  Layers,
  LayoutList,
  MessageCircle,
  MoreHorizontal,
  Network,
  NotebookPen,
  RefreshCcw,
  Settings2,
  Sparkles,
  Trash2,
  Captions,
} from "lucide-react";
import { toast } from "sonner";
import { fmtTime } from "@shared/time";
import type { Lecture, ModelChoice } from "@shared/types";
import { ThemeMenu, useOpenSettings } from "@/App";
import { ModelPicker } from "@/components/ModelPicker";
import { Button, Dialog, Label, Menu, MenuItem, MenuSeparator, Segmented, Spinner, Tooltip } from "@/components/ui";
import { ChapterStrip, Player } from "@/features/Player";
import { ProcessingPanel } from "@/features/ProcessingPanel";
import { StudyContext, type StudyContextValue, type TabId } from "@/features/study-context";
import { TranscriptPanel } from "@/features/TranscriptPanel";
import { CardEditor, useCards } from "@/features/tabs/CardsTab";
import { CardsTab } from "@/features/tabs/CardsTab";
import { ChatTab } from "@/features/tabs/ChatTab";
import { MaterialsTab } from "@/features/tabs/MaterialsTab";
import { MemoTab } from "@/features/tabs/MemoTab";
import { MindmapTab } from "@/features/tabs/MindmapTab";
import { NotesTab } from "@/features/tabs/NotesTab";
import { OverviewTab } from "@/features/tabs/OverviewTab";
import { QuizTab } from "@/features/tabs/QuizTab";
import { api } from "@/lib/api";
import { player } from "@/lib/player";
import { cn } from "@/lib/utils";

const TABS: { id: TabId; label: string; icon: ReactNode }[] = [
  { id: "overview", label: "개요", icon: <BookOpen /> },
  { id: "notes", label: "노트", icon: <FileText /> },
  { id: "chat", label: "튜터", icon: <MessageCircle /> },
  { id: "cards", label: "카드", icon: <Layers /> },
  { id: "quiz", label: "퀴즈", icon: <ClipboardCheck /> },
  { id: "mindmap", label: "마인드맵", icon: <Network /> },
  { id: "materials", label: "자료실", icon: <Sparkles /> },
  { id: "memo", label: "메모", icon: <NotebookPen /> },
];

function useIsWide() {
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 1024px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

export function LectureView() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const openSettings = useOpenSettings();
  const wide = useIsWide();

  const { data: lecture, error } = useQuery({
    queryKey: ["lecture", id],
    queryFn: () => api.lecture(id),
    refetchInterval: (q) => (q.state.data?.busy || q.state.data?.status === "processing" || q.state.data?.status === "queued" ? 1500 : false),
  });
  const transcribed = lecture?.steps.find((s) => s.id === "transcribe")?.status === "done";
  const framesReady = lecture?.steps.find((s) => s.id === "frames")?.status === "done";
  const { data: transcript } = useQuery({ queryKey: ["transcript", id, transcribed], queryFn: () => api.transcript(id), enabled: !!lecture && transcribed });
  const { data: analysis } = useQuery({ queryKey: ["analysis", id, lecture?.analyzed], queryFn: () => api.analysis(id), enabled: !!lecture?.analyzed });
  const { data: frames = [] } = useQuery({ queryKey: ["frames", id, framesReady], queryFn: () => api.frames(id), enabled: !!lecture && framesReady });
  const { data: cards = [] } = useCards(id);
  const due = cards.filter((c) => c.due <= Date.now()).length;

  const [tab, setTabState] = useState<TabId>(() => (localStorage.getItem(`tab:${id}`) as TabId) || "overview");
  const setTab = useCallback(
    (t: TabId) => {
      setTabState(t);
      try {
        localStorage.setItem(`tab:${id}`, t);
      } catch {}
    },
    [id],
  );
  const [pendingAsk, setPendingAsk] = useState<{ text: string; anchor: number | null } | null>(null);
  const [memoAppend, setMemoAppend] = useState<{ text: string; time: number | null; n: number } | null>(null);
  const [cardDraft, setCardDraft] = useState<{ front: string; back: string; time: number | null } | null>(null);
  const [reprocessOpen, setReprocessOpen] = useState(false);
  const tabScroller = useRef<HTMLDivElement>(null);

  // stopping playback when leaving the page
  useEffect(() => () => player.media?.pause(), []);

  useEffect(() => {
    if (lecture?.status === "ready") {
      qc.invalidateQueries({ queryKey: ["flashcards", id] });
      qc.invalidateQueries({ queryKey: ["quizzes", id] });
    }
  }, [lecture?.status, id, qc]);

  useEffect(() => {
    tabScroller.current?.scrollTo({ top: 0 });
  }, [tab]);

  const ctx: StudyContextValue | null = useMemo(
    () =>
      lecture
        ? {
            lecture,
            analysis: analysis ?? null,
            tab,
            setTab,
            ask: (text, anchor = null) => {
              setPendingAsk({ text, anchor });
              setTab("chat");
            },
            addToMemo: (text, time = null) => {
              setMemoAppend((m) => ({ text, time, n: (m?.n ?? 0) + 1 }));
              setTab("memo");
              toast.success("메모에 추가했습니다");
            },
            makeCard: (front, back = "", time = null) => setCardDraft({ front, back, time }),
          }
        : null,
    [lecture, analysis, tab, setTab],
  );

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <p className="text-muted">{(error as Error).message}</p>
        <Button onClick={() => navigate("/")}>라이브러리로</Button>
      </div>
    );
  }
  if (!lecture || !ctx) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  }

  const ready = lecture.analyzed && !!analysis;
  const chapters = analysis?.overview.chapters ?? [];
  const hasMedia = Boolean(lecture.mediaPath);

  const left = (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {hasMedia ? (
        <Player lecture={lecture} chapters={chapters} frames={frames} onAsk={(t) => ctx.ask(`지금 보고 있는 [${fmtTime(t)}] 장면에서 설명하는 내용을 풀어서 설명해 줘`, t)} />
      ) : (
        <div className="flex aspect-video items-center justify-center rounded-2xl border border-border bg-surface-2 text-sm text-muted">
          <Spinner className="mr-2" /> 영상을 준비하는 중…
        </div>
      )}
      <ChapterStrip chapters={chapters} />
      {wide ? (
        <div className="min-h-0 flex-1 rounded-2xl border border-border bg-surface p-2 pt-3">
          <TranscriptPanel transcript={transcript} loading={!transcribed} />
        </div>
      ) : null}
    </div>
  );

  const tabs = wide ? TABS : [...TABS.slice(0, 2), { id: "transcript" as TabId, label: "대본", icon: <LayoutList /> }, ...TABS.slice(2)];

  const right = !ready ? (
    <div className="h-full overflow-y-auto">
      <ProcessingPanel lecture={lecture} busy={!!(lecture as Lecture & { busy?: boolean }).busy} />
    </div>
  ) : (
    <div className="flex h-full min-h-0 flex-col">
      <nav className="no-scrollbar mb-3 flex shrink-0 gap-0.5 overflow-x-auto rounded-[14px] border border-border bg-surface p-1 shadow-soft [scrollbar-width:none]">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "relative flex shrink-0 items-center gap-1.5 rounded-[10px] px-3 py-2 text-[13px] font-medium transition-all [&>svg]:size-4",
              tab === t.id ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-text",
            )}
          >
            {t.icon}
            {t.label}
            {t.id === "cards" && due > 0 ? <span className="rounded-full bg-accent px-1.5 text-[10.5px] leading-[17px] font-bold text-accent-fg tabular-nums">{due}</span> : null}
          </button>
        ))}
      </nav>
      <div ref={tabScroller} className={cn("min-h-0 flex-1", tab === "chat" || tab === "mindmap" || tab === "memo" || tab === "transcript" ? "overflow-hidden" : "overflow-y-auto")}>
        {tab === "overview" && <OverviewTab lecture={lecture} analysis={analysis} />}
        {tab === "notes" && <NotesTab lecture={lecture} analysis={analysis} scroller={tabScroller} />}
        {tab === "chat" && <ChatTab lecture={lecture} pending={pendingAsk} onPendingConsumed={() => setPendingAsk(null)} />}
        {tab === "cards" && <CardsTab lecture={lecture} />}
        {tab === "quiz" && <QuizTab lecture={lecture} />}
        {tab === "mindmap" && <MindmapTab analysis={analysis} />}
        {tab === "materials" && <MaterialsTab lecture={lecture} />}
        {tab === "memo" && <MemoTab lecture={lecture} appendRequest={memoAppend} />}
        {tab === "transcript" && <TranscriptPanel transcript={transcript} />}
      </div>
    </div>
  );

  return (
    <StudyContext.Provider value={ctx}>
      <div className="flex h-full flex-col">
        <LectureHeader lecture={lecture} onReprocess={() => setReprocessOpen(true)} onSettings={() => openSettings()} />
        {wide ? (
          <SplitPane left={left} right={right} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3 px-3 pb-3">
            <div className="shrink-0">{left}</div>
            <div className="min-h-0 flex-1">{right}</div>
          </div>
        )}
      </div>
      <CardEditor lecture={lecture} card={cardDraft} onClose={() => setCardDraft(null)} />
      <ReprocessDialog lecture={lecture} open={reprocessOpen} onOpenChange={setReprocessOpen} />
    </StudyContext.Provider>
  );
}

function SplitPane({ left, right }: { left: ReactNode; right: ReactNode }) {
  const [ratio, setRatio] = useState(() => Number(localStorage.getItem("split") ?? 0.52) || 0.52);
  const container = useRef<HTMLDivElement>(null);
  const drag = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = container.current;
    if (!el) return;
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      setRatio(Math.min(0.7, Math.max(0.3, (ev.clientX - r.left) / r.width)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      setRatio((v) => {
        try {
          localStorage.setItem("split", String(v));
        } catch {}
        return v;
      });
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div ref={container} className="flex min-h-0 flex-1 px-5 pb-5">
      <div style={{ width: `${ratio * 100}%` }} className="min-w-0">
        {left}
      </div>
      <div onPointerDown={drag} className="group flex w-5 shrink-0 cursor-col-resize items-center justify-center" role="separator" aria-orientation="vertical">
        <div className="h-12 w-1 rounded-full bg-border transition-colors group-hover:bg-accent" />
      </div>
      <div className="min-w-0 flex-1">{right}</div>
    </div>
  );
}

function LectureHeader({ lecture, onReprocess, onSettings }: { lecture: Lecture; onReprocess: () => void; onSettings: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(lecture.title);
  useEffect(() => setTitle(lecture.title), [lecture.title]);

  const saveTitle = async () => {
    setEditing(false);
    if (title.trim() && title.trim() !== lecture.title) {
      await api.updateLecture(lecture.id, { title: title.trim() });
      qc.invalidateQueries({ queryKey: ["lecture", lecture.id] });
    }
  };

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 px-3 sm:px-5">
      <Tooltip content="라이브러리">
        <Link to="/" className="flex size-9 items-center justify-center rounded-[10px] text-muted transition-colors hover:bg-surface-2 hover:text-text" aria-label="라이브러리">
          <ArrowLeft className="size-[18px]" />
        </Link>
      </Tooltip>
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveTitle();
              if (e.key === "Escape") {
                setTitle(lecture.title);
                setEditing(false);
              }
            }}
            className="w-full rounded-lg border border-accent bg-surface px-2 py-1 text-[15px] font-semibold outline-none"
          />
        ) : (
          <button onClick={() => setEditing(true)} className="max-w-full truncate rounded-lg px-2 py-1 text-left text-[15px] font-semibold tracking-tight hover:bg-surface-2" title="제목 바꾸기">
            {lecture.title}
          </button>
        )}
      </div>
      <ThemeMenu />
      <Menu
        trigger={
          <Button variant="ghost" size="icon" aria-label="더보기">
            <MoreHorizontal className="size-[18px]" />
          </Button>
        }
      >
        {lecture.analyzed ? (
          <>
            <MenuItem icon={<Download />} onSelect={() => window.open(api.exportUrl(lecture.id, "md"))}>
              학습 노트 내보내기 (.md)
            </MenuItem>
            <MenuItem icon={<Layers />} onSelect={() => window.open(api.exportUrl(lecture.id, "anki"))}>
              플래시카드 내보내기 (Anki)
            </MenuItem>
            <MenuSeparator />
          </>
        ) : null}
        <MenuItem icon={<RefreshCcw />} onSelect={onReprocess}>
          다시 분석하기…
        </MenuItem>
        <MenuItem icon={<Settings2 />} onSelect={onSettings}>
          설정
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          danger
          icon={<Trash2 />}
          onSelect={async () => {
            if (!confirm("이 강의와 모든 학습 기록을 삭제할까요?")) return;
            await api.deleteLecture(lecture.id);
            qc.invalidateQueries({ queryKey: ["lectures"] });
            navigate("/");
          }}
        >
          강의 삭제
        </MenuItem>
      </Menu>
    </header>
  );
}

function ReprocessDialog({ lecture, open, onOpenChange }: { lecture: Lecture; open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const [from, setFrom] = useState<"analysis" | "transcript">("analysis");
  const [model, setModel] = useState<ModelChoice>(lecture.options.analysis);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setModel(lecture.options.analysis);
  }, [open, lecture.options.analysis]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="다시 분석하기"
      description="노트·퀴즈·카드가 새로 만들어집니다. 내 메모와 대화는 유지돼요."
      footer={
        <Button
          variant="primary"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.reprocess(lecture.id, from, { analysis: model });
              qc.invalidateQueries({ queryKey: ["lecture", lecture.id] });
              onOpenChange(false);
            } catch (e) {
              toast.error((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <RefreshCcw className="size-3.5" /> 시작
        </Button>
      }
    >
      <div className="space-y-5">
        <div>
          <Label>범위</Label>
          <Segmented
            value={from}
            onChange={setFrom}
            options={[
              { value: "analysis", label: <span className="flex items-center gap-1.5"><Sparkles className="size-3.5" />분석만 다시</span> },
              { value: "transcript", label: <span className="flex items-center gap-1.5"><Captions className="size-3.5" />받아쓰기부터 다시</span> },
            ]}
          />
          <p className="mt-2 text-xs text-muted">
            {from === "analysis" ? "기존 대본으로 다른 모델·추론 강도를 써서 다시 분석합니다." : "현재 설정의 받아쓰기 엔진으로 대본부터 새로 만듭니다."}
          </p>
        </div>
        <div>
          <Label>분석 모델</Label>
          <ModelPicker value={model} onChange={setModel} />
        </div>
      </div>
    </Dialog>
  );
}
