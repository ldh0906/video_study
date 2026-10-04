import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpenCheck, Download, ExternalLink, Eye, FileDown, FileUp, Keyboard, NotebookPen, PenLine, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { EXPORT_PRESETS, presetOptions } from "@shared/export";
import type { ExportOptions, ExportResult, Lecture } from "@shared/types";
import { Badge, Button, Dialog, Label, Segmented, Spinner, Switch } from "@/components/ui";
import { api } from "@/lib/api";
import { cn, relativeDate } from "@/lib/utils";

function fmtBytes(n: number) {
  return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1000)} KB`;
}

/** Tiny page schematics so the layout choice is visual rather than verbal. */
function LayoutThumb({ kind }: { kind: ExportOptions["layout"] }) {
  return (
    <div className="relative h-[54px] w-[40px] rounded-[3px] border border-border-strong bg-surface p-[4px]">
      {kind === "margin" ? (
        <>
          <div className="absolute inset-y-[4px] left-[4px] w-[19px] space-y-[3px]">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="h-[2px] rounded bg-faint/60" />
            ))}
          </div>
          <div className="absolute inset-y-[4px] right-[4px] w-[11px] rounded-[2px] bg-[radial-gradient(var(--faint)_0.6px,transparent_0.7px)] [background-size:3px_3px]" />
        </>
      ) : kind === "cornell" ? (
        <>
          <div className="absolute top-[4px] bottom-[14px] left-[4px] w-[9px] space-y-[3px] border-r border-faint/70 pr-[1px]">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-[2px] rounded bg-accent/60" />
            ))}
          </div>
          <div className="absolute top-[4px] right-[4px] bottom-[14px] left-[16px] space-y-[3px]">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-[2px] rounded bg-faint/60" />
            ))}
          </div>
          <div className="absolute inset-x-[4px] bottom-[4px] h-[8px] rounded-[2px] border border-dashed border-faint" />
        </>
      ) : (
        <div className="space-y-[2.5px]">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="h-[2px] rounded bg-faint/60" />
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ label, hint, checked, onChange, disabled }: { label: ReactNode; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={cn("flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-2", disabled && "pointer-events-none opacity-40")}>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium">{label}</span>
        {hint ? <span className="block text-[11.5px] leading-snug text-muted">{hint}</span> : null}
      </span>
      <Switch checked={checked} onChange={onChange} />
    </label>
  );
}

export function ExportDialog({ lecture, open, onOpenChange }: { lecture: Lecture; open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const { data: materials = [] } = useQuery({ queryKey: ["materials", lecture.id], queryFn: () => api.materials(lecture.id), enabled: open });
  const { data: files = [] } = useQuery({ queryKey: ["exports", lecture.id], queryFn: () => api.exports(lecture.id), enabled: open });
  const [o, setO] = useState<ExportOptions>(() => presetOptions("full", []));
  const [result, setResult] = useState<ExportResult | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const importInput = useRef<HTMLInputElement>(null);
  const done = materials.filter((m) => m.status === "done");

  // re-apply the preset once materials are known, so their default selection is right
  useEffect(() => {
    if (open) setO((cur) => ({ ...presetOptions(cur.preset, materials), layout: cur.layout, paper: cur.paper, fields: cur.fields }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, materials.length]);

  const set = (patch: Partial<ExportOptions>) => setO((cur) => ({ ...cur, ...patch }));

  const gen = useMutation({
    mutationFn: () => api.exportPdf(lecture.id, o),
    onSuccess: (r) => {
      setResult(r);
      qc.invalidateQueries({ queryKey: ["exports", lecture.id] });
    },
    onError: (e) => toast.error("PDF를 만들지 못했습니다", { description: (e as Error).message }),
  });
  useEffect(() => {
    if (!gen.isPending) return;
    const t0 = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(t);
  }, [gen.isPending]);

  const importPdf = useMutation({
    mutationFn: (file: File) => api.importPdf(lecture.id, file),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["notes", lecture.id] });
      if (r.imported) toast.success(`메모 ${r.imported}개를 가져왔습니다`, { description: "메모 탭 맨 아래에 추가했어요." });
      else toast.info("가져올 입력 내용이 없습니다", { description: "타이핑용 학습서에 직접 입력한 칸만 가져옵니다." });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const blanksAvailable = o.notes && o.depth === "full";

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="학습서 PDF 만들기"
      description="정답은 부록으로 분리하고, 필기 공간과 회독·복습 칸까지 들어간 공부용 문서를 만듭니다."
      className="max-w-[880px]"
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={() => importInput.current?.click()} loading={importPdf.isPending}>
            {!importPdf.isPending ? <FileUp className="size-3.5" /> : null} 채운 PDF에서 메모 가져오기
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => window.open(api.printUrl(lecture.id, o), "_blank")}>
              <Eye className="size-4" /> 미리보기
            </Button>
            <Button variant="primary" onClick={() => gen.mutate()} loading={gen.isPending}>
              {!gen.isPending ? <FileDown className="size-4" /> : null}
              {gen.isPending ? `조판 중… ${elapsed}초` : "PDF 만들기"}
            </Button>
          </div>
        </div>
      }
    >
      <input
        ref={importInput}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importPdf.mutate(f);
          e.target.value = "";
        }}
      />
      <div className="space-y-6">
        <div className="grid gap-2 sm:grid-cols-4">
          {EXPORT_PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => setO({ ...presetOptions(p.id, materials), paper: o.paper, fields: o.fields })}
              className={cn(
                "rounded-xl border p-3 text-left transition-colors",
                o.preset === p.id ? "border-accent bg-accent-soft" : "border-border hover:border-border-strong",
              )}
            >
              <div className="text-[13.5px] font-semibold">{p.label}</div>
              <div className="mt-0.5 text-[11.5px] leading-snug text-muted">{p.blurb}</div>
            </button>
          ))}
        </div>

        <div className="grid gap-6 md:grid-cols-[1fr_1.15fr]">
          <div className="space-y-5">
            <div>
              <Label>레이아웃</Label>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    ["margin", "필기 여백형", "오른쪽 점 격자 메모 칸"],
                    ["cornell", "코넬형", "단서 질문 · 노트 · 요약"],
                    ["compact", "절약형", "여백 없이 촘촘하게"],
                  ] as const
                ).map(([k, t, d]) => (
                  <button
                    key={k}
                    onClick={() => set({ layout: k })}
                    className={cn("flex flex-col items-center gap-1.5 rounded-xl border p-2.5 text-center transition-colors", o.layout === k ? "border-accent bg-accent-soft" : "border-border hover:border-border-strong")}
                  >
                    <LayoutThumb kind={k} />
                    <span className="text-[12.5px] font-semibold">{t}</span>
                    <span className="text-[10.5px] leading-tight text-muted">{d}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-5">
              <div>
                <Label>용지</Label>
                <Segmented size="sm" value={o.paper} onChange={(paper) => set({ paper })} options={[{ value: "A4", label: "A4" }, { value: "B5", label: "B5" }]} />
              </div>
              <div>
                <Label>메모 방식</Label>
                <Segmented
                  size="sm"
                  value={o.fields ? "type" : "hand"}
                  onChange={(v) => set({ fields: v === "type" })}
                  options={[
                    { value: "hand", label: <span className="flex items-center gap-1"><PenLine className="size-3" />손필기</span> },
                    { value: "type", label: <span className="flex items-center gap-1"><Keyboard className="size-3" />타이핑 칸</span> },
                  ]}
                />
              </div>
            </div>
            <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-[12px] leading-relaxed text-muted">
              {o.fields
                ? "요약·답·여백 칸에 Edge, Acrobat, PDF Expert 등에서 바로 입력할 수 있어요. 굿노트·노타빌리티는 입력 칸을 지원하지 않으니 손필기판을 쓰세요. 다 쓴 PDF는 ‘채운 PDF에서 메모 가져오기’로 앱 메모에 저장됩니다."
                : "아이패드(굿노트·노타빌리티)나 인쇄해서 손으로 쓰는 판입니다. 필기 공간이 PDF 안에 미리 들어 있어요."}
            </p>

            {result ? (
              <div className="rounded-xl border border-success/40 bg-success-soft p-3.5">
                <div className="flex items-center gap-2 text-[13px] font-semibold text-success">
                  <BookOpenCheck className="size-4" /> 완성! {result.pages}쪽 · {fmtBytes(result.bytes)}
                  {result.fields ? ` · 입력 칸 ${result.fields}개` : ""} · {(result.ms / 1000).toFixed(1)}초
                </div>
                <div className="mt-1 truncate text-[12px] text-muted">{result.file}</div>
                <div className="mt-2.5 flex gap-2">
                  <Button size="sm" variant="primary" onClick={() => window.open(api.exportFileUrl(lecture.id, result.file), "_blank")}>
                    <ExternalLink className="size-3.5" /> 열기
                  </Button>
                  <a href={api.exportFileUrl(lecture.id, result.file, true)}>
                    <Button size="sm">
                      <Download className="size-3.5" /> 다운로드
                    </Button>
                  </a>
                </div>
              </div>
            ) : gen.isPending ? (
              <div className="flex items-center gap-2 rounded-xl border border-border p-3.5 text-[13px] text-muted">
                <Spinner /> 쪽을 나누고 쪽 번호를 맞추는 중… 긴 강의는 30초 이상 걸릴 수 있어요.
              </div>
            ) : null}

            {files.length ? (
              <div>
                <Label>내보낸 파일</Label>
                <div className="max-h-[160px] space-y-1 overflow-y-auto">
                  {files.map((f) => (
                    <div key={f.file} className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2">
                      <button className="min-w-0 flex-1 text-left" onClick={() => window.open(api.exportFileUrl(lecture.id, f.file), "_blank")}>
                        <div className="truncate text-[12.5px] font-medium">{f.file.replace(/\.pdf$/, "")}</div>
                        <div className="text-[11px] text-muted">
                          {relativeDate(f.createdAt)} · {fmtBytes(f.bytes)}
                        </div>
                      </button>
                      <a href={api.exportFileUrl(lecture.id, f.file, true)} aria-label="다운로드" className="rounded-md p-1 text-muted hover:text-text">
                        <Download className="size-3.5" />
                      </a>
                      <button
                        aria-label="삭제"
                        className="rounded-md p-1 text-muted opacity-0 group-hover:opacity-100 hover:text-danger"
                        onClick={async () => {
                          await api.deleteExport(lecture.id, f.file);
                          qc.invalidateQueries({ queryKey: ["exports", lecture.id] });
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div className="space-y-4">
            <div>
              <div className="mb-1 px-2 text-[11.5px] font-semibold tracking-wide text-faint">앞부분</div>
              <Row label="표지" checked={o.cover} onChange={(cover) => set({ cover })} />
              <Row label="목차" hint="쪽 번호와 영상 시각" checked={o.toc} onChange={(toc) => set({ toc })} />
              <Row label="사용법 · 복습 일정 · 회독 기록표" checked={o.guide} onChange={(guide) => set({ guide })} />
              <Row label="한눈에 보기" hint="요약, 학습 목표, 선수 지식, 강의 흐름" checked={o.overview} onChange={(overview) => set({ overview })} />
            </div>
            <div>
              <div className="mb-1 px-2 text-[11.5px] font-semibold tracking-wide text-faint">본문</div>
              <Row label="노트" checked={o.notes} onChange={(notes) => set({ notes })} />
              <div className={cn("flex flex-wrap items-center gap-3 px-2 py-1", !o.notes && "pointer-events-none opacity-40")}>
                <Segmented size="sm" value={o.depth} onChange={(depth) => set({ depth })} options={[{ value: "full", label: "전체 노트" }, { value: "key", label: "핵심만" }]} />
                <span className={cn("flex items-center gap-1.5 text-[12px] text-muted", !blanksAvailable && "opacity-40")}>
                  <NotebookPen className="size-3.5" /> 빈칸
                  <Segmented size="sm" value={o.blanks} onChange={(blanks) => set({ blanks })} options={[{ value: "off", label: "끄기" }, { value: "some", label: "일부" }, { value: "all", label: "전부" }]} />
                </span>
              </div>
              <Row label="이해 확인 질문" hint="정답은 부록, → p.N 으로 연결" checked={o.checks} onChange={(checks) => set({ checks })} />
              <Row label="덮고 3문장 요약 칸" checked={o.summaryBox} onChange={(summaryBox) => set({ summaryBox })} />
              <Row label="챕터별 백지 복습 쪽" checked={o.recall} onChange={(recall) => set({ recall })} />
              <Row label="슬라이드·판서 캡처" checked={o.frames} onChange={(frames) => set({ frames })} disabled={!o.notes} />
              <Row label="챕터 QR 코드" hint="인쇄본에서 폰으로 영상 바로 열기 (온라인 강의)" checked={o.qr} onChange={(qr) => set({ qr })} disabled={lecture.source.kind !== "url"} />
            </div>
            <div>
              <div className="mb-1 px-2 text-[11.5px] font-semibold tracking-wide text-faint">뒷부분</div>
              <Row label="종합 문제 + 오답 노트" hint="섹션을 섞은 문제, 확신도·채점 칸" checked={o.quiz} onChange={(quiz) => set({ quiz })} />
              <Row label="용어집" checked={o.glossary} onChange={(glossary) => set({ glossary })} />
              <Row label="개념 구조 + 직접 그리는 개념 지도" checked={o.conceptMap} onChange={(conceptMap) => set({ conceptMap })} />
              <Row label="플래시카드 시트" hint="접어서 답을 가리는 방식" checked={o.cards} onChange={(cards) => set({ cards })} />
              <Row label="내 메모" checked={o.memo} onChange={(memo) => set({ memo })} />
              <Row label="강의 대본 전문" hint="쪽수가 크게 늘어납니다" checked={o.transcript} onChange={(transcript) => set({ transcript })} />
              {done.length ? (
                <div className="px-2 pt-1.5">
                  <div className="mb-1.5 text-[12px] font-medium">학습 자료</div>
                  <div className="flex flex-wrap gap-1.5">
                    {done.map((m) => {
                      const on = o.materials.includes(m.id);
                      return (
                        <button
                          key={m.id}
                          onClick={() => set({ materials: on ? o.materials.filter((x) => x !== m.id) : [...o.materials, m.id] })}
                          className={cn("rounded-lg border px-2.5 py-1 text-[12px] transition-colors", on ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:text-text")}
                        >
                          {m.title}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              <div className="flex items-center justify-between px-2 pt-2.5">
                <span className="text-[13px] font-medium">빈 노트 쪽</span>
                <Segmented size="sm" value={String(o.blankPages)} onChange={(v) => set({ blankPages: Number(v) })} options={["0", "2", "4", "8"].map((v) => ({ value: v, label: v }))} />
              </div>
            </div>
            <div className="px-2">
              <Badge tone="accent">정답·해설은 항상 부록으로 분리됩니다</Badge>
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
