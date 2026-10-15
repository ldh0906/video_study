import assert from "node:assert/strict";
import test from "node:test";
import { CATALOG_VERSION, MODEL_UPGRADES, currentChoice } from "../shared/catalog";
import { preprocessMarkdown, replacePages } from "../shared/markdown";
import { buildDocSections, pageFixer } from "../server/pipeline/doc";
import { sanitizeStudyHtml } from "../server/studypages";

test("page citations become page links outside code and math, and only for a document", () => {
  const md = "규칙은 [p.3]에 있고 범위 [p.4–6]도 있다. `x[p.9]` $a[p.2]$";
  assert.equal(preprocessMarkdown(md, { unit: "page" }), "규칙은 [p.3](#p=3)에 있고 범위 [p.4–6](#p=4)도 있다. `x[p.9]` $a[p.2]$");
  // a lecture keeps its timestamps and leaves page-like text alone
  assert.equal(preprocessMarkdown("[1:05] 그리고 [p.3]", { unit: "time" }), "[1:05](#t=65) 그리고 [p.3]");
  // pages past the end of the document stay text
  assert.equal(preprocessMarkdown("[p.40]", { unit: "page", maxTime: 12 }), "[p.40]");
});

test("pages that do not exist lose their citation brackets", () => {
  const fix = pageFixer(10);
  assert.equal(fix("근거 [p.3], 없는 쪽 [p.30], 0쪽 [p.0]"), "근거 [p.3], 없는 쪽 p.30, 0쪽 p.0");
  assert.equal(replacePages("[p.2](#p=2)", () => "X"), "[p.2](#p=2)");
});

test("document parts cut at topic starts and keep every page exactly once", () => {
  const pages = Array.from({ length: 60 }, (_, i) => ({ page: i + 1, text: "가".repeat(900), images: 0, paths: 0 }));
  // ~13 pages fill a part; topics start at 1, 24 and 45
  const ranges = buildDocSections(pages, [1, 24, 45]);
  assert.equal(ranges[0].start, 1);
  assert.equal(ranges.at(-1)!.end, 61);
  for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i].start, ranges[i - 1].end);
  // a topic start is preferred as a cut once the part is half full
  assert.ok(ranges.some((r) => r.start === 24));
  // terse slides: many pages per part, capped
  const slides = Array.from({ length: 50 }, (_, i) => ({ page: i + 1, text: "짧은 슬라이드", images: 1, paths: 0 }));
  const sr = buildDocSections(slides, []);
  assert.ok(sr.every((r) => r.end - r.start <= 24));
});

test("study page HTML loses document wrappers, remote scripts and frames", () => {
  const raw = '```html\n<!doctype html><html><head><title>x</title></head><body><section><h2>A</h2><script src="https://evil.example/x.js"></script><iframe src="https://a"></iframe><form action="https://b"><input></form><lk-quiz answer="1"></lk-quiz><script>LK.ready(() => 1)</script></section></body></html>\n```';
  const html = sanitizeStudyHtml(raw);
  assert.ok(!/<html|<head|<body|doctype/i.test(html));
  assert.ok(!html.includes("evil.example"));
  assert.ok(!/<iframe|<form/i.test(html));
  assert.ok(html.includes("<lk-quiz") && html.includes("LK.ready"));
});

test("saved model choices move to the current generation, retired ones always", () => {
  assert.deepEqual(currentChoice({ provider: "openai", model: "gpt-5.5", effort: "medium" }), { provider: "openai", model: "gpt-6.1-sol", effort: "medium" });
  // still served: only the one-time upgrade moves it
  assert.equal(currentChoice({ provider: "openai", model: "gpt-6-sol", effort: "high" }).model, "gpt-6-sol");
  assert.equal(currentChoice({ provider: "openai", model: "gpt-6-sol", effort: "high" }, MODEL_UPGRADES).model, "gpt-6.1-sol");
  // an effort the successor lacks falls back to its default
  assert.equal(currentChoice({ provider: "anthropic", model: "claude-haiku-4-5", effort: "none" }).effort, "medium");
  assert.match(CATALOG_VERSION, /^\d{4}-\d{2}$/);
});
