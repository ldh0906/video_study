import { useEffect, useMemo, useRef, useState } from "react";
import { AudioLines, Gauge, Maximize, MessageCircleQuestion, Minimize, Pause, Play, RotateCcw, RotateCw, Volume2, VolumeX } from "lucide-react";
import { fmtTime } from "@shared/time";
import type { Chapter, Frame, Lecture } from "@shared/types";
import { Popover, Tooltip } from "@/components/ui";
import { api } from "@/lib/api";
import { player, usePlayer } from "@/lib/player";
import { cn, isTyping } from "@/lib/utils";

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5];

function nearestFrame(frames: Frame[], t: number) {
  let lo = 0;
  let hi = frames.length - 1;
  let best: Frame | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].time <= t) {
      best = frames[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

export function Player({ lecture, chapters, frames, onAsk }: { lecture: Lecture; chapters: Chapter[]; frames: Frame[]; onAsk: (t: number) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const time = usePlayer((s) => s.time);
  const duration = usePlayer((s) => s.duration) || lecture.durationSec;
  const playing = usePlayer((s) => s.playing);
  const [speed, setSpeed] = useState(() => Number(localStorage.getItem("speed") ?? 1) || 1);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const video = lecture.hasVideo;

  useEffect(() => {
    player.attach(mediaRef.current);
    return () => player.attach(null);
  }, [lecture.mediaPath]);

  useEffect(() => {
    if (mediaRef.current) mediaRef.current.playbackRate = speed;
    try {
      localStorage.setItem("speed", String(speed));
    } catch {}
  }, [speed]);

  useEffect(() => {
    const on = () => setFullscreen(document.fullscreenElement === wrap.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const m = mediaRef.current;
      if (!m) return;
      const k = e.key.toLowerCase();
      if (k === " " || k === "k") {
        e.preventDefault();
        player.toggle();
      } else if (k === "j") player.seek(m.currentTime - 10, !m.paused);
      else if (k === "l") player.seek(m.currentTime + 10, !m.paused);
      else if (e.key === "ArrowLeft") player.seek(m.currentTime - 5, !m.paused);
      else if (e.key === "ArrowRight") player.seek(m.currentTime + 5, !m.paused);
      else if (k === "f" && video) toggleFullscreen();
      else if (k === "m") setMuted((v) => !v);
      else if (e.key === ">" || e.key === ".") setSpeed((s) => SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(s) + 1)] ?? s);
      else if (e.key === "<" || e.key === ",") setSpeed((s) => SPEEDS[Math.max(0, SPEEDS.indexOf(s) - 1)] ?? s);
      else return;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [video]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrap.current?.requestFullscreen();
  };

  const poke = () => {
    setIdle(false);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIdle(true), 2500);
  };

  const currentChapter = useMemo(() => chapters.find((c) => time >= c.start && time < c.end), [chapters, time]);
  const hoverChapter = hover ? chapters.find((c) => hover.t >= c.start && hover.t < c.end) : undefined;
  const hoverFrame = hover && frames.length ? nearestFrame(frames, hover.t) : undefined;
  const segments = chapters.length ? chapters : [{ title: "", start: 0, end: duration || 1, summary: "", sections: [] }];

  const scrubAt = (clientX: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return { x: clientX - r.left, t: p * (duration || 0), width: r.width };
  };

  const showControls = !playing || !idle || hover !== null;

  return (
    <div
      ref={wrap}
      onMouseMove={poke}
      onMouseLeave={() => setIdle(true)}
      className={cn(
        "group/player relative overflow-hidden bg-black select-none",
        fullscreen ? "flex size-full items-center" : "rounded-2xl shadow-float",
        !video && "bg-gradient-to-br from-[#26264a] via-[#1f1f2e] to-[#141416]",
        !showControls && fullscreen && "cursor-none",
      )}
    >
      {video ? (
        <video
          ref={mediaRef}
          src={api.mediaUrl(lecture.id)}
          preload="metadata"
          playsInline
          muted={muted}
          onClick={() => player.toggle()}
          onDoubleClick={toggleFullscreen}
          className={cn("block w-full bg-black", fullscreen ? "max-h-full" : "aspect-video")}
        />
      ) : (
        <div className="flex aspect-[16/7] w-full flex-col items-center justify-center gap-3 text-white/80" onClick={() => player.toggle()}>
          <AudioLines className={cn("size-12 text-white/60", playing && "animate-pulse")} />
          <div className="max-w-[80%] truncate text-sm font-medium">{currentChapter?.title ?? lecture.title}</div>
          <audio ref={mediaRef} src={api.mediaUrl(lecture.id)} preload="metadata" muted={muted} />
        </div>
      )}

      {!playing && video ? (
        <button
          onClick={() => player.toggle()}
          className="absolute top-1/2 left-1/2 flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur-md transition-transform hover:scale-105"
          aria-label="재생"
        >
          <Play className="ml-1 size-7 fill-current" />
        </button>
      ) : null}

      <div
        className={cn(
          "absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-3 pt-10 pb-2.5 transition-opacity duration-300",
          showControls ? "opacity-100" : "opacity-0",
        )}
      >
        {/* scrubber with chapter segments */}
        <div
          className="relative flex h-5 cursor-pointer items-center gap-[3px]"
          onMouseMove={(e) => setHover(scrubAt(e.clientX, e.currentTarget))}
          onMouseLeave={() => setHover(null)}
          onClick={(e) => player.seek(scrubAt(e.clientX, e.currentTarget).t, playing)}
        >
          {segments.map((c, i) => {
            const w = ((c.end - c.start) / (duration || 1)) * 100;
            const fill = Math.min(1, Math.max(0, (time - c.start) / (c.end - c.start || 1)));
            const hovered = hover && hover.t >= c.start && hover.t < c.end;
            return (
              <div key={i} style={{ width: `${w}%` }} className={cn("relative h-[4px] overflow-hidden rounded-full bg-white/25 transition-[height]", hovered && "h-[7px]")}>
                <div className="absolute inset-y-0 left-0 bg-white" style={{ width: `${fill * 100}%` }} />
              </div>
            );
          })}
          {hover ? (
            <div
              className="pointer-events-none absolute bottom-6 -translate-x-1/2"
              style={{ left: Math.min(Math.max(hover.x, 90), (wrap.current?.clientWidth ?? 400) - 110) }}
            >
              <div className="overflow-hidden rounded-xl border border-white/15 bg-black/85 text-white shadow-float backdrop-blur">
                {hoverFrame ? <img src={api.frameUrl(lecture.id, hoverFrame.file)} alt="" className="block h-[90px] w-[160px] object-cover" /> : null}
                <div className="max-w-[200px] px-2.5 py-1.5 text-center">
                  {hoverChapter?.title ? <div className="truncate text-[11.5px] font-medium">{hoverChapter.title}</div> : null}
                  <div className="text-[11px] text-white/70 tabular-nums">{fmtTime(hover.t)}</div>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <div className="mt-1 flex items-center gap-1 text-white">
          <CtrlButton label={playing ? "일시정지 (K)" : "재생 (K)"} onClick={() => player.toggle()}>
            {playing ? <Pause className="size-[18px] fill-current" /> : <Play className="size-[18px] fill-current" />}
          </CtrlButton>
          <CtrlButton label="10초 뒤로 (J)" onClick={() => player.seek(time - 10, playing)}>
            <RotateCcw className="size-[17px]" />
          </CtrlButton>
          <CtrlButton label="10초 앞으로 (L)" onClick={() => player.seek(time + 10, playing)}>
            <RotateCw className="size-[17px]" />
          </CtrlButton>
          <span className="hidden sm:contents">
            <CtrlButton label="음소거 (M)" onClick={() => setMuted((v) => !v)}>
              {muted ? <VolumeX className="size-[18px]" /> : <Volume2 className="size-[18px]" />}
            </CtrlButton>
          </span>
          <span className="ml-1 text-[12.5px] font-medium whitespace-nowrap text-white/90 tabular-nums">
            {fmtTime(time)} <span className="text-white/50">/ {fmtTime(duration)}</span>
          </span>
          {currentChapter?.title ? <span className="ml-2 hidden min-w-0 truncate text-[12.5px] text-white/70 md:block">· {currentChapter.title}</span> : null}
          <div className="flex-1" />
          <CtrlButton label="이 장면에 대해 질문" onClick={() => onAsk(time)}>
            <MessageCircleQuestion className="size-[18px]" />
          </CtrlButton>
          <Popover
            align="end"
            className="w-36 border-white/10 bg-[#1c1c1e] p-1 text-white"
            trigger={
              <button className="flex h-8 items-center gap-1 rounded-lg px-2 text-[12.5px] font-semibold whitespace-nowrap tabular-nums hover:bg-white/15" aria-label="재생 속도">
                <Gauge className="size-4" />
                {speed}×
              </button>
            }
          >
            {SPEEDS.map((s) => (
              <button
                key={s}
                onClick={() => setSpeed(s)}
                className={cn("flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-[13px] tabular-nums hover:bg-white/10", s === speed && "text-[#a5a5f7]")}
              >
                {s}× {s === 1 ? <span className="text-xs text-white/50">기본</span> : null}
              </button>
            ))}
          </Popover>
          {video ? (
            <CtrlButton label="전체 화면 (F)" onClick={toggleFullscreen}>
              {fullscreen ? <Minimize className="size-[18px]" /> : <Maximize className="size-[18px]" />}
            </CtrlButton>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function CtrlButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip content={label}>
      <button onClick={onClick} aria-label={label} className="flex size-8 items-center justify-center rounded-lg transition-colors hover:bg-white/15">
        {children}
      </button>
    </Tooltip>
  );
}

export function ChapterStrip({ chapters }: { chapters: Chapter[] }) {
  const second = usePlayer((s) => Math.floor(s.time));
  const ref = useRef<HTMLDivElement>(null);
  const active = chapters.findIndex((c) => second >= c.start && second < c.end);
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
  }, [active]);
  if (!chapters.length) return null;
  return (
    <div ref={ref} className="no-scrollbar flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
      {chapters.map((c, i) => (
        <button
          key={i}
          data-idx={i}
          onClick={() => player.seek(c.start)}
          className={cn(
            "flex max-w-[240px] shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-left transition-all",
            i === active ? "border-accent bg-accent-soft" : "border-border bg-surface hover:border-border-strong",
          )}
        >
          <span className={cn("text-[11.5px] font-semibold tabular-nums", i === active ? "text-accent" : "text-faint")}>{fmtTime(c.start)}</span>
          <span className="truncate text-[13px] font-medium">{c.title}</span>
        </button>
      ))}
    </div>
  );
}
