import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Blocks,
  BookOpen,
  Check,
  ChevronDown,
  ChevronUp,
  Hash,
  ClipboardCheck,
  Download,
  FileText,
  Layers,
  LayoutList,
  MessageCircle,
  MoreHorizontal,
  Network,
  NotebookPen,
  Pencil,
  RefreshCcw,
  Settings2,
  Sparkles,
  Trash2,
  Captions,
  FileDown,
  GraduationCap,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { fmtTime } from "@shared/time";
import { unitOf } from "@shared/anchor";
import { DOC_TYPE_INFO, DOC_TYPE_ORDER } from "@shared/doctypes";
import { dueToday } from "@shared/review";
import type { Lecture, ModelChoice } from "@shared/types";
import { ThemeMenu, useOpenSettings } from "@/App";
import { ModelPicker } from "@/components/ModelPicker";
import { NameDialog } from "@/components/NameDialog";
import { TagChip, TagEditor } from "@/components/TagEditor";
import { Button, Dialog, Label, Menu, MenuItem, MenuSeparator, Segmented, Spinner, Tooltip } from "@/components/ui";
import { Player } from "@/features/Player";
import { ProcessingPanel } from "@/features/ProcessingPanel";
import { StudyContext, type StudyContextValue, type TabId } from "@/features/study-context";
import { TranscriptPanel } from "@/features/TranscriptPanel";
import { ExportDialog } from "@/features/ExportDialog";
import { CardEditor, useCards } from "@/features/tabs/CardsTab";
import { CardsTab } from "@/features/tabs/CardsTab";
import { ChatTab } from "@/features/tabs/ChatTab";
import { ExploreTab } from "@/features/tabs/ExploreTab";
import { MaterialsTab } from "@/features/tabs/MaterialsTab";
import { MemoTab } from "@/features/tabs/MemoTab";
import { MindmapTab } from "@/features/tabs/MindmapTab";
import { NotesTab } from "@/features/tabs/NotesTab";
import { OverviewTab } from "@/features/tabs/OverviewTab";
import { QuizTab } from "@/features/tabs/QuizTab";
import { api } from "@/lib/api";
import { player } from "@/lib/player";
import { cn } from "@/lib/utils";

// pdf.js is large; only PDF items load it
const PdfViewer = lazy(() => import("@/features/PdfViewer").then((m) => ({ default: m.PdfViewer })));

interface TabGroup {
  id: string;
  label: string;
  icon: ReactNode;
  tabs: { id: TabId; label: string; icon: ReactNode }[];
}

/** Four destinations instead of eight tabs: views of the same job share a group. */
const GROUPS: TabGroup[] = [
  {
    id: "read",
    label: "읽기",
    icon: <BookOpen />,
    tabs: [
      { id: "overview", label: "개요", icon: <BookOpen /> },
      { id: "notes", label: "노트", icon: <FileText /> },
      { id: "explore", label: "인터랙티브", icon: <Blocks /> },
      { id: "mindmap", label: "마인드맵", icon: <Network /> },
    ],
  },
  {
    id: "practice",
    label: "연습",
    icon: <GraduationCap />,
    tabs: [
      { id: "cards", label: "카드", icon: <Layers /> },
      { id: "quiz", label: "퀴즈", icon: <ClipboardCheck /> },
    ],
  },
  { id: "chat", label: "튜터", icon: <MessageCircle />, tabs: [{ id: "chat", label: "튜터", icon: <MessageCircle /> }] },
  { id: "materials", label: "자료 만들기", icon: <Sparkles />, tabs: [{ id: "materials", label: "자료", icon: <Sparkles /> }] },
];
const TRANSCRIPT_GROUP: TabGroup = { id: "transcript", label: "대본", icon: <LayoutList />, tabs: [{ id: "transcript", label: "대본", icon: <LayoutList /> }] };

