import assert from "node:assert/strict";
import test from "node:test";
import type { Lecture, SectionAnalysis, Segment } from "../shared/types.ts";
import { neighboringContext, sectionCacheKey, sectionDigest } from "../server/pipeline/analyze.ts";

test("resumed analysis invalidates stale notes when teaching inputs change", () => {
  const lecture = {
    title: "Lecture", durationSec: 500,
    options: { analysis: { provider: "anthropic", model: "test", effort: "high" }, outputLanguage: "ko", focus: "" },
  } as Lecture;
  const segments: Segment[] = [{ start: 0, end: 500, text: "Source explanation" }];
  const ranges = [{ start: 0, end: 500, from: 0, to: 1 }];
  const frames = [{ time: 100, file: "frame.jpg", hash: "original-pixels" }];
  const key = sectionCacheKey(lecture, segments, ranges, frames, 6);
  assert.equal(sectionCacheKey(structuredClone(lecture), structuredClone(segments), structuredClone(ranges), structuredClone(frames), 6), key);
  for (const patch of [
    { analysis: { ...lecture.options.analysis, effort: "low" } },
    { analysis: { ...lecture.options.analysis, model: "other" } },
    { analysis: { ...lecture.options.analysis, provider: "openai" as const } },
    { outputLanguage: "en" },
    { focus: "Explain mechanisms" },
  ]) {
    assert.notEqual(sectionCacheKey({ ...lecture, options: { ...lecture.options, ...patch } }, segments, ranges, frames, 6), key);
  }
  assert.notEqual(sectionCacheKey(lecture, [{ ...segments[0], text: "Corrected transcript" }], ranges, frames, 6), key);
  assert.notEqual(sectionCacheKey(lecture, segments, [{ ...ranges[0], end: 499 }], frames, 6), key);
  assert.notEqual(sectionCacheKey(lecture, segments, ranges, [{ ...frames[0], hash: "new-pixels" }], 6), key);
  assert.notEqual(sectionCacheKey(lecture, segments, ranges, [], 6), key);
  assert.notEqual(sectionCacheKey(lecture, segments, ranges, frames, 2), key);
  assert.notEqual(sectionCacheKey({ ...lecture, title: "New course context" }, segments, ranges, frames, 6), key);
  assert.equal(sectionCacheKey({ ...lecture, status: "processing", updatedAt: Date.now() }, segments, ranges, frames, 6), key);
  assert.notEqual(key, "anthropic:test:1", "legacy cache keys must be discarded");
});

test("neighboring context preserves more than three short utterances without mixing in the current part", () => {
  const segments = Array.from({ length: 450 }, (_, i) => ({ start: i, end: i + 1, text: `segment-${i}` }));
  const context = neighboringContext(segments, { start: 200, end: 300, from: 200, to: 300 });
  assert.ok(context.before.includes("segment-100"));
  assert.ok(context.before.endsWith("segment-199"));
  assert.ok(!context.before.includes("segment-78\n"));
  assert.ok(context.after.startsWith("[5:00] segment-300"));
  assert.ok(context.after.endsWith("segment-359"));
  assert.ok(!context.before.includes("segment-200"));
  assert.ok(!context.after.includes("segment-299"));
  assert.deepEqual(neighboringContext(segments, { start: 0, end: 450, from: 0, to: 450 }), { before: "", after: "" });
});

test("neighboring context stays bounded and never cuts a transcript segment in half", () => {
  const segments = Array.from({ length: 20 }, (_, i) => ({ start: i, end: i + 1, text: `${i}:` + "x".repeat(900) }));
  const { before, after } = neighboringContext(segments, { start: 10, end: 11, from: 10, to: 11 });
  assert.ok(before.length <= 6000);
  assert.ok(after.length <= 3000);
  assert.equal(before.split("\n").length, 6);
  assert.equal(after.split("\n").length, 3);
  assert.ok(before.split("\n").every(line => line.endsWith("x".repeat(900))));
  assert.ok(after.split("\n").every(line => line.endsWith("x".repeat(900))));
});

test("lecture synthesis receives explanations, applications and uncertainty rather than losing them in short summaries", () => {
  const section: SectionAnalysis = {
    index: 0, start: 0, end: 500, title: "A concept", summary: "Short summary", notes: "Long notes",
    keyPoints: [{ time: 50, point: "Rule with a condition" }],
    concepts: [{ term: "Rule", definition: "Applies under an assumption" }],
    difficult: [{ time: 100, topic: "Scope", why: "Students generalize too far", explanation: "💡 보충: Worked example. 확인 필요: the source does not specify the boundary." }],
    cards: [{ time: 150, front: "Does the rule hold in a new case?", back: "Only if the assumption is met, because the mechanism depends on it." }],
  };
  const digest = sectionDigest(section);
  for (const value of [section.summary, section.concepts[0].definition, section.difficult[0].why, section.difficult[0].explanation, section.cards[0].front, section.cards[0].back]) {
    assert.ok(digest.includes(value));
  }
  assert.ok(digest.includes("[2:30]"));
});
