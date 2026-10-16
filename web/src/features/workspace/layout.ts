/**
 * The lecture workspace as a tree, after Toss Securities' order screen:
 * splits hold panels side by side ("row") or stacked ("col"); each panel is
 * a group of widget tabs. Every widget appears at most once; the source
 * (video or PDF) is always somewhere. Pure functions, so the UI only renders.
 */

export type WidgetId = "source" | "transcript" | "overview" | "notes" | "explore" | "mindmap" | "cards" | "quiz" | "chat" | "materials" | "memo";

export interface Group {
  type: "group";
  id: string;
  tabs: WidgetId[];
  active: WidgetId;
}

export interface Split {
  type: "split";
  dir: "row" | "col";
  /** shares of the split, summing to 1 */
  sizes: number[];
  children: LayoutNode[];
}

export type LayoutNode = Group | Split;
export type SourceKind = "video" | "doc";
export type Edge = "left" | "right" | "top" | "bottom";
export type PresetId = "toss" | "two" | "focus";

export const ALL_WIDGETS: WidgetId[] = ["source", "transcript", "overview", "notes", "explore", "mindmap", "cards", "quiz", "chat", "materials", "memo"];

/** The widgets an item can show: a PDF has no transcript. */
export function availableWidgets(kind: SourceKind): WidgetId[] {
  return kind === "doc" ? ALL_WIDGETS.filter((w) => w !== "transcript") : ALL_WIDGETS;
}

let seq = 0;
const groupId = () => `g${Date.now().toString(36)}${(seq++).toString(36)}`;

export const group = (tabs: WidgetId[], active = tabs[0]): Group => ({ type: "group", id: groupId(), tabs, active });
const split = (dir: Split["dir"], parts: [number, LayoutNode][]): Split => ({ type: "split", dir, sizes: parts.map((p) => p[0]), children: parts.map((p) => p[1]) });

export const PRESETS: Record<PresetId, { label: string; hint: string }> = {
  toss: { label: "3열 (기본)", hint: "영상·대본·메모 | 노트 | 튜터·연습" },
  two: { label: "2열", hint: "영상·대본 | 모든 학습 탭" },
  focus: { label: "영상 집중", hint: "큰 영상 | 튜터·노트" },
};

export function preset(id: PresetId, kind: SourceKind): LayoutNode {
  const layouts: Record<PresetId, () => LayoutNode> = {
    toss: () =>
      split("row", [
        [0.42, split("col", [[0.62, group(["source"])], [0.38, split("row", [[0.5, group(["transcript"])], [0.5, group(["memo"])]])]])],
        [0.33, group(["notes", "overview", "explore", "mindmap"])],
        [0.25, split("col", [[0.55, group(["chat"])], [0.45, group(["cards", "quiz", "materials"])]])],
      ]),
    two: () =>
      split("row", [
        [0.52, split("col", [[0.62, group(["source"])], [0.38, group(["transcript", "memo"])]])],
        [0.48, group(["overview", "notes", "explore", "mindmap", "cards", "quiz", "chat", "materials"])],
      ]),
    focus: () => split("row", [[0.68, group(["source"])], [0.32, split("col", [[0.5, group(["chat"])], [0.5, group(["notes", "transcript", "memo"])]])]]),
  };
  return normalize(layouts[id](), kind) ?? layouts.toss();
}

// --- queries --------------------------------------------------------------------------

export function groups(node: LayoutNode): Group[] {
  return node.type === "group" ? [node] : node.children.flatMap(groups);
}

export function shown(node: LayoutNode): WidgetId[] {
  return groups(node).flatMap((g) => g.tabs);
}

export function groupOf(node: LayoutNode, widget: WidgetId): Group | undefined {
  return groups(node).find((g) => g.tabs.includes(widget));
}

// --- edits (each returns a new tree) -----------------------------------------------------