function loadFlag(key: string) {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function saveValue(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

/** Video layout: the left column's share of the width, and the video's share of that column's height. */
const DEFAULT_SPLIT = 0.52;
const DEFAULT_SHARE = 0.48;
const LARGE = { split: 0.68, share: 0.85 };
const clampSplit = (v: number) => Math.min(0.8, Math.max(0.25, v));
const clampShare = (v: number) => Math.min(0.85, Math.max(0.25, v));

function loadNumber(key: string, fallback: number, clamp: (v: number) => number) {
  try {
    const v = Number(localStorage.getItem(key));
    return v ? clamp(v) : fallback;
  } catch {
    return fallback;
  }
}

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
  const due = dueToday(cards);
  const isDoc = lecture?.kind === "doc";

  // anchors render as pages or times from the first paint, before a viewer mounts
  useLayoutEffect(() => {
    if (lecture) player.setUnit(unitOf(lecture));
  }, [lecture?.kind]);

  // memo is a panel that opens beside any view, so it is never "the" tab
  const [memoOpen, setMemoOpenState] = useState(() => loadFlag("memoOpen") || localStorage.getItem(`tab:${id}`) === "memo");
  const setMemoOpen = useCallback((v: boolean) => {
    setMemoOpenState(v);
    saveValue("memoOpen", v ? "1" : "0");
  }, []);
  const [tab, setTabState] = useState<TabId>(() => {
    const saved = localStorage.getItem(`tab:${id}`) as TabId | null;
    return saved && saved !== "memo" ? saved : "overview";
  });
  // the view each group was last left on, so switching groups comes back to it
  const [lastViewOf, setLastViewOf] = useState<Record<string, TabId>>({});
  const setTab = useCallback(
    (t: TabId) => {
      if (t === "memo") return setMemoOpen(true);
      setTabState(t);
      saveValue(`tab:${id}`, t);
      const g = [...GROUPS, TRANSCRIPT_GROUP].find((x) => x.tabs.some((v) => v.id === t));
      if (g) setLastViewOf((m) => ({ ...m, [g.id]: t }));
    },
    [id, setMemoOpen],
  );
  const [pendingAsk, setPendingAsk] = useState<{ text: string; anchor: number | null } | null>(null);
  const [memoAppend, setMemoAppend] = useState<{ text: string; time: number | null; n: number } | null>(null);
  const [cardDraft, setCardDraft] = useState<{ front: string; back: string; time: number | null } | null>(null);
  const [reprocessOpen, setReprocessOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const tabScroller = useRef<HTMLDivElement>(null);
  const leftColumn = useRef<HTMLDivElement>(null);
  const [split, setSplitState] = useState(() => loadNumber("split", DEFAULT_SPLIT, clampSplit));
  const [videoShare, setVideoShareState] = useState(() => loadNumber("videoShare", DEFAULT_SHARE, clampShare));
  // the transcript under the video can be put away; it stays reachable as a tab on the right
  const [transcriptShown, setTranscriptShownState] = useState(() => {
    try {
      return localStorage.getItem("transcriptShown") !== "0";
    } catch {
      return true;
    }
  });
  const setTranscriptShown = useCallback((v: boolean) => {
    setTranscriptShownState(v);
    saveValue("transcriptShown", v ? "1" : "0");
  }, []);
  const setSplit = useCallback((v: number) => {
    setSplitState(v);
    saveValue("split", String(v));
  }, []);
  const setVideoShare = useCallback((v: number) => {
    setVideoShareState(v);
    saveValue("videoShare", String(v));
  }, []);
  // the "large video" button remembers the layout it replaced
  const beforeLarge = useRef<{ split: number; share: number } | null>(null);
  const large = split >= LARGE.split - 0.02 && videoShare >= LARGE.share - 0.02;
  const toggleLarge = useCallback(() => {
    if (large) {
      const prev = beforeLarge.current ?? { split: DEFAULT_SPLIT, share: DEFAULT_SHARE };
      setSplit(prev.split);
      setVideoShare(prev.share);
    } else {
      beforeLarge.current = { split, share: videoShare };
      setSplit(LARGE.split);
      setVideoShare(LARGE.share);
    }
  }, [large, split, videoShare, setSplit, setVideoShare]);

  // stopping playback when leaving the page
  useEffect(() => () => player.media?.pause(), []);

  // ?t=123 (links printed in study-book PDFs, review cards) → jump there once the media or PDF is loaded
  const [searchParams] = useSearchParams();
  const startAt = Number(searchParams.get("t"));
  useEffect(() => {
    if (!startAt || !lecture?.mediaPath) return;
    let tries = 0;
    const t = setInterval(() => {
      const m = player.media;
      const pdfReady = isDoc && player.pagesReady && player.state.duration > 0;
      if (pdfReady || (m && m.readyState >= 1) || ++tries > 50) {
        clearInterval(t);
        // let the pages lay out before scrolling
        if (pdfReady) setTimeout(() => player.seek(startAt), 300);
        else if (m) player.seek(startAt, false);
      }
    }, 200);
    return () => clearInterval(t);
  }, [startAt, lecture?.mediaPath, isDoc]);

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
              setMemoOpen(true);
              toast.success("메모에 추가했습니다");
            },
            makeCard: (front, back = "", time = null) => setCardDraft({ front, back, time }),
            openExport: () => setExportOpen(true),
          }
        : null,
    [lecture, analysis, tab, setTab, setMemoOpen],
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

  const left = isDoc ? (
    <Suspense fallback={<div className={cn("flex items-center justify-center rounded-2xl border border-border bg-surface-2", wide ? "h-full" : "h-[52vh]")}><Spinner /></div>}>
      <PdfViewer lecture={lecture} className={wide ? "h-full" : "h-[52vh]"} />
    </Suspense>
  ) : (
    // the column is a size container, so the video's width can follow a share of its height
    <div ref={leftColumn} className={cn("flex h-full min-h-0 flex-col", wide ? "[container-type:size]" : "gap-3")}>
      <div
        className="mx-auto w-full shrink-0"
        // without the transcript the video may use the whole column (minus the bar that brings the transcript back)
        style={{ maxWidth: wide ? (transcriptShown ? `calc(${videoShare * 100}cqh * 16 / 9)` : "calc((100cqh - 40px) * 16 / 9)") : "calc(48vh * 16 / 9)" }}
      >
        {hasMedia ? (
          <Player
            lecture={lecture}
            chapters={chapters}
            frames={frames}
            segments={transcript?.segments}
            onAsk={(t) => ctx.ask(`지금 보고 있는 [${fmtTime(t)}] 장면에서 설명하는 내용을 풀어서 설명해 줘`, t)}
            large={wide ? large : undefined}
            onToggleLarge={wide ? toggleLarge : undefined}
          />
        ) : (
          <div className="flex aspect-video items-center justify-center rounded-2xl border border-border bg-surface-2 text-sm text-muted">
            <Spinner className="mr-2" /> 영상을 준비하는 중…
          </div>
        )}
      </div>
      {wide && transcriptShown ? (
        <>
          <RowHandle column={leftColumn} share={videoShare} onShare={setVideoShare} onHide={() => setTranscriptShown(false)} />
          <div className="min-h-[96px] flex-1 rounded-2xl border border-border bg-surface p-2 pt-3">
            <TranscriptPanel transcript={transcript} chapters={chapters} loading={!transcribed} />
          </div>
        </>
      ) : wide ? (
        <div className="flex shrink-0 justify-center pt-2">
          <button
            onClick={() => {
              setTranscriptShown(true);
              if (tab === "transcript") setTab("overview");
            }}
            className="inline-flex h-7 items-center gap-1 rounded-full border border-border bg-surface px-3 text-[12px] font-medium text-muted shadow-soft transition-colors hover:border-accent hover:text-accent"
          >
            <ChevronDown className="size-3.5" /> 영상 아래에 대본 펼치기
          </button>
        </div>
      ) : null}
    </div>
  );

  // the transcript is a tab whenever it isn't under the video
  const groups = isDoc || (wide && transcriptShown) ? GROUPS : [GROUPS[0], TRANSCRIPT_GROUP, ...GROUPS.slice(1)];
  const group = groups.find((g) => g.tabs.some((t) => t.id === tab)) ?? groups[0];
  const view = group.tabs.some((t) => t.id === tab) ? tab : group.tabs[0].id;

  const memoPanel = (
    <div className="flex h-[42%] min-h-[180px] shrink-0 flex-col border-t border-border pt-3">
      <div className="mb-1 flex items-center gap-2 px-1">
        <NotebookPen className="size-4 text-accent" />
        <span className="text-[13px] font-semibold">내 메모</span>
        <div className="flex-1" />
        <Button variant="ghost" size="icon-sm" onClick={() => setMemoOpen(false)} aria-label="메모 닫기">
          <X className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <MemoTab lecture={lecture} appendRequest={memoAppend} />
      </div>
    </div>
  );

  const right = !ready ? (
    <div className="h-full overflow-y-auto">
      <ProcessingPanel lecture={lecture} busy={!!(lecture as Lecture & { busy?: boolean }).busy} />
    </div>
  ) : (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3 flex shrink-0 items-center gap-2">
        <nav role="tablist" aria-label="학습 메뉴" className="flex min-w-0 flex-1 gap-0.5 rounded-[14px] border border-border bg-surface p-1 shadow-soft">
          {groups.map((g) => {
            const selected = g === group;
            return (
              <button
                key={g.id}
                role="tab"
                aria-selected={selected}
                onClick={() => setTab(selected ? view : (g.tabs.find((t) => t.id === lastViewOf[g.id])?.id ?? g.tabs[0].id))}
                className={cn(
                  "relative flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[10px] px-2 py-2 text-[13px] font-medium whitespace-nowrap transition-all [&>svg]:size-4 [&>svg]:shrink-0",
                  selected ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-text",
                )}
              >
                {g.icon}
                <span className="truncate">{g.label}</span>
                {g.id === "practice" && due > 0 ? <span className="rounded-full bg-accent px-1.5 text-[10.5px] leading-[17px] font-bold text-accent-fg tabular-nums">{due}</span> : null}
              </button>
            );
          })}
        </nav>
        <Tooltip content={memoOpen ? "메모 닫기" : "메모 열기"}>
          <Button variant={memoOpen ? "soft" : "secondary"} size="icon" aria-pressed={memoOpen} aria-label="내 메모" onClick={() => setMemoOpen(!memoOpen)} className="h-[42px] w-[42px] shrink-0 rounded-[14px]">
            <NotebookPen className="size-[18px]" />
          </Button>
        </Tooltip>
      </div>
      {group.tabs.length > 1 ? (
        <div className="mb-3 shrink-0">
          <Segmented
            size="sm"
            value={view}
            onChange={(t) => setTab(t as TabId)}
            options={group.tabs.map((t) => ({ value: t.id, label: <span className="flex items-center gap-1.5 [&>svg]:size-3.5">{t.icon}{t.label}{t.id === "cards" && due > 0 ? ` ${due}` : ""}</span> }))}
          />
        </div>
      ) : null}
      <div
        ref={tabScroller}
        role="tabpanel"
        className={cn("min-h-0 flex-1", view === "chat" || view === "mindmap" || view === "transcript" || view === "explore" ? "overflow-hidden" : "overflow-y-auto")}
      >
        {view === "overview" && <OverviewTab lecture={lecture} analysis={analysis} />}
        {view === "notes" && <NotesTab lecture={lecture} analysis={analysis} scroller={tabScroller} />}
        {view === "explore" && <ExploreTab lecture={lecture} analysis={analysis} />}
        {view === "chat" && <ChatTab lecture={lecture} pending={pendingAsk} onPendingConsumed={() => setPendingAsk(null)} />}
        {view === "cards" && <CardsTab lecture={lecture} />}
        {view === "quiz" && <QuizTab lecture={lecture} />}
        {view === "mindmap" && <MindmapTab analysis={analysis} />}
        {view === "materials" && <MaterialsTab lecture={lecture} />}
        {view === "transcript" && <TranscriptPanel transcript={transcript} chapters={chapters} />}
      </div>
      {memoOpen ? memoPanel : null}
    </div>
  );

  return (
    <StudyContext.Provider value={ctx}>
      <div className="flex h-full flex-col">
        <LectureHeader lecture={lecture} onReprocess={() => setReprocessOpen(true)} onSettings={() => openSettings()} onExport={() => setExportOpen(true)} />
        {wide ? (
          <SplitPane left={left} right={right} ratio={split} onRatio={setSplit} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3 px-3 pb-3">
            <div className="shrink-0">{left}</div>
            <div className="min-h-0 flex-1">{right}</div>
          </div>
        )}
      </div>
      <CardEditor lecture={lecture} card={cardDraft} onClose={() => setCardDraft(null)} />
      <ReprocessDialog lecture={lecture} open={reprocessOpen} onOpenChange={setReprocessOpen} />
      {lecture.analyzed ? <ExportDialog lecture={lecture} open={exportOpen} onOpenChange={setExportOpen} /> : null}
    </StudyContext.Provider>
  );
}

