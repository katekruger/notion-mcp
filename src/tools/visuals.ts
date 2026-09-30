import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { call, normalizeId, notion, read } from "../services/notion.js";
import { dataSourceTitle, resolveDataSource } from "../services/schema.js";
import type { ChartRow } from "../services/charts.js";
import { pointsFromDatabase } from "../services/chartdata.js";
import { saveChart } from "../services/chartstore.js";
import { describeView, viewRequest, viewRestorePayload, viewSpecSchema } from "../services/views.js";
import { textToTitle } from "../services/richtext.js";
import { insertedBlocks, record } from "../services/journal.js";
import {
  buildReport,
  captionFor,
  chartSourceSchema,
  chartSpecSchema,
  createView,
  databaseIdOf,
  refreshChart,
  renderAndUpload,
  ReportError,
  reportArgsShape,
  rowSchema,
  type Placement,
} from "../services/visualops.js";
import { ok, safe, WRITE } from "./util.js";

export function registerVisualTools(server: McpServer): void {
  server.registerTool(
    "notion_views",
    {
      title: "Database Views",
      description:
        "List, read, create, update, or delete database views. Types: table, board, list, calendar, timeline, gallery, form, map, " +
        "and chart (Notion's native, live charts: column, bar, line, donut, number, with stacking). A view can be a tab on the " +
        "database (default), a linked view placed on any page (`on: {page, after_block}`), or a widget on a dashboard view " +
        "(`on: {dashboard}`). Views take `where`/`filter` like notion_query, `sorts`, `group_by` (e.g. board by Status, dates by " +
        "week), visible `properties`, and a `chart` spec like {type: \"column\", x: \"Owner\", y: \"count\"} or y: \"sum:Estimate\". " +
        "Every change is reversible with notion_undo.",
      inputSchema: {
        action: z.enum(["list", "get", "create", "update", "delete"]),
        database: z.string().optional().describe("list, create"),
        data_source_name: z.string().optional(),
        view_id: z.string().optional().describe("get, update, delete (a view id or a view URL with ?v=)"),
        view: viewSpecSchema.optional().describe("create: the full view; update: name, type, and only what should change"),
        on: z
          .union([
            z.object({ page: z.string(), after_block: z.string().optional() }).strict(),
            z.object({ dashboard: z.string(), row: z.number().int().min(0).optional() }).strict(),
          ])
          .optional()
          .describe("create: place a linked view on a page, or a widget on a dashboard view. Omit for a database tab."),
      },
      annotations: { ...WRITE, idempotentHint: false },
    },
    safe(async ({ action, database, data_source_name, view_id, view, on }) => {
      const n = notion();
      const viewIdOf = (v: string) => {
        const m = v.match(/[?&]v=([0-9a-f-]{32,36})/i);
        return normalizeId(m ? m[1] : v);
      };
      if (action === "list") {
        if (!database) throw new Error("action=list needs `database`.");
        const ds = await resolveDataSource(database, data_source_name);
        const dbId = await databaseIdOf(ds);
        const refs = await read(() => n.views.list({ database_id: dbId, page_size: 100 } as never));
        const views = [];
        for (const r of refs.results.slice(0, 50)) {
          const v = (await read(() => n.views.retrieve({ view_id: r.id }))) as unknown as Record<string, unknown>;
          views.push({ id: v.id, name: v.name, type: v.type, url: v.url });
        }
        return ok({ database: dataSourceTitle(ds), count: refs.results.length, views });
      }
      if (action === "create") {
        if (!view) throw new Error("action=create needs `view`.");
        if (!database) throw new Error("action=create needs `database`.");
        const ds = await resolveDataSource(database, data_source_name);
        const placement: Placement = !on ? { type: "database" } : "page" in on ? { type: "page", page: on.page, ...(on.after_block ? { after_block: on.after_block } : {}) } : { type: "dashboard", view_id: viewIdOf(on.dashboard), ...(on.row !== undefined ? { row: on.row } : {}) };
        const { view: created, undo } = await createView(ds, await databaseIdOf(ds), view, placement);
        const where = placement.type === "page" ? "on the page" : placement.type === "dashboard" ? "on the dashboard" : `as a tab of "${dataSourceTitle(ds)}"`;
        const journalId = await record("notion_views", `Created ${view.type} view "${view.name}" ${where}`, [undo]);
        return ok({ view_id: created.id, url: created.url, type: created.type, placement: where, undo_id: journalId });
      }
      if (!view_id) throw new Error(`action=${action} needs \`view_id\`.`);
      const id = viewIdOf(view_id);
      const current = (await read(() => n.views.retrieve({ view_id: id }))) as unknown as Record<string, unknown>;
      const dsId = current.data_source_id as string | undefined;
      const ds = dsId ? await resolveDataSource(dsId) : null;
      if (action === "get") return ok(describeView(ds, current));
      if (action === "delete") {
        // Create (unlike update) rejects null filter/sorts, so leave empty ones out.
        const restore = Object.fromEntries(
          Object.entries({ data_source_id: dsId, database_id: (current.parent as { database_id?: string }).database_id, type: current.type, ...viewRestorePayload(current) }).filter(([, v]) => v !== null && v !== undefined)
        );
        await call(() => n.views.delete({ view_id: id }));
        const journalId = await record("notion_views", `Deleted view "${String(current.name)}"`, [{ kind: "view_create", request: restore }]);
        return ok({ deleted: id, name: current.name, undo_id: journalId, note: "Undo re-creates the view with the same settings (it gets a new id)." });
      }
      // update
      if (!view) throw new Error("action=update needs `view` (name, type, and the settings to change).");
      if (!ds) throw new Error("This view has no data source to resolve properties against.");
      if (view.type !== current.type) throw new Error(`A view's type can't change (this is a ${String(current.type)} view). Create a new view instead.`);
      const body = await viewRequest(ds, view);
      await call(() => n.views.update({ view_id: id, ...body } as never));
      const journalId = await record("notion_views", `Updated view "${String(current.name)}"`, [{ kind: "view_update", view_id: id, payload: viewRestorePayload(current) }]);
      return ok({ view_id: id, updated: Object.keys(body).filter((k) => k !== "type"), undo_id: journalId });
    })
  );

  server.registerTool(
    "notion_create_chart",
    {
      title: "Create or Refresh Chart Image",
      description:
        "Render a chart as a PNG and put it on a page, or refresh an existing chart image in place. Types: bar, column, " +
        "stacked_bar, stacked_column, grouped_column, line, area, stacked_area, pie, donut, scatter. Data is inline `data` " +
        "([{x, y, series?}]) or a `source` query that groups a database (x, y like \"count\" or \"sum:Estimate\", optional series). " +
        "Uses one validated, colorblind-safe palette. The chart's recipe is remembered, so `refresh_block_id` re-renders it from " +
        "current data. Prefer notion_views chart views when a live, clickable Notion chart is enough; use this for chart types " +
        "Notion lacks, data from outside Notion, or a fixed snapshot. Reversible with notion_undo.",
      inputSchema: {
        chart: chartSpecSchema.optional().describe("Required for a new chart; optional on refresh (keeps the stored one)."),
        data: z.array(rowSchema).max(5000).optional(),
        source: chartSourceSchema.optional(),
        parent: z.string().optional().describe("New chart: page or block to insert into."),
        position: z.enum(["end", "start", "after_block"]).default("end"),
        after_block_id: z.string().optional(),
        refresh_block_id: z.string().optional().describe("An image block made by this tool: re-render it in place."),
        caption: z.string().optional(),
      },
      annotations: { ...WRITE, idempotentHint: false },
    },
    safe(async ({ chart, data, source, parent, position, after_block_id, refresh_block_id, caption }) => {
      if (data && source) throw new Error("Give `data` or `source`, not both.");
      if (refresh_block_id) {
        const r = await refreshChart({ block_id: refresh_block_id, ...(chart ? { chart } : {}), ...(data ? { data } : {}), ...(source ? { source } : {}), ...(caption ? { caption } : {}) });
        const { undo, ...rest } = r;
        const journalId = await record("notion_create_chart", `Refreshed chart ${r.refreshed}`, undo, undo.length ? undefined : "the previous image couldn't be downloaded");
        return ok({ ...rest, undo_id: journalId });
      }
      if (!chart) throw new Error("A new chart needs `chart` ({type, title, …}).");
      if (!parent) throw new Error("A new chart needs `parent` (the page or block to put it in).");
      if (!data && !source) throw new Error("Give `data` ([{x, y, series?}]) or `source` (a database query).");
      if (position === "after_block" && !after_block_id) throw new Error("position=after_block needs after_block_id.");
      const got = source ? await pointsFromDatabase(source) : null;
      const points = got?.points ?? (data as ChartRow[]);
      const { uploadId, notes } = await renderAndUpload(chart, points);
      const parentId = normalizeId(parent);
      const res = await call(() =>
        notion().blocks.children.append({
          block_id: parentId,
          children: [{ type: "image", image: { type: "file_upload", file_upload: { id: uploadId }, caption: caption ? textToTitle(caption) : captionFor(chart, got?.label) } }],
          position: position === "after_block" ? { type: "after_block", after_block: { id: normalizeId(after_block_id as string) } } : { type: position },
        } as never)
      );
      const blockId = res.results[0].id;
      const now = new Date().toISOString();
      await saveChart({ block_id: blockId, page_id: parentId, spec: chart, ...(source ? { source } : { data: points }), created: now, updated: now });
      const journalId = await record("notion_create_chart", `Added ${chart.type} chart "${chart.title ?? ""}" to ${parentId}`, insertedBlocks([blockId], parentId));
      return ok({
        block_id: blockId,
        points: points.length,
        ...(got ? { rows_scanned: got.rows, ...(got.more ? { warning: "More rows matched than max_rows; the chart uses the first ones." } : {}) } : {}),
        ...(notes.length ? { notes } : {}),
        refresh: `notion_create_chart with refresh_block_id "${blockId}" redraws it from current data.`,
        undo_id: journalId,
      });
    })
  );

  server.registerTool(
    "notion_build_report",
    {
      title: "Build Report Page",
      description:
        "Build a report page for a database in one call: a summary callout (row count, completion, overdue), KPI numbers side " +
        "by side, charts (live Notion chart views where Notion supports the type, rendered images otherwise), a table of key rows " +
        "(e.g. overdue items), and a Mermaid Gantt chart of dated work. Every section is optional; `where` scopes the whole report. " +
        "Image charts can be refreshed later with notion_create_chart. notion_undo trashes the page.",
      inputSchema: {
        ...reportArgsShape,
      },
      annotations: { ...WRITE, idempotentHint: false },
    },
    safe(async (a) => {
      try {
        const r = await buildReport(a);
        const { undo, ...rest } = r;
        const journalId = await record("notion_build_report", `Built report "${a.title ?? "report"}" (${r.page_id})`, undo);
        return ok({ ...rest, undo_id: journalId });
      } catch (e) {
        if (e instanceof ReportError) {
          const journalId = await record("notion_build_report", "Partial report", e.undo);
          throw new Error(`${e.message} notion_undo ${journalId} trashes it.`);
        }
        throw e;
      }
    })
  );
}
