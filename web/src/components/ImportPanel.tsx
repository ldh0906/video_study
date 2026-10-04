import { useRef, useState, type DragEvent } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Captions, ChevronDown, FileVideo, FolderOpen, Link2, SlidersHorizontal, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { OUTPUT_LANGUAGES } from "@shared/catalog";
import type { LectureOptions, ModelChoice } from "@shared/types";
import { api, uploadFile } from "@/lib/api";
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
  const [file, setFile] = useState<File | null>(null);
  const [subs, setSubs] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [showOptions, setShowOptions] = useState(false);
  const [title, setTitle] = useState("");
  const [focus, setFocus] = useState("");
  const [analysis, setAnalysis] = useState<ModelChoice | null>(null);
  const [outputLanguage, setOutputLanguage] = useState<string | null>(null);
  const [visual, setVisual] = useState<boolean | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const subsInput = useRef<HTMLInputElement>(null);

  const ready = mode === "file" ? !!file : mode === "url" ? /^https?:\/\//i.test(url.trim()) : localPath.trim().length > 2;

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    for (const f of Array.from(e.dataTransfer.files)) {
      if (/\.(srt|vtt)$/i.test(f.name)) setSubs(f);
      else setFile(f);
    }
    setMode("file");
  };

  const start = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      let source: { kind: "upload" | "path" | "url"; value: string; uploadId?: string };
      if (mode === "file" && file) {
        setUploadProgress(0);
        const { uploadId } = await uploadFile(file, setUploadProgress);
        source = { kind: "upload", value: file.name, uploadId };
      } else if (mode === "url") {
        source = { kind: "url", value: url.trim() };
      } else {
        source = { kind: "path", value: localPath.trim() };
      }
      let subtitleUploadId: string | undefined;
      if (subs) subtitleUploadId = (await uploadFile(subs, () => {})).uploadId;
      const options: Partial<LectureOptions> = { focus: focus.trim() };
      if (analysis) options.analysis = analysis;
      if (outputLanguage) options.outputLanguage = outputLanguage;
      if (visual !== null) options.visualAnalysis = visual;
      const lecture = await api.createLecture({ source, title: title.trim() || undefined, subtitleUploadId, options });
      qc.invalidateQueries({ queryKey: ["lectures"] });
      navigate(`/lecture/${lecture.id}`);
    } catch (e) {
      toast.error("시작하지 못했습니다", { description: (e as Error).message });
    } finally {
      setBusy(false);
      setUploadProgress(null);
    }
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
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
          <span className="hidden sm:inline">이 강의 설정</span>
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
            {file ? (
              <>
                <div className="flex size-12 items-center justify-center rounded-2xl bg-accent text-accent-fg">
                  <FileVideo className="size-6" />
                </div>
                <div>
                  <div className="max-w-[440px] truncate text-[15px] font-semibold">{file.name}</div>
                  <div className="mt-0.5 text-[13px] text-muted">{fmtSize(file.size)} · 다른 파일을 고르려면 클릭</div>
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
      </div>

      <AnimatePresence initial={false}>
        {showOptions && settings ? (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="grid gap-5 px-3 pt-5 pb-2 md:grid-cols-2">
              <div className="space-y-4">
                <div>
                  <Label hint="비우면 자동">제목</Label>
                  <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 선형대수 7강 — 고유값" />
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
                <div>
                  <Label>자막 파일</Label>
                  <div className="flex items-center gap-2">
                    <Button size="sm" onClick={() => subsInput.current?.click()}>
                      <Captions className="size-3.5" />
                      {subs ? "변경" : ".srt / .vtt 첨부"}
                    </Button>
                    {subs ? (
                      <span className="flex min-w-0 items-center gap-1 text-[13px] text-muted">
                        <span className="truncate">{subs.name}</span>
                        <button onClick={() => setSubs(null)} aria-label="자막 제거">
                          <X className="size-3.5" />
                        </button>
                      </span>
                    ) : (
                      <span className="text-xs text-faint">있으면 받아쓰기를 건너뜁니다</span>
                    )}
                  </div>
                </div>
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

      <div className="flex items-center justify-between gap-3 px-3 pt-3 pb-2">
        <div className="min-w-0 flex-1 text-xs text-faint">
          {uploadProgress !== null ? (
            <div className="flex items-center gap-3">
              <Progress value={uploadProgress} className="max-w-[240px] flex-1" />
              <span className="tabular-nums">업로드 {Math.round(uploadProgress * 100)}%</span>
            </div>
          ) : settings ? (
            <span className="hidden truncate sm:block">
              {(analysis ?? settings.analysis).model} · 추론 {(analysis ?? settings.analysis).effort} · {settings.transcription === "local-whisper" ? "로컬 Whisper" : settings.transcription}
            </span>
          ) : null}
        </div>
        <Button variant="primary" size="lg" disabled={!ready} loading={busy} onClick={start} className="px-6">
          분석 시작 {!busy ? <ArrowRight className="size-4" /> : null}
        </Button>
      </div>

      <input ref={fileInput} type="file" accept={MEDIA_ACCEPT} hidden onChange={(e) => e.target.files?.[0] && setFile(e.target.files[0])} />
      <input ref={subsInput} type="file" accept=".srt,.vtt" hidden onChange={(e) => e.target.files?.[0] && setSubs(e.target.files[0])} />
    </div>
  );
}
