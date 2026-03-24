import fs from "fs";
import path from "path";
import { DATA_DIR } from "@/lib/db";
import { slugify } from "@/lib/unified/utils";

export const UNIFIED_DIR = path.join(DATA_DIR, "unified");

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function unifiedPath(...parts: string[]): string {
  ensureDir(UNIFIED_DIR);
  return path.join(UNIFIED_DIR, ...parts);
}

export function writeUnifiedArtifact(parts: string[], fileName: string, contents: string | Buffer): { relativePath: string; sizeBytes: number } {
  const dirPath = unifiedPath(...parts);
  ensureDir(dirPath);
  const absolutePath = path.join(dirPath, fileName);
  const buffer = typeof contents === "string" ? Buffer.from(contents, "utf-8") : contents;
  fs.writeFileSync(absolutePath, buffer);
  return {
    relativePath: path.relative(DATA_DIR, absolutePath).replace(/\\/g, "/"),
    sizeBytes: buffer.byteLength,
  };
}

export function readUnifiedArtifact(relativePath: string): Buffer {
  return fs.readFileSync(path.join(DATA_DIR, relativePath));
}

export function readUnifiedArtifactText(relativePath: string): string {
  return readUnifiedArtifact(relativePath).toString("utf-8");
}

export function writeStagingHtml(syncRunId: string, relativePath: string, html: string): { absolutePath: string; relativePath: string; sizeBytes: number } {
  const safePath = relativePath.replace(/\\/g, "/");
  const fileName = `${slugify(safePath.replace(/\//g, "-"))}.html`;
  const dirPath = unifiedPath("staging", syncRunId);
  ensureDir(dirPath);
  const absolutePath = path.join(dirPath, fileName);
  const buffer = Buffer.from(html, "utf-8");
  fs.writeFileSync(absolutePath, buffer);
  return {
    absolutePath,
    relativePath: path.relative(DATA_DIR, absolutePath).replace(/\\/g, "/"),
    sizeBytes: buffer.byteLength,
  };
}
