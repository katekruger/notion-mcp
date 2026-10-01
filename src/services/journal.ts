import path from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { call, isNotFound, mapLimited, notion, read, setBeforeWrite, updateBlock, updateDataSource, updatePage } from "./notion.js";
import { readJson, updateJson } from "./store.js";
import { stateDir } from "./workspace.js";
import { invalidateSchema } from "./schema.js";
import { uploadLocalFile } from "./files.js";

export type UndoOp =
  | { kind: "page_properties"; page_id: string; properties: Record<string, unknown>; data_source_id?: string }
  | { kind: "block_update"; block_id: string; payload: Record<string, unknown> }
  | { kind: "block_trash"; block_id: string; in_trash: boolean; parent_id?: string }
  | { kind: "page_trash"; page_id: string; in_trash: boolean }
  | { kind: "schema"; data_source_id: string; properties: Record<string, unknown> }
  | { kind: "comment_delete"; comment_id: string }
  | { kind: "page_update"; page_id: string; payload: Record<string, unknown> }
  | { kind: "page_move"; page_id: string; parent: Record<string, unknown> }
  | { kind: "database_trash"; database_id: string; in_trash: boolean }
  /** Remove a view this server created; a linked view on a page is removed with its block. */
  | { kind: "view_delete"; view_id: string; linked_block_id?: string }
  | { kind: "view_update"; view_id: string; payload: Record<string, unknown> }
  | { kind: "view_create"; request: Record<string, unknown> }
  /** Put back a chart image replaced by a refresh, from the copy saved at the time. */
  | { kind: "image_restore"; block_id: string; path: string; caption?: unknown[] };

/** Undo ops that trash newly inserted blocks. The parent lets undo check freshness with one listing, not one read per block. */
export function insertedBlocks(ids: string[], parentId: string): UndoOp[] {
  return ids.map((id) => ({ kind: "block_trash", block_id: id, in_trash: true, parent_id: parentId }));
}

export interface JournalEntry {
  id: string;
  at: string;
  tool: string;
  summary: string;
  undo: UndoOp[];
  undone: boolean;
  not_undoable?: string;
  /**
   * Write-ahead state. "pending": the tool started writing to Notion and hasn't finished (or its process died:
   * see `interrupted` in history). "failed": it stopped with an error after writing, before recording undo.
   * Absent: finished and recorded.
   */
  status?: "pending" | "failed";
  pid?: number;
  /** The tool's input, shortened, so an interrupted write can be checked by hand. */
  args?: string;
  error?: string;
}

const MAX_ENTRIES = 500;

async function journalFile(): Promise<string> {
  return path.join(await stateDir(), "journal.json");
}

function parseEntries(raw: unknown): JournalEntry[] {
  if (!Array.isArray(raw)) throw new Error("expected a list of entries");
  for (const e of raw) {
    const o = e as Partial<JournalEntry> | null;
    if (!o || typeof o.id !== "string" || typeof o.at !== "string" || !Array.isArray(o.undo)) throw new Error("an entry is missing id, at, or undo");
  }
  return raw as JournalEntry[];
}

async function load(): Promise<JournalEntry[]> {
  return (await readJson(await journalFile(), parseEntries, () => [])).data;
}

/** Change the journal under its lock. */
async function edit<R>(fn: (entries: JournalEntry[]) => R): Promise<R> {
  return updateJson(await journalFile(), parseEntries, () => [], (entries) => {
    const result = fn(entries);
    return { data: entries.slice(-MAX_ENTRIES), result };
  });
}

function newEntry(tool: string, summary: string, undo: UndoOp[], notUndoable?: string): JournalEntry {
  return {
    id: randomUUID().slice(0, 8),
    at: new Date().toISOString(),
    tool,
    summary,
    undo,
    undone: false,
    ...(notUndoable ? { not_undoable: notUndoable } : {}),
  };
}

// ---------- write-ahead intents ----------

interface ToolContext {
  tool: string;
  args: unknown;
  /** Journal entry written before the first Notion write of this call. */
  intentId?: string;
  /** record() has run (it fills in the intent, or wrote its own entry), so later writes need no new intent. */
  recorded: boolean;
}

const context = new AsyncLocalStorage<ToolContext>();

function shortArgs(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(args) ?? "";
  } catch {
    text = String(args);
  }
  return text.length > 2000 ? text.slice(0, 2000) + "…" : text;
}

async function beginIntent(): Promise<void> {
  const ctx = context.getStore();
  if (!ctx || ctx.intentId || ctx.recorded) return;
  const entry: JournalEntry = {
    ...newEntry(ctx.tool, `${ctx.tool} started`, [], "the write was interrupted before undo was recorded"),
    status: "pending",
    pid: process.pid,
    args: shortArgs(ctx.args),
  };
  ctx.intentId = entry.id;
  await edit((entries) => entries.push(entry));
}
setBeforeWrite(beginIntent);

/**
 * Run a write tool so that its first Notion write is preceded by a "pending" journal entry. record() completes
 * that entry; if the process dies in between, history shows the write as interrupted with the tool's input.
 */
