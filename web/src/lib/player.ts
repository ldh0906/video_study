import { useSyncExternalStore } from "react";

/**
 * A tiny global store for the media player, so the transcript, notes and chat
 * can read the playhead and seek without re-rendering the whole page on every
 * timeupdate.
 */
interface PlayerState {
  time: number;
  duration: number;
  playing: boolean;
}

let state: PlayerState = { time: 0, duration: 0, playing: false };
let media: HTMLMediaElement | null = null;
const listeners = new Set<() => void>();

function emit(patch: Partial<PlayerState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export const player = {
  attach(el: HTMLMediaElement | null) {
    media = el;
    if (!el) return emit({ time: 0, duration: 0, playing: false });
    const sync = () => emit({ time: el.currentTime, duration: el.duration || 0, playing: !el.paused });
    for (const ev of ["timeupdate", "durationchange", "play", "pause", "seeked", "loadedmetadata"]) el.addEventListener(ev, sync);
    sync();
  },
  seek(t: number, play = true) {
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
