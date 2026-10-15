import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, Check, CheckCircle2, ClipboardList, Clock, FileText, Flag, Play, RotateCcw, Send, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { fmtAnchor, unitOf } from "@shared/anchor";
import type { Bloom, Exam, ExamAttempt, ExamQuestion } from "@shared/types";
import { AnchorProvider, Markdown } from "@/components/Markdown";
import { Badge, Button, EmptyState, Progress, Spinner, Textarea } from "@/components/ui";
import { api, type LectureSummary } from "@/lib/api";
import { cn } from "@/lib/utils";

const BLOOM: Record<Bloom, string> = { remember: "기억", understand: "이해", apply: "적용", analyze: "분석", evaluate: "평가" };
const TYPE: Record<ExamQuestion["type"], string> = { mcq: "객관식", short: "단답·서술", essay: "논술" };

function clock(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A course mock exam: generation progress, the blueprint, taking it under time, then graded results. */
export function ExamPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: exam, error } = useQuery({
    queryKey: ["exam", id],
    queryFn: () => api.exam(id),
    refetchInterval: (q) => {
      const e = q.state.data;
      return e && (e.status === "planning" || e.status === "writing" || e.attempts.some((a) => a.status === "grading")) ? 2000 : false;
    },
  });
  const { data: lectures = [] } = useQuery({ queryKey: ["lectures"], queryFn: api.lectures });
  const byId = useMemo(() => new Map(lectures.map((l) => [l.id, l])), [lectures]);
  const [attemptId, setAttemptId] = useState<string | null>(null);

  if (error) return <EmptyState icon={<ClipboardList />} title="시험을 찾을 수 없어요" action={<Button onClick={() => navigate("/")}>라이브러리로</Button>} />;
  if (!exam) {
    return (
      <div className="flex justify-center py-24">
        <Spinner className="size-6" />
      </div>
    );
  }

  const taking = exam.attempts.find((a) => a.status === "taking");
  const shown = exam.attempts.find((a) => a.id === attemptId) ?? null;
  const back = exam.folderId ? `/?folder=${exam.folderId}` : "/";

  const start = async () => {
    const a = taking ?? (await api.startAttempt(exam.id));
    await qc.invalidateQueries({ queryKey: ["exam", id] });
    setAttemptId(a.id);
  };

  return (
    <div className="mx-auto w-full max-w-[820px] px-4 pt-6 pb-28 sm:px-8">
      <Link to={back} className="-ml-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text">
        <ArrowLeft className="size-4" />
        라이브러리
      </Link>
      <div className="mt-3 mb-6 flex items-start gap-3">
        <h1 className="min-w-0 flex-1 font-serif text-[26px] leading-snug font-semibold tracking-tight">{exam.title}</h1>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="시험 삭제"
          onClick={async () => {
            if (!confirm("이 시험과 응시 기록을 삭제할까요?")) return;
            await api.deleteExam(exam.id);
            void qc.invalidateQueries({ queryKey: ["exams"] });
            navigate(back);
          }}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>

      {exam.status === "planning" || exam.status === "writing" ? (
        <Building exam={exam} />
      ) : exam.status === "error" ? (
        <EmptyState icon={<XCircle />} title="시험을 만들지 못했어요" description={exam.error} />
      ) : shown?.status === "taking" ? (
        <TakeExam exam={exam} attempt={shown} byId={byId} onDone={() => qc.invalidateQueries({ queryKey: ["exam", id] })} />
      ) : shown ? (
        <Results exam={exam} attempt={shown} byId={byId} onRetry={start} onBack={() => setAttemptId(null)} />
      ) : (
        <Overview exam={exam} byId={byId} onStart={start} resuming={!!taking} onOpenAttempt={(a) => setAttemptId(a.id)} />
      )}
    </div>
  );
}

// --- while generating -------------------------------------------------------------

