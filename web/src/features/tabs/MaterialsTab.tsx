import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { AlertTriangle, ArrowLeft, BookOpenCheck, Copy, Download, FileQuestion, Lightbulb, NotebookText, PenLine, Printer, ScrollText, Sparkles, Trash2, Wand2 } from "lucide-react";
import { toast } from "sonner";
import type { Lecture, Material, MaterialKind } from "@shared/types";
import { Markdown } from "@/components/Markdown";
import { Button, Dialog, Input, Label, Spinner, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { downloadText, relativeDate } from "@/lib/utils";

const PRESETS: { kind: MaterialKind; title: string; description: string; icon: React.ReactNode; input?: { label: string; placeholder: string; required?: boolean } }[] = [
  { kind: "cheatsheet", title: "한 장 요약 노트", description: "시험 직전에 보는 공식·정의·절차 압축본", icon: <ScrollText /> },
  {
    kind: "deepdive",
    title: "심화 해설",
    description: "어려운 개념을 직관 → 정의 → 예제 순으로 깊게",
    icon: <Lightbulb />,
    input: { label: "특히 파고들 주제 (선택)", placeholder: "비우면 강의에서 가장 어려운 개념들을 골라요" },
  },
  { kind: "practice", title: "연습 문제", description: "기초부터 응용까지, 단계별 풀이 포함", icon: <PenLine /> },
  { kind: "exam", title: "예상 시험 문제", description: "강조된 내용 중심 · 모범 답안과 채점 포인트", icon: <BookOpenCheck /> },
  { kind: "faq", title: "자주 묻는 질문", description: "학생들이 헷갈려 할 질문과 답", icon: <FileQuestion /> },
  {
    kind: "custom",
    title: "원하는 자료 요청",
    description: "비교표, 코드 예제, 발표 대본… 무엇이든",
    icon: <Wand2 />,
    input: { label: "어떤 자료가 필요한가요?", placeholder: "예) 강의에 나온 알고리즘들을 시간복잡도 기준으로 비교한 표와 파이썬 예제", required: true },
  },
];

export function MaterialsTab({ lecture }: { lecture: Lecture }) {
  const qc = useQueryClient();
  const { data: materials = [] } = useQuery({
    queryKey: ["materials", lecture.id],
    queryFn: () => api.materials(lecture.id),
    refetchInterval: (q) => (q.state.data?.some((m) => m.status === "generating") ? 1000 : false),
  });
  const [openId, setOpenId] = useState<string | null>(null);
  const [asking, setAsking] = useState<(typeof PRESETS)[number] | null>(null);
  const [prompt, setPrompt] = useState("");
  const create = useMutation({
    mutationFn: ({ kind, prompt }: { kind: MaterialKind; prompt: string }) => api.createMaterial(lecture.id, kind, prompt),
    onSuccess: (m) => {
      qc.invalidateQueries({ queryKey: ["materials", lecture.id] });
      setAsking(null);
      setPrompt("");
      setOpenId(m.id);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const open = materials.find((m) => m.id === openId);

  if (open) return <MaterialReader lecture={lecture} material={open} onBack={() => setOpenId(null)} />;

  return (
    <div className="mx-auto max-w-[760px] px-1 pb-16">
      <div className="mb-5">
        <h3 className="font-serif text-[20px] font-semibold">학습 자료 만들기</h3>
        <p className="mt-0.5 text-[13px] text-muted">강의 전체 노트를 바탕으로 필요한 자료를 만들어요. 만든 자료는 여기에 보관됩니다.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {PRESETS.map((p, i) => (
          <motion.button
            key={p.kind}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04 }}
            onClick={() => (p.input ? setAsking(p) : create.mutate({ kind: p.kind, prompt: "" }))}
            disabled={create.isPending}
            className="group flex gap-3.5 rounded-2xl border border-border bg-surface p-4 text-left transition-all hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-soft disabled:opacity-60"
          >
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent transition-colors group-hover:bg-accent group-hover:text-accent-fg [&>svg]:size-5">{p.icon}</div>
            <div className="min-w-0">
              <div className="text-[14px] font-semibold">{p.title}</div>
              <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{p.description}</div>
            </div>
          </motion.button>
        ))}
      </div>

      {materials.length ? (
        <section className="mt-10">
          <h4 className="mb-3 flex items-center gap-2 text-[13px] font-semibold tracking-wide text-muted">
            <NotebookText className="size-4 text-accent" /> 내 자료 {materials.length}
          </h4>
          <div className="space-y-2">
            {materials.map((m) => (
              <button
                key={m.id}
                onClick={() => setOpenId(m.id)}
                className="flex w-full items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3 text-left transition-colors hover:border-border-strong"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium">{m.title}</div>
                  <div className="mt-0.5 text-xs text-muted">
                    {m.status === "generating" ? "만드는 중…" : m.status === "error" ? "실패" : `${relativeDate(m.createdAt)} · ${m.model}`}
                  </div>
                </div>
                {m.status === "generating" ? <Spinner /> : m.status === "error" ? <AlertTriangle className="size-4 text-danger" /> : null}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <Dialog
        open={asking !== null}
        onOpenChange={(v) => !v && setAsking(null)}
        title={asking?.title ?? ""}
        footer={
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={asking?.input?.required && !prompt.trim()}
            onClick={() => asking && create.mutate({ kind: asking.kind, prompt: prompt.trim() })}
          >
            <Sparkles className="size-3.5" /> 만들기
          </Button>
        }
      >
        <Label>{asking?.input?.label}</Label>
        {asking?.kind === "custom" ? (
          <Textarea rows={4} autoFocus value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={asking?.input?.placeholder} />
        ) : (
          <Input autoFocus value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={asking?.input?.placeholder} />
        )}
      </Dialog>
    </div>
  );
}

function MaterialReader({ lecture, material: m, onBack }: { lecture: Lecture; material: Material; onBack: () => void }) {
  const qc = useQueryClient();
  return (
    <div className="mx-auto max-w-[760px] px-1 pb-16">
      <div className="no-print sticky top-0 z-10 -mx-1 mb-4 flex items-center gap-2 bg-bg/85 px-1 py-2 backdrop-blur">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" /> 자료 목록
        </Button>
        <div className="flex-1" />
        {m.status === "done" ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                navigator.clipboard.writeText(m.content);
                toast.success("복사했습니다");
              }}
            >
              <Copy className="size-3.5" /> 복사
            </Button>
            <Button variant="ghost" size="sm" onClick={() => downloadText(`${lecture.title} - ${m.title}.md`, `# ${m.title}\n\n${m.content}`)}>
              <Download className="size-3.5" /> .md
            </Button>
            <Button variant="ghost" size="sm" onClick={() => window.print()}>
              <Printer className="size-3.5" /> 인쇄
            </Button>
          </>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="삭제"
          onClick={async () => {
            if (!confirm("이 자료를 삭제할까요?")) return;
            await api.deleteMaterial(lecture.id, m.id);
            qc.invalidateQueries({ queryKey: ["materials", lecture.id] });
            onBack();
          }}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <h2 className="font-serif text-[26px] leading-snug font-semibold tracking-tight">{m.title}</h2>
      {m.prompt ? <p className="mt-1.5 text-[13.5px] text-muted">요청: {m.prompt}</p> : null}
      <div className="mt-6 rounded-2xl border border-border bg-surface p-6 shadow-soft sm:p-8">
        {m.status === "error" ? (
          <div className="flex gap-2 text-[13.5px] text-danger">
            <AlertTriangle className="size-4 shrink-0" /> {m.error}
          </div>
        ) : m.content ? (
          <Markdown streaming={m.status === "generating"}>{m.content}</Markdown>
        ) : (
          <div className="flex items-center gap-2 text-[13.5px] text-muted">
            <Spinner /> 강의 노트를 읽고 자료를 구성하는 중… (모델과 추론 강도에 따라 몇 분 걸릴 수 있어요)
          </div>
        )}
      </div>
    </div>
  );
}
