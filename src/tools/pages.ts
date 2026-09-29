import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isFullPage } from "@notionhq/client";
import type { DataSourceObjectResponse, PageObjectResponse } from "@notionhq/client";
import { call, read, isNotFound, normalizeId, notion } from "../services/notion.js";
import { appendSpecs, markdownToSpecs, normalizeSpecs } from "../services/blocks.js";
import { fileRef, isUrl } from "../services/files.js";
import { blockSpecSchema } from "../services/specSchema.js";

export { blockSpecSchema };
import { textToTitle } from "../services/richtext.js";
import {
  buildWhereFilter,
  dataSourceTitle,
  invalidateSchema,
  pageDataSourceId,
  resolveDataSource,
  withFullProperties,
} from "../services/schema.js";
import { record, type UndoOp } from "../services/journal.js";
import { beforeAfter, getFullPage, preparePayload, snapshot } from "../services/writes.js";
import { DESTRUCTIVE, ok, safe, WRITE } from "./util.js";

/** Page icon from an emoji, image URL, or local image path. */
export async function iconRef(source: string): Promise<Record<string, unknown>> {
  return isUrl(source) || /[\\/.]/.test(source) ? fileRef(source) : { type: "emoji", emoji: source };
}

/** "default", a template name, or a template id → the pages.create `template` value. */
export async function resolveTemplate(dataSourceId: string, input: string): Promise<Record<string, unknown>> {
  if (input.toLowerCase() === "default") return { type: "default" };
  const res = await read(() => notion().dataSources.listTemplates({ data_source_id: dataSourceId }));
  const byId = /^[0-9a-f-]{32,36}$/i.test(input) ? res.templates.find((t) => t.id.replace(/-/g, "") === input.replace(/-/g, "")) : undefined;
  const byName = res.templates.filter((t) => t.name.toLowerCase() === input.toLowerCase());
  const match = byId ?? (byName.length === 1 ? byName[0] : undefined);
  if (!match) {
    throw new Error(
      `No template "${input}". Templates: ${res.templates.map((t) => `"${t.name}"${t.is_default ? " (default)" : ""}`).join(", ") || "(none)"}.`
    );
  }
  return { type: "template_id", template_id: match.id };
}

export function checkFresh(actual: string, expected: string | undefined, what: string): void {
  if (expected && new Date(actual).getTime() > new Date(expected).getTime()) {
    throw new Error(
      `${what} was edited at ${actual}, after the version you read (${expected}). Re-read it and try again so you don't overwrite that change.`
    );
  }
}

