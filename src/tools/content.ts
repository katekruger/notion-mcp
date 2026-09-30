import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { call, isNotFound, normalizeId, notion, read } from "../services/notion.js";
import { appendSpecs, PartialWriteError, type BlockSpec } from "../services/blocks.js";
import {
  blockAsSpec,
  copyFileObject,
  describeBlock,
  duplicatePage,
  pageSegments,
  getBlock,
  getPage,
  pageTitle,
  parentOf,
  type PageParent,
  type Skipped,
} from "../services/copy.js";
import { fileRef } from "../services/files.js";
import { MAX_COPY_ROWS, planDatabaseCopy, readDatabase } from "../services/dbcopy.js";
import { plain, textToTitle, toInlineMarkdown } from "../services/richtext.js";
import { dataSourceTitle, resolveDataSource, restoreValue } from "../services/schema.js";
import { insertedBlocks, record, type UndoOp } from "../services/journal.js";
import { checkFresh, iconRef } from "./pages.js";
import { ok, READ, safe, WRITE } from "./util.js";

/** A page or database given as a destination. Databases become data source parents. */
async function destinationParent(input: string, dataSourceName?: string): Promise<{ parent: PageParent; label: string }> {
  try {
    const ds = await resolveDataSource(input, dataSourceName);
    return { parent: { data_source_id: ds.id }, label: `database "${dataSourceTitle(ds)}"` };
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  const page = await getPage(normalizeId(input));
  return { parent: { page_id: page.id }, label: `page "${pageTitle(page)}"` };
}

export function registerContentTools(server: McpServer): void {
  server.registerTool(
    "notion_update_page",
    {
      title: "Update Page",
      description:
        "Change a page's title, icon, or cover, lock or unlock it, or move it under another page or into a database. " +
        "Icons: an emoji, image URL, or local image path; covers: an image URL or local path; \"none\" removes either. " +
        "For database row fields use notion_update_properties. Reversible with notion_undo (an icon or cover that was an uploaded " +
        "file is uploaded again on undo).",
      inputSchema: {
        page: z.string().describe("Page URL or id."),
        title: z.string().optional(),
        icon: z.string().optional(),
        cover: z.string().optional(),
        locked: z.boolean().optional(),
        move_to: z.string().optional().describe("New parent: a page, or a database (the page becomes a row)."),
        data_source_name: z.string().optional(),
        expected_last_edited_time: z.string().optional(),
      },
      annotations: WRITE,
    },
    safe(async ({ page, title, icon, cover, locked, move_to, data_source_name, expected_last_edited_time }) => {
      const p = await getPage(normalizeId(page));
      checkFresh(p.last_edited_time, expected_last_edited_time, "This page");
      if (title === undefined && icon === undefined && cover === undefined && locked === undefined && !move_to) {
        throw new Error("Nothing to change: pass title, icon, cover, locked, or move_to.");
      }
      const payload: Record<string, unknown> = {};
      const restore: Record<string, unknown> = {};
      const changed: string[] = [];
      if (title !== undefined) {
        const entry = Object.entries(p.properties).find(([, v]) => v.type === "title");
        if (!entry) throw new Error("This page has no title property.");
        payload.properties = { [entry[0]]: { title: textToTitle(title) } };
        restore.properties = { [entry[0]]: restoreValue(entry[1]) };
        changed.push("title");
      }
      if (icon !== undefined) {
        payload.icon = icon.toLowerCase() === "none" ? null : await iconRef(icon);
        restore.icon = await copyFileObject(p.icon);
        changed.push("icon");
      }
      if (cover !== undefined) {
        payload.cover = cover.toLowerCase() === "none" ? null : await fileRef(cover);
        restore.cover = await copyFileObject(p.cover);
        changed.push("cover");
      }
      if (locked !== undefined) {
        payload.is_locked = locked;
        restore.is_locked = Boolean(p.is_locked);
        changed.push(locked ? "locked" : "unlocked");
      }
      const undo: UndoOp[] = [];
      const notes: string[] = [];
      if (Object.keys(payload).length) {
        await call(() => notion().pages.update({ page_id: p.id, ...payload } as never));
        undo.push({ kind: "page_update", page_id: p.id, payload: restore });
      }
      let movedTo: string | undefined;
      if (move_to) {
        const dest = await destinationParent(move_to, data_source_name);
        const from = parentOf(p);
        await call(() => notion().pages.move({ page_id: p.id, parent: dest.parent } as never));
        movedTo = dest.label;
        if (from) undo.push({ kind: "page_move", page_id: p.id, parent: from });
        else notes.push("The page's old location (workspace top level or inside a block) can't be restored through the API; undo won't move it back.");
        if ("data_source_id" in dest.parent) notes.push("As a database row, its properties now follow that database's schema; set them with notion_update_properties.");
      }
      const journalId = await record("notion_update_page", `Updated ${[...changed, ...(movedTo ? [`moved to ${movedTo}`] : [])].join(", ")} on ${p.id}`, undo);
      return ok({ page_id: p.id, changed, ...(movedTo ? { moved_to: movedTo } : {}), ...(notes.length ? { notes } : {}), undo_id: journalId });
    })
  );

  server.registerTool(
    "notion_duplicate_page",
    {
      title: "Duplicate Page",
      description:
        "Copy a page with its icon, cover, content (every block type the API can create, with formatting), and, when it stays in " +
        "the same database, all writable properties. Sub-pages and databases on the page are copied in place; databases get their " +
        "schema and (by default) their rows with content, with relations inside the copy pointing at the copied rows. Views, " +
        "linked database views, and read-only blocks are listed as skipped. Uploaded files and images are re-uploaded so the " +
        "copy doesn't depend on expiring links. dry_run shows what would be copied. notion_undo trashes the copy.",
      inputSchema: {
        page: z.string().describe("Page to copy."),
        to: z.string().optional().describe("Destination page or database. Defaults to the original's parent."),
        data_source_name: z.string().optional(),
        title: z.string().optional().describe('Defaults to "<original title> (copy)".'),
        include_subpages: z.boolean().default(true),
        databases: z
          .enum(["rows", "schema", "none"])
          .default("rows")
          .describe(`Databases on the page: copy schema and rows (up to ${MAX_COPY_ROWS} per data source), schema only, or skip them.`),
        dry_run: z.boolean().default(false),
      },
      annotations: { ...WRITE, idempotentHint: false },
    },
    safe(async ({ page, to, data_source_name, title, include_subpages, databases, dry_run }) => {
      const source = await getPage(normalizeId(page));
      const dest = to ? await destinationParent(to, data_source_name) : null;
      const parent = dest?.parent ?? parentOf(source);
      if (!parent) throw new Error("This page sits at the workspace top level or inside a block; pass `to` with a destination page or database.");
      if (dry_run) {
        const content = await pageSegments(source.id);
        const dbs = [];
        const skipped: Skipped[] = [...content.skipped];
        if (databases !== "none") {
          for (const seg of content.segments) {
            if (seg.kind !== "database") continue;
            const db = await readDatabase(seg.id);
            if (db && (db.parent as { page_id?: string }).page_id?.replace(/-/g, "") === source.id.replace(/-/g, "")) dbs.push(await planDatabaseCopy(db, databases === "rows"));
            else skipped.push({ id: seg.id, type: "child_database", reason: "linked database view (the API can't read or recreate it)" });
          }
        }
        const pages = content.segments.filter((s) => s.kind === "page").map((s) => (s as { title: string }).title);
        return ok({
          dry_run: true,
          title: title ?? `${pageTitle(source)} (copy)`,
          destination: dest?.label ?? "same parent as the original",
          blocks: content.blockCount,
          subpages: include_subpages ? [...pages, ...content.nestedPages.map((p) => p.title)] : [],
          databases: dbs,
          skipped,
          next_step: "Call again with dry_run=false to copy.",
        });
      }
      const undo: UndoOp[] = [];
      try {
        const r = await duplicatePage(source, parent, { title, includeSubpages: include_subpages, databases }, undo);
        const journalId = await record("notion_duplicate_page", `Duplicated "${pageTitle(source)}" as ${r.page_id}`, undo);
        return ok({ ...r, undo_id: journalId });
      } catch (e) {
        if (undo.length) {
          const journalId = await record("notion_duplicate_page", `Partial duplicate of "${pageTitle(source)}"`, undo);
          throw new Error(`${(e as Error).message} The copy was partly written; notion_undo ${journalId} trashes it.`);
        }
        throw e;
      }
    })
  );

  server.registerTool(
    "notion_copy_blocks",
    {
      title: "Copy or Move Blocks",
      description:
        "Copy blocks (with everything nested inside them) to another spot: a page or block, at the start, end, or after a block. " +
        "With move=true the originals are trashed afterward (the API has no move, so moved blocks get new ids and lose their " +
        "comments). Sub-pages among the given blocks are moved with Notion's page move, or duplicated when copying; they land at " +
        "the end of the destination page. A move is refused if it would lose something the API can't recreate (databases, " +
        "read-only blocks, original synced blocks whose references would break). Copying an original synced block creates a " +
        "reference to it. Moves default to dry_run=true. One notion_undo reverts everything.",
      inputSchema: {
        block_ids: z.array(z.string()).min(1).max(100).describe("Blocks to copy, in the order they should appear."),
        to: z.string().describe("Destination page or block."),
        position: z.enum(["end", "start", "after_block"]).default("end"),
        after_block_id: z.string().optional(),
        move: z.boolean().default(false),
        dry_run: z.boolean().optional().describe("Default: true for moves, false for copies."),
      },
      annotations: { ...WRITE, destructiveHint: true, idempotentHint: false },
    },
    safe(async ({ block_ids, to, position, after_block_id, move, dry_run }) => {
      const preview = dry_run ?? move;
      if (position === "after_block" && !after_block_id) throw new Error("position=after_block needs after_block_id.");
      const destId = normalizeId(to);
      const dest = await getBlock(destId);
      const destIsPage = dest.type === "child_page";

      type Item = { kind: "blocks"; specs: BlockSpec[]; ids: string[] } | { kind: "page"; id: string; title: string };
      const items: Item[] = [];
      const skipped: Skipped[] = [];
      const blockers: string[] = [];
      const summary: string[] = [];
      let blockCount = 0;
      for (const raw of block_ids) {
        const b = await getBlock(normalizeId(raw));
        if (b.id === destId) throw new Error(`Can't copy block ${b.id} into itself.`);
        if (b.type === "child_page") {
          if (!destIsPage) blockers.push(`${b.id} is a sub-page; sub-pages can only go directly under a page, not inside a block.`);
          items.push({ kind: "page", id: b.id, title: b.child_page.title });
          summary.push(`page: ${b.child_page.title}`);
          continue;
        }
        const { spec, sub } = await blockAsSpec(b);
        blockCount += sub.blockCount;
        skipped.push(...sub.skipped, ...sub.nestedPages.map((p) => ({ id: p.id, type: "child_page", reason: "sub-page nested inside a copied block" })));
        if (move) {
          if (sub.skipped.length || sub.nestedPages.length) {
            blockers.push(`${describeBlock(b)} contains ${sub.skipped.length + sub.nestedPages.length} item(s) the API can't recreate; moving would lose them.`);
          }
          if (sub.syncedOriginals.length) {
            blockers.push(`${describeBlock(b)} is or contains an original synced block; moving it would break every copy that syncs from it.`);
          }
        }
        if (!spec) {
          const reason = `${b.type} can't be recreated through the API`;
          if (move) blockers.push(`${describeBlock(b)}: ${reason}.`);
          skipped.push({ id: b.id, type: b.type, reason });
          continue;
        }
        const last = items[items.length - 1];
        if (last?.kind === "blocks") {
          last.specs.push(spec);
          last.ids.push(b.id);
        } else items.push({ kind: "blocks", specs: [spec], ids: [b.id] });
        summary.push(describeBlock(b));
      }
      if (move && blockers.length) {
        throw new Error(`Nothing was moved:\n- ${blockers.join("\n- ")}\nCopy instead (move=false) and delete what you no longer need, or move these in Notion.`);
      }
      if (!move && blockers.length) throw new Error(blockers.join(" "));
      if (preview) {
        return ok({
          dry_run: true,
          action: move ? "move" : "copy",
          destination: `${dest.type === "child_page" ? "page" : dest.type} ${destId}`,
          top_level: summary,
          total_blocks: blockCount,
          ...(skipped.length ? { skipped } : {}),
          next_step: "Call again with dry_run=false.",
        });
      }

      const undo: UndoOp[] = [];
      const created: string[] = [];
      const moved: string[] = [];
      const notes: string[] = [];
      let anchor: string | null = position === "after_block" ? normalizeId(after_block_id as string) : null;
      let first = true;
      try {
        for (const item of items) {
          if (item.kind === "blocks") {
            const pos = anchor ? { type: "after_block" as const, after_block_id: anchor } : first && position === "start" ? { type: "start" as const } : { type: "end" as const };
            let ids: string[];
            try {
              ids = await appendSpecs(destId, item.specs, pos);
            } catch (e) {
              if (e instanceof PartialWriteError) {
                created.push(...e.createdIds);
                undo.push(...insertedBlocks(e.createdIds, destId));
              }
              throw e;
            }
            created.push(...ids);
            undo.push(...insertedBlocks(ids, destId));
            anchor = ids[ids.length - 1] ?? anchor;
            if (move) {
              for (const id of item.ids) {
                await call(() => notion().blocks.delete({ block_id: id }));
                undo.push({ kind: "block_trash", block_id: id, in_trash: false });
                moved.push(id);
              }
            }
          } else if (move) {
            const page = await getPage(item.id);
            const from = parentOf(page);
            await call(() => notion().pages.move({ page_id: item.id, parent: { page_id: destId } } as never));
            if (from) undo.push({ kind: "page_move", page_id: item.id, parent: from });
            moved.push(item.id);
            notes.push(`Sub-page "${item.title}" was moved to the end of the destination page.`);
          } else {
            const r = await duplicatePage(await getPage(item.id), { page_id: destId }, { title: item.title, includeSubpages: true }, undo);
            created.push(r.page_id);
            skipped.push(...r.skipped);
            notes.push(`Sub-page "${item.title}" was copied to the end of the destination page.`);
          }
          first = false;
        }
      } catch (e) {
        const journalId = undo.length ? await record("notion_copy_blocks", `Partial ${move ? "move" : "copy"} into ${destId}`, undo) : undefined;
        throw new Error(
          `${(e as Error).message}${journalId ? ` Part of the ${move ? "move" : "copy"} was written (${created.length} created, ${moved.length} originals removed); notion_undo ${journalId} reverts it.` : ""}`
        );
      }
      const journalId = await record(
        "notion_copy_blocks",
        `${move ? "Moved" : "Copied"} ${block_ids.length} item(s) into ${destId}`,
        undo
      );
      return ok({
        action: move ? "moved" : "copied",
        created_block_ids: created,
        ...(move ? { removed_originals: moved } : {}),
        ...(skipped.length ? { skipped } : {}),
        ...(notes.length ? { notes } : {}),
        undo_id: journalId,
      });
    })
  );

  server.registerTool(
    "notion_list_templates",
    {
      title: "List Database Templates",
      description: "List a database's page templates (name, id, which is the default). Use a name or id as notion_create_page's `template`.",
      inputSchema: { database: z.string(), data_source_name: z.string().optional() },
      annotations: READ,
    },
    safe(async ({ database, data_source_name }) => {
      const ds = await resolveDataSource(database, data_source_name);
      const templates: { id: string; name: string; is_default: boolean }[] = [];
      let cursor: string | undefined;
      do {
        const res = await read(() => notion().dataSources.listTemplates({ data_source_id: ds.id, ...(cursor ? { start_cursor: cursor } : {}) } as never));
        templates.push(...res.templates.map((t) => ({ id: t.id, name: t.name, is_default: t.is_default })));
        cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
      } while (cursor);
      if (templates.length === 0) return ok(`"${dataSourceTitle(ds)}" has no templates. Create them in Notion (New ▾ → + New template).`);
      return ok({ database: dataSourceTitle(ds), templates });
    })
  );

  server.registerTool(
    "notion_comments",
    {
      title: "Comments",
      description:
        "Read, add, or reply to comments. action=list returns a page's or block's open comments with discussion ids (Notion's API " +
        "doesn't return resolved threads). action=add starts a discussion on a page or block; action=reply answers a discussion by " +
        "discussion_id. `text` is markdown (bold, links, mentions such as <mention-user email=\"…\"/>). Added comments can be " +
        "removed with notion_undo; an integration can only delete its own comments.",
      inputSchema: {
        action: z.enum(["list", "add", "reply"]),
        target: z.string().optional().describe("Page or block URL/id (list, add)."),
        discussion_id: z.string().optional().describe("reply: from action=list."),
        text: z.string().optional().describe("add, reply: markdown body."),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { ...WRITE, idempotentHint: false },
    },
    safe(async ({ action, target, discussion_id, text, limit }) => {
      const n = notion();
      if (action === "list") {
        if (!target) throw new Error("action=list needs `target`.");
        const id = normalizeId(target);
        const comments: Record<string, unknown>[] = [];
        let cursor: string | undefined;
        do {
          const res = await read(() => n.comments.list({ block_id: id, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }));
          for (const c of res.results) {
            const full = c as { id: string; discussion_id: string; created_time: string; created_by: { id: string; name?: string }; rich_text: Parameters<typeof plain>[0] };
            comments.push({ id: full.id, discussion_id: full.discussion_id, at: full.created_time, by: full.created_by.name ?? full.created_by.id, text: toInlineMarkdown(full.rich_text) });
          }
          cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
        } while (cursor && comments.length < limit);
        const threads = new Set(comments.map((c) => c.discussion_id)).size;
        return ok({ count: comments.length, discussions: threads, comments: comments.slice(0, limit), note: "Resolved discussions aren't returned by Notion's API." });
      }
      if (!text) throw new Error(`action=${action} needs \`text\`.`);
      let body: Record<string, unknown>;
      if (action === "reply") {
        if (!discussion_id) throw new Error("action=reply needs `discussion_id` (from action=list).");
        body = { discussion_id: normalizeId(discussion_id), markdown: text };
      } else {
        if (!target) throw new Error("action=add needs `target`.");
        const b = await getBlock(normalizeId(target));
        body = { parent: b.type === "child_page" ? { page_id: b.id } : { block_id: b.id }, markdown: text };
      }
      const c = await call(() => n.comments.create(body as never));
      const journalId = await record("notion_comments", `Comment ${c.id} (${action})`, [{ kind: "comment_delete", comment_id: c.id }]);
      return ok({ comment_id: c.id, discussion_id: (c as { discussion_id?: string }).discussion_id, undo_id: journalId });
    })
  );
}
