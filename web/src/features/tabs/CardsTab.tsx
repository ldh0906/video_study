import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { Download, GraduationCap, Layers, ListChecks, Pencil, Plus, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { Flashcard, Lecture } from "@shared/types";
import { Markdown, TimeChip } from "@/components/Markdown";
import { Badge, Button, Dialog, EmptyState, Input, Kbd, Label, Segmented, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { deckStats, previewInterval, schedule, type Rating } from "@/lib/srs";
import { cn, isTyping } from "@/lib/utils";

export function useCards(id: string) {
  return useQuery({ queryKey: ["flashcards", id], queryFn: () => api.flashcards(id) });
}

export function CardsTab({ lecture }: { lecture: Lecture }) {
  const { data: cards = [] } = useCards(lecture.id);
  const [mode, setMode] = useState<"review" | "list">("review");
  const [editing, setEditing] = useState<Partial<Flashcard> | null>(null);
  const [genOpen, setGenOpen] = useState(false);
  const stats = deckStats(cards);

  return (
    <div className="mx-auto max-w-[720px] px-1 pb-16">
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "review", label: <span className="flex items-center gap-1.5"><GraduationCap className="size-3.5" />복습</span> },
            { value: "list", label: <span className="flex items-center gap-1.5"><ListChecks className="size-3.5" />카드 목록 {cards.length}</span> },
          ]}
        />
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => setEditing({ front: "", back: "", time: null })}>
          <Plus className="size-3.5" /> 직접 추가
        </Button>
        <Button size="sm" variant="soft" onClick={() => setGenOpen(true)}>
          <Sparkles className="size-3.5" /> AI로 더 만들기
        </Button>
      </div>

      {mode === "review" ? (
        <Review lecture={lecture} cards={cards} stats={stats} onEdit={setEditing} />
      ) : (
        <CardList lecture={lecture} cards={cards} onEdit={setEditing} />
      )}

      <CardEditor lecture={lecture} card={editing} onClose={() => setEditing(null)} />
      <GenerateCards lecture={lecture} open={genOpen} onOpenChange={setGenOpen} />
    </div>
  );
}