/** Two columns with a draggable divider; `ratio` is the left column's share of the width. */
function SplitPane({ left, right, ratio, onRatio }: { left: ReactNode; right: ReactNode; ratio: number; onRatio: (v: number) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const drag = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = container.current;
    if (!el) return;
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      onRatio(clampSplit((ev.clientX - r.left) / r.width));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
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
      <div
        onPointerDown={drag}
        onDoubleClick={() => onRatio(DEFAULT_SPLIT)}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          onRatio(clampSplit(ratio + (e.key === "ArrowLeft" ? -0.02 : 0.02)));
        }}
        className="group flex w-5 shrink-0 cursor-col-resize items-center justify-center rounded-full outline-none"
        role="separator"
        aria-orientation="vertical"
        aria-label="영상과 학습 패널 너비 조절 (두 번 누르면 기본값)"
        aria-valuemin={25}
        aria-valuemax={80}
        aria-valuenow={Math.round(ratio * 100)}
      >
        <div className="h-12 w-1 rounded-full bg-border transition-colors group-hover:bg-accent group-focus-visible:bg-accent" />
      </div>
      <div className="min-w-0 flex-1">{right}</div>
    </div>
  );
}

/** Between the video and the transcript: drag to give the video more or less of the column's height. */
function RowHandle({ column, share, onShare, onHide }: { column: React.RefObject<HTMLDivElement | null>; share: number; onShare: (v: number) => void; onHide: () => void }) {
  const drag = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = column.current;
    if (!el) return;
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      onShare(clampShare((ev.clientY - r.top) / r.height));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "row-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div className="relative flex shrink-0 items-center">
      <div
        onPointerDown={drag}
        onDoubleClick={() => onShare(DEFAULT_SHARE)}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          e.preventDefault();
          onShare(clampShare(share + (e.key === "ArrowUp" ? -0.03 : 0.03)));
        }}
        className="group flex h-5 flex-1 cursor-row-resize items-center justify-center outline-none"
        role="separator"
        aria-orientation="horizontal"
        aria-label="영상 크기 조절 (두 번 누르면 기본값)"
        aria-valuemin={25}
        aria-valuemax={85}
        aria-valuenow={Math.round(share * 100)}
      >
        <div className="h-1 w-12 rounded-full bg-border transition-colors group-hover:bg-accent group-focus-visible:bg-accent" />
      </div>
      <button
        onClick={onHide}
        title="대본 숨기기 · 영상이 세로 공간을 모두 써요 (대본은 오른쪽 탭에서 볼 수 있어요)"
        className="absolute right-1 inline-flex h-5 items-center gap-0.5 rounded-md px-1.5 text-[11.5px] font-medium text-faint transition-colors hover:bg-surface-2 hover:text-text"
      >
        <ChevronUp className="size-3.5" /> 대본 숨기기
      </button>
    </div>
  );
}

