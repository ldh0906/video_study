import { useMemo, useState, type DragEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { AlertCircle, AudioLines, Check, ChevronRight, Folder as FolderIcon, FolderInput, FolderMinus, FolderPlus, GraduationCap, Layers, MoreHorizontal, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { fmtDuration } from "@shared/time";
import type { Folder, Lecture } from "@shared/types";
import { ImportPanel } from "@/components/ImportPanel";
import { NameDialog } from "@/components/NameDialog";
import { Badge, Button, Dialog, EmptyState, Input, Menu, MenuItem, MenuSeparator, MenuSub } from "@/components/ui";
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

/** dataTransfer type used when dragging a lecture card onto a folder */
const DRAG_TYPE = "application/x-lecture-id";

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

type Naming = { kind: "lecture"; lecture: LectureSummary } | { kind: "new-folder"; moveId?: string } | { kind: "folder"; folder: Folder };

export function Library() {
  const qc = useQueryClient();
  const { data: lectures } = useQuery({
    queryKey: ["lectures"],
    queryFn: api.lectures,
    refetchInterval: (q) => (q.state.data?.some((l) => l.status === "processing" || l.status === "queued") ? 2000 : false),
  });
  const { data: folders = [] } = useQuery({ queryKey: ["folders"], queryFn: api.folders });
  const [params, setParams] = useSearchParams();
  const folder = folders.find((f) => f.id === params.get("folder"));
  const openFolder = (id: string | null) => setParams(id ? { folder: id } : {}, { replace: false });
  const [q, setQ] = useState("");
  const [naming, setNaming] = useState<Naming | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const all = lectures ?? [];
  const folderIds = new Set(folders.map((f) => f.id));
  const inFolder = (l: LectureSummary) => (l.folderId && folderIds.has(l.folderId) ? l.folderId : null);
  const query = q.trim().toLowerCase();
  // Searching from the top level looks inside every folder; inside a folder it stays there.
  const visible = useMemo(
    () =>
      all.filter((l) => {
        if (folder && inFolder(l) !== folder.id) return false;
        if (query) return l.title.toLowerCase().includes(query);
        return folder ? true : !inFolder(l);
      }),
    [all, folder, query, folders],
  );
  const counts = (id: string) => {
    const items = all.filter((l) => l.folderId === id);
    return { total: items.length, due: items.reduce((n, l) => n + l.cardsDue, 0) };
  };
  const due = (folder ? all.filter((l) => l.folderId === folder.id) : all).reduce((n, l) => n + l.cardsDue, 0);
  const folderName = (id?: string) => folders.find((f) => f.id === id)?.name;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["lectures"] });
    void qc.invalidateQueries({ queryKey: ["folders"] });
  };

  const move = async (lecture: Pick<LectureSummary, "id" | "title" | "folderId">, folderId: string | null) => {
    if ((lecture.folderId ?? null) === folderId) return;
    try {
      await api.updateLecture(lecture.id, { folderId });
      refresh();
      toast.success(folderId ? `“${folderName(folderId)}” 폴더로 옮겼어요` : "폴더에서 뺐어요", { description: lecture.title });
    } catch (e) {
      toast.error("옮기지 못했습니다", { description: (e as Error).message });
    }
  };

  const remove = async (l: LectureSummary) => {
    if (!confirm(`“${l.title}” 강의와 모든 학습 기록을 삭제할까요?`)) return;
    await api.deleteLecture(l.id);
    refresh();
    toast.success("강의를 삭제했습니다.");
  };

  const removeFolder = async (f: Folder) => {
    const n = counts(f.id).total;
    if (!confirm(`“${f.name}” 폴더를 삭제할까요?${n ? `\n안에 있는 강의 ${n}개는 지워지지 않고 ‘내 강의’로 옮겨져요.` : ""}`)) return;
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
      if (naming.moveId) await api.updateLecture(naming.moveId, { folderId: created.id });
      toast.success(naming.moveId ? `“${created.name}” 폴더를 만들고 옮겼어요` : `“${created.name}” 폴더를 만들었어요`);
    }
    refresh();
  };

  // drag a lecture card onto a folder (or onto "내 강의" to take it out)
  const dropProps = (key: string, folderId: string | null) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropTarget(key);
    },
    onDragLeave: () => setDropTarget((t) => (t === key ? null : t)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setDropTarget(null);
      const lecture = all.find((l) => l.id === e.dataTransfer.getData(DRAG_TYPE));
      if (lecture) void move(lecture, folderId);
    },
  });

  const hasLibrary = all.length > 0 || folders.length > 0;
  const showFolders = !folder && !query && folders.length > 0;

  return (
    <div className="mx-auto w-full max-w-[1180px] px-4 pb-24 sm:px-8">
      {/* The pitch is for a first visit; a returning student lands on their lectures. */}
      {lectures && !hasLibrary ? (
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
          <ImportPanel folder={folder} />
        </motion.div>
      </section>
      ) : null}

      <Dialog open={importing} onOpenChange={setImporting} title={folder ? `“${folder.name}”에 강의 추가` : "강의 추가"} className="max-w-[820px]">
        <ImportPanel folder={folder} />
      </Dialog>

      {hasLibrary ? (
        <section className="pt-8 sm:pt-10">
          <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              {folder ? (
                <div className="flex min-w-0 items-center gap-1">
                  <button
                    onClick={() => openFolder(null)}
                    className={cn(
                      "-ml-2 rounded-lg px-2 py-0.5 font-serif text-[22px] font-semibold tracking-tight text-muted transition-colors hover:bg-surface-2 hover:text-text",
                      dropTarget === "root" && "bg-accent-soft text-accent ring-2 ring-accent",
                    )}
                    {...dropProps("root", null)}
                  >
                    내 강의
                  </button>
                  <ChevronRight className="size-5 shrink-0 text-faint" />
                  <h2 className="truncate font-serif text-[22px] font-semibold tracking-tight">{folder.name}</h2>
                  <FolderMenu folder={folder} onRename={() => setNaming({ kind: "folder", folder })} onDelete={() => removeFolder(folder)} />
                </div>
              ) : (
                <h2 className="font-serif text-[22px] font-semibold tracking-tight">내 강의</h2>
              )}
              <p className="mt-0.5 text-[13px] text-muted">
                {folder ? `${counts(folder.id).total}개의 강의` : `${all.length}개의 강의${folders.length ? ` · 폴더 ${folders.length}개` : ""}`}
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
              <Button size="sm" variant="soft" onClick={() => setImporting(true)} className="h-9 shrink-0">
                <Plus className="size-4" />강의 추가
              </Button>
              {!folder ? (
                <Button size="sm" onClick={() => setNaming({ kind: "new-folder" })} className="h-9 shrink-0">
                  <FolderPlus className="size-4" />새 폴더
                </Button>
              ) : null}
              {all.length > 3 ? (
                <div className="relative flex-1 sm:w-64 sm:flex-none">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={folder ? "이 폴더에서 검색" : "모든 강의 검색"} className="h-9 pl-9" />
                </div>
              ) : null}
            </div>
          </div>

          {showFolders ? (
            <div className="mb-7 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {folders.map((f, i) => (
                <motion.div key={f.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.03, 0.2) }}>
                  <FolderTile
                    folder={f}
                    {...counts(f.id)}
                    over={dropTarget === f.id}
                    onOpen={() => openFolder(f.id)}
                    onRename={() => setNaming({ kind: "folder", folder: f })}
                    onDelete={() => removeFolder(f)}
                    dropProps={dropProps(f.id, f.id)}
                  />
                </motion.div>
              ))}
            </div>
          ) : null}

          {visible.length ? (
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((l, i) => (
                <motion.div key={l.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.04, 0.3) }}>
                  <LectureCard
                    lecture={l}
                    folders={folders}
                    folderLabel={query && !folder ? folderName(inFolder(l) ?? undefined) : undefined}
                    onRename={() => setNaming({ kind: "lecture", lecture: l })}
                    onMove={(folderId) => move(l, folderId)}
                    onMoveToNew={() => setNaming({ kind: "new-folder", moveId: l.id })}
                    onDelete={() => remove(l)}
                  />
                </motion.div>
              ))}
            </div>
          ) : query ? (
            <p className="py-12 text-center text-sm text-muted">“{q.trim()}”에 맞는 강의가 없어요.</p>
          ) : folder ? (
            <EmptyState
              icon={<FolderIcon />}
              title="아직 이 폴더에 강의가 없어요"
              description="위에서 영상을 올리면 이 폴더에 바로 추가돼요. 다른 강의는 ⋯ 메뉴의 ‘폴더로 이동’으로 옮길 수 있어요."
            />
          ) : null}
        </section>
      ) : null}

      <NameDialog
        open={naming !== null}
        title={naming?.kind === "lecture" ? "강의 이름 바꾸기" : naming?.kind === "folder" ? "폴더 이름 바꾸기" : "새 폴더"}
        description={naming?.kind === "new-folder" && naming.moveId ? "폴더를 만들고 이 강의를 옮깁니다." : undefined}
        initial={naming?.kind === "lecture" ? naming.lecture.title : naming?.kind === "folder" ? naming.folder.name : ""}
        placeholder={naming?.kind === "lecture" ? "강의 이름" : "예: 컴퓨터구조"}
        confirmLabel={naming?.kind === "new-folder" ? "만들기" : "저장"}
        onClose={() => setNaming(null)}
        onSubmit={submitName}
      />
    </div>
  );
}

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
  over,
  onOpen,
  onRename,
  onDelete,
  dropProps,
}: {
  folder: Folder;
  total: number;
  due: number;
  over: boolean;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
  dropProps: { onDragOver: (e: DragEvent) => void; onDragLeave: () => void; onDrop: (e: DragEvent) => void };
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
      {...dropProps}
      className={cn(
        "group flex cursor-pointer items-center gap-3 rounded-2xl border border-border bg-surface p-3 shadow-soft transition-all duration-200 outline-none hover:-translate-y-0.5 hover:border-border-strong hover:shadow-float focus-visible:ring-2 focus-visible:ring-accent",
        over && "-translate-y-0.5 border-accent bg-accent-soft ring-2 ring-accent",
      )}
    >
      <div className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent transition-colors", over && "bg-accent text-accent-fg")}>
        <FolderIcon className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-semibold tracking-tight">{folder.name}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
          <span>강의 {total}개</span>
          {due ? <span className="font-medium text-accent">· 복습 {due}</span> : null}
        </div>
      </div>
      <div className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 [@media(hover:none)]:opacity-100" onClick={(e) => e.stopPropagation()}>
        <FolderMenu folder={folder} onRename={onRename} onDelete={onDelete} />
      </div>
    </div>
  );
}

function LectureCard({
  lecture: l,
  folders,
  folderLabel,
  onRename,
  onMove,
  onMoveToNew,
  onDelete,
}: {
  lecture: LectureSummary;
  folders: Folder[];
  folderLabel?: string;
  onRename: () => void;
  onMove: (folderId: string | null) => void;
  onMoveToNew: () => void;
  onDelete: () => void;
}) {
  const processing = l.status === "processing" || l.status === "queued";
  const running = l.steps.find((s) => s.status === "running");
  return (
    <Link
      to={`/lecture/${l.id}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, l.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      className="group block overflow-hidden rounded-2xl border border-border bg-surface shadow-soft transition-all duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-float"
    >
      <div className="relative aspect-video overflow-hidden bg-surface-2">
        {l.hasThumbnail ? (
          <img src={api.thumbUrl(l.id, l.updatedAt)} alt="" draggable={false} className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" loading="lazy" />
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
        <div
          className="absolute top-2 right-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 [@media(hover:none)]:opacity-100"
          onClick={(e) => e.preventDefault()}
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
