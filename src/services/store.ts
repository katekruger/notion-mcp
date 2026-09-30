// Durable local JSON state: every file this server keeps (journal, chart recipes, automation state, rules) goes
// through here, so it gets the same guarantees:
// - A missing file is empty state; anything else wrong (bad JSON, a failed schema check, no permission) stops
//   with StateCorruptError instead of being read as empty, which would repeat automations or lose undo history.
// - Writes go to a unique temp file, are flushed to disk, and replace the old file in one rename, keeping the
//   previous version as <file>.bak.
// - Read-modify-write runs under a cross-process lock, so two servers (Desktop, Cowork, Claude Code, the
//   scheduled runner) sharing a folder can't overwrite each other's changes.
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

export class StateCorruptError extends Error {
  constructor(
    readonly file: string,
    detail: string
  ) {
    super(
      `${file} can't be read: ${detail}\nNothing was changed. To recover, fix the file, or restore the previous version from ` +
        `${file}.bak (if it exists), or move the file away to start with empty state. Starting fresh loses what it held ` +
        `(undo history, which scheduled occurrences already fired, chart recipes).`
    );
    this.name = "StateCorruptError";
  }
}

export class LockTimeoutError extends Error {
  constructor(file: string, holder: string) {
    super(`${file} is locked by another process (${holder}). Try again in a moment; if no other Notion Plus process is running, delete ${file}.lock.`);
    this.name = "LockTimeoutError";
  }
}

/** Short content hash, used as a file's revision for compare-and-swap edits. */
export function revisionOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export interface Loaded<T> {
  data: T;
  /** Hash of the file as read, or null when it didn't exist. */
  revision: string | null;
}

/**
 * Read a JSON file. `parse` validates and returns the typed value (throw to reject); `empty` is used only when the
 * file doesn't exist.
 */
export async function readJson<T>(file: string, parse: (raw: unknown) => T, empty: () => T): Promise<Loaded<T>> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { data: empty(), revision: null };
    throw new StateCorruptError(file, (e as Error).message);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new StateCorruptError(file, `not valid JSON (${(e as Error).message}); it may have been cut off by a crash or a full disk.`);
  }
  try {
    return { data: parse(raw), revision: revisionOf(text) };
  } catch (e) {
    throw new StateCorruptError(file, `unexpected contents (${(e as Error).message}).`);
  }
}

/** Serialize the way writeJson does, so revisions computed before writing match what a later read sees. */
export function serialize(data: unknown, trailingNewline = false): string {
  return JSON.stringify(data, null, 2) + (trailingNewline ? "\n" : "");
}

/** Write atomically: unique temp file, fsync, keep the old version as .bak, rename over. Returns the new revision. */
export async function writeJson(file: string, data: unknown, opts: { trailingNewline?: boolean } = {}): Promise<string> {
  const text = serialize(data, opts.trailingNewline);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const h = await fs.open(tmp, "w");
  try {
    await h.writeFile(text);
    await h.sync();
  } finally {
    await h.close();
  }
  try {
    await fs.copyFile(file, `${file}.bak`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      await fs.rm(tmp, { force: true });
      throw e;
    }
  }
  try {
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
  // Make the rename itself durable. Not every platform can open a directory (Windows), so this is best effort.
  try {
    const d = await fs.open(path.dirname(file), "r");
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  } catch {
    /* best effort */
  }
  return revisionOf(text);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const STALE_MS = 60_000;

/** Run `fn` holding an exclusive lock on `file` (a sibling .lock file), across processes. */
export async function withLock<R>(file: string, fn: () => Promise<R>, opts: { timeoutMs?: number } = {}): Promise<R> {
  const lock = `${file}.lock`;
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  await fs.mkdir(path.dirname(file), { recursive: true });
  let wait = 5;
  for (;;) {
    try {
      const h = await fs.open(lock, "wx");
      try {
        await h.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      } finally {
        await h.close();
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Break a lock whose holder died, or that is older than any real critical section.
      let holder = "unknown process";
      try {
        const [text, st] = await Promise.all([fs.readFile(lock, "utf8"), fs.stat(lock)]);
        const info = JSON.parse(text || "{}") as { pid?: number; at?: string };
        holder = `pid ${info.pid ?? "?"} since ${info.at ?? "?"}`;
        const dead = typeof info.pid === "number" && info.pid !== process.pid && !alive(info.pid);
        if (dead || Date.now() - st.mtimeMs > STALE_MS) {
          await fs.rm(lock, { force: true });
          continue;
        }
      } catch {
        // The holder released it (or is mid-write) while we looked; try again.
      }
      if (Date.now() > deadline) throw new LockTimeoutError(file, holder);
      await new Promise((r) => setTimeout(r, wait + Math.random() * wait));
      wait = Math.min(wait * 2, 200);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lock, { force: true });
  }
}

/**
 * Read, change, and write a JSON file under its lock. `change` returns the new data (or undefined to leave the file
 * alone) and a result for the caller.
 */
export async function updateJson<T, R>(
  file: string,
  parse: (raw: unknown) => T,
  empty: () => T,
  change: (data: T, revision: string | null) => Promise<{ data?: T; result: R }> | { data?: T; result: R },
  opts: { trailingNewline?: boolean } = {}
): Promise<R> {
  return withLock(file, async () => {
    const cur = await readJson(file, parse, empty);
    const { data, result } = await change(cur.data, cur.revision);
    if (data !== undefined) await writeJson(file, data, opts);
    return result;
  });
}
