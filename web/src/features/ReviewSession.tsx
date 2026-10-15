import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import type { AnchorUnit } from "@shared/anchor";
import { motion } from "motion/react";
import { GraduationCap, Layers, Pencil, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import type { Flashcard } from "@shared/types";
import { AnchorProvider, Markdown, TimeChip } from "@/components/Markdown";
import { Badge, Button, EmptyState, Kbd } from "@/components/ui";
import { buildQueue, NEW_PER_DAY, previewInterval, schedule, type Rating } from "@/lib/srs";
import { cn, focusOwnsActivation } from "@/lib/utils";

export interface ReviewItem {
  lectureId: string;
  /** shown when the session mixes lectures */
  lectureTitle?: string;
  /** how the card's source is cited; absent = the open item's */
  unit?: AnchorUnit;
  card: Flashcard;
}

const RATINGS: { r: Rating; label: string; cls: string }[] = [
  { r: 1, label: "다시", cls: "text-danger" },
  { r: 2, label: "어려움", cls: "text-warning" },
  { r: 3, label: "알맞음", cls: "text-success" },
  { r: 4, label: "쉬움", cls: "text-accent" },
];

/**
 * One review session over a set of cards, possibly from several lectures.
 * `onSave` persists a schedule change; `inLecture` means a player is on the
 * page, so time links seek it instead of opening the lecture.
 */
export function ReviewSession({
  items,
  onSave,
  onEdit,
  inLecture,
  empty,
}: {
  items: ReviewItem[];
  onSave: (item: ReviewItem, patch: Partial<Flashcard>) => Promise<unknown>;
  onEdit?: (item: ReviewItem) => void;
  inLecture?: boolean;
  empty?: ReactNode;
}) {
  const navigate = useNavigate();
  const [flipped, setFlipped] = useState(false);
  const [cram, setCram] = useState(false);
  const [sessionDone, setSessionDone] = useState(0);
  // cram mode walks through every card once without touching the schedule
  const [crammed, setCrammed] = useState<Set<string>>(new Set());
  const queue = useMemo(
    () => (cram ? items.filter((x) => !crammed.has(x.card.id)) : buildQueue(items)),
    [items, cram, crammed],
  );
  const item = queue[0];
  const card = item?.card;

  const rate = async (r: Rating) => {
    if (!item) return;
    setFlipped(false);
    setSessionDone((n) => n + 1);
    if (cram) {
      if (r > 1) setCrammed((s) => new Set(s).add(item.card.id));
      return;
    }
    await onSave(item, schedule(item.card, r)).catch((e) => toast.error((e as Error).message));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!card || focusOwnsActivation(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === "Space" || e.key === "Enter") {
        e.preventDefault();
        e.stopImmediatePropagation(); // keep the video player from toggling too
        setFlipped((f) => !f);
      } else if (flipped && ["1", "2", "3", "4"].includes(e.key)) rate(Number(e.key) as Rating);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  if (!items.length) return <>{empty ?? <EmptyState icon={<Layers />} title="카드가 아직 없어요" />}</>;

  if (!item || !card) {
    const waitingNew = items.filter((x) => x.card.due <= Date.now()).length;
    return (
      <div className="rounded-3xl border border-border bg-surface px-6 py-14 text-center shadow-soft">
        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-success-soft text-success">
          <GraduationCap className="size-7" />
        </div>
        <h3 className="font-serif text-[22px] font-semibold">오늘 복습 완료!</h3>
        <p className="mt-2 text-[13.5px] text-muted">
          {sessionDone ? `이번에 ${sessionDone}장을 복습했어요. ` : ""}
          {waitingNew ? `새 카드는 하루 ${NEW_PER_DAY}장씩 열려요. 남은 ${waitingNew}장은 내일부터 나와요.` : "다음 복습 때가 되면 다시 나와요."}
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

  const isNew = card.state === undefined ? card.reps === 0 : card.state === 0;
  const source =
    card.time === null ? null : inLecture ? (
      <TimeChip time={card.time}>원본에서 보기</TimeChip>
    ) : (
      <Link to={`/lecture/${item.lectureId}?t=${Math.floor(card.time)}`} className="rounded-md bg-accent-soft px-1.5 py-[1px] text-[11.5px] font-semibold text-accent hover:bg-accent hover:text-accent-fg">
        원본에서 보기
      </Link>
    );

  const body = (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-muted">
        <span>
          남은 카드 <b className="text-text tabular-nums">{queue.length}</b>
        </span>
        {item.lectureTitle ? <span className="min-w-0 truncate">· {item.lectureTitle}</span> : null}
        {cram ? <Badge tone="accent">전체 복습 모드</Badge> : null}
      </div>
      <div className="flip-scene">
        <motion.div key={card.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
          <div className={cn("flip-card relative min-h-[300px] cursor-pointer", flipped && "is-flipped")} onClick={() => setFlipped((f) => !f)}>
            <div className="flip-face absolute inset-0 flex flex-col rounded-3xl border border-border bg-surface p-7 shadow-float">
              <div className="mb-3 flex items-center justify-between text-[11.5px] font-semibold tracking-wide text-faint">
                <span>질문</span>
                {isNew ? <Badge tone="accent">NEW</Badge> : null}
              </div>
              <div className="flex flex-1 items-center justify-center text-center">
                <Markdown className="text-[18px] leading-relaxed [&_p]:text-[18px]">{card.front}</Markdown>
              </div>
              <div className="mt-4 text-center text-xs text-faint">
                답을 떠올린 뒤 클릭하거나 <Kbd>Space</Kbd> 로 뒤집기
              </div>
            </div>
            <div className="flip-face flip-back absolute inset-0 flex flex-col overflow-y-auto rounded-3xl border border-accent/30 bg-surface p-7 shadow-float">
              <div className="mb-3 flex items-center justify-between text-[11.5px] font-semibold tracking-wide text-accent">
                <span>답</span>
                <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  {source}
                  {onEdit ? (
                    <Button variant="ghost" size="icon-sm" onClick={() => onEdit(item)} aria-label="카드 편집">
                      <Pencil className="size-3.5" />
                    </Button>
                  ) : null}
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
        {RATINGS.map(({ r, label, cls }) => (
          <button
            key={r}
            onClick={() => rate(r)}
            tabIndex={flipped ? 0 : -1}
            className="flex flex-col items-center gap-0.5 rounded-2xl border border-border bg-surface py-3 shadow-soft transition-all hover:-translate-y-0.5 hover:border-border-strong"
          >
            <span className={cn("text-[14px] font-semibold", cls)}>{label}</span>
            <span className="text-[11.5px] text-muted tabular-nums">
              {previewInterval(card, r)} · <Kbd>{r}</Kbd>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
  if (inLecture) return body;
  // outside an item's page, citations open that card's own source
  return <AnchorProvider value={{ unit: item.unit ?? "time", seek: (v) => navigate(`/lecture/${item.lectureId}?t=${Math.round(v)}`) }}>{body}</AnchorProvider>;
}
