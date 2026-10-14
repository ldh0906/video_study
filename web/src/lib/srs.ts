import { State, createEmptyCard, fsrs, generatorParameters, type Card, type Grade } from "ts-fsrs";
import { buildQueue, isNewCard } from "@shared/review";
import type { Flashcard } from "@shared/types";

export { NEW_PER_DAY, buildQueue } from "@shared/review";

export type Rating = 1 | 2 | 3 | 4; // again, hard, good, easy

const DAY = 86_400_000;
const MIN = 60_000;

// FSRS with fuzz so cards made together don't stay clumped on the same days.
const scheduler = fsrs(generatorParameters({ request_retention: 0.9, maximum_interval: 365, enable_fuzz: true }));

/** The card's FSRS state; cards reviewed under the old SM-2 scheduler are converted from interval and ease. */
function toFsrs(c: Flashcard, now: number): Card {
  if (c.state !== undefined) {
    return {
      due: new Date(c.due),
      stability: c.stability ?? 0,
      difficulty: c.difficulty ?? 0,
      elapsed_days: 0,
      scheduled_days: Math.round(c.interval),
      learning_steps: c.learningSteps ?? 0,
      reps: c.reps,
      lapses: c.lapses,
      state: c.state as State,
      last_review: c.lastReview ? new Date(c.lastReview) : undefined,
    };
  }
  if (c.reps === 0) return { ...createEmptyCard(new Date(now)), lapses: c.lapses };
  const interval = Math.max(c.interval, 0.1);
  return {
    due: new Date(c.due),
    stability: interval,
    // SM-2 ease 1.3 (hard) … 3+ (easy) onto FSRS difficulty 10 … 1
    difficulty: Math.min(10, Math.max(1, 5 + (2.5 - c.ease) * 5)),
    elapsed_days: 0,
    scheduled_days: Math.round(interval),
    learning_steps: 0,
    reps: c.reps,
    lapses: c.lapses,
    state: State.Review,
    last_review: new Date(c.due - interval * DAY),
  };
}

export function schedule(card: Flashcard, rating: Rating, now = Date.now()): Partial<Flashcard> {
  const next = scheduler.next(toFsrs(card, now), new Date(now), rating as Grade).card;
  return {
    due: next.due.getTime(),
    interval: next.scheduled_days,
    stability: next.stability,
    difficulty: next.difficulty,
    state: next.state as 0 | 1 | 2 | 3,
    learningSteps: next.learning_steps,
    reps: next.reps,
    lapses: next.lapses,
    lastReview: now,
    introducedAt: card.introducedAt ?? now,
  };
}

export function previewInterval(card: Flashcard, rating: Rating, now = Date.now()): string {
  const ms = schedule(card, rating, now).due! - now;
  if (ms < 60 * MIN) return `${Math.max(1, Math.round(ms / MIN))}분`;
  if (ms < DAY) return `${Math.round(ms / (60 * MIN))}시간`;
  const d = ms / DAY;
  if (d < 30) return `${Math.round(d)}일`;
  if (d < 365) return `${Math.round(d / 30)}개월`;
  return `${(d / 365).toFixed(1)}년`;
}

export function deckStats(cards: Flashcard[], now = Date.now()) {
  return {
    total: cards.length,
    due: buildQueue(cards.map((card) => ({ card })), now).length,
    fresh: cards.filter(isNewCard).length,
    learned: cards.filter((c) => !isNewCard(c) && c.interval >= 1).length,
  };
}
