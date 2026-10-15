import { useMemo, useState } from "react";
import { AudioLines, ClipboardList, FileText } from "lucide-react";
import { toast } from "sonner";
import { DOC_TYPE_INFO, DOC_TYPE_ORDER } from "@shared/doctypes";
import type { Exam, ExamConfig, Folder } from "@shared/types";
import { Button, Dialog, Input, Label, Segmented, Textarea } from "@/components/ui";
import { api, type LectureSummary } from "@/lib/api";
import { cn } from "@/lib/utils";

const STYLES: { value: ExamConfig["style"]; label: string; count: number; minutes: number; hint: string }[] = [
  { value: "quiz", label: "쪽지시험", count: 10, minutes: 20, hint: "핵심 개념 위주로 짧게" },
  { value: "midterm", label: "중간고사", count: 20, minutes: 75, hint: "이해·적용 중심, 고르게" },
  { value: "final", label: "기말고사", count: 25, minutes: 100, hint: "여러 주제를 잇는 응용·분석까지" },
];

/** Group order in the source list: lectures first, then documents by how the course uses them. */
const groupOf = (l: LectureSummary) => (l.kind === "doc" ? DOC_TYPE_ORDER.indexOf(l.docType ?? "other") + 1 : 0);

/**
 * Pick the sources and the shape of a mock exam. The server plans coverage
 * from what the course emphasizes (lecture time, "시험에 나와요" cues,
 * assignments, labs and past exams), writes the questions and has a second
 * model check them.
 */
export function ExamBuilder({
  folder,
  items,
  initial,
  onClose,
  onCreated,
}: {
  folder: Folder | null;
  items: LectureSummary[];
  initial: string[];
  onClose: () => void;
  onCreated: (e: Exam) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initial.length ? initial : items.map((l) => l.id)));
  const [style, setStyle] = useState<ExamConfig["style"]>("midterm");
  const [count, setCount] = useState(20);
  const [minutes, setMinutes] = useState(75);
  const [mcq, setMcq] = useState(50);
  const [difficulty, setDifficulty] = useState<ExamConfig["difficulty"]>("mixed");
  const [focus, setFocus] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const sorted = useMemo(() => [...items].sort((a, b) => groupOf(a) - groupOf(b) || a.createdAt - b.createdAt), [items]);

  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const create = async () => {
    setBusy(true);
    try {
      const exam = await api.createExam({
        folderId: folder?.id ?? null,
        title: title.trim() || undefined,
        config: { lectureIds: [...picked], style, count, minutes, difficulty, mcqShare: mcq / 100, focus: focus.trim() },
      });
      toast.success("시험을 만들기 시작했어요", { description: "출제 설계 → 문항 작성 → 검토 순서로 몇 분 걸려요." });
      onCreated(exam);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      title={folder ? `“${folder.name}” 모의고사 만들기` : "모의고사 만들기"}
      description="고른 자료 전체를 보고, 교수님이 강조한 부분·과제·실습·기출 비중에 맞춰 출제해요. 다른 모델이 정답과 보기를 한 번 더 검토합니다."
      className="max-w-[760px]"
      footer={
        <Button variant="primary" loading={busy} disabled={!picked.size} onClick={create}>
          <ClipboardList className="size-4" /> {count}문항 만들기
        </Button>
      }
    >
      <div className="grid gap-6 md:grid-cols-[1.1fr_1fr]">
        <div className="min-w-0">
          <div className="mb-2 flex items-center justify-between">
            <Label className="mb-0">출제 범위</Label>
            <div className="flex gap-2 text-[12px]">
              <button className="text-accent hover:underline" onClick={() => setPicked(new Set(items.map((l) => l.id)))}>
                전체
              </button>
              <button className="text-muted hover:underline" onClick={() => setPicked(new Set())}>
                비우기
              </button>
            </div>
          </div>
          {items.length ? (
            <ul className="max-h-[360px] space-y-1 overflow-y-auto rounded-xl border border-border p-1.5">
              {sorted.map((l) => {
                const type = l.kind === "doc" ? DOC_TYPE_INFO[l.docType ?? "other"] : null;
                const on = picked.has(l.id);
                return (
                  <li key={l.id}>
                    <label className={cn("flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors", on ? "bg-accent-soft" : "hover:bg-surface-2")}>
                      <input type="checkbox" checked={on} onChange={() => toggle(l.id)} className="size-4 accent-[var(--accent)]" />
                      {type ? <FileText className="size-4 shrink-0" style={{ color: type.color }} /> : <AudioLines className="size-4 shrink-0 text-accent" />}
                      <span className="min-w-0 flex-1 truncate text-[13px]">{l.title}</span>
                      <span className="shrink-0 rounded-full px-1.5 text-[11px] font-semibold" style={{ color: type?.color ?? "var(--accent)" }}>
                        {type?.label ?? "영상"}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="rounded-xl border border-dashed border-border p-6 text-center text-[13px] text-muted">분석이 끝난 자료가 아직 없어요.</p>
          )}
          <p className="mt-2 text-[12px] text-muted">기출·예시 시험 PDF를 넣으면 그 문제 스타일을 따라 해요.</p>
        </div>

        <div className="space-y-4">
          <div>
            <Label>시험 종류</Label>
            <Segmented
              value={style}
              onChange={(v) => {
                const s = STYLES.find((x) => x.value === v)!;
                setStyle(v);
                setCount(s.count);
                setMinutes(s.minutes);
              }}
              options={STYLES.map((s) => ({ value: s.value, label: s.label }))}
            />
            <p className="mt-1.5 text-[12px] text-muted">{STYLES.find((s) => s.value === style)!.hint}</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label hint={`${count}문항`}>문항 수</Label>
              <input type="range" min={5} max={40} value={count} onChange={(e) => setCount(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
            </div>
            <div>
              <Label hint={`${minutes}분`}>시간</Label>
              <input type="range" min={10} max={180} step={5} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
            </div>
          </div>
          <div>
            <Label hint={`객관식 ${mcq}% · 서술형 ${100 - mcq}%`}>문항 구성</Label>
            <input type="range" min={0} max={100} step={10} value={mcq} onChange={(e) => setMcq(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
          </div>
          <div>
            <Label>난이도</Label>
            <Segmented
              size="sm"
              value={difficulty}
              onChange={setDifficulty}
              options={[
                { value: "easy", label: "쉽게" },
                { value: "mixed", label: "고르게" },
                { value: "hard", label: "어렵게" },
              ]}
            />
          </div>
          <div>
            <Label hint="선택">요청</Label>
            <Textarea rows={2} value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="예) 3~5주차 위주로, 계산 문제 많이" />
          </div>
          <div>
            <Label hint="비우면 자동">제목</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 컴퓨터구조 중간고사 대비 1회" />
          </div>
        </div>
      </div>
    </Dialog>
  );
}
