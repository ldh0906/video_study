import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { presetOptions } from "../shared/export.ts";
import type { Lecture } from "../shared/types.ts";

const edge = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find(file => fs.existsSync(file));

test("concurrent Edge PDF exports use separate profiles and produce valid files", {
  skip: !edge,
  timeout: 60000,
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lecture-lens-pdf-test-"));
  const previousData = process.env.LECTURE_DATA_DIR;
  const previousBrowser = process.env.LECTURE_PDF_BROWSER;
  process.env.LECTURE_DATA_DIR = directory;
  process.env.LECTURE_PDF_BROWSER = edge;
  const server = http.createServer((_req, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end('<!doctype html><html><head><meta charset="utf-8"></head><body><h1>PDF export test</h1><script id="lecture-lens-labels" type="application/json">{}</script></body></html>');
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { exportStudyPdf } = await import("../server/export/pdf.ts");
    // Wait for both renders, including browser cleanup, even if one fails.
    const results = await Promise.allSettled(["pdf-one", "pdf-two"].map(async id => {
      const lecture = { id, source: { kind: "upload", value: "sample.mp4" } } as Lecture;
      const result = await exportStudyPdf(lecture, "PDF export test", presetOptions("review", []), origin);
      const bytes = fs.readFileSync(path.join(directory, "lectures", id, "exports", result.file));
      assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
      assert.ok(result.pages >= 1);
      assert.ok(result.bytes > 1000);
    }));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousData === undefined) delete process.env.LECTURE_DATA_DIR;
    else process.env.LECTURE_DATA_DIR = previousData;
    if (previousBrowser === undefined) delete process.env.LECTURE_PDF_BROWSER;
    else process.env.LECTURE_PDF_BROWSER = previousBrowser;
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(directory).startsWith("lecture-lens-pdf-test-"));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
