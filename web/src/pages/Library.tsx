import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertCircle,
  AudioLines,
  Check,
  ChevronRight,
  ClipboardList,
  FileText,
  Folder as FolderIcon,
  FolderInput,
  FolderMinus,
  FolderPlus,
  GraduationCap,
  Hash,
  Layers,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Shapes,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { DOC_TYPE_INFO, DOC_TYPE_ORDER } from "@shared/doctypes";
import { fmtDuration } from "@shared/time";
import type { DocType, Exam, Folder, Lecture } from "@shared/types";
import { ImportPanel } from "@/components/ImportPanel";
import { NameDialog } from "@/components/NameDialog";
import { TagChip, TagEditor } from "@/components/TagEditor";
import { Badge, Button, Dialog, EmptyState, Input, Menu, MenuItem, MenuSeparator, MenuSub } from "@/components/ui";
import { ExamBuilder } from "@/features/ExamBuilder";
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

const SPRING = { type: "spring" as const, stiffness: 420, damping: 34 };

export function overallProgress(l: Lecture) {
  const weights: Record<string, number> = { fetch: 1, audio: 0.5, transcribe: 3, frames: 0.5, extract: 0.5, analyze: 4, synthesize: 1, materials: 1, pages: 2 };
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

/** "video" or a document type: what the kind filter sorts by */
type Kind = "video" | DocType;
const kindOf = (l: LectureSummary): Kind => (l.kind === "doc" ? (l.docType ?? "other") : "video");
const KIND_LABEL = (k: Kind) => (k === "video" ? "강의 영상" : DOC_TYPE_INFO[k].label);

type Naming = { kind: "lecture"; lecture: LectureSummary } | { kind: "new-folder"; moveIds?: string[] } | { kind: "folder"; folder: Folder };

/** Where a pointer drag currently hovers: a folder, the top level, or a card (for tags). */
type DropKey = `folder:${string}` | "root" | `card:${string}`;

function dropAt(x: number, y: number, ignore?: Element | null): DropKey | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (ignore && ignore.contains(el)) continue;
    const t = (el as HTMLElement).closest<HTMLElement>("[data-drop]");
    if (t && !(ignore && ignore.contains(t))) return t.dataset.drop as DropKey;
  }
  return null;
}

