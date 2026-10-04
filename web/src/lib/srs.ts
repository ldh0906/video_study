import type { Flashcard } from "@shared/types";

export type Rating = 1 | 2 | 3 | 4; // again, hard, good, easy

const DAY = 86_400_000;
const MIN = 60_000;

/** SM-2 style scheduling with a short relearning step for lapses. */
export function schedule(card: Flashcard, rating: Rating, now = Date.now()): Partial<Flashcard> {
  let { ease, interval, reps, lapses } = card;
  if (rating === 1) {
    return { ease: Math.max(1.3, ease - 0.2), interval: 0, reps: 0, lapses: lapses + 1, due: now + 10 * MIN };
  }
  if (reps === 0) {
    interval = rating === 2 ? 0.25 : rating === 3 ? 1 : 3;
  } else if (reps === 1 && rating >= 3) {
    interval = rating === 3 ? 3 : 6;
  } else {
    const base = Math.max(interval, 0.25);
    interval = rating === 2 ? base * 1.2 : rating === 3 ? base * ease : base * ease * 1.35;
  }
  if (rating === 2) ease = Math.max(1.3, ease - 0.15);
  if (rating === 4) ease = ease + 0.15;
  interval = Math.min(interval, 365);
  return { ease, interval, reps: reps + 1, lapses, due: now + interval * DAY };
}

export function previewInterval(card: Flashcard, rating: Rating): string {
  const next = schedule(card, rating, 0);
  const ms = next.due!;
  if (ms < 60 * MIN) return `${Math.round(ms / MIN)}분`;
  if (ms < DAY) return `${Math.round(ms / (60 * MIN))}시간`;
  const d = ms / DAY;
  if (d < 30) return `${Math.round(d)}일`;
  if (d < 365) return `${Math.round(d / 30)}개월`;
  return `${(d / 365).toFixed(1)}년`;
}

export function deckStats(cards: Flashcard[], now = Date.now()) {
  return {
    total: cards.length,
    due: cards.filter((c) => c.due <= now).length,
    fresh: cards.filter((c) => c.reps === 0).length,
    learned: cards.filter((c) => c.reps > 0 && c.interval >= 1).length,
  };
}
