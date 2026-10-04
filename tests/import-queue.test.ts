import assert from "node:assert/strict";
import test from "node:test";
import { addImportFiles, runImportQueue, type ImportItem } from "../web/src/lib/import-queue.ts";

const file = (name: string, lastModified = 1) => new File(["test"], name, { lastModified });
const queue = (...names: string[]) => addImportFiles([], names.map((name) => file(name))).items;

test("multiple files append, duplicates are skipped, subtitles match regardless of drop order", () => {
  const first = addImportFiles([], [file("강의 1.srt"), file("강의 2.mp4"), file("강의 1.mp4"), file("강의 2.vtt")]);
  assert.equal(first.items.length, 2);
  assert.deepEqual(first.items.map((item) => item.subtitle?.name), ["강의 2.vtt", "강의 1.srt"]);
  const next = addImportFiles(first.items, [file("강의 1.mp4"), file("강의 3.mkv"), file("notes.pdf")]);
  assert.equal(next.items.length, 3);
  assert.deepEqual(next.rejected, ["notes.pdf"]);
  assert.deepEqual(first.unmatched, []);
});

test("one video accepts differently named subtitles; ambiguous matches require manual attachment", () => {
  assert.equal(addImportFiles([], [file("one.mp4"), file("captions.srt")]).items[0].subtitle?.name, "captions.srt");
  const result = addImportFiles([], [file("same.mp4"), file("same.mkv"), file("same.srt"), file("missing.vtt")]);
  assert.deepEqual(result.unmatched, ["same.srt", "missing.vtt"]);
  assert.ok(result.items.every((item) => !item.subtitle));
});

test("completed items cannot receive new dropped subtitles", () => {
  const [done] = queue("one.mp4");
  done.status = "done";
  const result = addImportFiles([done], [file("one.srt")]);
  assert.deepEqual(result.unmatched, ["one.srt"]);
  assert.equal(result.items[0].subtitle, undefined);
});

test("uploads and creates run sequentially, failed files do not block later files, retry skips successes", async () => {
  const events: string[] = [];
  let fail = true;
  let active = 0;
  let maxActive = 0;
  const dependencies = {
    upload: async (input: File, progress: (n: number) => void) => {
      active++;
      maxActive = Math.max(maxActive, active);
      events.push(`upload:${input.name}`);
      await new Promise((resolve) => setTimeout(resolve, 3));
      active--;
      if (input.name === "bad.mp4" && fail) throw new Error("connection lost");
      progress(1);
      return { uploadId: input.name };
    },
    create: async (body: { source: { value: string } }) => {
      events.push(`create:${body.source.value}`);
      return { id: body.source.value };
    },
  };
  const updates: ImportItem[] = [];
  const results = await runImportQueue(queue("one.mp4", "bad.mp4", "three.mp4"), {}, undefined, dependencies, (item) => updates.push(item));
  assert.equal(maxActive, 1);
  assert.deepEqual(results.map((item) => item.status), ["done", "error", "done"]);
  assert.deepEqual(events, ["upload:one.mp4", "create:one.mp4", "upload:bad.mp4", "upload:three.mp4", "create:three.mp4"]);
  assert.equal(results[1].error, "connection lost");
  assert.ok(updates.some((item) => item.status === "uploading" && item.progress === 1));
  fail = false;
  events.length = 0;
  const retry = await runImportQueue(results, {}, undefined, dependencies, () => {});
  assert.deepEqual(events, ["upload:bad.mp4", "create:bad.mp4"]);
  assert.deepEqual(retry.map((item) => item.status), ["done"]);
});

test("subtitle upload failure retains unconsumed media upload; settings and per-item subtitles reach creation", async () => {
  const items = addImportFiles([], [file("one.mp4"), file("one.srt")]).items;
  const uploaded: string[] = [];
  let failSubtitle = true;
  const upload = async (input: File) => {
    uploaded.push(input.name);
    if (input.name.endsWith(".srt") && failSubtitle) throw new Error("subtitle failed");
    return { uploadId: input.name };
  };
  const create = async (body: { source: { uploadId: string }; subtitleUploadId?: string; title?: string; options: { focus?: string } }) => {
    assert.equal(body.source.uploadId, "one.mp4");
    assert.equal(body.subtitleUploadId, "one.srt");
    assert.equal(body.title, "Custom title");
    assert.equal(body.options.focus, "Linear algebra");
    return { id: "lecture-one" };
  };
  const failed = await runImportQueue(items, {}, undefined, { upload, create }, () => {});
  assert.equal(failed[0].uploadId, "one.mp4");
  failSubtitle = false;
  const succeeded = await runImportQueue(failed, { focus: "Linear algebra" }, "Custom title", { upload, create }, () => {});
  assert.deepEqual(uploaded, ["one.mp4", "one.srt", "one.srt"]);
  assert.equal(succeeded[0].lectureId, "lecture-one");
});

test("creation failure discards potentially consumed upload IDs and retries by reuploading", async () => {
  const items = addImportFiles([], [file("one.mp4"), file("one.srt")]).items;
  let uploads = 0;
  let fail = true;
  const dependencies = {
    upload: async () => ({ uploadId: `upload-${++uploads}` }),
    create: async () => { if (fail) throw new Error("create failed after moving files"); return { id: "ok" }; },
  };
  const failed = await runImportQueue(items, {}, undefined, dependencies, () => {});
  assert.equal(failed[0].uploadId, undefined);
  assert.equal(failed[0].subtitleUploadId, undefined);
  fail = false;
  const succeeded = await runImportQueue(failed, {}, undefined, dependencies, () => {});
  assert.equal(uploads, 4);
  assert.equal(succeeded[0].status, "done");
});

test("stop finishes the active file and leaves later files pending", async () => {
  let stop = false;
  const items = queue("one.mp4", "two.mp4");
  const results = await runImportQueue(items, {}, undefined, {
    upload: async () => { stop = true; return { uploadId: "upload" }; },
    create: async () => ({ id: "first" }),
  }, () => {}, () => stop);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "done");
  assert.equal(items[1].status, "pending");
});