export function Library() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: lectures } = useQuery({
    queryKey: ["lectures"],
    queryFn: api.lectures,
    refetchInterval: (q) => (q.state.data?.some((l) => l.status === "processing" || l.status === "queued") ? 2000 : false),
  });
  const { data: folders = [] } = useQuery({ queryKey: ["folders"], queryFn: api.folders });
  const [params, setParams] = useSearchParams();
  const folder = folders.find((f) => f.id === params.get("folder"));
  const { data: exams = [] } = useQuery({
    queryKey: ["exams", folder?.id ?? null],
    queryFn: () => api.exams(folder?.id ?? null),
    refetchInterval: (q) => (q.state.data?.some((e) => e.status === "planning" || e.status === "writing") ? 2500 : false),
  });
  const [q, setQ] = useState("");
  const [kinds, setKinds] = useState<Set<Kind>>(new Set());
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  const [naming, setNaming] = useState<Naming | null>(null);
  const [importing, setImporting] = useState<{ files?: File[] } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [over, setOver] = useState<DropKey | null>(null);
  const [dragging, setDragging] = useState<string[] | null>(null);
  const [fly, setFly] = useState<Record<string, { x: number; y: number }>>({});
  const [pulse, setPulse] = useState<Record<string, number>>({});
  const [fileDrag, setFileDrag] = useState(false);
  const [examOpen, setExamOpen] = useState<string[] | null>(null);
  const openFolder = (id: string | null) => {
    setSelected(new Set());
    setParams(id ? { folder: id } : {}, { replace: false });
  };

  const all = lectures ?? [];
  const folderIds = new Set(folders.map((f) => f.id));
  const inFolder = (l: LectureSummary) => (l.folderId && folderIds.has(l.folderId) ? l.folderId : null);
  const query = q.trim().toLowerCase();
  // searching from the top level looks inside every folder; inside a folder it stays there
  const scope = useMemo(() => all.filter((l) => (folder ? inFolder(l) === folder.id : query ? true : !inFolder(l))), [all, folder, query, folders]);
  const visible = useMemo(
    () =>
      scope.filter((l) => {
        if (query && !`${l.title} ${(l.tags ?? []).join(" ")}`.toLowerCase().includes(query)) return false;
        if (kinds.size && !kinds.has(kindOf(l))) return false;
        for (const t of tagFilter) if (!(l.tags ?? []).includes(t)) return false;
        return true;
      }),
    [scope, query, kinds, tagFilter],
  );
  const allTags = useMemo(() => [...new Set(all.flatMap((l) => l.tags ?? []))].sort((a, b) => a.localeCompare(b, "ko")), [all]);
  const scopeTags = useMemo(() => {
    const n = new Map<string, number>();
    for (const l of scope) for (const t of l.tags ?? []) n.set(t, (n.get(t) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"));
  }, [scope]);
  const scopeKinds = useMemo(() => {
    const present = new Set(scope.map(kindOf));
    return (["video", ...DOC_TYPE_ORDER] as Kind[]).filter((k) => present.has(k));
  }, [scope]);

  // a new folder starts unfiltered
  useEffect(() => {
    setTagFilter(new Set());
    setKinds(new Set());
  }, [folder?.id]);
  // bulk actions only ever act on cards the student can see
  useEffect(() => {
    const shown = new Set(visible.map((l) => l.id));
    setSelected((s) => ([...s].every((id) => shown.has(id)) ? s : new Set([...s].filter((id) => shown.has(id)))));
  }, [visible]);

  const counts = (id: string) => {
    const items = all.filter((l) => l.folderId === id);
    return { total: items.length, due: items.reduce((n, l) => n + l.cardsDue, 0), docs: items.filter((l) => l.kind === "doc").length };
  };
  const due = (folder ? all.filter((l) => l.folderId === folder.id) : all).reduce((n, l) => n + l.cardsDue, 0);
  const folderName = (id?: string | null) => folders.find((f) => f.id === id)?.name;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["lectures"] });
    void qc.invalidateQueries({ queryKey: ["folders"] });
  };

  /** Move items; with `animate` the cards first fly into the folder they were dropped on. */
  const move = async (ids: string[], folderId: string | null, animate = false) => {
    const items = all.filter((l) => ids.includes(l.id) && (l.folderId ?? null) !== folderId);
    if (!items.length) return;
    const before = new Map(items.map((l) => [l.id, l.folderId ?? null]));
    if (animate) {
      const target = document.querySelector(`[data-drop="${folderId ? `folder:${folderId}` : "root"}"]`)?.getBoundingClientRect();
      if (target) {
        const next: Record<string, { x: number; y: number }> = {};
        for (const l of items) {
          const el = document.querySelector<HTMLElement>(`[data-card="${l.id}"]`);
          if (!el) continue;
          // measure from the laid-out position: the drag transform is still applied
          const r = el.getBoundingClientRect();
          const t = new DOMMatrixReadOnly(getComputedStyle(el).transform);
          next[l.id] = { x: target.x + target.width / 2 - (r.x - t.m41 + r.width / 2), y: target.y + target.height / 2 - (r.y - t.m42 + r.height / 2) };
        }
        setFly(next);
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      const key = folderId ?? "root";
      setPulse((p) => ({ ...p, [key]: (p[key] ?? 0) + 1 }));
    }
    // optimistic: the cards leave the grid (and play their exit) right away
    qc.setQueryData<LectureSummary[]>(["lectures"], (old) => (old ?? []).map((l) => (before.has(l.id) ? { ...l, folderId: folderId ?? undefined } : l)));
    setSelected(new Set());
    try {
      await api.bulkUpdate({ ids: items.map((l) => l.id), folderId });
      toast.success(folderId ? `“${folderName(folderId)}”(으)로 옮겼어요` : "폴더에서 뺐어요", {
        description: items.length > 1 ? `${items.length}개 항목` : items[0].title,
        action: {
          label: "되돌리기",
          onClick: async () => {
            for (const [id, f] of before) await api.updateLecture(id, { folderId: f });
            refresh();
          },
        },
      });
    } catch (e) {
      toast.error("옮기지 못했습니다", { description: (e as Error).message });
    } finally {
      refresh();
      setTimeout(() => setFly({}), 600);
    }
  };

  const tag = async (ids: string[], add: string[], remove: string[] = []) => {
    qc.setQueryData<LectureSummary[]>(["lectures"], (old) =>
      (old ?? []).map((l) => (ids.includes(l.id) ? { ...l, tags: [...new Set([...(l.tags ?? []), ...add])].filter((t) => !remove.includes(t)) } : l)),
    );
    await api.bulkUpdate({ ids, addTags: add, removeTags: remove }).catch((e: Error) => toast.error(e.message));
    refresh();
  };

  const remove = async (items: LectureSummary[]) => {
    const label = items.length === 1 ? `“${items[0].title}”` : `${items.length}개 항목`;
    if (!confirm(`${label}과(와) 모든 학습 기록을 삭제할까요?`)) return;
    for (const l of items) await api.deleteLecture(l.id);
    setSelected(new Set());
    refresh();
    toast.success("삭제했습니다.");
  };

  const removeFolder = async (f: Folder) => {
    const n = counts(f.id).total;
    if (!confirm(`“${f.name}” 폴더를 삭제할까요?${n ? `\n안에 있는 ${n}개 항목은 지워지지 않고 ‘내 강의’로 옮겨져요.` : ""}`)) return;
    await api.deleteFolder(f.id);
    if (folder?.id === f.id) openFolder(null);
    refresh();
    toast.success("폴더를 삭제했습니다.");
  };

  const submitName = async (name: string) => {
    if (!naming) return;
    if (naming.kind === "lecture") {
      await api.updateLecture(naming.lecture.id, { title: name });
      toast.success("이름을 바꿨어요");
    } else if (naming.kind === "folder") {
      await api.renameFolder(naming.folder.id, name);
    } else {
      const created = await api.createFolder(name);
      if (naming.moveIds?.length) await api.bulkUpdate({ ids: naming.moveIds, folderId: created.id });
      setSelected(new Set());
      toast.success(naming.moveIds?.length ? `“${created.name}” 폴더를 만들고 옮겼어요` : `“${created.name}” 폴더를 만들었어요`);
    }
    refresh();
  };

  // --- pointer drags: cards onto folders, tags onto cards ----------------------------
  const dragSource = useRef<HTMLElement | null>(null);
  const draggingRef = useRef<string[] | null>(null);
  const cardDrag = {
    start(id: string, el: HTMLElement) {
      dragSource.current = el;
      const ids = selected.has(id) ? [...selected] : [id];
      draggingRef.current = ids;
      setDragging(ids);
    },
    move(x: number, y: number) {
      const key = dropAt(x, y, dragSource.current);
      setOver(key && !key.startsWith("card:") ? key : null);
    },
    end(x: number, y: number) {
      const key = dropAt(x, y, dragSource.current);
      const ids = draggingRef.current ?? [];
      draggingRef.current = null;
      setOver(null);
      setDragging(null);
      if (!key || key.startsWith("card:")) return;
      void move(ids, key === "root" ? null : key.slice(7), true);
    },
  };
  const tagDrag = {
    start(el: HTMLElement) {
      dragSource.current = el;
    },
    move(x: number, y: number) {
      const key = dropAt(x, y, dragSource.current);
      setOver(key?.startsWith("card:") ? key : null);
    },
    end(t: string, x: number, y: number) {
      const key = dropAt(x, y, dragSource.current);
      setOver(null);
      if (!key?.startsWith("card:")) return;
      const id = key.slice(5);
      const ids = selected.has(id) ? [...selected] : [id];
      void tag(ids, [t]);
      toast.success(`#${t} 태그를 붙였어요`, { description: ids.length > 1 ? `${ids.length}개 항목` : all.find((l) => l.id === id)?.title });
    },
  };

  // --- files dropped from the desktop -------------------------------------------------
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e) || importing) return;
      depth++;
      setFileDrag(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setFileDrag(false);
    };
    // a file dropped anywhere must never make the browser open it and leave the app
    const dragOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (importing) return;
      depth = 0;
      setFileDrag(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) setImporting({ files });
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", dragOver);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", dragOver);
      window.removeEventListener("drop", drop);
    };
  }, [importing]);

  const toggleSelect = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleIn = <T,>(set: (fn: (s: Set<T>) => Set<T>) => void, v: T) =>
    set((s) => {
      const n = new Set(s);
      if (n.has(v)) n.delete(v);
      else n.add(v);
      return n;
    });

  const hasLibrary = all.length > 0 || folders.length > 0;
  const showFolders = !folder && !query && folders.length > 0;
  const filtering = kinds.size > 0 || tagFilter.size > 0;
  const selectedItems = all.filter((l) => selected.has(l.id));
  const examPool = (folder ? all.filter((l) => l.folderId === folder.id) : all).filter((l) => l.analyzed);

  return (
    <div className="mx-auto w-full max-w-[1180px] px-4 pb-32 sm:px-8">
      {lectures && !hasLibrary ? (
        <section className="mx-auto max-w-[760px] pt-10 pb-12 sm:pt-16">
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }}>
            <p className="mb-3 text-center text-[13px] font-medium tracking-wide text-accent">{greeting()}</p>
            <h1 className="text-center font-serif text-[29px] leading-[1.3] font-semibold tracking-tight sm:text-[44px] sm:leading-[1.25]">
              강의도, 교재도, 과제도
              <br />
              <span className="text-muted">내 것이 될 때까지.</span>
            </h1>
            <p className="mx-auto mt-4 max-w-[540px] text-center text-[15px] leading-relaxed text-muted">
              영상·링크·PDF를 넣으면 노트와 개념 정리, 직접 만져 보는 인터랙티브 학습 페이지, 퀴즈·카드, 과목 전체를 아우르는 모의고사까지 만들어 드려요.
            </p>
          </motion.div>
          <motion.div className="mt-9" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, delay: 0.08, ease: [0.2, 0.8, 0.2, 1] }}>
            <ImportPanel folder={folder} />
          </motion.div>
        </section>
      ) : null}

      <Dialog open={importing !== null} onOpenChange={(v) => !v && setImporting(null)} title={folder ? `“${folder.name}”에 추가` : "강의·자료 추가"} className="max-w-[820px]">
        <ImportPanel folder={folder} initialFiles={importing?.files} />
      </Dialog>

      {hasLibrary ? (
        <section className="pt-8 sm:pt-10">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              {folder ? (
                <div className="flex min-w-0 items-center gap-1">
                  <motion.button
                    data-drop="root"
                    key={`root-${pulse.root ?? 0}`}
                    animate={pulse.root ? { scale: [1, 1.12, 1] } : undefined}
                    onClick={() => openFolder(null)}
                    className={cn(
                      "-ml-2 rounded-lg px-2 py-0.5 font-serif text-[22px] font-semibold tracking-tight text-muted transition-colors hover:bg-surface-2 hover:text-text",
                      dragging && "ring-2 ring-accent/30",
                      over === "root" && "bg-accent-soft text-accent ring-2 ring-accent",
                    )}
                  >
                    내 강의
                  </motion.button>
                  <ChevronRight className="size-5 shrink-0 text-faint" />
                  <h2 className="truncate font-serif text-[22px] font-semibold tracking-tight">{folder.name}</h2>
                  <FolderMenu folder={folder} onRename={() => setNaming({ kind: "folder", folder })} onDelete={() => removeFolder(folder)} />
                </div>
              ) : (
                <h2 className="font-serif text-[22px] font-semibold tracking-tight">내 강의</h2>
              )}
              <p className="mt-0.5 text-[13px] text-muted">
                {folder
                  ? `${counts(folder.id).total}개 항목${counts(folder.id).docs ? ` · PDF ${counts(folder.id).docs}개` : ""}`
                  : `${all.length}개 항목${folders.length ? ` · 폴더 ${folders.length}개` : ""}`}
              </p>
            </div>
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <Link
                to={folder ? `/review?folder=${folder.id}` : "/review"}
                className={cn(
                  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[10px] px-3.5 text-[13px] font-semibold transition-colors",
                  due > 0 ? "bg-accent text-accent-fg hover:bg-accent-strong" : "border border-border bg-surface text-muted hover:bg-surface-2",
                )}
              >
                <GraduationCap className="size-4" />
                {due > 0 ? `오늘의 복습 ${due}장` : "복습 완료"}
              </Link>
              <Button size="sm" variant="soft" disabled={!examPool.length} onClick={() => setExamOpen(examPool.map((l) => l.id))} className="h-9 shrink-0">
                <ClipboardList className="size-4" />
                시험 만들기
              </Button>
              <Button size="sm" variant="soft" onClick={() => setImporting({})} className="h-9 shrink-0">
                <Plus className="size-4" />
                추가
              </Button>
              {!folder ? (
                <Button size="sm" onClick={() => setNaming({ kind: "new-folder" })} className="h-9 shrink-0">
                  <FolderPlus className="size-4" />새 폴더
                </Button>
              ) : null}
              {all.length > 3 ? (
                <div className="relative flex-1 sm:w-56 sm:flex-none">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={folder ? "이 폴더에서 검색" : "제목·태그 검색"} className="h-9 pl-9" />
                </div>
              ) : null}
            </div>
          </div>

          {scopeKinds.length > 1 || scopeTags.length ? (
            <FilterBar
              kinds={scopeKinds}
              kindOn={kinds}
              onKind={(k) => toggleIn(setKinds, k)}
              tags={scopeTags}
              tagOn={tagFilter}
              onTag={(t) => toggleIn(setTagFilter, t)}
              onClear={() => {
                setKinds(new Set());
                setTagFilter(new Set());
              }}
              filtering={filtering}
              tagDrag={tagDrag}
            />
          ) : null}

          {showFolders ? (
            <div className="mb-7 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {folders.map((f, i) => (
                <motion.div key={f.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.03, 0.2) }}>
                  <FolderTile
                    folder={f}
                    {...counts(f.id)}
                    over={over === `folder:${f.id}`}
                    armed={!!dragging}
                    pulse={pulse[f.id] ?? 0}
                    onOpen={() => openFolder(f.id)}
                    onRename={() => setNaming({ kind: "folder", folder: f })}
                    onDelete={() => removeFolder(f)}
                  />
                </motion.div>
              ))}
            </div>
          ) : null}

          {exams.length && !query ? <ExamShelf exams={exams} onOpen={(e) => navigate(`/exam/${e.id}`)} /> : null}

          {visible.length ? (
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              <AnimatePresence mode="popLayout">
                {visible.map((l, i) => (
                  <ItemCard
                    key={l.id}
                    index={i}
                    lecture={l}
                    folders={folders}
                    allTags={allTags}
                    folderLabel={query && !folder ? folderName(inFolder(l)) : undefined}
                    selected={selected.has(l.id)}
                    selecting={selected.size > 0}
                    dragging={dragging}
                    tagOver={over === `card:${l.id}`}
                    fly={fly[l.id]}
                    drag={cardDrag}
                    onSelect={() => toggleSelect(l.id)}
                    onRename={() => setNaming({ kind: "lecture", lecture: l })}
                    onMove={(folderId) => move([l.id], folderId)}
                    onMoveToNew={() => setNaming({ kind: "new-folder", moveIds: [l.id] })}
                    onTags={(next) => {
                      const prev = l.tags ?? [];
                      void tag(
                        [l.id],
                        next.filter((t) => !prev.includes(t)),
                        prev.filter((t) => !next.includes(t)),
                      );
                    }}
                    onDocType={async (t) => {
                      await api.updateLecture(l.id, { docType: t });
                      refresh();
                    }}
                    onDelete={() => remove([l])}
                  />
                ))}
              </AnimatePresence>
            </div>
          ) : query || filtering ? (
            <p className="py-12 text-center text-sm text-muted">조건에 맞는 항목이 없어요.</p>
          ) : folder ? (
            <EmptyState
              icon={<FolderIcon />}
              title="아직 이 폴더가 비어 있어요"
              description="영상이나 PDF(교재·강의자료·과제·실습)를 이 화면에 끌어다 놓으면 바로 이 폴더에 추가돼요. 다른 항목은 카드를 끌어서 옮길 수 있어요."
              action={
                <Button variant="primary" onClick={() => setImporting({})}>
                  <Plus className="size-4" /> 추가하기
                </Button>
              }
            />
          ) : null}
        </section>
      ) : null}

      <SelectionBar
        items={selectedItems}
        folders={folders}
        allTags={allTags}
        currentFolder={folder?.id ?? null}
        onClear={() => setSelected(new Set())}
        onMove={(f) => move([...selected], f)}
        onMoveToNew={() => setNaming({ kind: "new-folder", moveIds: [...selected] })}
        onTag={(t) => tag([...selected], [t])}
        onExam={() => setExamOpen(selectedItems.filter((l) => l.analyzed).map((l) => l.id))}
        onDelete={() => remove(selectedItems)}
      />

      <AnimatePresence>
        {fileDrag ? (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center bg-accent/10 p-6 backdrop-blur-[2px]">
            <motion.div
              initial={{ scale: 0.92, y: 10 }}
              animate={{ scale: 1, y: 0 }}
              transition={SPRING}
              className="flex flex-col items-center gap-3 rounded-[28px] border-2 border-dashed border-accent bg-surface/95 px-12 py-10 text-center shadow-float"
            >
              <motion.div animate={{ y: [0, -6, 0] }} transition={{ repeat: Infinity, duration: 1.4 }} className="flex size-14 items-center justify-center rounded-2xl bg-accent text-accent-fg">
                <Upload className="size-6" />
              </motion.div>
              <div className="text-[17px] font-semibold">{folder ? `“${folder.name}”에 놓으세요` : "여기에 놓으세요"}</div>
              <div className="text-[13px] text-muted">강의 영상·음성·PDF(교재·강의자료·과제·실습·기출)</div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <NameDialog
        open={naming !== null}
        title={naming?.kind === "lecture" ? "이름 바꾸기" : naming?.kind === "folder" ? "폴더 이름 바꾸기" : "새 폴더"}
        description={
          naming?.kind === "new-folder" && naming.moveIds?.length
            ? `폴더를 만들고 ${naming.moveIds.length}개 항목을 옮깁니다.`
            : naming?.kind === "new-folder"
              ? "과목마다 폴더를 만들면 그 과목의 모든 자료로 시험을 만들 수 있어요."
              : undefined
        }
        initial={naming?.kind === "lecture" ? naming.lecture.title : naming?.kind === "folder" ? naming.folder.name : ""}
        placeholder={naming?.kind === "lecture" ? "이름" : "예: 컴퓨터구조"}
        confirmLabel={naming?.kind === "new-folder" ? "만들기" : "저장"}
        onClose={() => setNaming(null)}
        onSubmit={submitName}
      />

      {examOpen ? (
        <ExamBuilder
          folder={folder ?? null}
          items={examPool.length ? examPool : all.filter((l) => l.analyzed)}
          initial={examOpen}
          onClose={() => setExamOpen(null)}
          onCreated={(e) => {
            setExamOpen(null);
            setSelected(new Set());
            void qc.invalidateQueries({ queryKey: ["exams"] });
            navigate(`/exam/${e.id}`);
          }}
        />
      ) : null}
    </div>
  );
}

