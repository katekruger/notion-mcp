import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { call, isNotFound, notion, read } from "./notion.js";
import { invalidateSchema } from "./schema.js";

export type UndoOp =
  | { kind: "page_properties"; page_id: string; properties: Record<string, unknown> }
  | { kind: "block_update"; block_id: string; payload: Record<string, unknown> }
  | { kind: "block_trash"; block_id: string; in_trash: boolean }
  | { kind: "page_trash"; page_id: string; in_trash: boolean }
  | { kind: "schema"; data_source_id: string; properties: Record<string, unknown> }
  | { kind: "comment_delete"; comment_id: string };

export interface JournalEntry {
  id: string;
  at: string;
  tool: string;
  summary: string;
  undo: UndoOp[];
  undone: boolean;
  not_undoable?: string;
}

const MAX_ENTRIES = 500;
const dir = process.env.NOTION_PLUS_HOME ?? path.join(os.homedir(), ".notion-plus");
const file = path.join(dir, "journal.json");

async function load(): Promise<JournalEntry[]> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as JournalEntry[];
  } catch {
    return [];
  }
}

async function save(entries: JournalEntry[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(entries.slice(-MAX_ENTRIES), null, 2));
  await fs.rename(tmp, file);
}

export async function record(
  tool: string,
  summary: string,
  undo: UndoOp[],
  notUndoable?: string
): Promise<string> {
  const entries = await load();
  const entry: JournalEntry = {
    id: randomUUID().slice(0, 8),
    at: new Date().toISOString(),
    tool,
    summary,
    undo,
    undone: false,
    ...(notUndoable ? { not_undoable: notUndoable } : {}),
  };
  entries.push(entry);
  await save(entries);
  return entry.id;
}

export async function history(limit: number): Promise<JournalEntry[]> {
  const entries = await load();
  return entries.slice(-limit).reverse();
}

async function apply(op: UndoOp): Promise<void> {
  const n = notion();
  switch (op.kind) {
    case "page_properties":
      await call(() => n.pages.update({ page_id: op.page_id, properties: op.properties } as never));
      break;
    case "block_update":
      await call(() => n.blocks.update({ block_id: op.block_id, ...op.payload } as never));
      break;
    case "block_trash":
      if (op.in_trash) await call(() => n.blocks.delete({ block_id: op.block_id }));
      else await call(() => n.blocks.update({ block_id: op.block_id, in_trash: false } as never));
      break;
    case "page_trash":
      await call(() => n.pages.update({ page_id: op.page_id, in_trash: op.in_trash } as never));
      break;
    case "comment_delete":
      await call(() => n.comments.delete({ comment_id: op.comment_id }));
      break;
    case "schema":
      await call(() => n.dataSources.update({ data_source_id: op.data_source_id, properties: op.properties } as never));
      invalidateSchema(op.data_source_id);
      break;
  }
}

/** What an undo op would overwrite, if anything: the object whose later edits it could clobber. */
export function undoTarget(op: UndoOp): { kind: "page" | "block" | "data_source"; id: string } | null {
  switch (op.kind) {
    case "page_properties":
      return { kind: "page", id: op.page_id };
    case "block_update":
      return { kind: "block", id: op.block_id };
    case "block_trash":
      // Trashing a block we inserted would also throw away edits made inside it since.
      return op.in_trash ? { kind: "block", id: op.block_id } : null;
    case "page_trash":
      return op.in_trash ? { kind: "page", id: op.page_id } : null;
    case "schema":
      return { kind: "data_source", id: op.data_source_id };
    case "comment_delete":
      return null;
  }
}

export interface UndoConflict {
  id: string;
  kind: string;
  last_edited_time: string;
  /** Later journal entries that touched the same object, which explains the edit when it was ours. */
  later_entries: string[];
}

/** Start of the minute: Notion rounds last_edited_time down to the minute. */
function minuteOf(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 60_000) * 60_000;
}

/**
 * Objects edited after this entry was written. Edits within the same minute as the write can't be seen,
 * because Notion reports last_edited_time to the minute.
 */
export function findConflicts(
  entry: JournalEntry,
  lastEdited: Map<string, string | null>,
  entries: JournalEntry[] = []
): UndoConflict[] {
  const since = minuteOf(entry.at);
  const out: UndoConflict[] = [];
  const seen = new Set<string>();
  for (const op of entry.undo) {
    const t = undoTarget(op);
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);
    const edited = lastEdited.get(t.id);
    if (!edited || new Date(edited).getTime() <= since) continue;
    const later = entries
      .filter((e) => e.at > entry.at && !e.undone && e.undo.some((o) => undoTarget(o)?.id === t.id))
      .map((e) => e.id);
    out.push({ id: t.id, kind: t.kind, last_edited_time: edited, later_entries: later });
  }
  return out;
}

async function lastEditedTimes(entry: JournalEntry): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const n = notion();
  for (const op of entry.undo) {
    const t = undoTarget(op);
    if (!t || out.has(t.id)) continue;
    try {
      const obj: object =
        t.kind === "page"
          ? await read(() => n.pages.retrieve({ page_id: t.id }))
          : t.kind === "block"
            ? await read(() => n.blocks.retrieve({ block_id: t.id }))
            : await read(() => n.dataSources.retrieve({ data_source_id: t.id }));
      const edited = (obj as { last_edited_time?: unknown }).last_edited_time;
      out.set(t.id, typeof edited === "string" ? edited : null);
    } catch (e) {
      if (!isNotFound(e)) throw e;
      out.set(t.id, null); // Gone or unshared; applying the op will report it.
    }
  }
  return out;
}

export async function undo(
  entryId?: string,
  opts: { force?: boolean } = {}
): Promise<{ entry: JournalEntry; applied: number; failed: string[]; conflicts: UndoConflict[] }> {
  const entries = await load();
  const target = entryId
    ? entries.find((e) => e.id === entryId)
    : [...entries].reverse().find((e) => !e.undone && e.undo.length > 0);
  if (!target) throw new Error(entryId ? `No journal entry "${entryId}".` : "Nothing to undo.");
  if (target.undone) throw new Error(`Entry ${target.id} was already undone.`);
  if (target.undo.length === 0) throw new Error(`Entry ${target.id} can't be undone: ${target.not_undoable ?? "no snapshot"}.`);

  const conflicts = findConflicts(target, await lastEditedTimes(target), entries);
  if (conflicts.length && !opts.force) {
    const lines = conflicts.map(
      (c) =>
        `- ${c.kind} ${c.id} edited at ${c.last_edited_time}` +
        (c.later_entries.length ? ` (also changed by later entries ${c.later_entries.join(", ")}; undo those first)` : " (by someone else)")
    );
    throw new Error(
      `Nothing was undone. ${conflicts.length} object(s) changed after entry ${target.id} (${target.at}), and undo would overwrite those changes:\n` +
        `${lines.join("\n")}\nCheck with the user, then call again with force: true to overwrite.`
    );
  }

  let applied = 0;
  const failed: string[] = [];
  for (const op of [...target.undo].reverse()) {
    try {
      await apply(op);
      applied++;
    } catch (e) {
      failed.push(`${op.kind}: ${(e as Error).message}`);
    }
  }
  target.undone = failed.length === 0;
  await save(entries);
  return { entry: target, applied, failed, conflicts };
}
