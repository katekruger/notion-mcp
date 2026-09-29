import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { call, notion } from "./notion.js";
import { invalidateSchema } from "./schema.js";

export type UndoOp =
  | { kind: "page_properties"; page_id: string; properties: Record<string, unknown> }
  | { kind: "block_update"; block_id: string; payload: Record<string, unknown> }
  | { kind: "block_trash"; block_id: string; in_trash: boolean }
  | { kind: "page_trash"; page_id: string; in_trash: boolean }
  | { kind: "schema"; data_source_id: string; properties: Record<string, unknown> };

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
    case "schema":
      await call(() => n.dataSources.update({ data_source_id: op.data_source_id, properties: op.properties } as never));
      invalidateSchema(op.data_source_id);
      break;
  }
}

export async function undo(entryId?: string): Promise<{ entry: JournalEntry; applied: number; failed: string[] }> {
  const entries = await load();
  const target = entryId
    ? entries.find((e) => e.id === entryId)
    : [...entries].reverse().find((e) => !e.undone && e.undo.length > 0);
  if (!target) throw new Error(entryId ? `No journal entry "${entryId}".` : "Nothing to undo.");
  if (target.undone) throw new Error(`Entry ${target.id} was already undone.`);
  if (target.undo.length === 0) throw new Error(`Entry ${target.id} can't be undone: ${target.not_undoable ?? "no snapshot"}.`);

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
  return { entry: target, applied, failed };
}
