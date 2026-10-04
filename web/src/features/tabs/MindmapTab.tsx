import { useEffect, useRef, useState } from "react";
import { Transformer } from "markmap-lib";
import { Markmap } from "markmap-view";
import { Download, Maximize2, Minus, Plus } from "lucide-react";
import type { Analysis } from "@shared/types";
import { Button, Tooltip } from "@/components/ui";
import { downloadText } from "@/lib/utils";

const transformer = new Transformer();
const PALETTE = ["#5b5bd6", "#2f8f5b", "#c2410c", "#0e7490", "#a21caf", "#b7791f", "#be123c", "#4d7c0f"];

export function MindmapTab({ analysis }: { analysis: Analysis }) {
  const svg = useRef<SVGSVGElement>(null);
  const mm = useRef<Markmap | null>(null);
  const [level, setLevel] = useState(3);

  useEffect(() => {
    if (!svg.current) return;
    const { root } = transformer.transform(analysis.overview.mindmap || `# ${analysis.overview.title}`);
    mm.current?.destroy();
    svg.current.innerHTML = "";
    // paths look like "1.5.8" (node ids); give each top-level branch its own palette color
    const branchColor = new Map<string, string>();
    const colorOf = (path = "") => {
      const branch = path.split(".")[1] ?? "";
      if (!branchColor.has(branch)) branchColor.set(branch, PALETTE[branchColor.size % PALETTE.length]);
      return branchColor.get(branch)!;
    };
    mm.current = Markmap.create(
      svg.current,
      {
        autoFit: true,
        duration: 350,
        initialExpandLevel: level,
        spacingHorizontal: 70,
        spacingVertical: 10,
        paddingX: 12,
        maxWidth: 260,
        color: (node) => colorOf(node.state?.path),
      },
      root,
    );
    return () => {
      mm.current?.destroy();
      mm.current = null;
    };
  }, [analysis, level]);

  return (
    <div className="relative h-full min-h-[420px] overflow-hidden rounded-2xl border border-border bg-surface">
      <svg ref={svg} className="markmap-wrap size-full" />
      <div className="absolute top-3 right-3 flex gap-1 rounded-xl border border-border bg-surface/90 p-1 shadow-soft backdrop-blur">
        <Tooltip content="한 단계 접기">
          <Button variant="ghost" size="icon-sm" onClick={() => setLevel((l) => Math.max(1, l - 1))} aria-label="접기">
            <Minus className="size-4" />
          </Button>
        </Tooltip>
        <Tooltip content="한 단계 펼치기">
          <Button variant="ghost" size="icon-sm" onClick={() => setLevel((l) => Math.min(6, l + 1))} aria-label="펼치기">
            <Plus className="size-4" />
          </Button>
        </Tooltip>
        <Tooltip content="화면에 맞추기">
          <Button variant="ghost" size="icon-sm" onClick={() => mm.current?.fit()} aria-label="맞추기">
            <Maximize2 className="size-4" />
          </Button>
        </Tooltip>
        <Tooltip content="SVG로 저장">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="저장"
            onClick={() => svg.current && downloadText(`${analysis.overview.title}-mindmap.svg`, new XMLSerializer().serializeToString(svg.current), "image/svg+xml")}
          >
            <Download className="size-4" />
          </Button>
        </Tooltip>
      </div>
      <p className="pointer-events-none absolute bottom-3 left-4 text-[11.5px] text-faint">드래그로 이동 · 스크롤로 확대 · 동그라미를 눌러 접고 펼치기</p>
    </div>
  );
}
