import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Layers, Lightbulb, MessageCircleQuestion, NotebookPen } from "lucide-react";
import { useStudy } from "./study-context";

/**
 * Floating toolbar that appears when the user selects text inside `container`:
 * ask about it, get a simpler explanation, turn it into a card, or save it.
 */
export function SelectionActions({ container, timeOf }: { container: RefObject<HTMLElement | null>; timeOf?: (node: Node) => number | null }) {
  const { ask, addToMemo, makeCard } = useStudy();
  const [sel, setSel] = useState<{ text: string; x: number; y: number; time: number | null } | null>(null);

  useEffect(() => {
    const update = () => {
      const s = window.getSelection();
      const el = container.current;
      if (!s || s.isCollapsed || !el || !s.anchorNode || !el.contains(s.anchorNode)) return setSel(null);
      const text = s.toString().trim();
      if (text.length < 2) return setSel(null);
      const rect = s.getRangeAt(0).getBoundingClientRect();
      setSel({ text, x: rect.left + rect.width / 2, y: rect.top, time: timeOf?.(s.anchorNode) ?? null });
    };
    const onUp = () => setTimeout(update, 0);
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-selection-toolbar]")) setSel(null);
    };
    document.addEventListener("mouseup", onUp);
    document.addEventListener("keyup", onUp);
    document.addEventListener("mousedown", onDown);
    const scroller = container.current;
    const hide = () => setSel(null);
    scroller?.addEventListener("scroll", hide, { passive: true });
    return () => {
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("keyup", onUp);
      document.removeEventListener("mousedown", onDown);
      scroller?.removeEventListener("scroll", hide);
    };
  }, [container, timeOf]);

  if (!sel) return null;
  const quote = sel.text.length > 600 ? `${sel.text.slice(0, 600)}…` : sel.text;
  const done = () => {
    window.getSelection()?.removeAllRanges();
    setSel(null);
  };
  const actions = [
    { icon: <MessageCircleQuestion />, label: "질문", run: () => ask(`> ${quote.replace(/\n/g, "\n> ")}\n\n이 부분에 대해 질문이 있어요: `, sel.time) },
    { icon: <Lightbulb />, label: "쉽게 설명", run: () => ask(`다음 부분을 처음 배우는 사람도 이해할 수 있게 직관과 예시로 쉽게 설명해 주세요.\n\n> ${quote.replace(/\n/g, "\n> ")}`, sel.time) },
    { icon: <Layers />, label: "카드로", run: () => makeCard(quote, "", sel.time) },
    { icon: <NotebookPen />, label: "메모", run: () => addToMemo(quote, sel.time) },
  ];
  return createPortal(
    <div
      data-selection-toolbar
      className="fixed z-50 flex -translate-x-1/2 -translate-y-full items-center gap-0.5 rounded-xl border border-border bg-surface p-1 shadow-float animate-[popIn_120ms_ease]"
      style={{ left: Math.min(Math.max(sel.x, 160), window.innerWidth - 160), top: Math.max(sel.y - 8, 56) }}
    >
      {actions.map((a) => (
        <button
          key={a.label}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            a.run();
            done();
          }}
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-text hover:bg-surface-2 [&>svg]:size-3.5 [&>svg]:text-accent"
        >
          {a.icon}
          {a.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
