import { useRef, useState, type ReactNode, type RefObject } from "react";
import { GripVertical, Maximize2, Minimize2, Plus, X } from "lucide-react";
import { Menu, MenuItem, Tooltip } from "@/components/ui";
import { cn } from "@/lib/utils";
import { activate, moveInto, removeWidget, setSizes, showWidget, shown, splitWith, type Edge, type Group, type LayoutNode, type Split, type WidgetId } from "./layout";

export interface WidgetDef {
  label: string;
  icon: ReactNode;
  /** a number shown after the label, e.g. cards due */
  badge?: number;
  /** the body scrolls; otherwise the widget manages its own scrolling */
  scroll?: boolean;
  render: (scroller: RefObject<HTMLDivElement | null>) => ReactNode;
}

/** What is being dragged right now: dataTransfer can't be read during dragover. */
let dragging: { widgets: WidgetId[]; from: string } | null = null;
const DRAG_TYPE = "application/x-lens-tabs";

const MIN_PX = { row: 220, col: 120 };

/**
 * Panels of widget tabs in resizable splits, like Toss Securities' order
 * screen: drag a tab (or a panel's grip) onto another panel to merge, onto
 * its edge to split it; drag the gaps to resize; one panel can fill the
 * workspace. A maximized panel stays where it is in the tree (it is only
 * positioned over the others), so a playing video keeps playing.
 */
export function Workspace({
  layout,
  onLayout,
  defs,
  maximized,
  onMaximize,
}: {
  layout: LayoutNode;
  onLayout: (next: LayoutNode) => void;
  defs: Record<WidgetId, WidgetDef | undefined>;
  maximized: string | null;
  onMaximize: (groupId: string | null) => void;
}) {
  const available = (Object.keys(defs) as WidgetId[]).filter((w) => defs[w]);
  const hidden = available.filter((w) => !shown(layout).includes(w));
  const ctx: Ctx = { layout, onLayout, defs, hidden, maximized, onMaximize };
  return <div className="relative flex min-h-0 flex-1">{renderNode(layout, [], ctx)}</div>;
}

interface Ctx {
  layout: LayoutNode;
  onLayout: (next: LayoutNode) => void;
  defs: Record<WidgetId, WidgetDef | undefined>;
  hidden: WidgetId[];
  maximized: string | null;
  onMaximize: (groupId: string | null) => void;
}

function renderNode(node: LayoutNode, path: number[], ctx: Ctx): ReactNode {
  return node.type === "group" ? <Panel key={node.id} group={node} ctx={ctx} /> : <SplitView key={path.join(".") || "root"} split={node} path={path} ctx={ctx} />;
}

function SplitView({ split, path, ctx }: { split: Split; path: number[]; ctx: Ctx }) {
  const box = useRef<HTMLDivElement>(null);
  const row = split.dir === "row";
  const drag = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    const el = box.current;
    if (!el) return;
    const total = row ? el.clientWidth : el.clientHeight;
    const start = row ? e.clientX : e.clientY;
    const base = split.sizes;
    const min = MIN_PX[split.dir] / total;
    const move = (ev: PointerEvent) => {
      const d = ((row ? ev.clientX : ev.clientY) - start) / total;
      const pair = base[i] + base[i + 1];
      const a = Math.min(pair - min, Math.max(min, base[i] + d));
      const sizes = [...base];
      sizes[i] = a;
      sizes[i + 1] = pair - a;
      ctx.onLayout(setSizes(ctx.layout, path, sizes));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = row ? "ew-resize" : "ns-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div ref={box} className={cn("flex min-h-0 min-w-0 flex-1", row ? "flex-row" : "flex-col")}>
      {split.children.map((child, i) => (
        <div key={child.type === "group" ? child.id : `s${i}`} className="contents">
          {i > 0 ? (
            <div
              role="separator"
              aria-orientation={row ? "vertical" : "horizontal"}
              aria-label="패널 크기 조절"
              onPointerDown={drag(i - 1)}
              className={cn("group flex shrink-0 items-center justify-center", row ? "w-2.5 cursor-ew-resize" : "h-2.5 cursor-ns-resize")}
            >
              <div className={cn("rounded-full bg-transparent transition-colors group-hover:bg-accent/60", row ? "h-10 w-1" : "h-1 w-10")} />
            </div>
          ) : null}
          <div className="flex min-h-0 min-w-0" style={{ flex: `${split.sizes[i]} 1 0px` }}>
            {renderNode(child, [...path, i], ctx)}
          </div>
        </div>
      ))}
    </div>
  );
}