export async function runJournaled<R extends { isError?: boolean; content?: { text?: string }[] }>(
  tool: string,
  args: unknown,
  fn: () => Promise<R>
): Promise<R> {
  const ctx: ToolContext = { tool, args, recorded: false };
  const settle = async (error?: string) => {
    if (!ctx.intentId || ctx.recorded) return;
    const id = ctx.intentId;
    await edit((entries) => {
      const i = entries.findIndex((e) => e.id === id);
      if (i < 0) return;
      // A write that finished without recording undo (undo itself, a no-op) leaves nothing to keep.
      if (error === undefined) entries.splice(i, 1);
      else Object.assign(entries[i], { status: "failed", summary: `${tool} stopped with an error after writing`, error: error.slice(0, 1000) });
    });
  };
  try {
    const r = await context.run(ctx, fn);
    await settle(r?.isError ? (r.content?.[0]?.text ?? "error") : undefined);
    return r;
  } catch (e) {
    await settle((e as Error).message ?? String(e));
    throw e;
  }
}

/**
 * How much of a write undo can revert: all of it, part of it (some effects have no undo, named in the entry), or
 * none. Kept for recent entries so tool results can report it.
 */
export type UndoCoverage = "full" | "partial" | "none";
const coverage = new Map<string, UndoCoverage>();

export function undoCoverage(id: string): UndoCoverage | undefined {
  return coverage.get(id);
}

export async function record(
  tool: string,
  summary: string,
  undo: UndoOp[],
  notUndoable?: string
): Promise<string> {
  const id = await recordEntry(tool, summary, undo, notUndoable);
  coverage.set(id, undo.length === 0 ? "none" : notUndoable ? "partial" : "full");
  if (coverage.size > 500) coverage.delete(coverage.keys().next().value as string);
  return id;
}

