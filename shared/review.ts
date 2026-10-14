import type { Flashcard } from "./types";

const DAY = 86_400_000;

/** New cards a deck introduces per day; more than this buries the student in reviews a week later. */
export const NEW_PER_DAY = 20;

export const isNewCard = (c: Flashcard) => (c.state === undefined ? c.reps === 0 : c.state === 0);

/** Start of the study day; like Anki it rolls over at 4 a.m. */
export function studyDayStart(now = Date.now()) {
  const d = new Date(now);
  d.setHours(4, 0, 0, 0);
  return d.getTime() > now ? d.getTime() - DAY : d.getTime();
}

/** Today's queue: every due review, plus new cards up to what's left of the daily limit. */
export function buildQueue<T extends { card: Flashcard }>(items: T[], now = Date.now(), newPerDay = NEW_PER_DAY): T[] {
  const today = studyDayStart(now);
  const introduced = items.filter((x) => (x.card.introducedAt ?? 0) >= today).length;
  const due = items.filter((x) => x.card.due <= now);
  const reviews = due.filter((x) => !isNewCard(x.card)).sort((a, b) => a.card.due - b.card.due);
  const fresh = due
    .filter((x) => isNewCard(x.card))
    .sort((a, b) => a.card.createdAt - b.card.createdAt)
    .slice(0, Math.max(0, newPerDay - introduced));
  return [...reviews, ...fresh];
}

export const dueToday = (cards: Flashcard[], now = Date.now()) => buildQueue(cards.map((card) => ({ card })), now).length;