function Panel({ group, ctx }: { group: Group; ctx: Ctx }) {
  const scroller = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [zone, setZone] = useState<Edge | "center" | null>(null);
  const [tabDrop, setTabDrop] = useState<number | null>(null);
  const def = ctx.defs[group.active];
  const max = ctx.maximized === group.id;

  const start = (widgets: WidgetId[]) => (e: React.DragEvent) => {
    dragging = { widgets, from: group.id };
    e.dataTransfer.setData(DRAG_TYPE, widgets.join(","));
    e.dataTransfer.effectAllowed = "move";
  };
  const end = () => {
    dragging = null;
    setZone(null);
    setTabDrop(null);
  };
  const accepts = (e: React.DragEvent) => !!dragging && e.dataTransfer.types.includes(DRAG_TYPE);

  const zoneAt = (e: React.DragEvent): Edge | "center" => {
    const r = body.current!.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const edges: [Edge, number][] = [
      ["left", x],
      ["right", 1 - x],
      ["top", y],
      ["bottom", 1 - y],
    ];
    const [edge, d] = edges.sort((a, b) => a[1] - b[1])[0];
    return d < 0.25 ? edge : "center";
  };

  const dropOnBody = (e: React.DragEvent) => {
    if (!accepts(e)) return;
    e.preventDefault();
    const z = zoneAt(e);
    const { widgets } = dragging!;
    end();
    ctx.onLayout(z === "center" ? moveInto(ctx.layout, widgets, group.id) : splitWith(ctx.layout, widgets, group.id, z));
  };
  const dropOnTabs = (index: number) => (e: React.DragEvent) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const { widgets } = dragging!;
    end();
    ctx.onLayout(moveInto(ctx.layout, widgets, group.id, index));
  };

  const overlay: Record<Edge | "center", string> = {
    center: "inset-1.5",
    left: "inset-y-1.5 left-1.5 w-1/2",
    right: "inset-y-1.5 right-1.5 w-1/2",
    top: "inset-x-1.5 top-1.5 h-1/2",
    bottom: "inset-x-1.5 bottom-1.5 h-1/2",
  };

  return (
    <section
      aria-label={`${group.tabs.map((t) => ctx.defs[t]?.label).join(", ")} 패널`}
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-soft",
        // positioned over the whole workspace, but still in place in the tree
        max ? "absolute inset-0 z-20" : "relative",
      )}
      onDragEnd={end}
    >
      <header
        className="flex h-10 shrink-0 items-center gap-0.5 border-b border-border px-1.5"
        onDragOver={(e) => {
          if (!accepts(e)) return;
          e.preventDefault();
          setTabDrop(group.tabs.length);
        }}
        onDragLeave={() => setTabDrop(null)}
        onDrop={dropOnTabs(group.tabs.length)}
      >
        <Tooltip content="끌어서 다른 패널로 옮기기 · 가장자리에 놓으면 나눠져요">
          <span draggable onDragStart={start(group.tabs)} className="flex size-6 shrink-0 cursor-grab items-center justify-center rounded-md text-faint hover:bg-surface-2 hover:text-muted active:cursor-grabbing" aria-label="패널 옮기기">
            <GripVertical className="size-3.5" />
          </span>
        </Tooltip>
        <div role="tablist" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
          {group.tabs.map((t, i) => {
            const d = ctx.defs[t];
            if (!d) return null;
            const on = t === group.active;
            return (
              <div
                key={t}
                role="tab"
                aria-selected={on}
                draggable
                onDragStart={start([t])}
                onDragOver={(e) => {
                  if (!accepts(e)) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setTabDrop(i);
                }}
                onDrop={dropOnTabs(i)}
                onClick={() => ctx.onLayout(activate(ctx.layout, t))}
                onDoubleClick={() => ctx.onMaximize(max ? null : group.id)}
                className={cn(
                  "group/tab relative flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-semibold whitespace-nowrap transition-colors select-none [&>svg]:size-3.5",
                  on ? "bg-surface-2 text-text" : "text-muted hover:bg-surface-2/70 hover:text-text",
                  tabDrop === i && "before:absolute before:inset-y-1 before:-left-0.5 before:w-0.5 before:rounded-full before:bg-accent",
                )}
              >
                {d.icon}
                {d.label}
                {d.badge ? <span className="rounded-full bg-accent px-1.5 text-[10.5px] leading-4 font-bold text-accent-fg tabular-nums">{d.badge}</span> : null}
                {t !== "source" ? (
                  <button
                    aria-label={`${d.label} 닫기`}
                    onClick={(e) => {
                      e.stopPropagation();
                      ctx.onLayout(removeWidget(ctx.layout, t));
                    }}
                    className={cn("-mr-1 rounded p-0.5 text-faint hover:bg-surface-3 hover:text-text", on ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100")}
                  >
                    <X className="size-3" />
                  </button>
                ) : null}
              </div>
            );
          })}
          {ctx.hidden.length ? (
            <Menu
              align="start"
              trigger={
                <button aria-label="이 패널에 위젯 추가" className="flex size-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-surface-2 hover:text-text">
                  <Plus className="size-3.5" />
                </button>
              }
            >
              {ctx.hidden.map((w) => (
                <MenuItem key={w} icon={ctx.defs[w]!.icon} onSelect={() => ctx.onLayout(showWidget(ctx.layout, w, group.id))}>
                  {ctx.defs[w]!.label}
                </MenuItem>
              ))}
            </Menu>
          ) : null}
        </div>
        <Tooltip content={max ? "원래 크기로 (Esc)" : "크게 보기"}>
          <button onClick={() => ctx.onMaximize(max ? null : group.id)} aria-label={max ? "원래 크기로" : "패널 크게 보기"} className="flex size-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-surface-2 hover:text-text">
            {max ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
        </Tooltip>
      </header>
      <div
        ref={body}
        className="relative min-h-0 flex-1"
        onDragOver={(e) => {
          if (!accepts(e)) return;
          e.preventDefault();
          setZone(zoneAt(e));
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setZone(null);
        }}
        onDrop={dropOnBody}
      >
        <div ref={scroller} className={cn("h-full", def?.scroll ? "overflow-y-auto px-4 py-3" : "overflow-hidden p-2")}>
          {def?.render(scroller)}
        </div>
        {zone ? <div className={cn("pointer-events-none absolute z-10 rounded-xl border-2 border-dashed border-accent bg-accent/10 transition-all", overlay[zone])} /> : null}
      </div>
    </section>
  );
}