/** Rebuild a split from its kept children, collapsing a lone child and rescaling sizes. */
function rebuild(s: Split, kids: { node: LayoutNode; size: number }[]): LayoutNode | null {
  if (!kids.length) return null;
  if (kids.length === 1) return kids[0].node;
  const sum = kids.reduce((n, k) => n + k.size, 0) || 1;
  // a child that is a split in the same direction merges into this one
  const flat: { node: LayoutNode; size: number }[] = [];
  for (const k of kids) {
    if (k.node.type === "split" && k.node.dir === s.dir) k.node.children.forEach((c, i) => flat.push({ node: c, size: (k.size * (k.node as Split).sizes[i]) / sum }));
    else flat.push({ node: k.node, size: k.size / sum });
  }
  return { ...s, sizes: flat.map((k) => k.size), children: flat.map((k) => k.node) };
}

function mapGroups(node: LayoutNode, fn: (g: Group) => Group | null): LayoutNode | null {
  if (node.type === "group") {
    const g = fn(node);
    return g && g.tabs.length ? g : null;
  }
  const kids = node.children.map((c, i) => ({ node: mapGroups(c, fn), size: node.sizes[i] })).filter((k): k is { node: LayoutNode; size: number } => k.node !== null);
  return rebuild(node, kids);
}

export function activate(node: LayoutNode, widget: WidgetId): LayoutNode {
  return mapGroups(node, (g) => (g.tabs.includes(widget) ? { ...g, active: widget } : g))!;
}

export function removeWidget(node: LayoutNode, widget: WidgetId): LayoutNode {
  if (widget === "source") return node;
  return (
    mapGroups(node, (g) => {
      if (!g.tabs.includes(widget)) return g;
      const i = g.tabs.indexOf(widget);
      const tabs = g.tabs.filter((t) => t !== widget);
      return { ...g, tabs, active: g.active === widget ? (tabs[Math.max(0, i - 1)] ?? tabs[0]) : g.active };
    }) ?? node
  );
}

/** Put widgets into a group at `index` (moving them from wherever they are) and activate the first. */
export function moveInto(node: LayoutNode, widgets: WidgetId[], targetId: string, index?: number): LayoutNode {
  const target = groups(node).find((g) => g.id === targetId);
  if (!target) return node;
  // removing first can collapse the target's siblings, but never the target itself unless it held only these
  const rest = target.tabs.filter((t) => !widgets.includes(t));
  if (!rest.length) return activate(node, widgets[0]);
  let tree = node;
  for (const w of widgets) tree = w === "source" ? stripSource(tree) : removeWidget(tree, w);
  const at = Math.min(index ?? rest.length, rest.length);
  return (
    mapGroups(tree, (g) => {
      if (g.id !== targetId) return g;
      const tabs = [...g.tabs.slice(0, at), ...widgets, ...g.tabs.slice(at)];
      return { ...g, tabs, active: widgets[0] };
    }) ?? node
  );
}

/** Move widgets next to a group, splitting it on that edge. */
export function splitWith(node: LayoutNode, widgets: WidgetId[], targetId: string, edge: Edge): LayoutNode {
  const target = groups(node).find((g) => g.id === targetId);
  if (!target) return node;
  if (target.tabs.every((t) => widgets.includes(t))) return node; // dropping a panel on its own edge
  let tree = node;
  for (const w of widgets) tree = w === "source" ? stripSource(tree) : removeWidget(tree, w);
  const fresh = group(widgets);
  const dir: Split["dir"] = edge === "left" || edge === "right" ? "row" : "col";
  const first = edge === "left" || edge === "top";
  const replace = (n: LayoutNode): LayoutNode => {
    if (n.type === "group") {
      if (n.id !== targetId) return n;
      return split(dir, first ? [[0.5, fresh], [0.5, n]] : [[0.5, n], [0.5, fresh]]);
    }
    return rebuild(n, n.children.map((c, i) => ({ node: replace(c), size: n.sizes[i] })))!;
  };
  return replace(tree);
}

