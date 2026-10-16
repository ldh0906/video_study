import assert from "node:assert/strict";
import test from "node:test";
import { groupOf, groups, moveInto, normalize, preset, removeWidget, setSizes, showWidget, shown, splitWith, type LayoutNode, type Split } from "../web/src/features/workspace/layout.ts";

const sizesOk = (n: LayoutNode): boolean => n.type === "group" || (Math.abs(n.sizes.reduce((a, b) => a + b, 0) - 1) < 1e-9 && n.children.every(sizesOk));

test("presets show every widget once, with the source; a PDF has no transcript", () => {
  const video = preset("toss", "video");
  assert.equal(new Set(shown(video)).size, shown(video).length);
  assert.ok(shown(video).includes("source") && shown(video).includes("transcript"));
  const doc = preset("toss", "doc");
  assert.ok(!shown(doc).includes("transcript"));
  assert.ok(sizesOk(video) && sizesOk(doc));
  for (const id of ["two", "focus"] as const) assert.ok(shown(preset(id, "video")).includes("source"));
});

test("closing the last tab of a panel removes the panel and its split collapses", () => {
  let tree = preset("toss", "video");
  tree = removeWidget(tree, "memo");
  assert.ok(!shown(tree).includes("memo"));
  assert.ok(sizesOk(tree));
  // the transcript now fills the row the memo shared
  const col = (tree as Split).children[0] as Split;
  assert.equal(col.children[1].type, "group");
  // the source can never be closed
  assert.ok(shown(removeWidget(tree, "source")).includes("source"));
});

test("moving a tab into another panel and splitting a panel on an edge", () => {
  let tree = preset("toss", "video");
  const chat = groupOf(tree, "chat")!;
  tree = moveInto(tree, ["quiz"], chat.id, 0);
  assert.deepEqual(groupOf(tree, "quiz")!.tabs, ["quiz", "chat"]);
  assert.equal(groupOf(tree, "quiz")!.active, "quiz");
  const notes = groupOf(tree, "notes")!;
  tree = splitWith(tree, ["mindmap"], notes.id, "bottom");
  const mm = groupOf(tree, "mindmap")!;
  assert.deepEqual(mm.tabs, ["mindmap"]);
  assert.notEqual(mm.id, groupOf(tree, "notes")!.id);
  assert.equal(new Set(shown(tree)).size, shown(tree).length);
  assert.ok(sizesOk(tree));
  // the source moves too, and stays unique
  tree = moveInto(tree, ["source"], groupOf(tree, "chat")!.id);
  assert.equal(shown(tree).filter((w) => w === "source").length, 1);
  assert.ok(sizesOk(tree));
});

test("a hidden widget comes back next to its neighbor", () => {
  let tree = removeWidget(preset("toss", "video"), "quiz");
  tree = showWidget(tree, "quiz");
  assert.ok(groupOf(tree, "quiz")!.tabs.includes("cards"));
  // only the source left: the widget gets its own panel beside it
  let bare: LayoutNode = preset("focus", "video");
  for (const w of shown(bare)) bare = removeWidget(bare, w);
  assert.deepEqual(shown(bare), ["source"]);
  bare = showWidget(bare, "notes");
  assert.equal(groups(bare).length, 2);
});

test("stored layouts are cleaned: unknown, repeated and unavailable widgets go; no source means start over", () => {
  const stored = { type: "split", dir: "row", sizes: [2, 2], children: [{ type: "group", id: "a", tabs: ["source", "bogus", "notes"], active: "bogus" }, { type: "group", id: "b", tabs: ["notes", "transcript"], active: "transcript" }] };
  const doc = normalize(stored, "doc")!;
  assert.deepEqual(shown(doc), ["source", "notes"]);
  assert.equal(doc.type, "group"); // the second panel emptied out and the split collapsed
  assert.equal(normalize({ type: "group", id: "x", tabs: ["notes"], active: "notes" }, "video"), null);
  const resized = setSizes(preset("toss", "video"), [], [0.5, 0.3, 0.2]);
  assert.deepEqual((resized as Split).sizes, [0.5, 0.3, 0.2]);
});
