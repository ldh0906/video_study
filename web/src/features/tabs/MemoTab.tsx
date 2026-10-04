import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Clock, Eye, Pencil } from "lucide-react";
import { fmtTime } from "@shared/time";
import type { Lecture } from "@shared/types";
import { Markdown } from "@/components/Markdown";
import { Button, Segmented } from "@/components/ui";
import { api } from "@/lib/api";
import { player } from "@/lib/player";

export function MemoTab({ lecture, appendRequest }: { lecture: Lecture; appendRequest: { text: string; time: number | null; n: number } | null }) {
  const { data, isSuccess } = useQuery({ queryKey: ["notes", lecture.id], queryFn: () => api.notes(lecture.id) });
  const [content, setContent] = useState("");
  const [mode, setMode] = useState<"edit" | "view">("edit");
  const [saved, setSaved] = useState(true);
  const loaded = useRef(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const lastAppend = useRef(0);

  useEffect(() => {
    if (isSuccess && !loaded.current) {
      setContent(data.content);
      loaded.current = true;
    }
  }, [isSuccess, data]);

  useEffect(() => {
    if (!loaded.current || !appendRequest || appendRequest.n === lastAppend.current) return;
    lastAppend.current = appendRequest.n;
    const stamp = appendRequest.time !== null ? `[${fmtTime(appendRequest.time)}] ` : "";
    setContent((c) => `${c.trimEnd()}${c.trim() ? "\n\n" : ""}> ${stamp}${appendRequest.text.replace(/\n/g, "\n> ")}\n\n`);
    setSaved(false);
  }, [appendRequest, isSuccess]);

  useEffect(() => {
    if (!loaded.current || saved) return;
    const t = setTimeout(async () => {
      await api.saveNotes(lecture.id, content);
      setSaved(true);
    }, 700);
    return () => clearTimeout(t);
  }, [content, saved, lecture.id]);

  const insertTime = () => {
    const el = ta.current;
    const stamp = `[${fmtTime(player.state.time)}] `;
    if (!el) return setContent((c) => c + stamp);
    const { selectionStart: a, selectionEnd: b } = el;
    setContent((c) => c.slice(0, a) + stamp + c.slice(b));
    setSaved(false);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + stamp.length, a + stamp.length);
    });
  };

  return (
    <div className="mx-auto flex h-full max-w-[760px] flex-col px-1 pb-2">
      <div className="mb-3 flex items-center gap-2">
        <Segmented
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "edit", label: <span className="flex items-center gap-1"><Pencil className="size-3" />쓰기</span> },
            { value: "view", label: <span className="flex items-center gap-1"><Eye className="size-3" />보기</span> },
          ]}
        />
        {mode === "edit" ? (
          <Button size="sm" variant="ghost" onClick={insertTime} title="Ctrl+T">
            <Clock className="size-3.5" /> 현재 시각 넣기
          </Button>
        ) : null}
        <div className="flex-1" />
        <span className="flex items-center gap-1 text-xs text-faint">{saved ? <><Check className="size-3.5" /> 저장됨</> : "저장 중…"}</span>
      </div>
      {mode === "edit" ? (
        <textarea
          ref={ta}
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            setSaved(false);
          }}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "t") {
              e.preventDefault();
              insertTime();
            }
          }}
          placeholder={"강의를 보며 떠오른 생각을 자유롭게 적어 보세요.\n\n· Markdown과 $수식$을 쓸 수 있어요\n· Ctrl+T로 현재 재생 시각을 넣으면 나중에 그 장면으로 바로 이동할 수 있어요\n· 대본이나 노트에서 텍스트를 선택해 ‘메모’를 누르면 여기로 옮겨져요"}
          className="min-h-[360px] flex-1 resize-none rounded-2xl border border-border bg-surface p-5 font-[inherit] text-[14.5px] leading-[1.8] outline-none placeholder:text-faint focus:border-accent"
        />
      ) : (
        <div className="flex-1 overflow-y-auto rounded-2xl border border-border bg-surface p-6">
          {content.trim() ? <Markdown>{content}</Markdown> : <p className="text-sm text-faint">아직 메모가 없습니다.</p>}
        </div>
      )}
    </div>
  );
}
