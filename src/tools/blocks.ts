import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isFullBlock } from "@notionhq/client";
import type { BlockObjectResponse, PageObjectResponse, RichTextItemResponse } from "@notionhq/client";
import { call, read, normalizeId, notion } from "../services/notion.js";
import {
  blockContent,
  blockText,
  currentSegments,
  flatten,
  getTree,
  markdownToSpecs,
  normalizeLanguage,
  restorePayload,
  RICH_TEXT_TYPES,
  appendSpecs,
  PartialWriteError,
} from "../services/blocks.js";
import { buildPattern, forApi, fromInlineMarkdown, replaceInRichText, segmentText, toRequest, type RichTextReq } from "../services/richtext.js";
import { getFullPage, snapshot } from "../services/writes.js";
import { withFullProperties } from "../services/schema.js";
import { insertedBlocks, record, type UndoOp } from "../services/journal.js";
import { blockSpecSchema, checkFresh } from "./pages.js";
import { fileRef, isUrl } from "../services/files.js";
import { normalizeColor } from "../services/richtext.js";
import { resolveUserMentions } from "../services/schema.js";
import { DESTRUCTIVE, fail, ok, safe, WRITE } from "./util.js";

async function getBlock(id: string): Promise<BlockObjectResponse> {
  const b = await read(() => notion().blocks.retrieve({ block_id: id }));
  if (!isFullBlock(b)) throw new Error(`Could not read block ${id}.`);
  return b;
}