function LectureHeader({ lecture, onReprocess, onSettings, onExport }: { lecture: Lecture; onReprocess: () => void; onSettings: () => void; onExport: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState(false);
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
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
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
          <button onClick={() => setEditing(true)} className="min-w-0 truncate rounded-lg px-2 py-1 text-left text-[15px] font-semibold tracking-tight hover:bg-surface-2" title="제목 바꾸기">
            {lecture.title}
          </button>
        )}
        {!editing ? <ItemLabels lecture={lecture} /> : null}
      </div>
      {lecture.analyzed ? (
        <Menu
          trigger={
            <Button size="sm" variant="soft">
              <FileDown className="size-3.5" /> <span className="hidden sm:inline">내보내기</span>
            </Button>
          }
        >
          <MenuItem icon={<FileDown />} onSelect={onExport}>
            학습서 PDF 만들기…
          </MenuItem>
          <MenuItem icon={<Download />} onSelect={() => window.open(api.exportUrl(lecture.id, "md"))}>
            학습 노트 (.md)
          </MenuItem>
          <MenuItem icon={<Layers />} onSelect={() => window.open(api.exportUrl(lecture.id, "anki"))}>
            플래시카드 (Anki)
          </MenuItem>
        </Menu>
      ) : null}
      <ThemeMenu />
      <Menu
        trigger={
          <Button variant="ghost" size="icon" aria-label="더보기">
            <MoreHorizontal className="size-[18px]" />
          </Button>
        }
      >
        <MenuItem icon={<Pencil />} onSelect={() => setRenaming(true)}>
          이름 바꾸기
        </MenuItem>
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
            if (!confirm(`이 ${lecture.kind === "doc" ? "자료" : "강의"}와 모든 학습 기록을 삭제할까요?`)) return;
            await api.deleteLecture(lecture.id);
            qc.invalidateQueries({ queryKey: ["lectures"] });
            navigate("/");
          }}
        >
          {lecture.kind === "doc" ? "자료 삭제" : "강의 삭제"}
        </MenuItem>
      </Menu>
      <NameDialog
        open={renaming}
        title="강의 이름 바꾸기"
        initial={lecture.title}
        placeholder="강의 이름"
        onClose={() => setRenaming(false)}
        onSubmit={async (name) => {
          await api.updateLecture(lecture.id, { title: name });
          qc.invalidateQueries({ queryKey: ["lecture", lecture.id] });
          qc.invalidateQueries({ queryKey: ["lectures"] });
        }}
      />
    </header>
  );
}