/** The source may move but never disappear: take it out only as part of a move. */
function stripSource(node: LayoutNode): LayoutNode {
  return (
    mapGroups(node, (g) => {
      if (!g.tabs.includes("source")) return g;
      const tabs = g.tabs.filter((t) => t !== "source");
      return { ...g, tabs, active: g.active === "source" ? tabs[0] : g.active };
    }) ?? node
  );
}

/** Show a hidden widget: into the given group, or the group of its usual neighbor. */
export function showWidget(node: LayoutNode, widget: WidgetId, targetId?: string): LayoutNode {
  if (groupOf(node, widget)) return activate(node, widget);
  const neighbors: Record<WidgetId, WidgetId[]> = {
    source: [],
    transcript: ["memo", "notes"],
    memo: ["transcript", "notes"],
    overview: ["notes", "explore", "mindmap"],
    notes: ["overview", "explore", "mindmap"],
    explore: ["notes", "overview"],
    mindmap: ["notes", "overview"],
    cards: ["quiz", "materials", "chat"],
    quiz: ["cards", "materials", "chat"],
    materials: ["cards", "quiz", "notes"],
    chat: ["cards", "notes"],
  };
  const near = targetId ?? neighbors[widget].map((w) => groupOf(node, w)?.id).find(Boolean) ?? groups(node).find((g) => !g.tabs.includes("source"))?.id;
  if (near) return moveInto(node, [widget], near);
  // only the source is showing: give the widget its own column
  return splitWith(node, [widget], groups(node)[0].id, "right");
}

export function setSizes(node: LayoutNode, path: number[], sizes: number[]): LayoutNode {
  if (node.type === "group") return node;
  if (!path.length) return { ...node, sizes };
  const [i, ...rest] = path;
  return { ...node, children: node.children.map((c, k) => (k === i ? setSizes(c, rest, sizes) : c)) };
}

// --- validation and storage ---------------------------------------------------------------

/** Drop unknown, unavailable and repeated widgets; null if the source is missing (start over). */
export function normalize(node: unknown, kind: SourceKind): LayoutNode | null {
  const ok = new Set(availableWidgets(kind));
  const seen = new Set<WidgetId>();
  const walk = (n: unknown): LayoutNode | null => {
    if (!n || typeof n !== "object") return null;
    // stored JSON: check every field before trusting it
    const v = n as { type?: unknown; id?: unknown; tabs?: unknown; active?: unknown; dir?: unknown; sizes?: unknown; children?: unknown[] };
    if (v.type === "group" && Array.isArray(v.tabs)) {
      const tabs = (v.tabs as WidgetId[]).filter((t) => ok.has(t) && !seen.has(t));
      tabs.forEach((t) => seen.add(t));
      if (!tabs.length) return null;
      return { type: "group", id: typeof v.id === "string" ? v.id : groupId(), tabs, active: tabs.includes(v.active as WidgetId) ? (v.active as WidgetId) : tabs[0] };
    }
    if (v.type === "split" && Array.isArray(v.children) && (v.dir === "row" || v.dir === "col")) {
      const sizes: unknown[] = Array.isArray(v.sizes) ? v.sizes : [];
      const kids = v.children.map((c, i) => ({ node: walk(c), size: Number(sizes[i]) > 0 ? Number(sizes[i]) : 1 / v.children!.length })).filter((k): k is { node: LayoutNode; size: number } => k.node !== null);
      return rebuild({ type: "split", dir: v.dir, sizes: [], children: [] }, kids);
    }
    return null;
  };
  const tree = walk(node);
  return tree && seen.has("source") ? tree : null;
}

const storageKey = (kind: SourceKind) => `workspace:v1:${kind}`;

export function loadLayout(kind: SourceKind): LayoutNode {
  try {
    const raw = localStorage.getItem(storageKey(kind));
    const tree = raw ? normalize(JSON.parse(raw), kind) : null;
    if (tree) return tree;
  } catch {}
  return preset("toss", kind);
}

export function saveLayout(kind: SourceKind, node: LayoutNode) {
  try {
    localStorage.setItem(storageKey(kind), JSON.stringify(node));
  } catch {}
}
