import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { ArrowLeft, ArrowRight, Check, ChevronRight, ClipboardCheck, Eye, Plus, RotateCcw, Sparkles, Trash2, Trophy, X } from "lucide-react";
import { toast } from "sonner";
import type { GradeResult, Lecture, Quiz, QuizQuestion } from "@shared/types";
import { Markdown, TimeChip } from "@/components/Markdown";
import { Badge, Button, Dialog, EmptyState, Input, Label, Progress, Segmented, Spinner, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { cn, relativeDate } from "@/lib/utils";

interface Answer {
  choice?: number;
  text?: string;
  revealed: boolean;
  correct?: boolean;
  grade?: GradeResult;
}

type Attempt = Record<string, Answer>;

const attemptKey = (lectureId: string, quizId: string) => `quiz:${lectureId}:${quizId}`;

function loadAttempt(lectureId: string, quizId: string): Attempt {
  try {
    return JSON.parse(localStorage.getItem(attemptKey(lectureId, quizId)) ?? "{}");
  } catch {
    return {};
  }
}

const DIFF_LABEL = { easy: "쉬움", medium: "보통", hard: "어려움" } as const;

export function QuizTab({ lecture }: { lecture: Lecture }) {
  const { data: quizzes = [], isLoading } = useQuery({ queryKey: ["quizzes", lecture.id], queryFn: () => api.quizzes(lecture.id) });
  const [active, setActive] = useState<string | null>(null);
  const [genOpen, setGenOpen] = useState(false);
  const quiz = quizzes.find((q) => q.id === active);

  if (isLoading) return <div className="flex justify-center py-16"><Spinner /></div>;

  return (
    <div className="mx-auto max-w-[720px] px-1 pb-16">
      {quiz ? (
        <QuizRunner lecture={lecture} quiz={quiz} onBack={() => setActive(null)} />
      ) : (
        <>
          <div className="mb-5 flex items-center justify-between">
            <div>
              <h3 className="font-serif text-[20px] font-semibold">퀴즈</h3>
              <p className="mt-0.5 text-[13px] text-muted">풀어보면서 이해했는지 확인하세요. 틀린 문제는 해설과 영상 장면으로 바로 복습할 수 있어요.</p>
            </div>
            <Button variant="soft" size="sm" onClick={() => setGenOpen(true)}>
              <Plus className="size-3.5" /> 새 퀴즈
            </Button>
          </div>
          {quizzes.length === 0 ? (
            <EmptyState icon={<ClipboardCheck />} title="아직 퀴즈가 없어요" description="분석이 끝나면 기본 퀴즈가 만들어집니다." />
          ) : (
            <div className="space-y-2.5">
              {quizzes.map((q) => (
                <QuizRow key={q.id} lecture={lecture} quiz={q} onOpen={() => setActive(q.id)} />
              ))}
            </div>
          )}
        </>
      )}
      <GenerateQuiz lecture={lecture} open={genOpen} onOpenChange={setGenOpen} onCreated={(q) => setActive(q.id)} />
    </div>
  );
}

function QuizRow({ lecture, quiz, onOpen }: { lecture: Lecture; quiz: Quiz; onOpen: () => void }) {
  const qc = useQueryClient();
  const attempt = loadAttempt(lecture.id, quiz.id);
  const answered = quiz.questions.filter((q) => attempt[q.id]?.revealed).length;
  const correct = quiz.questions.filter((q) => attempt[q.id]?.correct).length;
  return (
    <div className="group flex items-center gap-4 rounded-2xl border border-border bg-surface p-4 transition-colors hover:border-border-strong">
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-4 text-left">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <ClipboardCheck className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14.5px] font-semibold">{quiz.title}</div>
          <div className="mt-0.5 text-xs text-muted">
            {quiz.questions.length}문제 · {relativeDate(quiz.createdAt)}
            {answered ? ` · ${answered === quiz.questions.length ? `완료 ${correct}/${quiz.questions.length}` : `${answered}문제 풀이 중`}` : ""}
          </div>
          {answered ? <Progress value={answered / quiz.questions.length} className="mt-2 h-1 max-w-[220px]" /> : null}
        </div>
        <ChevronRight className="size-4 text-faint" />
      </button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="opacity-0 group-hover:opacity-100"
        aria-label="삭제"
        onClick={async () => {
          if (!confirm(`“${quiz.title}”을 삭제할까요?`)) return;
          await api.deleteQuiz(lecture.id, quiz.id);
          localStorage.removeItem(attemptKey(lecture.id, quiz.id));
          qc.invalidateQueries({ queryKey: ["quizzes", lecture.id] });
        }}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}

function QuizRunner({ lecture, quiz, onBack }: { lecture: Lecture; quiz: Quiz; onBack: () => void }) {
  const [attempt, setAttempt] = useState<Attempt>(() => loadAttempt(lecture.id, quiz.id));
  // when retrying wrong answers, the run is limited to this subset of question ids
  const [subset, setSubset] = useState<string[] | null>(null);
  const questions = useMemo(() => (subset ? quiz.questions.filter((q) => subset.includes(q.id)) : quiz.questions), [quiz, subset]);
  const [idx, setIdx] = useState(() => {
    const first = quiz.questions.findIndex((q) => !loadAttempt(lecture.id, quiz.id)[q.id]?.revealed);
    return first < 0 ? quiz.questions.length : first;
  });

  useEffect(() => {
    try {
      localStorage.setItem(attemptKey(lecture.id, quiz.id), JSON.stringify(attempt));
    } catch {}
  }, [attempt, lecture.id, quiz.id]);

  const update = (qid: string, a: Partial<Answer>) => setAttempt((s) => ({ ...s, [qid]: { ...(s[qid] ?? { revealed: false }), ...a } }));
  const finished = idx >= questions.length;
  const answered = quiz.questions.filter((q) => attempt[q.id]?.revealed);
  const score = answered.filter((q) => attempt[q.id]?.correct).length;

  const restart = (wrongOnly: boolean) => {
    if (wrongOnly) {
      const wrong = quiz.questions.filter((q) => attempt[q.id]?.revealed && !attempt[q.id]?.correct);
      setAttempt((s) => {
        const next = { ...s };
        for (const q of wrong) delete next[q.id];
        return next;
      });
      setSubset(wrong.map((q) => q.id));
    } else {
      setAttempt({});
      setSubset(null);
    }
    setIdx(0);
  };

  return (
    <div>
      <div className="mb-5 flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="목록으로">
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold">{quiz.title}</div>
          <Progress value={Math.min(idx, questions.length) / Math.max(1, questions.length)} className="mt-1.5 h-1" />
        </div>
        <span className="text-[12.5px] font-medium text-muted tabular-nums">
          {Math.min(idx + 1, questions.length)} / {questions.length}
        </span>
      </div>

      {finished ? (
        <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} className="rounded-3xl border border-border bg-surface p-8 text-center shadow-soft">
          <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-2xl bg-accent-soft text-accent">
            <Trophy className="size-8" />
          </div>
          <div className="font-serif text-[40px] leading-none font-semibold tabular-nums">
            {score}
            <span className="text-[22px] text-faint"> / {answered.length}</span>
          </div>
          <p className="mt-3 text-[14px] text-muted">
            {answered.length === 0
              ? "아직 푼 문제가 없어요."
              : score === answered.length
                ? "완벽해요! 이 강의는 확실히 이해했네요."
                : score / answered.length >= 0.7
                  ? "잘했어요. 틀린 문제만 다시 보면 완벽해질 거예요."
                  : "괜찮아요. 해설과 영상 장면으로 복습한 뒤 다시 도전해 보세요."}
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            {score < answered.length ? (
              <Button variant="primary" onClick={() => restart(true)}>
                <RotateCcw className="size-3.5" /> 틀린 문제 다시 풀기
              </Button>
            ) : null}
            <Button onClick={() => restart(false)}>처음부터 다시</Button>
          </div>
          <div className="mt-8 space-y-2 text-left">
            {quiz.questions.map((q, i) => {
              const a = attempt[q.id];
              return (
                <button
                  key={q.id}
                  onClick={() => {
                    setSubset(null);
                    setIdx(i);
                  }}
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-surface-2"
                >
                  <span
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold",
                      !a?.revealed ? "bg-surface-3 text-faint" : a.correct ? "bg-success-soft text-success" : "bg-danger-soft text-danger",
                    )}
                  >
                    {!a?.revealed ? i + 1 : a.correct ? <Check className="size-3.5" /> : <X className="size-3.5" />}
                  </span>
                  <span className="line-clamp-1 text-[13.5px]">{q.question.replace(/[$*`#]/g, "")}</span>
                </button>
              );
            })}
          </div>
        </motion.div>
      ) : (
        <QuestionCard
          key={questions[idx].id}
          lecture={lecture}
          quiz={quiz}
          q={questions[idx]}
          answer={attempt[questions[idx].id]}
          onAnswer={(a) => update(questions[idx].id, a)}
          onPrev={idx > 0 ? () => setIdx(idx - 1) : undefined}
          onNext={() => setIdx(idx + 1)}
        />
      )}
    </div>
  );
}

function QuestionCard({
  lecture,
  quiz,
  q,
  answer,
  onAnswer,
  onPrev,
  onNext,
}: {
  lecture: Lecture;
  quiz: Quiz;
  q: QuizQuestion;
  answer?: Answer;
  onAnswer: (a: Partial<Answer>) => void;
  onPrev?: () => void;
  onNext: () => void;
}) {
  const [text, setText] = useState(answer?.text ?? "");
  const revealed = answer?.revealed ?? false;
  const grade = useMutation({
    mutationFn: () => api.grade(lecture.id, quiz.id, q.id, text),
    onSuccess: (g) => onAnswer({ text, grade: g, revealed: true, correct: g.verdict === "correct" || g.score >= 80 }),
    onError: (e) => toast.error((e as Error).message),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "TEXTAREA" || t.tagName === "INPUT") return;
      if (q.type === "mcq" && !revealed && /^[1-9]$/.test(e.key)) {
        const i = Number(e.key) - 1;
        if (i < q.options.length) onAnswer({ choice: i, revealed: true, correct: i === q.answerIndex });
      } else if (revealed && e.key === "Enter") onNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <motion.div initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.25 }}>
      <div className="rounded-3xl border border-border bg-surface p-6 shadow-soft sm:p-7">
        <div className="mb-4 flex items-center gap-2">
          <Badge tone={q.type === "mcq" ? "accent" : "warning"}>{q.type === "mcq" ? "객관식" : "서술형"}</Badge>
          <Badge>{DIFF_LABEL[q.difficulty]}</Badge>
        </div>
        <Markdown className="text-[16.5px] font-medium [&_p]:text-[16.5px]">{q.question}</Markdown>

        {q.type === "mcq" ? (
          <div className="mt-6 space-y-2.5">
            {q.options.map((o, i) => {
              const chosen = answer?.choice === i;
              const isAnswer = i === q.answerIndex;
              return (
                <button
                  key={i}
                  disabled={revealed}
                  onClick={() => onAnswer({ choice: i, revealed: true, correct: i === q.answerIndex })}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-2xl border px-4 py-3 text-left transition-all",
                    !revealed && "border-border hover:-translate-y-px hover:border-accent hover:bg-accent-soft",
                    revealed && isAnswer && "border-success bg-success-soft",
                    revealed && chosen && !isAnswer && "border-danger bg-danger-soft",
                    revealed && !chosen && !isAnswer && "border-border opacity-60",
                  )}
                >
                  <span
                    className={cn(
                      "mt-px flex size-6 shrink-0 items-center justify-center rounded-lg text-[12px] font-bold",
                      revealed && isAnswer ? "bg-success text-white" : revealed && chosen ? "bg-danger text-white" : "bg-surface-2 text-muted",
                    )}
                  >
                    {revealed && isAnswer ? <Check className="size-3.5" /> : revealed && chosen ? <X className="size-3.5" /> : i + 1}
                  </span>
                  <Markdown className="min-w-0 flex-1 text-[14.5px] [&_p]:text-[14.5px]">{o}</Markdown>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="mt-6">
            <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} disabled={revealed} placeholder="답을 적어 보세요. 수식은 $x^2$ 처럼 쓸 수 있어요." />
            {!revealed ? (
              <div className="mt-3 flex gap-2">
                <Button variant="primary" loading={grade.isPending} disabled={!text.trim()} onClick={() => grade.mutate()}>
                  <Sparkles className="size-3.5" /> AI 채점
                </Button>
                <Button variant="ghost" onClick={() => onAnswer({ text, revealed: true, correct: false })}>
                  <Eye className="size-3.5" /> 정답 보기
                </Button>
              </div>
            ) : null}
          </div>
        )}

        {revealed ? (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mt-6 space-y-4 border-t border-border pt-5">
            {answer?.grade ? (
              <div className={cn("rounded-2xl p-4", answer.grade.verdict === "correct" ? "bg-success-soft" : answer.grade.verdict === "partial" ? "bg-warning-soft" : "bg-danger-soft")}>
                <div className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold">
                  {answer.grade.verdict === "correct" ? "정답이에요" : answer.grade.verdict === "partial" ? "부분 정답" : "아쉬워요"}
                  <span className="text-muted tabular-nums">{answer.grade.score}점</span>
                </div>
                <Markdown className="text-[13.5px]">{answer.grade.feedback}</Markdown>
              </div>
            ) : q.type === "mcq" ? (
              <div className={cn("text-[14px] font-semibold", answer?.correct ? "text-success" : "text-danger")}>{answer?.correct ? "정답입니다!" : "오답이에요"}</div>
            ) : null}
            {q.type === "short" ? (
              <div>
                <div className="mb-1 text-[12px] font-semibold tracking-wide text-muted">모범 답안</div>
                <Markdown>{q.answer}</Markdown>
              </div>
            ) : null}
            <div>
              <div className="mb-1 text-[12px] font-semibold tracking-wide text-muted">해설</div>
              <Markdown>{q.explanation}</Markdown>
            </div>
            {q.time !== null ? <TimeChip time={q.time}>영상에서 다시 보기</TimeChip> : null}
          </motion.div>
        ) : null}
      </div>
      <div className="mt-4 flex justify-between">
        <Button variant="ghost" onClick={onPrev} disabled={!onPrev}>
          <ArrowLeft className="size-4" /> 이전
        </Button>
        <Button variant={revealed ? "primary" : "ghost"} onClick={onNext}>
          {revealed ? "다음" : "건너뛰기"} <ArrowRight className="size-4" />
        </Button>
      </div>
    </motion.div>
  );
}

function GenerateQuiz({ lecture, open, onOpenChange, onCreated }: { lecture: Lecture; open: boolean; onOpenChange: (v: boolean) => void; onCreated: (q: Quiz) => void }) {
  const qc = useQueryClient();
  const [count, setCount] = useState("10");
  const [difficulty, setDifficulty] = useState("mixed");
  const [focus, setFocus] = useState("");
  const gen = useMutation({
    mutationFn: () => api.generateQuiz(lecture.id, { count: Number(count), difficulty, focus }),
    onSuccess: (q) => {
      qc.invalidateQueries({ queryKey: ["quizzes", lecture.id] });
      onOpenChange(false);
      setFocus("");
      onCreated(q);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="새 퀴즈 만들기"
      footer={
        <Button variant="primary" loading={gen.isPending} onClick={() => gen.mutate()}>
          <Sparkles className="size-3.5" /> {gen.isPending ? "만드는 중…" : "만들기"}
        </Button>
      }
    >
      <div className="space-y-4">
        <div>
          <Label>문제 수</Label>
          <Segmented value={count} onChange={setCount} options={["5", "10", "15", "20", "30"].map((v) => ({ value: v, label: v }))} />
        </div>
        <div>
          <Label>난이도</Label>
          <Segmented
            value={difficulty}
            onChange={setDifficulty}
            options={[
              { value: "easy", label: "쉽게" },
              { value: "mixed", label: "골고루" },
              { value: "hard", label: "어렵게" },
            ]}
          />
        </div>
        <div>
          <Label hint="선택">범위·주제</Label>
          <Input value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="예: 후반부 증명, 계산 문제 위주" />
        </div>
      </div>
    </Dialog>
  );
}
