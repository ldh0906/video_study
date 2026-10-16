import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, GraduationCap, Layers, ListChecks, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { Flashcard, Lecture } from "@shared/types";
import { Markdown, TimeChip } from "@/components/Markdown";
import { Button, Dialog, EmptyState, Input, Label, Segmented, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { deckStats } from "@/lib/srs";
import { ReviewSession } from "@/features/ReviewSession";

export function useCards(id: string) {
  return useQuery({ queryKey: ["flashcards", id], queryFn: () => api.flashcards(id) });
}

export function CardsTab({ lecture }: { lecture: Lecture }) {
  const qc = useQueryClient();
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
        <>
          <div className="mb-4 flex items-center gap-4 text-[12.5px] text-muted">
            <span>새 카드 {stats.fresh}</span>
            <span>익힌 카드 {stats.learned}</span>
          </div>
          <ReviewSession
            items={cards.map((card) => ({ lectureId: lecture.id, card }))}
            inLecture
            onEdit={(x) => setEditing(x.card)}
            onSave={(x, patch) => {
              qc.setQueryData<Flashcard[]>(["flashcards", lecture.id], (old) => (old ?? []).map((c) => (c.id === x.card.id ? { ...c, ...patch } : c)));
              return api.updateCard(lecture.id, x.card.id, patch);
            }}
            empty={<EmptyState icon={<Layers />} title="카드가 아직 없어요" description="분석이 끝나면 자동으로 만들어져요. AI로 더 만들거나 직접 추가할 수도 있어요." />}
          />
        </>
      ) : (
        <CardList lecture={lecture} cards={cards} onEdit={setEditing} />
      )}

      <CardEditor lecture={lecture} card={editing} onClose={() => setEditing(null)} />
      <GenerateCards lecture={lecture} open={genOpen} onOpenChange={setGenOpen} />
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
  if (!cards.length) return <EmptyState icon={<Layers />} title="카드가 없어요" description="노트나 대본에서 문장을 선택하면 바로 카드로 만들 수 있어요." />;
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
                <div className="flex opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
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
      toast.success(card?.id ? "카드를 수정했어요" : "카드를 추가했어요");
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
      toast.success(`카드 ${cards.length}장을 만들었어요`);
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
      description="기존 카드와 겹치지 않게 새 카드를 만들어요."
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