export function registerPageTools(server: McpServer): void {
  server.registerTool(
    "notion_update_properties",
    {
      title: "Update Page Properties",
      description:
        "Set properties on a database row using simple values: strings, numbers, booleans, arrays for multi-select/people/relations, " +
        "ISO dates or {start,end}, null to clear. Property names and option values are matched forgivingly and validated against " +
        "the schema before anything is written; all problems are reported together. Saves a snapshot so notion_undo can revert. " +
        "Set dry_run to preview the before/after.",
      inputSchema: {
        page: z.string().describe("Page URL or id (must be a database row)."),
        properties: z.record(z.string(), z.unknown()).describe('e.g. {"Status": "In progress", "Tags": ["Q4", "Launch"], "Due": "2026-10-15"}'),
        allow_new_options: z.boolean().default(false).describe("Allow creating new select/multi-select options."),
        expected_last_edited_time: z.string().optional().describe("From a prior read; refuses to write if the page changed since."),
        dry_run: z.boolean().default(false),
      },
      annotations: WRITE,
    },
    safe(async ({ page, properties, allow_new_options, expected_last_edited_time, dry_run }) => {
      const p0 = await getFullPage(normalizeId(page));
      checkFresh(p0.last_edited_time, expected_last_edited_time, "This page");
      const dsId = pageDataSourceId(p0);
      if (!dsId) throw new Error("This page isn't in a database, so it only has a title. Use notion_patch_block / notion_insert_blocks for content.");
      const ds = await resolveDataSource(dsId);
      const { payload, notes } = await preparePayload(ds, properties, allow_new_options);
      const names = Object.keys(payload);
      const p = await withFullProperties(p0, names);
      const before = beforeAfter(p, names);
      if (dry_run) return ok({ dry_run: true, page_id: p.id, before, will_set: payload, notes });

      const undoOp = snapshot(p, names);
      const updated = await call(() => notion().pages.update({ page_id: p.id, properties: payload } as never));
      if (notes.some((n) => n.startsWith("creates new option"))) invalidateSchema(ds.id);
      const after = isFullPage(updated) ? beforeAfter(await withFullProperties(updated, names), names) : undefined;
      const journalId = await record("notion_update_properties", `Updated ${names.join(", ")} on ${p.id}`, [undoOp]);
      return ok({ page_id: p.id, before, after, notes, undo_id: journalId });
    })
  );

  server.registerTool(
    "notion_create_page",
    {
      title: "Create Page",
      description:
        "Create a page. If `parent` is a database, `properties` are validated against its schema (same rules as notion_update_properties) " +
        "and `title` fills the title property; `template` applies one of the database's templates (see notion_list_templates). " +
        "If `parent` is a page, a sub-page is created. Content can be `markdown` or structured `blocks` (same formats as " +
        "notion_insert_blocks). `icon` is an emoji, image URL, or local image path; `cover` is an image URL or local path.",
      inputSchema: {
        parent: z.string().describe("Parent database or page URL/id."),
        data_source_name: z.string().optional(),
        title: z.string().optional(),
        properties: z.record(z.string(), z.unknown()).optional(),
        allow_new_options: z.boolean().default(false),
        markdown: z.string().optional(),
        blocks: z.array(blockSpecSchema).optional(),
        icon: z.string().optional().describe("Emoji, image URL, or local image path."),
        icon_emoji: z.string().optional().describe("Older name for icon."),
        cover: z.string().optional().describe("Image URL or local image path."),
        template: z.string().optional().describe('Database parents: "default", or a template name or id from notion_list_templates.'),
      },
      annotations: { ...WRITE, idempotentHint: false },
    },
    safe(async ({ parent, data_source_name, title, properties, allow_new_options, markdown, blocks, icon, icon_emoji, cover, template }) => {
      const specs = normalizeSpecs([...(markdown ? markdownToSpecs(markdown) : []), ...(blocks ?? [])]);
      let ds: DataSourceObjectResponse | null = null;
      try {
        ds = await resolveDataSource(parent, data_source_name);
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }

      let body: Record<string, unknown>;
      let notes: string[] = [];
      if (ds) {
        const values = { ...(properties ?? {}) };
        const titleProp = Object.values(ds.properties).find((p) => p.type === "title");
        if (title && titleProp) values[titleProp.name] = title;
        const prepared = await preparePayload(ds, values, allow_new_options);
        notes = prepared.notes;
        body = { parent: { type: "data_source_id", data_source_id: ds.id }, properties: prepared.payload };
      } else {
        if (properties && Object.keys(properties).length) {
          throw new Error("The parent is a page, not a database, so only `title` can be set. Omit `properties`.");
        }
        body = { parent: { type: "page_id", page_id: normalizeId(parent) }, properties: { title: { title: textToTitle(title ?? "Untitled") } } };
      }
      if (template) {
        if (!ds) throw new Error("Templates belong to databases; `parent` is a page.");
        if (specs.length) throw new Error("A template fills the page's content, so it can't be combined with markdown or blocks. Create it, then add content with notion_insert_blocks.");
        body.template = await resolveTemplate(ds.id, template);
      }
      const iconSource = icon ?? icon_emoji;
      if (iconSource) body.icon = await iconRef(iconSource);
      if (cover) body.cover = await fileRef(cover);

      // Content is appended after creation so deep nesting and >100 blocks go through one code path.
      const created = await call(() => notion().pages.create(body as never));
      const journalId = await record("notion_create_page", `Created page ${created.id}`, [
        { kind: "page_trash", page_id: created.id, in_trash: true },
      ]);
      if (specs.length) {
        try {
          await appendSpecs(created.id, specs);
        } catch (e) {
          throw new Error(`Page ${created.id} was created but its content failed: ${(e as Error).message} (undo_id ${journalId} trashes it).`);
        }
      }
      return ok({
        page_id: created.id,
        url: "url" in created ? created.url : undefined,
        parent: ds ? `database "${dataSourceTitle(ds)}"` : "page",
        blocks_added: specs.length,
        ...(template ? { template_note: "Notion applies templates in the background; content may take a few seconds to appear." } : {}),
        notes,
        undo_id: journalId,
      });
    })
  );

  server.registerTool(
    "notion_bulk_update",
    {
      title: "Bulk Update Rows",
      description:
        "Set the same property values on every row matching `where` and/or a raw `filter`. Defaults to dry_run=true, which returns the " +
        "matching rows and their current values so you can confirm with the user first. Run again with dry_run=false to apply. " +
        "Values are validated once against the schema; every changed row is snapshotted, and the whole batch can be reverted with one notion_undo.",
      inputSchema: {
        database: z.string(),
        data_source_name: z.string().optional(),
        where: z.record(z.string(), z.unknown()).optional(),
        filter: z.record(z.string(), z.unknown()).optional(),
        set: z.record(z.string(), z.unknown()).describe("Property values to set on every matching row."),
        allow_new_options: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(100).describe("Safety cap on rows touched."),
        dry_run: z.boolean().default(true),
      },
      annotations: { ...WRITE, destructiveHint: true },
    },
    safe(async ({ database, data_source_name, where, filter, set, allow_new_options, limit, dry_run }) => {
      if (!where && !filter) throw new Error("Give `where` or `filter`. Bulk updates on every row need an explicit filter like {\"property\":\"Name\",\"title\":{\"is_not_empty\":true}}.");
      const ds = await resolveDataSource(database, data_source_name);
      const { payload, notes } = await preparePayload(ds, set, allow_new_options);
      const names = Object.keys(payload);
      const whereFilter = where ? await buildWhereFilter(ds, where) : undefined;
      const combined = whereFilter && filter ? { and: [whereFilter, filter] } : (whereFilter ?? filter);

      const pages: PageObjectResponse[] = [];
      let cursor: string | null = null;
      let more = false;
      do {
        const res = await read(() =>
          notion().dataSources.query({
            data_source_id: ds.id,
            filter: combined,
            page_size: 100,
            result_type: "page",
            ...(cursor ? { start_cursor: cursor } : {}),
          } as never)
        );
        for (const r of res.results) if (isFullPage(r as PageObjectResponse)) pages.push(r as PageObjectResponse);
        cursor = res.has_more ? res.next_cursor : null;
        more = Boolean(cursor);
      } while (cursor && pages.length < limit);
      const targets = pages.slice(0, limit);
      const overLimit = pages.length > limit || more;

      if (dry_run) {
        return ok({
          dry_run: true,
          matched: targets.length,
          ...(overLimit ? { warning: `More rows match than limit=${limit}. Raise limit or narrow the filter.` } : {}),
          will_set: payload,
          notes,
          rows: targets.slice(0, 50).map((p) => ({ id: p.id, current: beforeAfter(p, names) })),
          next_step: "Confirm with the user, then call again with dry_run=false.",
        });
      }

      const undoOps: UndoOp[] = [];
      const failed: { id: string; error: string }[] = [];
      for (const p of targets) {
        try {
          const op = snapshot(await withFullProperties(p, names), names);
          await call(() => notion().pages.update({ page_id: p.id, properties: payload } as never));
          undoOps.push(op);
        } catch (e) {
          failed.push({ id: p.id, error: (e as Error).message });
        }
      }
      if (notes.some((n) => n.startsWith("creates new option"))) invalidateSchema(ds.id);
      const journalId = await record(
        "notion_bulk_update",
        `Set ${names.join(", ")} on ${undoOps.length} rows in "${dataSourceTitle(ds)}"`,
        undoOps
      );
      return ok({ updated: undoOps.length, failed, notes, undo_id: journalId });
    })
  );

  server.registerTool(
    "notion_trash_page",
    {
      title: "Move Page to Trash",
      description: "Move a page or database row to the Notion trash. Reversible with notion_undo or from Notion's trash.",
      inputSchema: { page: z.string() },
      annotations: DESTRUCTIVE,
    },
    safe(async ({ page }) => {
      const id = normalizeId(page);
      await call(() => notion().pages.update({ page_id: id, in_trash: true } as never));
      const journalId = await record("notion_trash_page", `Trashed page ${id}`, [{ kind: "page_trash", page_id: id, in_trash: false }]);
      return ok({ trashed: id, undo_id: journalId });
    })
  );
}