// --- filter bar ----------------------------------------------------------------------

function FilterBar({
  kinds,
  kindOn,
  onKind,
  tags,
  tagOn,
  onTag,
  onClear,
  filtering,
  tagDrag,
}: {
  kinds: Kind[];
  kindOn: Set<Kind>;
  onKind: (k: Kind) => void;
  tags: [string, number][];
  tagOn: Set<string>;
  onTag: (t: string) => void;
  onClear: () => void;
  filtering: boolean;
  tagDrag: { start: (el: HTMLElement) => void; move: (x: number, y: number) => void; end: (t: string, x: number, y: number) => void };
}) {
  const dragged = useRef(false);
  return (
    <div className="mb-6 flex flex-wrap items-center gap-1.5">
      {kinds.length > 1
        ? kinds.map((k) => {
            const on = kindOn.has(k);
            const color = k === "video" ? "var(--accent)" : DOC_TYPE_INFO[k].color;
            return (
              <button
                key={k}
                onClick={() => onKind(k)}
                className={cn("inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-semibold transition-all", on ? "text-white" : "border-border bg-surface text-muted hover:text-text")}
                style={on ? { background: color, borderColor: color } : undefined}
              >
                {k === "video" ? <AudioLines className="size-3.5" /> : <span className="size-2 rounded-full" style={{ background: on ? "white" : color }} />}
                {KIND_LABEL(k)}
              </button>
            );
          })
        : null}
      {kinds.length > 1 && tags.length ? <span className="mx-1 h-4 w-px bg-border" /> : null}
      {tags.map(([t, n]) => (
        <motion.button
          key={t}
          drag
          dragSnapToOrigin
          dragMomentum={false}
          whileDrag={{ scale: 1.12, zIndex: 60, boxShadow: "0 12px 28px -8px rgba(0,0,0,.35)" }}
          onDragStart={(e) => {
            dragged.current = true;
            tagDrag.start(e.target as HTMLElement);
          }}
          onDrag={(e) => tagDrag.move((e as PointerEvent).clientX, (e as PointerEvent).clientY)}
          onDragEnd={(e) => {
            tagDrag.end(t, (e as PointerEvent).clientX, (e as PointerEvent).clientY);
            setTimeout(() => (dragged.current = false), 0);
          }}
          onClick={() => !dragged.current && onTag(t)}
          title="누르면 이 태그로 걸러 보고, 카드로 끌어다 놓으면 태그가 붙어요"
          className={cn(
            "relative inline-flex h-7 cursor-grab touch-none items-center gap-1 rounded-full border px-2.5 text-[12.5px] font-medium active:cursor-grabbing",
            tagOn.has(t) ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface text-muted hover:border-accent hover:text-accent",
          )}
        >
          <Hash className="size-3 opacity-70" />
          {t}
          <span className="tabular-nums opacity-60">{n}</span>
        </motion.button>
      ))}
      {filtering ? (
        <button onClick={onClear} className="ml-1 inline-flex h-7 items-center gap-1 rounded-full px-2 text-[12.5px] text-muted hover:text-text">
          <X className="size-3.5" /> 필터 지우기
        </button>
      ) : tags.length ? (
        <span className="ml-1 hidden text-[11.5px] text-faint md:inline">태그를 카드로 끌어다 놓으면 붙어요</span>
      ) : null}
    </div>
  );
}

