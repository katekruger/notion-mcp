// File Upload API helpers: local files and downloaded bytes become file_upload ids for image, file, and cover blocks.
import { promises as fs } from "node:fs";
import path from "node:path";
import { call, notion } from "./notion.js";
import { config } from "../config.js";
import { safeFetch } from "./fetch.js";

/** Notion's single-part limit; larger files go up in parts. */
const SINGLE_PART_MAX = 20 * 1024 * 1024;
const PART_SIZE = 10 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".heic": "image/heic", ".ico": "image/vnd.microsoft.icon", ".tif": "image/tiff", ".tiff": "image/tiff",
  ".pdf": "application/pdf", ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json", ".md": "text/markdown",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function contentTypeFor(name: string): string {
  return CONTENT_TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

export function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

/**
 * Folders local uploads may come from. Defaults to the working directory and the temp folder;
 * NOTION_PLUS_UPLOAD_DIRS (path-separated) replaces the list. Keeps a prompt from uploading arbitrary files.
 */
export function uploadRoots(): string[] {
  const roots = config().uploadDirs;
  // Apps can start the server with "/" as its working directory; never let that open the whole disk.
  return roots.map((r) => path.resolve(r)).filter((r) => path.parse(r).root !== r);
}

export async function checkUploadPath(p: string): Promise<string> {
  const resolved = await fs.realpath(path.resolve(p)).catch(() => {
    throw new Error(`File not found: ${p}`);
  });
  const roots = await Promise.all(uploadRoots().map((r) => fs.realpath(r).catch(() => r)));
  if (!roots.some((r) => resolved === r || resolved.startsWith(r + path.sep))) {
    throw new Error(
      `${p} is outside the folders uploads may come from (${roots.join(", ")}). ` +
        "Move the file there, or set NOTION_PLUS_UPLOAD_DIRS in the server config."
    );
  }
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error(`${p} is not a file.`);
  return resolved;
}

/** Upload bytes and return the file_upload id, ready to attach within an hour. */
export async function uploadBytes(data: Uint8Array, filename: string, contentType = contentTypeFor(filename)): Promise<string> {
  const n = notion();
  const blob = (from: number, to: number) => new Blob([data.slice(from, to)], { type: contentType });
  if (data.byteLength <= SINGLE_PART_MAX) {
    const up = await call(() => n.fileUploads.create({ mode: "single_part", filename, content_type: contentType }));
    await call(() => n.fileUploads.send({ file_upload_id: up.id, file: { filename, data: blob(0, data.byteLength) } }));
    return up.id;
  }
  const parts = Math.ceil(data.byteLength / PART_SIZE);
  const up = await call(() => n.fileUploads.create({ mode: "multi_part", filename, content_type: contentType, number_of_parts: parts }));
  for (let i = 0; i < parts; i++) {
    await call(() =>
      n.fileUploads.send({ file_upload_id: up.id, part_number: String(i + 1), file: { filename, data: blob(i * PART_SIZE, (i + 1) * PART_SIZE) } })
    );
  }
  await call(() => n.fileUploads.complete({ file_upload_id: up.id }));
  return up.id;
}

/** Where this server keeps its own files (journal, chart copies). */
export function homeDir(): string {
  return config().home;
}

/**
 * Upload a local file. Paths must be inside the allowed upload folders, except files this server saved itself
 * (`allowAnyPath`, used for undo copies under its home folder).
 */
export async function uploadLocalFile(p: string, filename?: string, opts: { allowAnyPath?: boolean } = {}): Promise<string> {
  const resolved = opts.allowAnyPath && path.resolve(p).startsWith(path.resolve(homeDir()) + path.sep) ? path.resolve(p) : await checkUploadPath(p);
  const data = new Uint8Array(await fs.readFile(resolved));
  return uploadBytes(data, filename ?? path.basename(resolved));
}

/** Download a file (e.g. a Notion-hosted file with an expiring link) and upload it again. */
export async function reuploadUrl(url: string, filename?: string): Promise<string> {
  const res = await safeFetch(url);
  if (res.status < 200 || res.status >= 300) throw new Error(`Couldn't download ${url.split("?")[0]}: HTTP ${res.status}.`);
  const name = filename ?? decodeURIComponent(new URL(url).pathname.split("/").pop() || "file");
  const type = res.contentType || contentTypeFor(name);
  return uploadBytes(res.body, name, type);
}

/** A file reference for icons, covers, and media blocks: external URL as-is, local path uploaded. */
export async function fileRef(source: string): Promise<Record<string, unknown>> {
  if (isUrl(source)) return { type: "external", external: { url: source.trim() } };
  return { type: "file_upload", file_upload: { id: await uploadLocalFile(source) } };
}