function Review({ lecture, cards, stats, onEdit }: { lecture: Lecture; cards: Flashcard[]; stats: ReturnType<typeof deckStats>; onEdit: (c: Flashcard) => void }) {
  const qc = useQueryClient();
  const [flipped, setFlipped] = useState(false);
  const [cram, setCram] = useState(false);
  const [sessionDone, setSessionDone] = useState(0);
  // cram mode walks through every card once without touching the schedule
  const [crammed, setCrammed] = useState<Set<string>>(new Set());
  const queue = useMemo(() => {
    const now = Date.now();
    return cards.filter((c) => (cram ? !crammed.has(c.id) : c.due <= now)).sort((a, b) => a.due - b.due);
  }, [cards, cram, crammed]);
  const card = queue[0];

  const rate = async (r: Rating) => {
    if (!card) return;
    setFlipped(false);
    setSessionDone((n) => n + 1);
    if (cram) {
      if (r > 1) setCrammed((s) => new Set(s).add(card.id));
      return;
    }
    const patch = schedule(card, r);
    qc.setQueryData<Flashcard[]>(["flashcards", lecture.id], (old) => (old ?? []).map((c) => (c.id === card.id ? { ...c, ...patch } : c)));
    await api.updateCard(lecture.id, card.id, patch).catch((e) => toast.error((e as Error).message));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || !card) return;
      if (e.code === "Space" || e.key === "Enter") {
        e.preventDefault();
        e.stopImmediatePropagation(); // keep the video player from toggling too
        setFlipped((f) => !f);
      } else if (flipped && ["1", "2", "3", "4"].includes(e.key)) rate(Number(e.key) as Rating);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  if (!cards.length) return <EmptyState icon={<Layers />} title="카드가 아직 없어요" description="분석이 끝나면 자동으로 만들어집니다. AI로 더 만들거나 직접 추가할 수도 있어요." />;

  if (!card) {
    return (
      <div className="rounded-3xl border border-border bg-surface px-6 py-14 text-center shadow-soft">
        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-success-soft text-success">
          <GraduationCap className="size-7" />
        </div>
        <h3 className="font-serif text-[22px] font-semibold">오늘 복습 완료!</h3>
        <p className="mt-2 text-[13.5px] text-muted">
          {sessionDone ? `이번에 ${sessionDone}장을 복습했어요. ` : ""}다음 복습 때가 되면 다시 알려드릴게요.
        </p>
        <Button
          className="mt-6"
          onClick={() => {
            setCrammed(new Set());
            setCram(true);
          }}
        >
          <RotateCcw className="size-3.5" /> 전체 카드 한 번 더 보기
        </Button>
      </div>
    );
  }

  const ratings: { r: Rating; label: string; cls: string }[] = [
    { r: 1, label: "다시", cls: "text-danger" },
    { r: 2, label: "어려움", cls: "text-warning" },
    { r: 3, label: "알맞음", cls: "text-success" },
    { r: 4, label: "쉬움", cls: "text-accent" },
  ];

  return (
    <div>
      <div className="mb-4 flex items-center gap-4 text-[12.5px] text-muted">
        <span>
          남은 카드 <b className="text-text tabular-nums">{queue.length}</b>
        </span>
        <span>새 카드 {stats.fresh}</span>
        <span>익힌 카드 {stats.learned}</span>
        {cram ? <Badge tone="accent">전체 복습 모드</Badge> : null}
      </div>
      <div className="flip-scene">
        <motion.div key={card.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
          <div className={cn("flip-card relative min-h-[300px] cursor-pointer", flipped && "is-flipped")} onClick={() => setFlipped((f) => !f)}>
            <div className="flip-face absolute inset-0 flex flex-col rounded-3xl border border-border bg-surface p-7 shadow-float">
              <div className="mb-3 flex items-center justify-between text-[11.5px] font-semibold tracking-wide text-faint">
                <span>질문</span>
                {card.reps === 0 ? <Badge tone="accent">NEW</Badge> : null}
              </div>
              <div className="flex flex-1 items-center justify-center text-center">
                <Markdown className="text-[18px] leading-relaxed [&_p]:text-[18px]">{card.front}</Markdown>
              </div>
              <div className="mt-4 text-center text-xs text-faint">
                클릭하거나 <Kbd>Space</Kbd> 로 뒤집기
              </div>
            </div>
            <div className="flip-face flip-back absolute inset-0 flex flex-col overflow-y-auto rounded-3xl border border-accent/30 bg-surface p-7 shadow-float">
              <div className="mb-3 flex items-center justify-between text-[11.5px] font-semibold tracking-wide text-accent">
                <span>답</span>
                <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  {card.time !== null ? <TimeChip time={card.time}>영상에서 보기</TimeChip> : null}
                  <Button variant="ghost" size="icon-sm" onClick={() => onEdit(card)} aria-label="편집">
                    <Pencil className="size-3.5" />
                  </Button>
                </span>
              </div>
              <div className="text-[13px] text-muted">
                <Markdown className="[&_p]:text-[13px] text-muted">{card.front}</Markdown>
              </div>
              <div className="my-4 h-px bg-border" />
              <Markdown className="text-[16px]">{card.back}</Markdown>
            </div>
          </div>
        </motion.div>
      </div>
      <div className={cn("mt-5 grid grid-cols-4 gap-2 transition-opacity", flipped ? "opacity-100" : "pointer-events-none opacity-0")}>
        {ratings.map(({ r, label, cls }) => (
          <button
            key={r}
            onClick={() => rate(r)}
            className="flex flex-col items-center gap-0.5 rounded-2xl border border-border bg-surface py-3 shadow-soft transition-all hover:-translate-y-0.5 hover:border-border-strong"
          >
            <span className={cn("text-[14px] font-semibold", cls)}>{label}</span>
            <span className="text-[11.5px] text-faint tabular-nums">
              {previewInterval(card, r)} · <Kbd>{r}</Kbd>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function CardList({ lecture, cards, onEdit }: { lecture: Lecture; cards: Flashcard[]; onEdit: (c: Flashcard) => void }) {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const list = cards.filter((c) => !q || `${c.front} ${c.back}`.toLowerCase().includes(q.toLowerCase()));
  const del = async (c: Flashcard) => {
    qc.setQueryData<Flashcard[]>(["flashcards", lecture.id], (old) => (old ?? []).filter((x) => x.id !== c.id));
    await api.deleteCard(lecture.id, c.id);
  };
  if (!cards.length) return <EmptyState icon={<Layers />} title="카드가 없습니다" />;
  return (
    <div>
      <div className="mb-3 flex gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="카드 검색" className="h-9" />
        <Button size="sm" className="h-9" onClick={() => window.open(api.exportUrl(lecture.id, "anki"))}>
          <Download className="size-3.5" /> Anki
        </Button>
      </div>
      <div className="space-y-2">
        {list.map((c) => (
          <div key={c.id} className="group rounded-2xl border border-border bg-surface p-4">
            <div className="flex gap-3">
              <div className="min-w-0 flex-1">
                <Markdown className="text-[14px] font-medium [&_p]:font-medium">{c.front}</Markdown>
                <div className="mt-2 border-t border-dashed border-border pt-2">
                  <Markdown className="text-[13.5px] text-muted">{c.back}</Markdown>
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                {c.time !== null ? <TimeChip time={c.time} /> : null}
                <div className="flex opacity-0 transition-opacity group-hover:opacity-100">
                  <Button variant="ghost" size="icon-sm" onClick={() => onEdit(c)} aria-label="편집">
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => del(c)} aria-label="삭제">
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function CardEditor({ lecture, card, onClose }: { lecture: Lecture; card: Partial<Flashcard> | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [front, setFront] = useState("");
  const [back, setBack] = useState("");
  useEffect(() => {
    setFront(card?.front ?? "");
    setBack(card?.back ?? "");
  }, [card]);
  const save = useMutation({
    mutationFn: async () => {
      if (card?.id) await api.updateCard(lecture.id, card.id, { front, back });
      else await api.addCard(lecture.id, { front, back, time: card?.time ?? null });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flashcards", lecture.id] });
      toast.success(card?.id ? "카드를 수정했습니다" : "카드를 추가했습니다");
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog
      open={card !== null}
      onOpenChange={(v) => !v && onClose()}
      title={card?.id ? "카드 편집" : "새 카드"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button variant="primary" disabled={!front.trim() || !back.trim()} loading={save.isPending} onClick={() => save.mutate()}>
            저장
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label hint="Markdown · $수식$ 지원">앞면 (질문)</Label>
          <Textarea rows={3} value={front} onChange={(e) => setFront(e.target.value)} autoFocus />
        </div>
        <div>
          <Label>뒷면 (답)</Label>
          <Textarea rows={5} value={back} onChange={(e) => setBack(e.target.value)} />
        </div>
      </div>
    </Dialog>
  );
}

function GenerateCards({ lecture, open, onOpenChange }: { lecture: Lecture; open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const [count, setCount] = useState("10");
  const [focus, setFocus] = useState("");
  const gen = useMutation({
    mutationFn: () => api.generateCards(lecture.id, Number(count), focus),
    onSuccess: (cards) => {
      qc.invalidateQueries({ queryKey: ["flashcards", lecture.id] });
      toast.success(`카드 ${cards.length}장을 만들었습니다`);
      onOpenChange(false);
      setFocus("");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="AI로 카드 더 만들기"
      description="기존 카드와 겹치지 않게 새 카드를 만듭니다."
      footer={
        <Button variant="primary" loading={gen.isPending} onClick={() => gen.mutate()}>
          <Sparkles className="size-3.5" /> 만들기
        </Button>
      }
    >
      <div className="space-y-4">
        <div>
          <Label>개수</Label>
          <Segmented value={count} onChange={setCount} options={["5", "10", "20", "30"].map((v) => ({ value: v, label: `${v}장` }))} />
        </div>
        <div>
          <Label hint="선택">집중할 주제</Label>
          <Input value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="예: 증명 과정, 공식 유도, 2장 내용" />
        </div>
      </div>
    </Dialog>
  );
}
