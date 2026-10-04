import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.LECTURE_DATA_DIR ? path.resolve(process.env.LECTURE_DATA_DIR) : path.join(ROOT, "data");
export const LECTURES_DIR = path.join(DATA_DIR, "lectures");
export const BIN_DIR = path.join(DATA_DIR, "bin");
export const WEB_DIST = path.join(ROOT, "web", "dist");

for (const dir of [DATA_DIR, LECTURES_DIR, BIN_DIR]) fs.mkdirSync(dir, { recursive: true });

export function lectureDir(id: string, ...parts: string[]) {
  if (!/^[\w-]+$/.test(id)) throw new Error("invalid lecture id");
  return path.join(LECTURES_DIR, id, ...parts);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Atomic-ish write so a crash mid-write never leaves a truncated JSON file. */
export function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