// --- folders -------------------------------------------------------------------------

function FolderMenu({ folder, onRename, onDelete, className }: { folder: Folder; onRename: () => void; onDelete: () => void; className?: string }) {
  return (
    <Menu
      trigger={
        <Button size="icon-sm" variant="ghost" aria-label={`${folder.name} 폴더 메뉴`} className={className}>
          <MoreHorizontal className="size-4" />
        </Button>
      }
    >
      <MenuItem icon={<Pencil />} onSelect={onRename}>
        이름 바꾸기
      </MenuItem>
      <MenuSeparator />
      <MenuItem danger icon={<Trash2 />} onSelect={onDelete}>
        폴더 삭제
      </MenuItem>
    </Menu>
  );
}

function FolderTile({
  folder,
  total,
  due,
  docs,
  over,
  armed,
  pulse,
  onOpen,
  onRename,
  onDelete,
}: {
  folder: Folder;
  total: number;
  due: number;
  docs: number;
  over: boolean;
  armed: boolean;
  pulse: number;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <motion.div
      data-drop={`folder:${folder.id}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
      animate={over ? { scale: 1.05, y: -3 } : { scale: 1, y: 0 }}
      transition={SPRING}
      className={cn(
        "group relative flex cursor-pointer items-center gap-3 rounded-2xl border bg-surface p-3 shadow-soft transition-colors outline-none hover:border-border-strong hover:shadow-float focus-visible:ring-2 focus-visible:ring-accent",
        over ? "border-accent bg-accent-soft ring-2 ring-accent" : armed ? "border-dashed border-accent/50" : "border-border",
      )}
    >
      <motion.div
        key={pulse}
        animate={pulse ? { scale: [1, 1.35, 0.95, 1], rotate: [0, -8, 6, 0] } : over ? { scale: 1.15, rotate: -6 } : { scale: 1, rotate: 0 }}
        transition={pulse ? { duration: 0.55 } : SPRING}
        className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent transition-colors", over && "bg-accent text-accent-fg")}
      >
        <FolderIcon className="size-5" />
      </motion.div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-semibold tracking-tight">{folder.name}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
          <span>
            {total}개{docs ? ` · PDF ${docs}` : ""}
          </span>
          {due ? <span className="font-medium text-accent">· 복습 {due}</span> : null}
        </div>
      </div>
      <div className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 [@media(hover:none)]:opacity-100" onClick={(e) => e.stopPropagation()}>
        <FolderMenu folder={folder} onRename={onRename} onDelete={onDelete} />
      </div>
    </motion.div>
  );
}

// --- exams -----------------------------------------------------------------------------

function ExamShelf({ exams, onOpen }: { exams: Exam[]; onOpen: (e: Exam) => void }) {
  return (
    <div className="mb-7">
      <div className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-muted">
        <ClipboardList className="size-4" /> 모의고사
      </div>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {exams.map((e) => {
          const last = e.attempts.find((a) => a.status === "graded");
          const busy = e.status === "planning" || e.status === "writing";
          return (
            <motion.button
              key={e.id}
              layout
              whileHover={{ y: -2 }}
              onClick={() => onOpen(e)}
              className="flex min-h-[96px] w-[230px] shrink-0 flex-col rounded-2xl border border-border bg-surface p-3.5 text-left shadow-soft transition-colors hover:border-border-strong"
            >
              <span className="line-clamp-2 text-[14px] leading-snug font-semibold">{e.title}</span>
              <span className="mt-auto flex w-full items-center gap-2 pt-3 text-[12px] text-muted">
                {busy ? (
                  <>
                    <span className="size-1.5 animate-pulse rounded-full bg-accent" />
                    {e.status === "planning" ? "출제 설계 중" : `문항 작성 중 ${e.progress ?? ""}`}
                  </>
                ) : e.status === "error" ? (
                  <Badge tone="danger">오류</Badge>
                ) : (
                  <>
                    <span>
                      {e.questions.length}문항 · {e.config.minutes}분
                    </span>
                    {last ? (
                      <span className="ml-auto font-semibold text-accent tabular-nums">{Math.round((last.score / Math.max(1, last.maxScore)) * 100)}점</span>
                    ) : (
                      <span className="ml-auto text-accent">응시하기 →</span>
                    )}
                  </>
                )}
              </span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}

// --- item cards ----------------------------------------------------------------------------

function ItemCard({
  index,
  lecture: l,
  folders,
  allTags,
  folderLabel,
  selected,
  selecting,
  dragging,
  tagOver,
  fly,
  drag,
  onSelect,
  onRename,
  onMove,
  onMoveToNew,
  onTags,
  onDocType,
  onDelete,
}: {
  index: number;
  lecture: LectureSummary;
  folders: Folder[];
  allTags: string[];
  folderLabel?: string;
  selected: boolean;
  selecting: boolean;
  dragging: string[] | null;
  tagOver: boolean;
  fly?: { x: number; y: number };
  drag: { start: (id: string, el: HTMLElement) => void; move: (x: number, y: number) => void; end: (x: number, y: number) => void };
  onSelect: () => void;
  onRename: () => void;
  onMove: (folderId: string | null) => void;
  onMoveToNew: () => void;
  onTags: (tags: string[]) => void;
  onDocType: (t: DocType) => void;
  onDelete: () => void;
}) {
  const navigate = useNavigate();
  const moved = useRef(false);
  const self = useRef<HTMLDivElement>(null);
  const processing = l.status === "processing" || l.status === "queued";
  const running = l.steps.find((s) => s.status === "running");
  const isDoc = l.kind === "doc";
  // no badge until the analysis has said what the document is
  const type = isDoc && l.docType ? DOC_TYPE_INFO[l.docType] : null;
  const isDragged = dragging?.[0] === l.id || (!!dragging && dragging.includes(l.id) && moved.current);
  const riding = !!dragging && !isDragged && dragging.includes(l.id);
  const tags = l.tags ?? [];

  return (
    <motion.div
      ref={self}
      data-card={l.id}
      data-drop={`card:${l.id}`}
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: riding ? 0.45 : 1, y: 0, scale: riding ? 0.97 : 1 }}
      exit={
        fly
          ? { x: fly.x, y: fly.y, scale: 0.12, opacity: 0, rotate: -8, transition: { duration: 0.45, ease: [0.5, 0, 0.75, 0] } }
          : { opacity: 0, scale: 0.92, transition: { duration: 0.2 } }
      }
      transition={{ ...SPRING, opacity: { duration: 0.25, delay: Math.min(index * 0.03, 0.25) } }}
      drag
      dragSnapToOrigin
      dragMomentum={false}
      dragElastic={0.35}
      whileDrag={{ scale: 1.04, rotate: -1.5, zIndex: 50, boxShadow: "0 28px 60px -18px rgba(0,0,0,.45)", cursor: "grabbing" }}
      onDragStart={() => {
        moved.current = true;
        drag.start(l.id, self.current!);
      }}
      onDrag={(e) => drag.move((e as PointerEvent).clientX, (e as PointerEvent).clientY)}
      onDragEnd={(e) => {
        drag.end((e as PointerEvent).clientX, (e as PointerEvent).clientY);
        // the click that ends a drag must not open the item
        setTimeout(() => (moved.current = false), 0);
      }}
      onClick={(e) => {
        if (moved.current) return;
        if ((e.target as HTMLElement).closest("[data-no-open]")) return;
        if (e.ctrlKey || e.metaKey || e.shiftKey || selecting) return onSelect();
        navigate(`/lecture/${l.id}`);
      }}
      onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && navigate(`/lecture/${l.id}`)}
      tabIndex={0}
      role="link"
      aria-label={l.title}
      className={cn(
        "group relative block cursor-pointer touch-pan-y overflow-hidden rounded-2xl border bg-surface shadow-soft transition-[border-color,box-shadow] outline-none select-none hover:border-border-strong hover:shadow-float focus-visible:ring-2 focus-visible:ring-accent",
        selected ? "border-accent ring-2 ring-accent" : "border-border",
        tagOver && "border-accent ring-4 ring-accent/40",
      )}
    >
      <div className="relative aspect-video overflow-hidden bg-surface-2">
        {l.hasThumbnail ? (
          <img
            src={api.thumbUrl(l.id, l.updatedAt)}
            alt=""
            draggable={false}
            className={cn("size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]", isDoc && "object-top")}
            loading="lazy"
          />
        ) : (
          <div className="flex size-full items-center justify-center bg-gradient-to-br from-accent-soft to-surface-2">
            {isDoc ? <FileText className="size-10 text-accent/60" /> : <AudioLines className="size-10 text-accent/60" />}
          </div>
        )}
        {isDoc ? <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/25 to-transparent" /> : null}
        {type ? (
          <span className="absolute top-2.5 left-10 rounded-full px-2 py-0.5 text-[11px] font-bold text-white shadow-sm" style={{ background: type.color }}>
            {type.label}
          </span>
        ) : null}
        {l.durationSec || (isDoc && l.pageCount) ? (
          <span className="absolute right-2.5 bottom-2.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[11.5px] font-medium text-white tabular-nums backdrop-blur-sm">
            {isDoc ? `${l.pageCount}쪽` : fmtDuration(l.durationSec)}
          </span>
        ) : null}
        {processing ? (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/20">
            <div className="h-full bg-accent transition-[width] duration-700" style={{ width: `${overallProgress(l) * 100}%` }} />
          </div>
        ) : null}
        <button
          data-no-open
          aria-label={selected ? "선택 해제" : "선택"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onSelect();
          }}
          className={cn(
            "absolute top-2.5 left-2.5 flex size-6 items-center justify-center rounded-full border-2 transition-all",
            selected ? "border-accent bg-accent text-accent-fg opacity-100" : "border-white/90 bg-black/25 text-transparent opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100",
            selecting && "opacity-100",
          )}
        >
          <Check className="size-3.5" strokeWidth={3} />
        </button>
        <div
          data-no-open
          className="absolute top-2 right-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 [@media(hover:none)]:opacity-100"
          // bubble phase: the menu trigger opens on pointerdown and must see it; only the card's drag must not
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <Menu
            trigger={
              <Button size="icon-sm" variant="secondary" aria-label="더보기" className="bg-surface/90 backdrop-blur">
                <MoreHorizontal className="size-4" />
              </Button>
            }
          >
            <MenuItem icon={<Pencil />} onSelect={onRename}>
              이름 바꾸기
            </MenuItem>
            {isDoc ? (
              <MenuSub icon={<Shapes />} label="자료 종류">
                {DOC_TYPE_ORDER.map((t) => (
                  <MenuItem key={t} icon={t === l.docType ? <Check /> : <span className="size-2.5 rounded-full" style={{ background: DOC_TYPE_INFO[t].color }} />} onSelect={() => onDocType(t)}>
                    {DOC_TYPE_INFO[t].label}
                  </MenuItem>
                ))}
              </MenuSub>
            ) : null}
            <MenuSub icon={<FolderInput />} label="폴더로 이동">
              {folders.map((f) => (
                <MenuItem key={f.id} icon={f.id === l.folderId ? <Check /> : <FolderIcon />} onSelect={() => onMove(f.id)}>
                  <span className={cn("max-w-[220px] truncate", f.id === l.folderId && "font-semibold")}>{f.name}</span>
                </MenuItem>
              ))}
              {folders.length ? <MenuSeparator /> : null}
              <MenuItem icon={<FolderPlus />} onSelect={onMoveToNew}>
                새 폴더 만들기…
              </MenuItem>
              {l.folderId && folders.some((f) => f.id === l.folderId) ? (
                <MenuItem icon={<FolderMinus />} onSelect={() => onMove(null)}>
                  폴더에서 빼기
                </MenuItem>
              ) : null}
            </MenuSub>
            <MenuSeparator />
            <MenuItem danger icon={<Trash2 />} onSelect={onDelete}>
              삭제
            </MenuItem>
          </Menu>
        </div>
        {dragging && dragging[0] === l.id && dragging.length > 1 ? (
          <span className="absolute bottom-2.5 left-2.5 rounded-full bg-accent px-2.5 py-0.5 text-[12px] font-bold text-accent-fg shadow-float">{dragging.length}개 함께 이동</span>
        ) : null}
      </div>
      <div className="p-4">
        <h3 className="line-clamp-2 min-h-[2.6em] text-[15px] leading-snug font-semibold tracking-tight">{l.title}</h3>
        <div className="mt-2 flex min-h-6 flex-wrap items-center gap-1" data-no-open onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          <AnimatePresence initial={false}>
            {tags.slice(0, 3).map((t) => (
              <TagChip key={t} tag={t} />
            ))}
          </AnimatePresence>
          {tags.length > 3 ? <span className="text-[11.5px] text-faint">+{tags.length - 3}</span> : null}
          <TagEditor
            tags={tags}
            allTags={allTags}
            onChange={onTags}
            trigger={
              <button
                aria-label="태그 편집"
                className={cn(
                  "inline-flex h-6 items-center gap-0.5 rounded-full border border-dashed border-border-strong px-2 text-[11.5px] text-faint transition-all hover:border-accent hover:text-accent",
                  tags.length && "opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100",
                )}
              >
                <Plus className="size-3" />
                {tags.length ? "" : "태그"}
              </button>
            }
          />
        </div>
        <div className="mt-2.5 flex items-center gap-2 text-xs text-muted">
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
              {folderLabel ? (
                <span className="flex min-w-0 items-center gap-1 truncate">
                  <FolderIcon className="size-3.5 shrink-0" />
                  {folderLabel}
                </span>
              ) : (
                <span>{relativeDate(l.createdAt)}</span>
              )}
              {l.cardsTotal ? (
                <span className={cn("ml-auto flex shrink-0 items-center gap-1", l.cardsDue ? "font-medium text-accent" : "")}>
                  <Layers className="size-3.5" />
                  {l.cardsDue ? `복습 ${l.cardsDue}` : `카드 ${l.cardsTotal}`}
                </span>
              ) : null}
            </>
          )}
        </div>
      </div>
    </motion.div>
  );
}

// --- selection --------------------------------------------------------------------------------

function SelectionBar({
  items,
  folders,
  allTags,
  currentFolder,
  onClear,
  onMove,
  onMoveToNew,
  onTag,
  onExam,
  onDelete,
}: {
  items: LectureSummary[];
  folders: Folder[];
  allTags: string[];
  currentFolder: string | null;
  onClear: () => void;
  onMove: (folderId: string | null) => void;
  onMoveToNew: () => void;
  onTag: (t: string) => void;
  onExam: () => void;
  onDelete: () => void;
}) {
  return (
    <AnimatePresence>
      {items.length ? (
        <motion.div
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          transition={SPRING}
          className="fixed inset-x-0 bottom-5 z-40 mx-auto flex w-fit max-w-[calc(100%-24px)] flex-wrap items-center gap-1 rounded-2xl border border-border bg-surface/95 p-1.5 pl-4 shadow-float backdrop-blur"
        >
          <span className="mr-2 text-[13px] font-semibold tabular-nums">{items.length}개 선택</span>
          <Menu
            align="start"
            trigger={
              <Button size="sm" variant="ghost">
                <FolderInput className="size-4" /> 폴더로
              </Button>
            }
          >
            {folders
              .filter((f) => f.id !== currentFolder)
              .map((f) => (
                <MenuItem key={f.id} icon={<FolderIcon />} onSelect={() => onMove(f.id)}>
                  <span className="max-w-[220px] truncate">{f.name}</span>
                </MenuItem>
              ))}
            <MenuSeparator />
            <MenuItem icon={<FolderPlus />} onSelect={onMoveToNew}>
              새 폴더 만들기…
            </MenuItem>
            {currentFolder ? (
              <MenuItem icon={<FolderMinus />} onSelect={() => onMove(null)}>
                폴더에서 빼기
              </MenuItem>
            ) : null}
          </Menu>
          <TagEditor
            tags={[]}
            allTags={allTags}
            align="center"
            onChange={(next) => next[0] && onTag(next[0])}
            trigger={
              <Button size="sm" variant="ghost">
                <Hash className="size-4" /> 태그 붙이기
              </Button>
            }
          />
          <Button size="sm" variant="ghost" onClick={onExam} disabled={!items.some((l) => l.analyzed)}>
            <ClipboardList className="size-4" /> 시험 만들기
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete} className="text-danger hover:text-danger" aria-label="선택한 항목 삭제">
            <Trash2 className="size-4" />
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={onClear} aria-label="선택 해제">
            <X className="size-4" />
          </Button>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export function stepLabel(id: string) {
  return (
    {
      fetch: "영상 가져오는 중",
      audio: "오디오 추출 중",
      transcribe: "받아쓰는 중",
      frames: "화면 캡처 중",
      extract: "PDF 읽는 중",
      analyze: "내용 분석 중",
      synthesize: "전체 구조 정리 중",
      materials: "학습 자료 만드는 중",
      pages: "학습 페이지 만드는 중",
    } as Record<string, string>
  )[id];
}