function Building({ exam }: { exam: Exam }) {
  const steps = [
    { key: "planning", label: "출제 설계", hint: "자료 전체에서 강조된 주제와 비중을 정하고 있어요" },
    { key: "writing", label: "문항 작성 · 검토", hint: exam.progress ? `${exam.progress} · 다른 모델이 정답과 보기를 검토해요` : "주제별로 문항을 쓰고 검토해요" },
  ];
  const at = exam.status === "planning" ? 0 : 1;
  return (
    <div className="rounded-2xl border border-border bg-surface p-6 shadow-soft">
      <div className="space-y-4">
        {steps.map((s, i) => (
          <div key={s.key} className="flex items-start gap-3">
            <div className={cn("mt-0.5 flex size-7 items-center justify-center rounded-full", i < at ? "bg-success text-white" : i === at ? "bg-accent-soft text-accent" : "bg-surface-2 text-faint")}>
              {i < at ? <Check className="size-4" /> : i === at ? <Spinner className="size-4 text-accent" /> : i + 1}
            </div>
            <div>
              <div className={cn("text-[15px] font-semibold", i > at && "text-muted")}>{s.label}</div>
              {i === at ? <div className="text-[13px] text-muted">{s.hint}</div> : null}
            </div>
          </div>
        ))}
      </div>
      {exam.blueprint.length ? (
        <div className="mt-6">
          <Blueprint exam={exam} />
        </div>
      ) : null}
    </div>
  );
}

