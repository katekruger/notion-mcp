import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isFullBlock } from "@notionhq/client";
import type { BlockObjectResponse } from "@notionhq/client";
import { call, normalizeId, notion } from "../services/notion.js";
import {
  blockText,
  currentSegments,
  flatten,
  getTree,
  markdownToSpecs,
  normalizeLanguage,
  restorePayload,
  RICH_TEXT_TYPES,
  appendSpecs,
} from "../services/blocks.js";
import { buildPattern, forApi, fromInlineMarkdown, replaceInRichText, segmentText } from "../services/richtext.js";
import { record, type UndoOp } from "../services/journal.js";
import { blockSpecSchema, checkFresh } from "./pages.js";
import { DESTRUCTIVE, ok, safe, WRITE } from "./util.js";

async function getBlock(id: string): Promise<BlockObjectResponse> {
  const b = await call(() => notion().blocks.retrieve({ block_id: id }));
  if (!isFullBlock(b)) throw new Error(`Could not read block ${id}.`);
  return b;
}

export function registerBlockTools(server: McpServer): void {
  server.registerTool(
    "notion_patch_block",
    {
      title: "Patch One Block",
      description:
        "Edit a single block in place by id without touching anything else on the page. Can replace its text (inline markdown " +
        "allowed), check/uncheck a to-do, change a code block's language, or change color. Block type can't change (Notion API " +
        "limit); to change type, insert a new block and delete the old one. Snapshots the old content for notion_undo.",
      inputSchema: {
        block_id: z.string(),
        text: z.string().optional().describe("New full text for the block. Omit to leave the text as-is."),
        checked: z.boolean().optional(),
        language: z.string().optional(),
        color: z.string().optional().describe("e.g. default, gray, red, blue_background"),
        expected_last_edited_time: z.string().optional(),
      },
      annotations: WRITE,
    },
    safe(async ({ block_id, text, checked, language, color, expected_last_edited_time }) => {
      const b = await getBlock(normalizeId(block_id));
      checkFresh(b.last_edited_time, expected_last_edited_time, "This block");
      if (!RICH_TEXT_TYPES.has(b.type)) throw new Error(`Block is a ${b.type}; only text blocks (${[...RICH_TEXT_TYPES].join(", ")}) can be patched.`);
      const content: Record<string, unknown> = {};
      if (text !== undefined) {
        content.rich_text = b.type === "code"
          ? forApi([{ type: "text", text: { content: text } }])
          : forApi(fromInlineMarkdown(text));
      }
      if (checked !== undefined) {
        if (b.type !== "to_do") throw new Error("`checked` only applies to to_do blocks.");
        content.checked = checked;
      }
      if (language !== undefined) {
        if (b.type !== "code") throw new Error("`language` only applies to code blocks.");
        content.language = normalizeLanguage(language);
      }
      if (color !== undefined) content.color = color;
      if (Object.keys(content).length === 0) throw new Error("Nothing to change: pass text, checked, language, or color.");

      const restore = restorePayload(b);
      const before = blockText(b);
      await call(() => notion().blocks.update({ block_id: b.id, [b.type]: content } as never));
      const undo: UndoOp[] = restore ? [{ kind: "block_update", block_id: b.id, payload: restore }] : [];
      const journalId = await record("notion_patch_block", `Patched ${b.type} ${b.id}`, undo);
      return ok({ block_id: b.id, type: b.type, before, after: text ?? before, undo_id: journalId });
    })
  );

  server.registerTool(
    "notion_insert_blocks",
    {
      title: "Insert Blocks",
      description:
        "Insert new content at an exact spot: at the start or end of a page/block, or directly after a specific block id. " +
        "Existing content is never rewritten. Provide `markdown` (headings, lists, to-dos, quotes, ``` code, ---, inline formatting; " +
        "indent list items to nest) or structured `blocks`. Returns the new block ids.",
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
      const createdIds = await appendSpecs(
        parentId,
        specs,
        position === "after_block"
          ? { type: "after_block", after_block_id: normalizeId(after_block_id as string) }
          : { type: position }
      );
      const journalId = await record(
        "notion_insert_blocks",
        `Inserted ${createdIds.length} blocks into ${parentId}`,
        createdIds.map((id) => ({ kind: "block_trash", block_id: id, in_trash: true }) as UndoOp)
      );
      return ok({ inserted: createdIds.length, block_ids: createdIds, undo_id: journalId });
    })
  );

  server.registerTool(
    "notion_replace_text",
    {
      title: "Find and Replace Text",
      description:
        "Find and replace text across a page's blocks while keeping bold/italic/links/colors and mentions intact. Supports regex with " +
        "$1-style groups. Defaults to dry_run=true, which shows every block that would change (before/after) so you can confirm. " +
        "Matches that cross a mention or equation are skipped and reported. All changed blocks revert together with notion_undo.",
      inputSchema: {
        page: z.string(),
        find: z.string().min(1),
        replace: z.string(),
        regex: z.boolean().default(false),
        case_sensitive: z.boolean().default(true),
        block_ids: z.array(z.string()).optional().describe("Limit to these blocks."),
        max_replacements: z.number().int().min(1).max(1000).default(200),
        dry_run: z.boolean().default(true),
      },
      annotations: { ...WRITE, idempotentHint: false },
    },
    safe(async ({ page, find, replace, regex, case_sensitive, block_ids, max_replacements, dry_run }) => {
      const pattern = buildPattern(find, regex, case_sensitive);
      const tree = await getTree(normalizeId(page), 6, 2000);
      const only = block_ids ? new Set(block_ids.map(normalizeId)) : null;
      const changes: { block: BlockObjectResponse; segments: ReturnType<typeof replaceInRichText>["segments"]; count: number; skipped: number }[] = [];
      let total = 0;
      for (const node of flatten(tree.nodes)) {
        if (total >= max_replacements) break;
        if (only && !only.has(node.id)) continue;
        const block = tree.raw.get(node.id);
        if (!block || !RICH_TEXT_TYPES.has(block.type)) continue;
        const r = replaceInRichText(currentSegments(block), pattern, replace, max_replacements - total);
        if (r.count > 0 || r.skipped > 0) {
          changes.push({ block, ...r });
          total += r.count;
        }
      }
      const preview = changes.map((c) => ({
        block_id: c.block.id,
        type: c.block.type,
        before: blockText(c.block),
        after: c.segments.map(segmentText).join(""),
        replacements: c.count,
        ...(c.skipped ? { skipped_matches: c.skipped } : {}),
      }));
      if (changes.length === 0) return ok(`No matches for ${regex ? "regex" : "text"} "${find}".${tree.truncated ? " (Page only partially scanned.)" : ""}`);
      if (dry_run) return ok({ dry_run: true, total_replacements: total, blocks: preview, next_step: "Confirm, then call again with dry_run=false." });

      const undo: UndoOp[] = [];
      const failed: string[] = [];
      for (const c of changes.filter((x) => x.count > 0)) {
        try {
          const restore = restorePayload(c.block);
          const content: Record<string, unknown> = { rich_text: forApi(c.segments) };
          await call(() => notion().blocks.update({ block_id: c.block.id, [c.block.type]: content } as never));
          if (restore) undo.push({ kind: "block_update", block_id: c.block.id, payload: restore });
        } catch (e) {
          failed.push(`${c.block.id}: ${(e as Error).message}`);
        }
      }
      const journalId = await record("notion_replace_text", `Replaced "${find}" in ${undo.length} blocks`, undo);
      return ok({ total_replacements: total, blocks_changed: undo.length, failed, undo_id: journalId });
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