async function recordEntry(
  tool: string,
  summary: string,
  undo: UndoOp[],
  notUndoable?: string
): Promise<string> {
  const ctx = context.getStore();
  const intentId = ctx && !ctx.recorded ? ctx.intentId : undefined;
  if (ctx) ctx.recorded = true;
  const entry = newEntry(tool, summary, undo, notUndoable);
  return edit((entries) => {
    const i = intentId ? entries.findIndex((e) => e.id === intentId) : -1;
    if (i < 0) {
      entries.push(entry);
      return entry.id;
    }
    // Complete the intent in place: same id, same position, now with its undo.
    entries[i] = { ...entry, id: intentId as string, at: entries[i].at };
    return intentId as string;
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type HistoryEntry = JournalEntry & { interrupted?: boolean };

/** Entries newest first, skipping `offset` of the newest. */
export async function history(limit: number, offset = 0): Promise<HistoryEntry[]> {
  const entries = await load();
  return entries
    .slice()
    .reverse()
    .slice(offset, offset + limit)
    .map((e) =>
      e.status === "pending" && e.pid !== undefined && e.pid !== process.pid && !pidAlive(e.pid)
        ? { ...e, interrupted: true, not_undoable: "interrupted: the process stopped mid-write; check the objects named in args by hand" }
        : e
    );
}

async function apply(op: UndoOp): Promise<void> {
  const n = notion();
  switch (op.kind) {
    case "page_properties":
      await call(() => updatePage({ page_id: op.page_id, properties: op.properties }));
      break;
    case "block_update":
      await call(() => updateBlock({ block_id: op.block_id, ...op.payload }));
      break;
    case "block_trash":
      if (op.in_trash) await call(() => n.blocks.delete({ block_id: op.block_id }));
      else await call(() => updateBlock({ block_id: op.block_id, in_trash: false }));
      break;
    case "page_trash":
      await call(() => updatePage({ page_id: op.page_id, in_trash: op.in_trash }));
      break;
    case "comment_delete":
      await call(() => n.comments.delete({ comment_id: op.comment_id }));
      break;
    case "page_update":
      await call(() => updatePage({ page_id: op.page_id, ...op.payload }));
      break;
    case "page_move":
      await call(() => n.pages.move({ page_id: op.page_id, parent: op.parent } as never));
      break;
    case "database_trash":
      await call(() => n.databases.update({ database_id: op.database_id, in_trash: op.in_trash } as never));
      break;
    case "view_delete":
      if (op.linked_block_id) await call(() => n.blocks.delete({ block_id: op.linked_block_id as string }));
      else await call(() => n.views.delete({ view_id: op.view_id }));
      break;
    case "view_update":
      await call(() => n.views.update({ view_id: op.view_id, ...op.payload } as never));
      break;
    case "view_create":
      await call(() => n.views.create(op.request as never));
      break;
    case "image_restore": {
      const id = await uploadLocalFile(op.path, undefined, { allowAnyPath: true });
      await call(() => updateBlock({ block_id: op.block_id, image: { file_upload: { id }, ...(op.caption ? { caption: op.caption } : {}) } }));
      break;
    }
    case "schema":
      await call(() => updateDataSource({ data_source_id: op.data_source_id, properties: op.properties }));
      invalidateSchema(op.data_source_id);
      for (const v of Object.values(op.properties)) {
        const rel = (v as { relation?: { data_source_id?: string } } | null)?.relation?.data_source_id;
        if (rel) invalidateSchema(rel);
      }
      break;
  }
}

/** What an undo op would overwrite, if anything: the object whose later edits it could clobber. */
export function undoTarget(op: UndoOp): { kind: "page" | "block" | "data_source" | "view"; id: string } | null {
  switch (op.kind) {
    case "page_properties":
      return { kind: "page", id: op.page_id };
    case "block_update":
      return { kind: "block", id: op.block_id };
    case "block_trash":
      // Trashing a block we inserted would also throw away edits made inside it since.
      return op.in_trash ? { kind: "block", id: op.block_id } : null;
    case "page_trash":
      // Trashing a page this server created keeps its later edits (it can be restored from Notion's trash), so no check.
      return null;
    case "schema":
      // A data source's edit time moves with every schema change and some row edits (verified live), so it can't
      // tell whether this property was changed since; schema undo only touches the property it names.
      return null;
    case "page_update":
    case "page_move":
      return { kind: "page", id: op.page_id };
    case "view_update":
      return { kind: "view", id: op.view_id };
    case "image_restore":
      return { kind: "block", id: op.block_id };
    case "comment_delete":
    case "database_trash":
    case "view_delete":
    case "view_create":
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
    if (!edited) continue;
    const at = new Date(edited).getTime();
    // Pages and blocks report edit times to the minute; views report exact times, which compare exactly.
    const threshold = at % 60_000 === 0 ? since : new Date(entry.at).getTime();
    if (at <= threshold) continue;
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
  // Inserted blocks: one children listing per parent covers them all.
  const parents = new Set(entry.undo.flatMap((op) => (op.kind === "block_trash" && op.in_trash && op.parent_id ? [op.parent_id] : [])));
  for (const parentId of parents) {
    try {
      let cursor: string | undefined;
      do {
        const res = await read(() => n.blocks.children.list({ block_id: parentId, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }));
        for (const b of res.results) {
          const edited = (b as { last_edited_time?: unknown }).last_edited_time;
          if (typeof edited === "string") out.set(b.id, edited);
        }
        cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
      } while (cursor);
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }
  // Rows in a database: one query for rows edited since the entry finds every conflict at once.
  const sources = new Set(entry.undo.flatMap((op) => (op.kind === "page_properties" && op.data_source_id ? [op.data_source_id] : [])));
  const checkedRows = new Set<string>();
  for (const dsId of sources) {
    try {
      let cursor: string | undefined;
      do {
        const res = await read(() =>
          n.dataSources.query({
            data_source_id: dsId,
            page_size: 100,
            filter: { timestamp: "last_edited_time", last_edited_time: { after: new Date(minuteOf(entry.at)).toISOString() } },
            ...(cursor ? { start_cursor: cursor } : {}),
          } as never)
        );
        for (const r of res.results) {
          const edited = (r as { last_edited_time?: unknown }).last_edited_time;
          if (typeof edited === "string") out.set(r.id, edited);
        }
        cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
      } while (cursor);
      for (const op of entry.undo) if (op.kind === "page_properties" && op.data_source_id === dsId) checkedRows.add(op.page_id);
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }
  for (const op of entry.undo) {
    const t = undoTarget(op);
    if (!t || out.has(t.id)) continue;
    if (checkedRows.has(t.id)) {
      out.set(t.id, null); // Not edited since the entry (the query above returns every row that was).
      continue;
    }
    // A listed parent that no longer shows the block means it's already gone; nothing to compare.
    if (op.kind === "block_trash" && op.parent_id && parents.has(op.parent_id)) {
      out.set(t.id, null);
      continue;
    }
    try {
      const obj: object =
        t.kind === "page"
          ? await read(() => n.pages.retrieve({ page_id: t.id }))
          : t.kind === "block"
            ? await read(() => n.blocks.retrieve({ block_id: t.id }))
            : t.kind === "view"
              ? await read(() => n.views.retrieve({ view_id: t.id }))
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
  // Reverse order matters across kinds (a re-created property before its values), not within a run of
  // independent row/block ops, so those runs go a few at a time.
  const ops = [...target.undo].reverse();
  const independent = new Set(["page_properties", "page_trash", "block_trash", "comment_delete", "block_update", "view_delete"]);
  for (let i = 0; i < ops.length; ) {
    let j = i + 1;
    if (independent.has(ops[i].kind)) while (j < ops.length && ops[j].kind === ops[i].kind) j++;
    await mapLimited(ops.slice(i, j), async (op) => {
      try {
        await apply(op);
        applied++;
      } catch (e) {
        failed.push(`${op.kind}: ${(e as Error).message}`);
      }
    });
    i = j;
  }
  target.undone = failed.length === 0;
  if (target.undone) {
    await edit((all) => {
      const e = all.find((x) => x.id === target.id);
      if (e) e.undone = true;
    });
  }
  return { entry: target, applied, failed, conflicts };
}
