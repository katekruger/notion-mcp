import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isFullPage } from "@notionhq/client";
import type { PageObjectResponse } from "@notionhq/client";
import { read, normalizeId, notion } from "../services/notion.js";
import { flatten, getTree, renderTree } from "../services/blocks.js";
import { buildPattern, plain } from "../services/richtext.js";
import {
  buildWhereFilter,
  dataSourceTitle,
  describeSchema,
  pageDataSourceId,
  resolveDataSource,
  resolvePropertyName,
  simplifyAll,
} from "../services/schema.js";
import { ok, READ, safe } from "./util.js";

function pageTitle(page: PageObjectResponse): string {
  const t = Object.values(page.properties).find((p) => p.type === "title");
  return t && t.type === "title" ? plain(t.title) || "(untitled)" : "(untitled)";
}

export function registerReadTools(server: McpServer): void {
  server.registerTool(
    "notion_search",
    {
      title: "Search Notion",
      description:
        "Search pages and databases shared with the integration by title. Returns id, type, title, url, and last edited time. " +
        "Use this to find ids before reading or editing. Only content shared with the integration is searchable.",
      inputSchema: {
        query: z.string().describe("Text to match in titles. Empty string lists recent items."),
        type: z.enum(["page", "data_source"]).optional().describe("Restrict to pages or databases (data sources)."),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: READ,
    },
    safe(async ({ query, type, limit }) => {
      const res = await read(() =>
        notion().search({
          query,
          page_size: limit,
          ...(type ? { filter: { property: "object", value: type } } : {}),
          sort: { direction: "descending", timestamp: "last_edited_time" },
        } as never)
      );
      const results = res.results.map((r) => {
        const o = r as unknown as Record<string, unknown> & { object: string; id: string; url?: string; last_edited_time?: string };
        const title =
          o.object === "page" && isFullPage(r as PageObjectResponse)
            ? pageTitle(r as PageObjectResponse)
            : plain((o.title as Parameters<typeof plain>[0]) ?? []) || "(untitled)";
        return { id: o.id, type: o.object === "data_source" ? "database" : o.object, title, url: o.url, last_edited: o.last_edited_time };
      });
      if (results.length === 0) return ok(`No results for "${query}". Make sure the page is shared with the integration (••• → Connections).`);
      return ok({ count: results.length, results });
    })
  );

  server.registerTool(
    "notion_get_page",
    {
      title: "Get Page",
      description:
        "Read a page: its properties as simple values, the database it belongs to (if any), and its content as an outline where " +
        "every block shows its id in ⟨…⟩. Use those block ids with notion_patch_block, notion_insert_blocks, or notion_delete_blocks. " +
        "last_edited_time can be passed to write tools as expected_last_edited_time to avoid overwriting someone else's edit.",
      inputSchema: {
        page: z.string().describe("Page URL or id."),
        include_content: z.boolean().default(true),
        max_depth: z.number().int().min(0).max(6).default(3).describe("How deep to read nested blocks."),
        max_blocks: z.number().int().min(1).max(1000).default(300),
      },
      annotations: READ,
    },
    safe(async ({ page, include_content, max_depth, max_blocks }) => {
      const id = normalizeId(page);
      const p = await read(() => notion().pages.retrieve({ page_id: id }));
      if (!isFullPage(p)) throw new Error("Could not read that page.");
      const header = {
        id: p.id,
        title: pageTitle(p),
        url: p.url,
        last_edited_time: p.last_edited_time,
        data_source_id: pageDataSourceId(p),
        in_trash: p.in_trash,
        properties: simplifyAll(p),
      };
      if (!include_content) return ok(header);
      const tree = await getTree(id, max_depth, max_blocks);
      const outline = renderTree(tree.nodes) || "(no content)";
      return ok(
        `${JSON.stringify(header, null, 2)}\n\nCONTENT${tree.truncated ? " (partial: raise max_depth/max_blocks or read a sub-block with notion_get_blocks)" : ""}:\n${outline}`
      );
    })
  );

  server.registerTool(
    "notion_get_blocks",
    {
      title: "Get Block Tree",
      description: "Read the children of a page or block as an outline with block ids. Use for large pages to read one section at a time.",
      inputSchema: {
        block: z.string().describe("Page or block URL/id."),
        max_depth: z.number().int().min(0).max(6).default(2),
        max_blocks: z.number().int().min(1).max(1000).default(300),
      },
      annotations: READ,
    },
    safe(async ({ block, max_depth, max_blocks }) => {
      const tree = await getTree(normalizeId(block), max_depth, max_blocks);
      return ok((renderTree(tree.nodes) || "(no children)") + (tree.truncated ? "\n\n(partial result)" : ""));
    })
  );

  server.registerTool(
    "notion_find_blocks",
    {
      title: "Find Blocks",
      description:
        "Find blocks on a page whose text matches a string or regex. Returns block id, type, text, and last_edited_time. " +
        "Use this to locate exactly which block to edit instead of rewriting the page.",
      inputSchema: {
        page: z.string().describe("Page URL or id."),
        query: z.string().min(1),
        regex: z.boolean().default(false),
        case_sensitive: z.boolean().default(false),
        max_depth: z.number().int().min(0).max(6).default(4),
        max_results: z.number().int().min(1).max(200).default(50),
      },
      annotations: READ,
    },
    safe(async ({ page, query, regex, case_sensitive, max_depth, max_results }) => {
      const pattern = buildPattern(query, regex, case_sensitive);
      const tree = await getTree(normalizeId(page), max_depth, 1000);
      const hits = flatten(tree.nodes)
        .filter((n) => new RegExp(pattern.source, pattern.flags.replace("g", "")).test(n.text))
        .slice(0, max_results)
        .map((n) => ({ id: n.id, type: n.type, text: n.text, depth: n.depth, last_edited_time: n.last_edited_time }));
      return ok({ count: hits.length, matches: hits, ...(tree.truncated ? { note: "Page was only partially scanned." } : {}) });
    })
  );

  server.registerTool(
    "notion_get_schema",
    {
      title: "Get Database Schema",
      description:
        "Read a database's properties: names, types, select/status options (with status groups), relation targets, and which are read-only. " +
        "Read this before writing properties so values match exactly.",
      inputSchema: {
        database: z.string().describe("Database URL/id or data source id."),
        data_source_name: z.string().optional().describe("Only needed if the database has several data sources."),
      },
      annotations: READ,
    },
    safe(async ({ database, data_source_name }) => {
      const ds = await resolveDataSource(database, data_source_name);
      return ok({ data_source_id: ds.id, title: dataSourceTitle(ds), url: ds.url, properties: describeSchema(ds) });
    })
  );

  server.registerTool(
    "notion_query",
    {
      title: "Query Database",
      description:
        "Query database rows. Use `where` for simple equality ({\"Status\": \"Done\", \"Owner\": \"kate@x.com\"}); property names and " +
        "option values are matched forgivingly and validated. Use `filter` for anything more complex (raw Notion filter JSON, " +
        "e.g. {\"property\":\"Due\",\"date\":{\"before\":\"2026-10-01\"}}). If both are given they are combined with AND. " +
        "Returns rows with simple property values and page ids.",
      inputSchema: {
        database: z.string().describe("Database URL/id or data source id."),
        data_source_name: z.string().optional(),
        where: z.record(z.string(), z.unknown()).optional(),
        filter: z.record(z.string(), z.unknown()).optional(),
        sorts: z
          .array(z.object({ property: z.string(), direction: z.enum(["ascending", "descending"]).default("ascending") }))
          .optional(),
        properties: z.array(z.string()).optional().describe("Only return these properties (saves context)."),
        limit: z.number().int().min(1).max(500).default(50),
        cursor: z.string().optional().describe("next_cursor from a previous call."),
      },
      annotations: READ,
    },
    safe(async ({ database, data_source_name, where, filter, sorts, properties, limit, cursor }) => {
      const ds = await resolveDataSource(database, data_source_name);
      const whereFilter = where ? await buildWhereFilter(ds, where) : undefined;
      const combined =
        whereFilter && filter ? { and: [whereFilter, filter] } : (whereFilter ?? filter);
      const sortSpec = sorts?.map((s) => ({ property: resolvePropertyName(ds, s.property).name, direction: s.direction }));
      const keep = properties?.map((p) => resolvePropertyName(ds, p).name);

      const rows: Record<string, unknown>[] = [];
      let next: string | null = cursor ?? null;
      let first = true;
      while ((first || next) && rows.length < limit) {
        first = false;
        const res = await read(() =>
          notion().dataSources.query({
            data_source_id: ds.id,
            page_size: Math.min(100, limit - rows.length),
            ...(next ? { start_cursor: next } : {}),
            ...(combined ? { filter: combined } : {}),
            ...(sortSpec ? { sorts: sortSpec } : {}),
            result_type: "page",
          } as never)
        );
        for (const r of res.results) {
          if (!isFullPage(r as PageObjectResponse)) continue;
          const page = r as PageObjectResponse;
          let props = simplifyAll(page);
          if (keep) props = Object.fromEntries(Object.entries(props).filter(([k]) => keep.includes(k)));
          rows.push({ id: page.id, last_edited_time: page.last_edited_time, ...props });
        }
        next = res.has_more ? res.next_cursor : null;
      }
      return ok({
        database: dataSourceTitle(ds),
        data_source_id: ds.id,
        count: rows.length,
        has_more: Boolean(next),
        ...(next ? { next_cursor: next } : {}),
        rows,
      });
    })
  );
}
