import type { LectureOptions } from "@shared/types";

export type ImportStatus = "pending" | "uploading" | "subtitle" | "creating" | "done" | "error";

export interface ImportItem {
  id: string;
  file: File;
  subtitle?: File;
  status: ImportStatus;
  progress: number;
  error?: string;
  lectureId?: string;
  uploadId?: string;
  subtitleUploadId?: string;
}

export const isSubtitle = (file: File) => /\.(srt|vtt)$/i.test(file.name);
const stem = (name: string) => name.replace(/\.[^.]+$/, "").normalize("NFC").toLowerCase();
const fileKey = (file: File) => JSON.stringify([file.name, file.size, file.lastModified]);

/** Keep File references only; never read large media files into JS memory. */
export function addImportFiles(existing: ImportItem[], files: File[]) {
  const items = existing.map((item) => ({ ...item }));
  const keys = new Set(items.map((item) => fileKey(item.file)));
  const subtitles: File[] = [];
  const rejected: string[] = [];
  for (const file of files) {
    if (isSubtitle(file)) {
      subtitles.push(file);
    } else if (/^(video|audio)\//i.test(file.type) || /\.(mp4|mkv|mov|webm|avi|m4v|mpeg|mpg|wmv|ts|mts|m2ts|ogv|3gp|mp3|m4a|flac|wav|ogg|opus|aac|aiff|wma)$/i.test(file.name)) {
      if (!keys.has(fileKey(file))) {
        keys.add(fileKey(file));
        items.push({ id: crypto.randomUUID(), file, status: "pending", progress: 0 });
      }
    } else rejected.push(file.name);
  }
  const unmatched: string[] = [];
  for (const subtitle of subtitles) {
    const candidates = items.filter((item) => item.status !== "done" && !item.subtitle && stem(item.file.name) === stem(subtitle.name));
    const target = candidates.length === 1 ? candidates[0] : items.length === 1 && items[0].status !== "done" && !items[0].subtitle && subtitles.length === 1 ? items[0] : undefined;
    if (target) target.subtitle = subtitle;
    else unmatched.push(subtitle.name);
  }
  return { items, rejected, unmatched };
}

interface ImportDependencies {
  upload: (file: File, onProgress: (progress: number) => void) => Promise<{ uploadId: string }>;
  create: (body: {
    source: { kind: "upload"; value: string; uploadId: string };
    title?: string;
    subtitleUploadId?: string;
    options: Partial<LectureOptions>;
  }) => Promise<{ id: string }>;
}

/** Upload and register one item at a time; an individual failure never stops the batch. */
export async function runImportQueue(
  items: ImportItem[],
  options: Partial<LectureOptions>,
  title: string | undefined,
  dependencies: ImportDependencies,
  onUpdate: (item: ImportItem) => void,
  shouldStop: () => boolean = () => false,
) {
  const results: ImportItem[] = [];
  for (const original of items) {
    if (original.status === "done") continue;
    if (shouldStop()) break;
    let item: ImportItem = { ...original, error: undefined };
    const update = (patch: Partial<ImportItem>) => {
      item = { ...item, ...patch };
      onUpdate(item);
    };
    try {
      if (!item.uploadId) {
        update({ status: "uploading", progress: 0 });
        const upload = await dependencies.upload(item.file, (progress) => update({ progress }));
        update({ uploadId: upload.uploadId, progress: 1 });
      }
      if (item.subtitle && !item.subtitleUploadId) {
        update({ status: "subtitle" });
        const upload = await dependencies.upload(item.subtitle, () => {});
        update({ subtitleUploadId: upload.uploadId });
      }
      update({ status: "creating" });
      const lecture = await dependencies.create({
        source: { kind: "upload", value: item.file.name, uploadId: item.uploadId! },
        title,
        subtitleUploadId: item.subtitleUploadId,
        options,
      });
      update({ status: "done", lectureId: lecture.id, progress: 1 });
    } catch (error) {
      // Creation moves uploads into the lecture directory. A failed response may
      // therefore leave these tokens consumed; only retain them before creation.
      const consumed = item.status === "creating";
      update({ status: "error", error: error instanceof Error ? error.message : String(error), ...(consumed ? { uploadId: undefined, subtitleUploadId: undefined } : {}) });
    }
    results.push(item);
  }
  return results;
}
