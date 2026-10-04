import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Clock, Copy, Eraser, Layers, Sparkles, Square } from "lucide-react";
import { toast } from "sonner";
import { fmtTime } from "@shared/time";
import type { ChatMessage, Lecture } from "@shared/types";
import { Markdown } from "@/components/Markdown";
import { Button, Tooltip } from "@/components/ui";
import { api, streamChat } from "@/lib/api";
import { player, usePlayerSecond } from "@/lib/player";
import { cn } from "@/lib/utils";
import { useStudy } from "../study-context";

const SUGGESTIONS = [
  "이 강의의 핵심을 5줄로 정리해 줘",
  "가장 어려운 개념을 비유를 들어 쉽게 설명해 줘",
  "시험에 나올 만한 내용은 뭐야?",
  "이 강의를 이해하려면 뭘 먼저 알아야 해?",
];

export function ChatTab({ lecture, pending, onPendingConsumed }: { lecture: Lecture; pending: { text: string; anchor: number | null } | null; onPendingConsumed: () => void }) {
  const qc = useQueryClient();
  const { makeCard } = useStudy();
  const { data: history = [] } = useQuery({ queryKey: ["chat", lecture.id], queryFn: () => api.chat(lecture.id) });
  const [input, setInput] = useState("");
  const [anchorOn, setAnchorOn] = useState(false);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [streaming, setStreaming] = useState<{ user: ChatMessage; text: string } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const second = usePlayerSecond();

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [history.length, streaming?.text]);

  useEffect(() => {
    if (!pending) return;
    setInput(pending.text);
    if (pending.anchor !== null && pending.anchor !== undefined) {
      setAnchor(pending.anchor);
      setAnchorOn(true);
    }
    onPendingConsumed();
    setTimeout(() => {
      const el = textarea.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 50);
  }, [pending, onPendingConsumed]);

  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  const send = async (text = input) => {
    const msg = text.trim();
    if (!msg || streaming) return;
    const at = anchorOn ? (anchor ?? second) : null;
    const user: ChatMessage = { id: "pending", role: "user", content: msg, createdAt: Date.now(), anchor: at };
    setInput("");
    setAnchorOn(false);
    setAnchor(null);
    setStreaming({ user, text: "" });
    abort.current = new AbortController();
    try {
      const res = await streamChat(lecture.id, msg, at, {
        onDelta: (d) => setStreaming((s) => (s ? { ...s, text: s.text + d } : s)),
        signal: abort.current.signal,
      });
      if (!res.ok) toast.error("답변을 받지 못했습니다", { description: res.error });
    } catch (e) {
      if ((e as Error).name !== "AbortError") toast.error((e as Error).message);
    } finally {
      await qc.invalidateQueries({ queryKey: ["chat", lecture.id] });
      setStreaming(null);
    }
  };

  const messages = [...history, ...(streaming ? [streaming.user] : [])];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-1">
        {messages.length === 0 ? (
          <div className="mx-auto max-w-[520px] pt-10 pb-6 text-center">
            <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
              <Sparkles className="size-6" />
            </div>
            <h3 className="font-serif text-[20px] font-semibold">무엇이든 물어보세요</h3>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">강의 전체 내용을 알고 있는 튜터예요. 답변 속 시간을 누르면 그 장면으로 이동합니다.</p>
            <div className="mt-6 grid gap-2 sm:grid-cols-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} className="rounded-xl border border-border bg-surface px-3.5 py-3 text-left text-[13px] leading-snug transition-colors hover:border-accent hover:text-accent">
                  {s}
                </button>
              ))}
              <button
                onClick={() => {
                  setAnchor(second);
                  setAnchorOn(true);
                  send(`지금 보고 있는 [${fmtTime(second)}] 장면의 내용을 설명해 줘`);
                }}
                className="rounded-xl border border-dashed border-accent/50 bg-accent-soft px-3.5 py-3 text-left text-[13px] leading-snug text-accent sm:col-span-2"
              >
                지금 보는 장면 ({fmtTime(second)}) 설명해 줘
              </button>
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-[720px] space-y-6 py-4">
            {messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id + m.createdAt} className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap text-accent-fg">
                    {m.anchor !== null && m.anchor !== undefined ? (
                      <button onClick={() => player.seek(m.anchor!)} className="mb-1 flex items-center gap-1 text-[11.5px] font-semibold opacity-80 hover:opacity-100">
                        <Clock className="size-3" /> {fmtTime(m.anchor)} 장면
                      </button>
                    ) : null}
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={m.id} className="group">
                  <div className={cn("rounded-2xl", m.error && "border border-danger/30 bg-danger-soft px-4 py-3 text-[13.5px] text-danger")}>
                    {m.error ? m.content : <Markdown>{m.content}</Markdown>}
                  </div>
                  {!m.error ? (
                    <div className="mt-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <Tooltip content="복사">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => {
                            navigator.clipboard.writeText(m.content);
                            toast.success("복사했습니다");
                          }}
                        >
                          <Copy className="size-3.5" />
                        </Button>
                      </Tooltip>
                      <Tooltip content="플래시카드로 만들기">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => {
                            const idx = history.findIndex((x) => x.id === m.id);
                            const q = idx > 0 ? history[idx - 1].content : "";
                            makeCard(q, m.content);
                          }}
                        >
                          <Layers className="size-3.5" />
                        </Button>
                      </Tooltip>
                    </div>
                  ) : null}
                </div>
              ),
            )}
            {streaming ? (
              streaming.text ? (
                <Markdown streaming>{streaming.text}</Markdown>
              ) : (
                <div className="flex items-center gap-1.5 py-2">
                  {[0, 1, 2].map((i) => (
                    <span key={i} className="size-1.5 animate-bounce rounded-full bg-accent" style={{ animationDelay: `${i * 0.15}s` }} />
                  ))}
                </div>
              )
            ) : null}
            <div ref={bottom} />
          </div>
        )}
      </div>

      <div className="mx-auto w-full max-w-[720px] px-1 pt-2 pb-1">
        <div className="rounded-2xl border border-border bg-surface p-2 shadow-soft transition-colors focus-within:border-accent">
          <textarea
            ref={textarea}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="강의에 대해 질문하기…  (Shift+Enter 줄바꿈)"
            className="block max-h-[200px] w-full resize-none bg-transparent px-2 py-1.5 text-[14px] leading-relaxed outline-none placeholder:text-faint"
          />
          <div className="mt-1 flex items-center gap-1.5">
            <button
              onClick={() => {
                setAnchorOn((v) => !v);
                setAnchor(null);
              }}
              className={cn(
                "flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium transition-colors",
                anchorOn ? "bg-accent-soft text-accent" : "text-faint hover:bg-surface-2 hover:text-muted",
              )}
            >
              <Clock className="size-3.5" />
              {anchorOn ? `${fmtTime(anchor ?? second)} 장면 기준` : "현재 장면 기준"}
            </button>
            <div className="flex-1" />
            {history.length > 0 && !streaming ? (
              <Tooltip content="대화 지우기">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={async () => {
                    if (!confirm("대화를 모두 지울까요?")) return;
                    await api.clearChat(lecture.id);
                    qc.invalidateQueries({ queryKey: ["chat", lecture.id] });
                  }}
                >
                  <Eraser className="size-3.5" />
                </Button>
              </Tooltip>
            ) : null}
            {streaming ? (
              <Button size="icon-sm" variant="secondary" onClick={() => abort.current?.abort()} aria-label="중지">
                <Square className="size-3 fill-current" />
              </Button>
            ) : (
              <Button size="icon-sm" variant="primary" onClick={() => send()} disabled={!input.trim()} aria-label="보내기">
                <ArrowUp className="size-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