function Blueprint({ exam }: { exam: Exam }) {
  const max = Math.max(...exam.blueprint.map((r) => r.questions), 1);
  return (
    <div>
      <div className="mb-2 text-[13px] font-semibold text-muted">출제 설계표</div>
      <div className="space-y-2">
        {exam.blueprint.map((r, i) => (
          <motion.div key={r.topic} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }} className="rounded-xl bg-surface-2/60 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{r.topic}</span>
              {r.bloom.map((b) => (
                <Badge key={b}>{BLOOM[b]}</Badge>
              ))}
              <span className="w-10 text-right text-[12.5px] font-semibold text-accent tabular-nums">{r.questions}문항</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3">
              <motion.div initial={{ width: 0 }} animate={{ width: `${(r.questions / max) * 100}%` }} transition={{ duration: 0.6, delay: i * 0.04 }} className="h-full rounded-full bg-accent" />
            </div>
            <div className="mt-1 text-[12px] text-muted">{r.why}</div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

// --- before starting --------------------------------------------------------------

function Overview({ exam, byId, onStart, resuming, onOpenAttempt }: { exam: Exam; byId: Map<string, LectureSummary>; onStart: () => void; resuming: boolean; onOpenAttempt: (a: ExamAttempt) => void }) {
  const mcq = exam.questions.filter((q) => q.type === "mcq").length;
  const graded = exam.attempts.filter((a) => a.status !== "taking");
  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-border bg-surface p-6 shadow-soft">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13.5px] text-muted">
          <span className="flex items-center gap-1.5">
            <ClipboardList className="size-4" /> {exam.questions.length}문항 (객관식 {mcq} · 서술 {exam.questions.length - mcq})
          </span>
          <span className="flex items-center gap-1.5">
            <Clock className="size-4" /> {exam.config.minutes}분
          </span>
          <span>100점 만점</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {exam.config.lectureIds.map((lid) => {
            const l = byId.get(lid);
            return l ? (
              <Badge key={lid} className="max-w-[240px]">
                {l.kind === "doc" ? <FileText className="size-3" /> : <Play className="size-3" />}
                <span className="truncate">{l.title}</span>
              </Badge>
            ) : null;
          })}
        </div>
        <Button variant="primary" size="lg" className="mt-6" onClick={onStart}>
          <Play className="size-4" /> {resuming ? "이어서 풀기" : "시험 시작"}
        </Button>
      </div>
      <div className="rounded-2xl border border-border bg-surface p-6 shadow-soft">
        <Blueprint exam={exam} />
      </div>
      {graded.length ? (
        <div>
          <div className="mb-2 text-[13px] font-semibold text-muted">응시 기록</div>
          <div className="space-y-2">
            {graded.map((a) => (
              <button key={a.id} onClick={() => onOpenAttempt(a)} className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-left transition-colors hover:border-border-strong">
                <span className="text-[13px] text-muted">{new Date(a.startedAt).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" })}</span>
                <span className="ml-auto text-[15px] font-semibold tabular-nums">{a.status === "grading" ? "채점 중…" : `${Math.round(a.score)} / ${a.maxScore}`}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// --- taking ------------------------------------------------------------------------

function TakeExam({ exam, attempt, byId, onDone }: { exam: Exam; attempt: ExamAttempt; byId: Map<string, LectureSummary>; onDone: () => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>(attempt.answers);
  const [now, setNow] = useState(Date.now());
  const [submitting, setSubmitting] = useState(false);
  const [flagged, setFlagged] = useState<Set<string>>(new Set());
  const end = attempt.startedAt + exam.config.minutes * 60_000;
  const left = end - now;
  const answered = exam.questions.filter((q) => (answers[q.id] ?? "").trim() !== "").length;
  const saved = useRef(JSON.stringify(attempt.answers));

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // autosave, so a closed tab loses nothing
  useEffect(() => {
    const t = setTimeout(() => {
      const s = JSON.stringify(answers);
      if (s === saved.current) return;
      saved.current = s;
      void api.saveAnswers(exam.id, attempt.id, answers);
    }, 800);
    return () => clearTimeout(t);
  }, [answers, exam.id, attempt.id]);

  const submit = async (auto = false) => {
    if (submitting) return;
    if (!auto && answered < exam.questions.length && !confirm(`${exam.questions.length - answered}문항이 비어 있어요. 제출할까요?`)) return;
    setSubmitting(true);
    try {
      await api.submitAttempt(exam.id, attempt.id, answers);
      if (auto) toast.info("시간이 끝나 자동으로 제출했어요");
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (left <= 0) void submit(true);
  }, [left <= 0]);

  const set = (qid: string, v: string) => setAnswers((a) => ({ ...a, [qid]: v }));
  const warn = left < 5 * 60_000;

  return (
    <div>
      <div className="sticky top-0 z-20 -mx-4 mb-5 flex items-center gap-3 border-b border-border bg-bg/90 px-4 py-2.5 backdrop-blur sm:-mx-8 sm:px-8">
        <span className={cn("flex items-center gap-1.5 text-[15px] font-semibold tabular-nums", warn ? "text-danger" : "text-text")}>
          <Clock className="size-4" /> {clock(left)}
        </span>
        <Progress value={answered / exam.questions.length} className="h-1.5 flex-1" />
        <span className="text-[12.5px] text-muted tabular-nums">
          {answered}/{exam.questions.length}
        </span>
        <Button variant="primary" size="sm" loading={submitting} onClick={() => submit()}>
          <Send className="size-3.5" /> 제출
        </Button>
      </div>
      <div className="mb-5 flex flex-wrap gap-1">
        {exam.questions.map((q, i) => (
          <a
            key={q.id}
            href={`#q-${q.id}`}
            className={cn(
              "flex size-7 items-center justify-center rounded-md text-[12px] font-semibold tabular-nums transition-colors",
              flagged.has(q.id) ? "bg-warning-soft text-warning ring-1 ring-warning" : (answers[q.id] ?? "").trim() ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted hover:bg-surface-3",
            )}
          >
            {i + 1}
          </a>
        ))}
      </div>
      <div className="space-y-5">
        {exam.questions.map((q, i) => (
          <QuestionShell key={q.id} q={q} n={i + 1} byId={byId} showSource={false}>
            <div className="mb-2 flex justify-end">
              <button
                onClick={() =>
                  setFlagged((s) => {
                    const n = new Set(s);
                    if (n.has(q.id)) n.delete(q.id);
                    else n.add(q.id);
                    return n;
                  })
                }
                className={cn("flex items-center gap-1 text-[12px]", flagged.has(q.id) ? "text-warning" : "text-faint hover:text-muted")}
              >
                <Flag className="size-3.5" /> 나중에 다시 보기
              </button>
            </div>
            {q.type === "mcq" ? (
              <div className="grid gap-2">
                {q.options.map((o, k) => {
                  const on = answers[q.id] === String(k);
                  return (
                    <motion.button
                      key={k}
                      whileTap={{ scale: 0.99 }}
                      onClick={() => set(q.id, String(k))}
                      className={cn("flex items-start gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors", on ? "border-accent bg-accent-soft" : "border-border hover:border-border-strong")}
                    >
                      <span className={cn("mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold", on ? "border-accent bg-accent text-accent-fg" : "border-border-strong text-muted")}>{k + 1}</span>
                      <Markdown className="min-w-0 flex-1 text-[14px]">{o}</Markdown>
                    </motion.button>
                  );
                })}
              </div>
            ) : (
              <Textarea rows={q.type === "essay" ? 7 : 3} value={answers[q.id] ?? ""} onChange={(e) => set(q.id, e.target.value)} placeholder={q.type === "essay" ? "근거와 과정을 함께 써 보세요" : "답을 쓰세요"} />
            )}
          </QuestionShell>
        ))}
      </div>
      <div className="mt-8 flex justify-center">
        <Button variant="primary" size="lg" loading={submitting} onClick={() => submit()}>
          <Send className="size-4" /> 답안 제출하고 채점받기
        </Button>
      </div>
    </div>
  );
}

function QuestionShell({ q, n, byId, showSource, children, tone }: { q: ExamQuestion; n: number; byId: Map<string, LectureSummary>; showSource: boolean; children: React.ReactNode; tone?: "good" | "bad" | "partial" }) {
  const navigate = useNavigate();
  const src = q.source ? byId.get(q.source.lectureId) : undefined;
  const unit = src ? unitOf(src) : "time";
  return (
    <AnchorProvider value={{ unit, seek: (v) => src && navigate(`/lecture/${src.id}?t=${Math.round(v)}`) }}>
      <section
        id={`q-${q.id}`}
        className={cn(
          "scroll-mt-20 rounded-2xl border bg-surface p-5 shadow-soft",
          tone === "good" ? "border-success/50" : tone === "bad" ? "border-danger/50" : tone === "partial" ? "border-warning/50" : "border-border",
        )}
      >
        <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
          <span className="text-[14px] font-bold text-text tabular-nums">{n}.</span>
          <Badge>{TYPE[q.type]}</Badge>
          <Badge>{BLOOM[q.bloom]}</Badge>
          <span className="truncate">{q.topic}</span>
          <span className="ml-auto font-semibold tabular-nums">{q.points}점</span>
        </div>
        <Markdown className="mb-3 text-[15px]">{q.question}</Markdown>
        {children}
        {showSource && src && q.source ? (
          <button onClick={() => navigate(`/lecture/${src.id}?t=${Math.round(q.source!.anchor)}`)} className="mt-3 inline-flex max-w-full items-center gap-1.5 rounded-md bg-accent-soft px-2 py-1 text-[12px] font-semibold text-accent hover:bg-accent hover:text-accent-fg">
            {unit === "page" ? <FileText className="size-3.5" /> : <Play className="size-3.5" />}
            <span className="truncate">
              {src.title} · {fmtAnchor(unit, q.source.anchor)}에서 다시 보기
            </span>
          </button>
        ) : null}
      </section>
    </AnchorProvider>
  );
}

// --- results -----------------------------------------------------------------------

function Results({ exam, attempt, byId, onRetry, onBack }: { exam: Exam; attempt: ExamAttempt; byId: Map<string, LectureSummary>; onRetry: () => void; onBack: () => void }) {
  const [onlyWrong, setOnlyWrong] = useState(false);
  const grading = attempt.status === "grading";
  const pct = Math.round((attempt.score / Math.max(1, attempt.maxScore)) * 100);
  const topics = useMemo(() => {
    const m = new Map<string, { got: number; max: number }>();
    for (const q of exam.questions) {
      const g = attempt.grades[q.id];
      const t = m.get(q.topic) ?? { got: 0, max: 0 };
      t.got += g?.points ?? 0;
      t.max += q.points;
      m.set(q.topic, t);
    }
    return [...m.entries()].sort((a, b) => a[1].got / a[1].max - b[1].got / b[1].max);
  }, [exam, attempt]);
  const shown = exam.questions.map((q, i) => ({ q, i })).filter(({ q }) => !onlyWrong || attempt.grades[q.id]?.verdict !== "correct");

  return (
    <div>
      <div className="rounded-2xl border border-border bg-surface p-6 shadow-soft">
        {grading ? (
          <div className="flex items-center gap-3">
            <Spinner className="size-5" />
            <div>
              <div className="text-[16px] font-semibold">서술형 답안을 채점하고 있어요</div>
              <div className="text-[13px] text-muted">
                {Object.keys(attempt.grades).length} / {exam.questions.length}문항 채점 완료 · 채점 기준을 하나씩 따로 판단해요
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-6">
            <motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 300, damping: 18 }} className="relative flex size-28 items-center justify-center">
              <svg viewBox="0 0 100 100" className="absolute inset-0 -rotate-90">
                <circle cx="50" cy="50" r="44" fill="none" stroke="var(--surface-3)" strokeWidth="9" />
                <motion.circle
                  cx="50"
                  cy="50"
                  r="44"
                  fill="none"
                  stroke={pct >= 80 ? "var(--success)" : pct >= 50 ? "var(--accent)" : "var(--danger)"}
                  strokeWidth="9"
                  strokeLinecap="round"
                  strokeDasharray={2 * Math.PI * 44}
                  initial={{ strokeDashoffset: 2 * Math.PI * 44 }}
                  animate={{ strokeDashoffset: 2 * Math.PI * 44 * (1 - pct / 100) }}
                  transition={{ duration: 1.1, ease: [0.2, 0.8, 0.2, 1] }}
                />
              </svg>
              <div className="text-center">
                <div className="text-[30px] leading-none font-bold tabular-nums">{pct}</div>
                <div className="text-[11.5px] text-muted">점</div>
              </div>
            </motion.div>
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="mb-1 text-[13px] font-semibold text-muted">주제별 점수 (약한 순)</div>
              {topics.slice(0, 6).map(([t, v]) => (
                <div key={t} className="flex items-center gap-2 text-[12.5px]">
                  <span className="w-[42%] truncate">{t}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
                    <motion.div initial={{ width: 0 }} animate={{ width: `${(v.got / v.max) * 100}%` }} transition={{ duration: 0.7 }} className={cn("h-full rounded-full", v.got / v.max >= 0.8 ? "bg-success" : v.got / v.max >= 0.5 ? "bg-accent" : "bg-danger")} />
                  </div>
                  <span className="w-12 text-right text-muted tabular-nums">{Math.round((v.got / v.max) * 100)}%</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          <Button size="sm" variant={onlyWrong ? "soft" : "secondary"} onClick={() => setOnlyWrong((v) => !v)}>
            <XCircle className="size-3.5" /> 틀린 문제만
          </Button>
          <Button size="sm" onClick={onRetry}>
            <RotateCcw className="size-3.5" /> 다시 응시
          </Button>
          <Button size="sm" variant="ghost" onClick={onBack}>
            시험 개요로
          </Button>
        </div>
      </div>

      <div className="mt-5 space-y-5">
        <AnimatePresence initial={false}>
          {shown.map(({ q, i }) => {
            const g = attempt.grades[q.id];
            const mine = attempt.answers[q.id] ?? "";
            const tone = g ? (g.verdict === "correct" ? "good" : g.verdict === "partial" ? "partial" : "bad") : undefined;
            return (
              <motion.div key={q.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }}>
                <QuestionShell q={q} n={i + 1} byId={byId} showSource tone={tone}>
                  {q.type === "mcq" ? (
                    <div className="grid gap-1.5">
                      {q.options.map((o, k) => (
                        <div
                          key={k}
                          className={cn(
                            "flex items-start gap-2.5 rounded-xl border px-3 py-2 text-[14px]",
                            k === q.answerIndex ? "border-success bg-success-soft" : mine === String(k) ? "border-danger bg-danger-soft" : "border-border",
                          )}
                        >
                          {k === q.answerIndex ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : mine === String(k) ? <XCircle className="mt-0.5 size-4 shrink-0 text-danger" /> : <span className="w-4 shrink-0 text-center text-[12px] text-muted">{k + 1}</span>}
                          <Markdown className="min-w-0 flex-1">{o}</Markdown>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="rounded-xl bg-surface-2 px-3.5 py-2.5 text-[14px] whitespace-pre-wrap">{mine || <span className="text-muted">(비어 있음)</span>}</div>
                      <details className="rounded-xl border border-border px-3.5 py-2.5">
                        <summary className="cursor-pointer text-[13px] font-semibold text-muted">모범 답안</summary>
                        <Markdown className="mt-2 text-[14px]">{q.answer}</Markdown>
                      </details>
                    </div>
                  )}
                  {g ? (
                    <div className={cn("mt-3 rounded-xl px-3.5 py-3 text-[14px]", tone === "good" ? "bg-success-soft" : tone === "partial" ? "bg-warning-soft" : "bg-danger-soft")}>
                      <div className="mb-1 flex items-center gap-2 text-[13px] font-semibold">
                        {g.verdict === "correct" ? "정답" : g.verdict === "partial" ? "부분 정답" : "오답"}
                        <span className="ml-auto tabular-nums">
                          {g.points} / {q.points}점
                        </span>
                      </div>
                      <Markdown>{q.type === "mcq" ? q.explanation : g.feedback}</Markdown>
                    </div>
                  ) : grading ? (
                    <div className="mt-3 flex items-center gap-2 text-[13px] text-muted">
                      <Spinner /> 채점 중…
                    </div>
                  ) : null}
                </QuestionShell>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}
