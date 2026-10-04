import { useEffect, useRef, useState, type DragEvent } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Captions, ChevronDown, FileVideo, FolderOpen, Link2, SlidersHorizontal, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { OUTPUT_LANGUAGES } from "@shared/catalog";
import type { LectureOptions, ModelChoice } from "@shared/types";
import { api, uploadFile } from "@/lib/api";
import { addImportFiles, runImportQueue, type ImportItem } from "@/lib/import-queue";
import { cn } from "@/lib/utils";
import { ModelPicker } from "./ModelPicker";
import { useSettings } from "./SettingsDialog";
import { Button, Input, Label, Progress, Segmented, Switch, Textarea } from "./ui";

type Mode = "file" | "url" | "path";

const MEDIA_ACCEPT = "video/*,audio/*,.mkv,.mov,.m4a,.flac,.webm";

function fmtSize(bytes: number) {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

export function ImportPanel() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const [mode, setMode] = useState<Mode>("file");
  const [files, setFiles] = useState<ImportItem[]>([]);
  const [subs, setSubs] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [title, setTitle] = useState("");
  const [focus, setFocus] = useState("");
  const [analysis, setAnalysis] = useState<ModelChoice | null>(null);
  const [outputLanguage, setOutputLanguage] = useState<string | null>(null);
  const [visual, setVisual] = useState<boolean | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const subsInput = useRef<HTMLInputElement>(null);
  const subtitleTarget = useRef<string | null>(null);
  const stopRequested = useRef(false);
  const running = useRef(false);

  const remaining = files.filter((item) => item.status !== "done");
  const completed = files.length - remaining.length;
  const multiple = mode === "file" && files.length > 1;
  const ready = mode === "file" ? remaining.length > 0 : mode === "url" ? /^https?:\/\//i.test(url.trim()) : localPath.trim().length > 2;
  const selectedSubs = mode === "file" ? files[0]?.subtitle : subs;

  useEffect(() => () => { stopRequested.current = true; }, []);
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  const addFiles = (incoming: File[]) => {
    if (running.current) return;
    const result = addImportFiles(files, incoming);
    setFiles(result.items);
    if (result.rejected.length) toast.error("영상·음성 또는 자막 파일을 선택해 주세요", { description: result.rejected.join(", ") });
    if (result.unmatched.length) toast.warning("연결할 영상을 찾지 못한 자막이 있습니다", { description: `${result.unmatched.join(", ")} — 영상 옆 자막 버튼으로 직접 첨부해 주세요.` });
  };

  const setItemSubtitle = (id: string, subtitle?: File) => setFiles((items) => items.map((item) => item.id === id ? { ...item, subtitle, subtitleUploadId: undefined } : item));
  const chooseSubtitle = (id: string | null) => {
    subtitleTarget.current = id;
    subsInput.current?.click();
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (running.current) return;
    addFiles(Array.from(e.dataTransfer.files));
    setMode("file");
  };

  const start = async () => {
    if (!ready || running.current) return;
    running.current = true;
    stopRequested.current = false;
    setStopping(false);
    setBusy(true);
    try {
      const options: Partial<LectureOptions> = { focus: focus.trim() };
      if (analysis) options.analysis = analysis;
      if (outputLanguage) options.outputLanguage = outputLanguage;
      if (visual !== null) options.visualAnalysis = visual;
      if (mode === "file") {
        const results = await runImportQueue(files, options, multiple ? undefined : title.trim() || undefined, {
          upload: uploadFile,
          create: api.createLecture,
        }, (updated) => {
          setFiles((items) => items.map((item) => item.id === updated.id ? updated : item));
          if (updated.status === "done") void qc.invalidateQueries({ queryKey: ["lectures"] });
        }, () => stopRequested.current);
        const succeeded = results.filter((item) => item.status === "done");
        const failed = results.filter((item) => item.status === "error");
        if (succeeded.length) toast.success(`${succeeded.length}개 강의를 등록했습니다`, { description: "각 영상은 별도 강의로 순서대로 분석합니다." });
        if (failed.length) toast.error(`${failed.length}개 파일을 등록하지 못했습니다`, { description: "파일별 오류를 확인한 뒤 실패한 항목만 다시 시도할 수 있습니다." });
        if (!multiple && succeeded[0] && !stopRequested.current) navigate(`/lecture/${succeeded[0].lectureId}`);
        return;
      }
      const source = mode === "url" ? { kind: "url" as const, value: url.trim() } : { kind: "path" as const, value: localPath.trim() };
      let subtitleUploadId: string | undefined;
      if (subs) subtitleUploadId = (await uploadFile(subs, () => {})).uploadId;
      const lecture = await api.createLecture({ source, title: title.trim() || undefined, subtitleUploadId, options });
      qc.invalidateQueries({ queryKey: ["lectures"] });
      navigate(`/lecture/${lecture.id}`);
    } catch (e) {
      toast.error("시작하지 못했습니다", { description: (e as Error).message });
    } finally {
      running.current = false;
      setBusy(false);
      setStopping(false);
    }
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!busy) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={onDrop}
      className={cn(
        "relative rounded-[22px] border bg-surface p-2 shadow-soft transition-all duration-200",
        dragging ? "border-accent ring-8 ring-accent-soft" : "border-border",
      )}
    >
      <fieldset disabled={busy} className="min-w-0">
      <div className="flex items-center justify-between gap-2 px-2 pt-1.5 pb-2">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "file", label: <span className="flex items-center gap-1.5"><Upload className="size-3.5" />파일</span> },
            { value: "url", label: <span className="flex items-center gap-1.5"><Link2 className="size-3.5" />URL</span> },
            { value: "path", label: <span className="flex items-center gap-1.5"><FolderOpen className="size-3.5" />경로</span> },
          ]}
        />
        <button onClick={() => setShowOptions((v) => !v)} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text">
          <SlidersHorizontal className="size-3.5" />
          <span className="hidden sm:inline">{multiple ? "공통 분석 설정" : "이 강의 설정"}</span>
          <ChevronDown className={cn("size-3.5 transition-transform", showOptions && "rotate-180")} />
        </button>
      </div>

      <div className="px-1">
        {mode === "file" ? (
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className={cn(
              "group flex w-full flex-col items-center justify-center gap-3 rounded-2xl border border-dashed px-6 py-10 text-center transition-colors",
              dragging ? "border-accent bg-accent-soft" : "border-border-strong bg-surface-2/60 hover:border-accent hover:bg-accent-soft",
            )}
          >
            {files.length ? (
              <>
                <div className="flex size-12 items-center justify-center rounded-2xl bg-accent text-accent-fg">
                  <FileVideo className="size-6" />
                </div>
                <div>
                  <div className="max-w-[440px] truncate text-[15px] font-semibold">{files.length === 1 ? files[0].file.name : `${files.length}개 영상 · 각각 별도 강의로 등록`}</div>
                  <div className="mt-0.5 text-[13px] text-muted">총 {fmtSize(files.reduce((sum, item) => sum + item.file.size, 0))} · 클릭하거나 드롭해서 파일 추가</div>
                </div>
              </>
            ) : (
              <>
                <div className="flex size-12 items-center justify-center rounded-2xl bg-surface text-accent shadow-soft transition-transform group-hover:-translate-y-0.5">
                  <Upload className="size-5" />
                </div>
                <div>
                  <div className="text-[15px] font-semibold">강의 영상을 끌어다 놓거나 클릭해서 선택하세요</div>
                  <div className="mt-1 text-[13px] text-muted">MP4 · MKV · MOV · WebM · MP3 · M4A — 몇 시간짜리 강의도 괜찮아요</div>
                  <div className="mt-1 text-xs text-accent">여러 파일을 한 번에 선택하면 각각 별도 강의로 등록합니다</div>
                </div>
              </>
            )}
          </button>
        ) : mode === "url" ? (
          <div className="rounded-2xl bg-surface-2/60 p-5">
            <Input
              autoFocus
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && start()}
              placeholder="https://www.youtube.com/watch?v=…  또는 강의 사이트 영상 링크"
              className="h-12 rounded-xl text-[15px]"
            />
            <p className="mt-2.5 text-[12.5px] text-muted">YouTube, Vimeo, 대부분의 강의·동영상 사이트를 지원합니다 (yt-dlp). 로그인이 필요한 사이트는 설정 → 분석 옵션에서 브라우저 쿠키를 켜세요.</p>
          </div>
        ) : (
          <div className="rounded-2xl bg-surface-2/60 p-5">
            <Input
              autoFocus
              value={localPath}
              onChange={(e) => setLocalPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && start()}
              placeholder="C:\Users\나\Videos\강의\3주차.mp4"
              className="h-12 rounded-xl font-mono text-[14px]"
            />
            <p className="mt-2.5 text-[12.5px] text-muted">이미 내려받은 파일을 복사하지 않고 원래 위치에서 바로 분석합니다. 탐색기에서 Shift+우클릭 → “경로로 복사”를 붙여넣으세요.</p>
          </div>
        )}
        {mode === "file" && files.length > 0 ? (
          <div className="mt-3 space-y-2 px-2">
            <div className="flex items-center justify-between gap-3 text-xs text-muted">
              <span>영상별 자막을 첨부할 수 있어요. 같은 이름의 자막을 함께 놓으면 자동 연결합니다.</span>
              <button type="button" onClick={() => setFiles([])} className="shrink-0 hover:text-text">목록 비우기</button>
            </div>
            <ul className="max-h-[340px] space-y-2 overflow-y-auto" aria-label="가져올 영상 목록">
              {files.map((item) => (
                <li key={item.id} className="rounded-xl border border-border bg-surface-2/50 p-3">
                  <div className="flex items-start gap-2">
                    <FileVideo className="mt-0.5 size-4 shrink-0 text-muted" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium" title={item.file.name}>{item.file.name}</p>
                      <p className={cn("mt-1 text-xs", item.status === "error" ? "text-danger" : item.status === "done" ? "text-accent" : "text-muted")}>
                        {fmtSize(item.file.size)} · {item.status === "uploading" ? `업로드 ${Math.round(item.progress * 100)}%` : item.status === "subtitle" ? "자막 업로드 중" : item.status === "creating" ? "강의 등록 중" : item.status === "done" ? "등록 완료 · 분석 대기열에 추가됨" : item.status === "error" ? "등록 실패" : "등록 대기"}
                      </p>
                      {item.status === "uploading" ? <Progress value={item.progress} className="mt-2" /> : null}
                      {item.error ? <p className="mt-1 break-words text-xs text-danger">{item.error}</p> : null}
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {item.status === "done" ? (
                          <button type="button" onClick={() => navigate(`/lecture/${item.lectureId}`)} className="text-xs font-medium text-accent">강의 열기 →</button>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => chooseSubtitle(item.id)} aria-label={`${item.file.name} 자막 ${item.subtitle ? "변경" : "첨부"}`}><Captions className="size-3.5" />{item.subtitle ? "자막 변경" : "자막 첨부"}</Button>
                        )}
                        {item.subtitle ? <span className="flex min-w-0 items-center gap-1 text-xs text-muted"><span className="truncate" title={item.subtitle.name}>{item.subtitle.name}</span>{item.status !== "done" ? <button type="button" onClick={() => setItemSubtitle(item.id)} aria-label={`${item.file.name} 자막 제거`}><X className="size-3.5" /></button> : null}</span> : null}
                      </div>
                    </div>
                    <button type="button" onClick={() => setFiles((items) => items.filter((entry) => entry.id !== item.id))} aria-label={`${item.file.name} 목록에서 제거`} className="rounded p-1 text-muted hover:bg-surface-3 hover:text-text"><X className="size-4" /></button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <AnimatePresence initial={false}>
        {showOptions && settings ? (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="grid gap-5 px-3 pt-5 pb-2 md:grid-cols-2">
              <div className="space-y-4">
                <div>
                  <Label hint={multiple ? "파일 이름으로 개별 생성" : "비우면 자동"}>제목</Label>
                  <Input disabled={multiple} value={multiple ? "" : title} onChange={(e) => setTitle(e.target.value)} placeholder={multiple ? "여러 영상의 제목은 각각 자동으로 정합니다" : "예: 선형대수 7강 — 고유값"} />
                </div>
                <div>
                  <Label hint="AI가 참고합니다">강의 메모</Label>
                  <Textarea
                    rows={3}
                    value={focus}
                    onChange={(e) => setFocus(e.target.value)}
                    placeholder="과목, 수준, 특히 알고 싶은 부분… 예) 대학원 강화학습 수업, 증명 과정을 꼼꼼히"
                  />
                </div>
                {!multiple ? <div>
                  <Label>자막 파일</Label>
                  <div className="flex items-center gap-2">
                    <Button size="sm" disabled={mode === "file" && (!files.length || files[0].status === "done")} onClick={() => chooseSubtitle(mode === "file" ? files[0]?.id ?? null : null)}>
                      <Captions className="size-3.5" />
                      {selectedSubs ? "변경" : ".srt / .vtt 첨부"}
                    </Button>
                    {selectedSubs ? (
                      <span className="flex min-w-0 items-center gap-1 text-[13px] text-muted">
                        <span className="truncate">{selectedSubs.name}</span>
                        <button disabled={mode === "file" && files[0]?.status === "done"} onClick={() => mode === "file" ? setItemSubtitle(files[0].id) : setSubs(null)} aria-label="자막 제거">
                          <X className="size-3.5" />
                        </button>
                      </span>
                    ) : (
                      <span className="text-xs text-faint">있으면 받아쓰기를 건너뜁니다</span>
                    )}
                  </div>
                </div> : <p className="text-xs text-muted">자막은 위 영상 목록에서 개별 첨부하세요. 강의 메모와 분석 설정은 이번에 등록할 모든 영상에 공통으로 적용합니다.</p>}
              </div>
              <div className="space-y-4">
                <div>
                  <Label>분석 모델</Label>
                  <ModelPicker value={analysis ?? settings.analysis} onChange={setAnalysis} compact />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <Label className="mb-1">학습 자료 언어</Label>
                    <Segmented
                      size="sm"
                      value={outputLanguage ?? settings.outputLanguage}
                      onChange={setOutputLanguage}
                      options={OUTPUT_LANGUAGES.map((l) => ({ value: l.id, label: l.label }))}
                    />
                  </div>
                  <label className="flex items-center gap-2 text-[13px] font-medium">
                    화면 분석
                    <Switch checked={visual ?? settings.visualAnalysis} onChange={setVisual} label="화면 분석" />
                  </label>
                </div>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      </fieldset>

      <div className="flex flex-wrap items-center justify-between gap-3 px-3 pt-3 pb-2">
        <div className="min-w-0 flex-1 text-xs text-faint">
          {mode === "file" && files.length ? (
            <span role="status">{completed} / {files.length}개 등록 완료{busy ? " · 등록이 끝날 때까지 이 화면을 열어 두세요" : remaining.some((item) => item.status === "error") ? " · 실패한 파일은 다시 시도하세요" : " · 한 파일씩 업로드합니다"}</span>
          ) : settings ? (
            <span className="hidden truncate sm:block">
              {(analysis ?? settings.analysis).model} · 추론 {(analysis ?? settings.analysis).effort} · {settings.transcription === "local-whisper" ? "로컬 Whisper" : settings.transcription}
            </span>
          ) : null}
        </div>
        {busy && mode === "file" ? <Button size="sm" disabled={stopping} onClick={() => { stopRequested.current = true; setStopping(true); }}>{stopping ? "현재 파일 처리 후 멈춥니다" : "남은 업로드 멈추기"}</Button> : null}
        <Button variant="primary" size="lg" disabled={!ready} loading={busy} onClick={start} className="px-6">
          {mode === "file" && files.length ? busy ? "등록 중" : remaining.length && remaining.every((item) => item.status === "error") ? `${remaining.length}개 다시 시도` : remaining.length ? `${remaining.length}개 강의 등록` : "등록 완료" : "분석 시작"} {!busy ? <ArrowRight className="size-4" /> : null}
        </Button>
      </div>

      <input ref={fileInput} type="file" accept={MEDIA_ACCEPT} multiple disabled={busy} hidden onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
      <input ref={subsInput} type="file" accept=".srt,.vtt" disabled={busy} hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) { if (subtitleTarget.current) setItemSubtitle(subtitleTarget.current, file); else setSubs(file); } e.target.value = ""; }} />
    </div>
  );
}