/** Document type and tags beside the title: both change with a click. */
function ItemLabels({ lecture }: { lecture: Lecture }) {
  const qc = useQueryClient();
  const { data: all = [] } = useQuery({ queryKey: ["lectures"], queryFn: api.lectures });
  const { data: analysis } = useQuery({ queryKey: ["analysis", lecture.id, lecture.analyzed], queryFn: () => api.analysis(lecture.id), enabled: lecture.analyzed });
  const allTags = useMemo(() => [...new Set(all.flatMap((l) => l.tags ?? []))].sort(), [all]);
  const tags = lecture.tags ?? [];
  const save = async (patch: Parameters<typeof api.updateLecture>[1]) => {
    await api.updateLecture(lecture.id, patch);
    void qc.invalidateQueries({ queryKey: ["lecture", lecture.id] });
    void qc.invalidateQueries({ queryKey: ["lectures"] });
  };
  const type = lecture.docType ? DOC_TYPE_INFO[lecture.docType] : null;
  return (
    <div className="hidden shrink-0 items-center gap-1 md:flex">
      {lecture.kind === "doc" ? (
        <Menu
          align="start"
          trigger={
            <button className="inline-flex h-6 items-center gap-1 rounded-full px-2 text-[12px] font-semibold text-white transition-opacity hover:opacity-90" style={{ background: type?.color ?? "#716d65" }}>
              {type?.label ?? "종류 미정"}
              <ChevronDown className="size-3" />
            </button>
          }
        >
          {DOC_TYPE_ORDER.map((t) => (
            <MenuItem key={t} icon={t === lecture.docType ? <Check /> : <span className="size-2.5 rounded-full" style={{ background: DOC_TYPE_INFO[t].color }} />} onSelect={() => save({ docType: t })}>
              {DOC_TYPE_INFO[t].label}
            </MenuItem>
          ))}
        </Menu>
      ) : null}
      {tags.slice(0, 3).map((t) => (
        <TagChip key={t} tag={t} />
      ))}
      <TagEditor
        tags={tags}
        allTags={allTags}
        suggested={analysis?.overview.tags ?? []}
        onChange={(next) => save({ tags: next })}
        trigger={
          <button className="inline-flex h-6 items-center gap-0.5 rounded-full border border-dashed border-border-strong px-2 text-[12px] font-medium text-muted transition-colors hover:border-accent hover:text-accent">
            <Hash className="size-3" />
            {tags.length > 3 ? `+${tags.length - 3}` : tags.length ? "편집" : "태그"}
          </button>
        }
      />
    </div>
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
      description={`노트·퀴즈·카드${lecture.kind === "doc" ? "·학습 페이지" : ""}가 새로 만들어집니다. 내 메모와 대화는 유지돼요.`}
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
              { value: "transcript", label: <span className="flex items-center gap-1.5"><Captions className="size-3.5" />{lecture.kind === "doc" ? "PDF 읽기부터 다시" : "받아쓰기부터 다시"}</span> },
            ]}
          />
          <p className="mt-2 text-xs text-muted">
            {from === "analysis"
              ? `기존 ${lecture.kind === "doc" ? "페이지 글자" : "대본"}로 다른 모델·추론 강도를 써서 다시 분석합니다.`
              : lecture.kind === "doc"
                ? "PDF의 글자와 그림 페이지를 처음부터 다시 읽습니다."
                : "현재 설정의 받아쓰기 엔진으로 대본부터 새로 만듭니다."}
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
