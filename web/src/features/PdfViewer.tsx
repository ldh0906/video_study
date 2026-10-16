import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Minus, Plus, ScanLine } from "lucide-react";
import { GlobalWorkerOptions, TextLayer, getDocument, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Lecture } from "@shared/types";
import { Button, Spinner, Tooltip } from "@/components/ui";
import { api } from "@/lib/api";
import { player } from "@/lib/player";
import { cn } from "@/lib/utils";
import { SelectionActions } from "./SelectionActions";

GlobalWorkerOptions.workerSrc = workerUrl;

const PAGE_GAP = 14;

/**
 * The document side of a PDF item: scrollable pages rendered on demand with a
 * selectable text layer. It stands in for the video player, so citations like
 * [p.12] anywhere in the app scroll it to that page.
 */
export function PdfViewer({ lecture, className }: { lecture: Lecture; className?: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([]);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(() => Number(localStorage.getItem("pdfZoom")) || 1);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");

  useEffect(() => {
    let alive = true;
    const task = getDocument({ url: api.pdfUrl(lecture.id), cMapUrl: "/api/kit/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/api/kit/pdfjs/standard_fonts/" });
    task.promise
      .then(async (d) => {
        // page sizes up front, so the scroll height is right before anything renders
        const out = await Promise.all(
          Array.from({ length: d.numPages }, async (_, i) => {
            const vp = (await d.getPage(i + 1)).getViewport({ scale: 1 });
            return { w: vp.width, h: vp.height };
          }),
        );
        if (!alive) return;
        setSizes(out);
        setDoc(d);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
      void task.destroy();
    };
  }, [lecture.id]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // measure now too: observer callbacks wait for a rendered frame, which a background window may not get
    setWidth(el.clientWidth - 24);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth - 24));
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc]);

  const goto = useCallback((n: number) => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-page="${n}"]`);
    if (!el) return;
    scroller.current!.scrollTo({ top: el.offsetTop - 8, behavior: Math.abs(n - player.state.time) > 6 ? "auto" : "smooth" });
    // the last pages can't scroll to the top, so the counter follows the jump, not the scroll position
    setPage(n);
    setPageInput(String(n));
  }, []);

  useEffect(() => {
    if (!doc) return;
    player.attachPages(doc.numPages, goto);
    return () => player.detachPages(goto);
  }, [doc, goto]);

  // the page whose top crossed the upper third is the current one
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const line = el.scrollTop + el.clientHeight / 3;
    let current = 1;
    for (const child of el.querySelectorAll<HTMLElement>("[data-page]")) {
      if (child.offsetTop <= line) current = Number(child.dataset.page);
      else break;
    }
    // scrolled to the end: the last page is the one being read even if its top never reaches the line
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) current = sizes.length;
    if (current !== page) {
      setPage(current);
      setPageInput(String(current));
      player.setPage(current);
    }
  };

  const setZoomSaved = (z: number) => {
    const v = Math.min(2.5, Math.max(0.5, Math.round(z * 10) / 10));
    setZoom(v);
    try {
      localStorage.setItem("pdfZoom", String(v));
    } catch {}
    requestAnimationFrame(() => goto(page));
  };

  const timeOf = useCallback((node: Node) => {
    const el = (node instanceof HTMLElement ? node : node.parentElement)?.closest<HTMLElement>("[data-page]");
    return el ? Number(el.dataset.page) : null;
  }, []);

  if (error) return <div className={cn("flex items-center justify-center rounded-2xl border border-border bg-surface p-6 text-sm text-danger", className)}>PDF를 열지 못했어요: {error}</div>;

  return (
    <div className={cn("flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface-2", className)}>
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-surface px-2 py-1.5">
        <Button size="icon-sm" variant="ghost" aria-label="이전 페이지" disabled={page <= 1} onClick={() => goto(page - 1)}>
          <ChevronLeft className="size-4" />
        </Button>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const n = Math.min(sizes.length, Math.max(1, Number(pageInput) || 1));
            goto(n);
          }}
          className="flex items-center gap-1 text-[12.5px] text-muted tabular-nums"
        >
          <input value={pageInput} onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))} aria-label="페이지 번호" className="h-7 w-10 rounded-md border border-border bg-surface-2 text-center text-[12.5px] text-text outline-none focus:border-accent" />
          <span>/ {sizes.length || "…"}</span>
        </form>
        <Button size="icon-sm" variant="ghost" aria-label="다음 페이지" disabled={page >= sizes.length} onClick={() => goto(page + 1)}>
          <ChevronRight className="size-4" />
        </Button>
        <div className="flex-1" />
        <Tooltip content="축소">
          <Button size="icon-sm" variant="ghost" aria-label="축소" onClick={() => setZoomSaved(zoom - 0.1)}>
            <Minus className="size-4" />
          </Button>
        </Tooltip>
        <button onClick={() => setZoomSaved(1)} className="min-w-[44px] rounded-md px-1 text-[12px] font-medium text-muted tabular-nums hover:bg-surface-2" title="폭에 맞추기">
          {Math.round(zoom * 100)}%
        </button>
        <Tooltip content="확대">
          <Button size="icon-sm" variant="ghost" aria-label="확대" onClick={() => setZoomSaved(zoom + 0.1)}>
            <Plus className="size-4" />
          </Button>
        </Tooltip>
        <Tooltip content="폭에 맞추기">
          <Button size="icon-sm" variant="ghost" aria-label="폭에 맞추기" onClick={() => setZoomSaved(1)}>
            <ScanLine className="size-4" />
          </Button>
        </Tooltip>
      </div>
      <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-auto px-3 py-2">
        {!doc ? (
          <div className="flex h-full items-center justify-center text-sm text-muted">
            <Spinner className="mr-2" /> PDF 여는 중…
          </div>
        ) : width > 0 ? (
          sizes.map((s, i) => {
            const scale = (width / s.w) * zoom;
            return <PdfPage key={i} doc={doc} n={i + 1} scale={scale} w={s.w * scale} h={s.h * scale} root={scroller} />;
          })
        ) : null}
        <SelectionActions container={scroller} timeOf={timeOf} />
      </div>
    </div>
  );
}

function PdfPage({ doc, n, scale, w, h, root }: { doc: PDFDocumentProxy; n: number; scale: number; w: number; h: number; root: React.RefObject<HTMLDivElement | null> }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // pages far off screen give their canvas back: a 500-page book would otherwise hold gigabytes
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { root: root.current, rootMargin: "1600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    if (!visible) {
      if (canvas.current) canvas.current.width = canvas.current.height = 0;
      text.current?.replaceChildren();
      return;
    }
    let task: RenderTask | null = null;
    let layer: TextLayer | null = null;
    let cancelled = false;
    void (async () => {
      const page = await doc.getPage(n);
      if (cancelled || !canvas.current || !text.current) return;
      const viewport = page.getViewport({ scale });
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const c = canvas.current;
      c.width = Math.floor(viewport.width * dpr);
      c.height = Math.floor(viewport.height * dpr);
      task = page.render({ canvas: c, canvasContext: c.getContext("2d")!, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      await task.promise.catch(() => {});
      if (cancelled) return;
      text.current.replaceChildren();
      text.current.style.setProperty("--total-scale-factor", String(scale));
      layer = new TextLayer({ textContentSource: page.streamTextContent(), container: text.current, viewport });
      await layer.render().catch(() => {});
    })();
    return () => {
      cancelled = true;
      task?.cancel();
      layer?.cancel();
    };
  }, [visible, doc, n, scale]);

  return (
    <div ref={box} data-page={n} className="relative mx-auto bg-white shadow-soft" style={{ width: w, height: h, marginBottom: PAGE_GAP }}>
      <canvas ref={canvas} className="absolute inset-0 size-full" />
      <div ref={text} className="textLayer" />
      <span className="pointer-events-none absolute right-2 bottom-1.5 rounded bg-black/45 px-1.5 text-[10.5px] font-medium text-white tabular-nums">{n}</span>
    </div>
  );
}