export function registerBlockTools(server: McpServer): void {
  server.registerTool(
    "notion_patch_block",
    {
      title: "Patch One Block",
      description:
        "Edit a single block in place by id without touching anything else on the page: replace its text (inline markdown, " +
        "colors, mentions allowed), check/uncheck a to-do, set a code block's language or caption, change color, make a heading " +
        "a toggle, change a callout's icon, or replace a table row's cells. Block type can't change (Notion API limit); to change " +
        "type, insert a new block and delete the old one. Snapshots the old content for notion_undo.",
      inputSchema: {
        block_id: z.string(),
        text: z.string().optional().describe("New full text for the block. Omit to leave the text as-is."),
        checked: z.boolean().optional(),
        language: z.string().optional(),
        caption: z.string().optional().describe("code blocks"),
        color: z.string().optional().describe("e.g. default, gray, red, blue_background (or blue_bg)"),
        toggleable: z.boolean().optional().describe("headings only"),
        icon: z.string().optional().describe("callouts: emoji, image URL, or local image path"),
        cells: z.array(z.string()).optional().describe("table_row blocks: new text for every cell, in order"),
        expected_last_edited_time: z.string().optional(),
      },
      annotations: WRITE,
    },
    safe(async ({ block_id, text, checked, language, caption, color, toggleable, icon, cells, expected_last_edited_time }) => {
      const b = await getBlock(normalizeId(block_id));
      checkFresh(b.last_edited_time, expected_last_edited_time, "This block");
      const content: Record<string, unknown> = {};
      const only = (cond: boolean, field: string, where: string): void => {
        if (!cond) throw new Error(`\`${field}\` only applies to ${where} (this is a ${b.type}).`);
      };
      if (b.type === "table_row") {
        if (!cells) throw new Error("For a table row, pass `cells` (one string per cell).");
        const width = b.table_row.cells.length;
        if (cells.length !== width) throw new Error(`This row has ${width} cells; pass exactly ${width}.`);
        content.cells = cells.map((c) => forApi(fromInlineMarkdown(c)));
      } else {
        if (!RICH_TEXT_TYPES.has(b.type)) {
          throw new Error(`Block is a ${b.type}; only text blocks (${[...RICH_TEXT_TYPES].join(", ")}) and table rows can be patched.`);
        }
        if (cells !== undefined) only(false, "cells", "table_row blocks");
        if (text !== undefined) {
          content.rich_text = b.type === "code" ? forApi([{ type: "text", text: { content: text } }]) : forApi(fromInlineMarkdown(text));
        }
        if (checked !== undefined) {
          only(b.type === "to_do", "checked", "to_do blocks");
          content.checked = checked;
        }
        if (language !== undefined) {
          only(b.type === "code", "language", "code blocks");
          content.language = normalizeLanguage(language);
        }
        if (caption !== undefined) {
          only(b.type === "code", "caption", "code blocks");
          content.caption = forApi(fromInlineMarkdown(caption));
        }
        if (toggleable !== undefined) {
          only(b.type.startsWith("heading_"), "toggleable", "headings");
          content.is_toggleable = toggleable;
        }
        if (icon !== undefined) {
          only(b.type === "callout", "icon", "callouts");
          content.icon = isUrl(icon) || /[\\/.]/.test(icon) ? await fileRef(icon) : { type: "emoji", emoji: icon };
        }
        if (color !== undefined) content.color = normalizeColor(color);
        // Notion rejects heading_4 updates that omit rich_text (verified live), so resend the current text.
        if (b.type === "heading_4" && content.rich_text === undefined) content.rich_text = forApi(currentSegments(b));
      }
      if (Object.keys(content).length === 0) throw new Error("Nothing to change: pass text, checked, language, caption, color, toggleable, icon, or cells.");
      await resolveUserMentions(content);

      const restore = restorePayload(b);
      const before = blockText(b);
      const updated = await call(() => notion().blocks.update({ block_id: b.id, [b.type]: content } as never));
      const undo: UndoOp[] = restore ? [{ kind: "block_update", block_id: b.id, payload: restore }] : [];
      const journalId = await record("notion_patch_block", `Patched ${b.type} ${b.id}`, undo);
      const after = isFullBlock(updated) ? blockText(updated) : undefined;
      return ok({ block_id: b.id, type: b.type, before, after, undo_id: journalId });
    })
  );

  server.registerTool(
    "notion_insert_blocks",
    {
      title: "Insert Blocks",
      description:
        "Insert new content at an exact spot: at the start or end of a page/block, or directly after a specific block id. " +
        "Existing content is never rewritten. `markdown` accepts headings (# to ####), lists and to-dos nested by indentation to " +
        "any depth, quotes, ``` code (```mermaid for diagrams), $$ equations $$, pipe tables, > [!NOTE]/[!TIP]/[!WARNING] callouts, " +
        "and Notion's markdown tags as returned by notion_get_page format=markdown (<callout>, <columns><column>, <details>, " +
        "<table>, <tabs>, <span color>, mentions, {color=\"…\"}). Or give structured `blocks` (tables via rows, columns, tabs, " +
        "images/files from a URL or local path, bookmarks, embeds, equations, synced blocks, link_to_page, table_of_contents, " +
        "breadcrumb). Everything is validated and uploaded before the first write. Returns the new block ids.",
      inputSchema: {
        parent: z.string().describe("Page or block URL/id to insert into."),
        position: z.enum(["end", "start", "after_block"]).default("end"),
        after_block_id: z.string().optional().describe("Required when position is after_block; must be a direct child of parent."),
        markdown: z.string().optional(),
        blocks: z.array(blockSpecSchema).optional(),
      },
      annotations: { ...WRITE, idempotentHint: false },
    },
    safe(async ({ parent, position, after_block_id, markdown, blocks }) => {
      const specs = [...(markdown ? markdownToSpecs(markdown) : []), ...(blocks ?? [])];
      if (specs.length === 0) throw new Error("Provide markdown or blocks to insert.");
      if (position === "after_block" && !after_block_id) throw new Error("position=after_block needs after_block_id.");
      const parentId = normalizeId(parent);
      let createdIds: string[];
      try {
        createdIds = await appendSpecs(
          parentId,
          specs,
          position === "after_block"
            ? { type: "after_block", after_block_id: normalizeId(after_block_id as string) }
            : { type: position }
        );
      } catch (e) {
        if (!(e instanceof PartialWriteError) || e.createdIds.length === 0) throw e instanceof PartialWriteError ? e.cause : e;
        const undoId = await record(
          "notion_insert_blocks",
          `Partial insert: ${e.createdIds.length} of ${specs.length} blocks into ${parentId}`,
          insertedBlocks(e.createdIds, parentId)
        );
        return fail(
          `${e.message}. ${e.createdIds.length} of ${specs.length} top-level blocks were written (ids: ${e.createdIds.join(", ")}). ` +
            `notion_undo ${undoId} removes them; or insert the rest after_block ${e.createdIds[e.createdIds.length - 1]}.`
        );
      }
      const journalId = await record(
        "notion_insert_blocks",
        `Inserted ${createdIds.length} blocks into ${parentId}`,
        insertedBlocks(createdIds, parentId)
      );
      return ok({ inserted: createdIds.length, block_ids: createdIds, undo_id: journalId });
    })
  );

  server.registerTool(
    "notion_replace_text",
    {
      title: "Find and Replace Text",
      description:
        "Find and replace text across a page while keeping bold/italic/links/colors and mentions intact: every text block, table " +
        "cell, and code caption, plus the page title (include_title). Supports regex with $1-style groups. Defaults to dry_run=true, " +
        "which shows every change (before/after) so you can confirm. Matches that cross a mention or equation are skipped and " +
        "reported. Sub-pages are separate documents and aren't searched. All changes revert together with notion_undo.",
      inputSchema: {
        page: z.string(),
        find: z.string().min(1),
        replace: z.string(),
        regex: z.boolean().default(false),
        case_sensitive: z.boolean().default(true),
        include_title: z.boolean().default(true).describe("Also replace in the page title."),
        block_ids: z.array(z.string()).optional().describe("Limit to these blocks."),
        max_replacements: z.number().int().min(1).max(1000).default(200),
        dry_run: z.boolean().default(true),
      },
      annotations: { ...WRITE, idempotentHint: false },
    },
    safe(async ({ page, find, replace, regex, case_sensitive, include_title, block_ids, max_replacements, dry_run }) => {
      const pattern = buildPattern(find, regex, case_sensitive);
      const pageId = normalizeId(page);
      const tree = await getTree(pageId, 8, 3000);
      const only = block_ids ? new Set(block_ids.map(normalizeId)) : null;
      interface Change {
        block: BlockObjectResponse;
        content: Record<string, unknown>;
        before: string;
        after: string;
        count: number;
        skipped: number;
      }
      const changes: Change[] = [];
      let total = 0;
      let skippedTotal = 0;
      const budget = () => max_replacements - total;
      const run = (segs: RichTextReq[]) => {
        const r = replaceInRichText(segs, pattern, replace, Math.max(0, budget()));
        total += r.count;
        skippedTotal += r.skipped;
        return r;
      };
      const joined = (segs: RichTextReq[]) => segs.map(segmentText).join("");

      // Page title first, so it counts toward max_replacements like everything else.
      let titleChange: { page: PageObjectResponse; name: string; before: string; after: string; value: Record<string, unknown>[] } | null = null;
      if (include_title && !only) {
        const p = await getFullPage(pageId).catch(() => null);
        const entry = p ? Object.entries(p.properties).find(([, v]) => v.type === "title") : undefined;
        if (p && entry && entry[1].type === "title") {
          const full = await withFullProperties(p, [entry[0]]);
          const prop = full.properties[entry[0]];
          const segs = prop.type === "title" ? toRequest(prop.title) : [];
          const r = run(segs);
          if (r.count > 0) titleChange = { page: full, name: entry[0], before: joined(segs), after: joined(r.segments), value: forApi(r.segments) };
        }
      }

      for (const node of flatten(tree.nodes)) {
        if (budget() <= 0) break;
        if (only && !only.has(node.id)) continue;
        const block = tree.raw.get(node.id);
        if (!block) continue;
        if (block.type === "table_row") {
          const cells = block.table_row.cells.map((c) => toRequest(c));
          let count = 0;
          let skipped = 0;
          const next = cells.map((c) => {
            const r = run(c);
            count += r.count;
            skipped += r.skipped;
            return r.segments;
          });
          if (count || skipped) {
            changes.push({
              block, content: { cells: next.map((c) => forApi(c)) }, count, skipped,
              before: cells.map(joined).join(" | "), after: next.map(joined).join(" | "),
            });
          }
          continue;
        }
        if (!RICH_TEXT_TYPES.has(block.type)) continue;
        const segs = currentSegments(block);
        const r = run(segs);
        const content: Record<string, unknown> = {};
        if (r.count) content.rich_text = forApi(r.segments);
        let count = r.count;
        let skipped = r.skipped;
        const caption = (blockContent(block).caption as RichTextItemResponse[] | undefined) ?? [];
        if (caption.length && budget() > 0) {
          const c = run(toRequest(caption));
          if (c.count) content.caption = forApi(c.segments);
          count += c.count;
          skipped += c.skipped;
        }
        if (count || skipped) changes.push({ block, content, count, skipped, before: joined(segs), after: joined(r.segments) });
      }

      const preview = [
        ...(titleChange ? [{ page_title: true, before: titleChange.before, after: titleChange.after }] : []),
        ...changes.map((c) => ({
          block_id: c.block.id,
          type: c.block.type,
          before: c.before,
          after: c.after,
          replacements: c.count,
          ...(c.skipped ? { skipped_matches: c.skipped } : {}),
        })),
      ];
      const partial = tree.truncated ? " The page is very large and was only partly scanned; use block_ids to target the rest." : "";
      if (preview.length === 0) return ok(`No matches for ${regex ? "regex" : "text"} "${find}".${partial}`);
      const capped = total >= max_replacements ? `Stopped at max_replacements=${max_replacements}; raise it to change the rest.` : undefined;
      if (dry_run) {
        return ok({
          dry_run: true,
          total_replacements: total,
          ...(skippedTotal ? { skipped_matches: skippedTotal, skipped_note: "Matches that cross a mention or equation aren't changed." } : {}),
          ...(capped ? { warning: capped } : {}),
          ...(partial ? { note: partial.trim() } : {}),
          changes: preview,
          next_step: "Confirm, then call again with dry_run=false.",
        });
      }

      const undo: UndoOp[] = [];
      const failed: { id: string; error: string }[] = [];
      if (titleChange) {
        try {
          const op = snapshot(titleChange.page, [titleChange.name]);
          await call(() => notion().pages.update({ page_id: pageId, properties: { [titleChange.name]: { title: titleChange.value } } } as never));
          undo.push(op);
        } catch (e) {
          failed.push({ id: pageId, error: `title: ${(e as Error).message}` });
        }
      }
      for (const c of changes.filter((x) => x.count > 0)) {
        try {
          const restore = restorePayload(c.block);
          await call(() => notion().blocks.update({ block_id: c.block.id, [c.block.type]: c.content } as never));
          if (restore) undo.push({ kind: "block_update", block_id: c.block.id, payload: restore });
        } catch (e) {
          failed.push({ id: c.block.id, error: (e as Error).message });
        }
      }
      const journalId = await record("notion_replace_text", `Replaced "${find}" → "${replace}" in ${undo.length} places on ${pageId}`, undo);
      return ok({
        total_replacements: total,
        changed: undo.length,
        ...(failed.length ? { failed, note: "The rest were applied; undo_id reverts only what changed." } : {}),
        ...(capped ? { warning: capped } : {}),
        undo_id: journalId,
      });
    })
  );

  server.registerTool(
    "notion_delete_blocks",
    {
      title: "Delete Blocks",
      description: "Move specific blocks (by id) to the trash. Nothing else on the page is touched. Reversible with notion_undo.",
      inputSchema: { block_ids: z.array(z.string()).min(1).max(100) },
      annotations: DESTRUCTIVE,
    },
    safe(async ({ block_ids }) => {
      const undo: UndoOp[] = [];
      const deleted: { id: string; type: string; text: string }[] = [];
      const failed: string[] = [];
      for (const raw of block_ids) {
        const id = normalizeId(raw);
        try {
          const b = await getBlock(id);
          await call(() => notion().blocks.delete({ block_id: id }));
          undo.push({ kind: "block_trash", block_id: id, in_trash: false });
          deleted.push({ id, type: b.type, text: blockText(b).slice(0, 120) });
        } catch (e) {
          failed.push(`${id}: ${(e as Error).message}`);
        }
      }
      const journalId = await record("notion_delete_blocks", `Deleted ${deleted.length} blocks`, undo);
      return ok({ deleted, failed, undo_id: journalId });
    })
  );
}

