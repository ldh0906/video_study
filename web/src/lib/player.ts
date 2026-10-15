import { useSyncExternalStore } from "react";
import { fmtAnchor, type AnchorUnit } from "@shared/anchor";

/**
 * A tiny global store for the media player, so the transcript, notes and chat
 * can read the playhead and seek without re-rendering the whole page on every
 * timeupdate. For a PDF the "player" is the page viewer: `time` is the page
 * on screen and seeking scrolls to a page.
 */
interface PlayerState {
  time: number;
  duration: number;
  playing: boolean;
  unit: AnchorUnit;
}

let state: PlayerState = { time: 0, duration: 0, playing: false, unit: "time" };
let media: HTMLMediaElement | null = null;
let pager: ((page: number) => void) | null = null;
const listeners = new Set<() => void>();

function emit(patch: Partial<PlayerState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export const player = {
  attach(el: HTMLMediaElement | null) {
    media = el;
    if (!el) return emit({ time: 0, duration: 0, playing: false });
    emit({ unit: "time" });
    const sync = () => emit({ time: el.currentTime, duration: el.duration || 0, playing: !el.paused });
    for (const ev of ["timeupdate", "durationchange", "play", "pause", "seeked", "loadedmetadata"]) el.addEventListener(ev, sync);
    sync();
  },
  /** A PDF viewer takes the player's place: `goto` scrolls it to a page. */
  attachPages(pageCount: number, goto: (page: number) => void) {
    pager = goto;
    emit({ unit: "page", duration: pageCount, time: 1, playing: false });
  },
  detachPages(goto: (page: number) => void) {
    // a newer viewer may already have attached
    if (pager !== goto) return;
    pager = null;
    emit({ duration: 0, time: 1 });
  },
  /** whether a PDF viewer is mounted and can take a seek */
  get pagesReady() {
    return pager !== null;
  },
  /** the viewer reports the page on screen */
  setPage(page: number) {
    if (page !== state.time) emit({ time: page });
  },
  /** which kind of source the open item is, before its viewer mounts */
  setUnit(unit: AnchorUnit) {
    if (unit !== state.unit) emit({ unit, time: unit === "page" ? 1 : 0, duration: 0 });
  },
  seek(t: number, play = true) {
    if (state.unit === "page") {
      pager?.(Math.max(1, Math.round(t)));
      return emit({ time: Math.max(1, Math.round(t)) });
    }
    if (!media) return;
    media.currentTime = Math.max(0, t);
    if (play) void media.play().catch(() => {});
    emit({ time: media.currentTime });
  },
  toggle() {
    if (!media) return;
    if (media.paused) void media.play().catch(() => {});
    else media.pause();
  },
  /** "12:34" for a video, "p.12" for a document */
  fmt(v: number) {
    return fmtAnchor(state.unit, v);
  },
  get media() {
    return media;
  },
  get state() {
    return state;
  },
};

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function usePlayer<T>(select: (s: PlayerState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}

/** Current time rounded to whole seconds — cheap enough for lists to subscribe to. */
export function usePlayerSecond() {
  return usePlayer((s) => Math.floor(s.time));
}

export function useAnchorUnit() {
  return usePlayer((s) => s.unit);
}
