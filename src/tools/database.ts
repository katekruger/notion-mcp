import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { isFullPage } from "@notionhq/client";
import type { DataSourceObjectResponse } from "@notionhq/client";
import { call, mapLimited, notion, read } from "../services/notion.js";
import { buildWhereFilter, dataSourceTitle, invalidateSchema, resolveDataSource, resolvePropertyName } from "../services/schema.js";
import { preparePayload } from "../services/writes.js";
import { aggregate, DATE_BUCKETS, EMPTY_KEY, METRIC_OPS, metricName, type Metric } from "../services/aggregate.js";
import { queryAll } from "../services/query.js";
import { parseCsv } from "../services/csv.js";
import { checkUploadPath } from "../services/files.js";
import { plain } from "../services/richtext.js";
import { record, type UndoOp } from "../services/journal.js";
import { ok, READ, safe, WRITE } from "./util.js";

/** Rows scanned by one aggregation unless raised. */
const DEFAULT_MAX_ROWS = 10_000;
/** Most rows one bulk create writes. */
export const MAX_BULK_CREATE = 1000;

function parseMetric(ds: DataSourceObjectResponse, m: string | Metric): Metric {
  const raw = typeof m === "string" ? { op: m.split(":")[0].trim(), property: m.split(":").slice(1).join(":").trim() || undefined } : m;
  const op = raw.op === "average" || raw.op === "mean" ? "avg" : raw.op;
  if (!(METRIC_OPS as readonly string[]).includes(op)) throw new Error(`Unknown metric "${raw.op}". Use: ${METRIC_OPS.join(", ")} (e.g. "sum:Points").`);
  if (op === "count") return { op: "count" };
  if (!raw.property) throw new Error(`Metric "${op}" needs a property, e.g. "${op}:Points".`);
  return { op: op as Metric["op"], property: resolvePropertyName(ds, raw.property).name };
}

async function combinedFilter(ds: DataSourceObjectResponse, where?: Record<string, unknown>, filter?: Record<string, unknown>) {
  const w = where ? await buildWhereFilter(ds, where) : undefined;
  return w && filter ? { and: [w, filter] } : (w ?? filter);
}

export function registerDatabaseTools(server: McpServer): void {
  server.registerTool(
    "notion_aggregate",
    {
      title: "Aggregate Rows",
      description:
        "Answer \"how many / how much by X\" without reading every row into context. Filters with `where`/`filter` (same as " +
        "notion_query), groups by any property (multi-select, people, and relations count a row in each of its groups; dates can " +
        "be bucketed by day/week/month/quarter/year), and computes metrics: count, count_values, count_empty, distinct, sum, " +
        "avg, min, max, median, checked, percent_checked (e.g. [\"count\", \"sum:Points\"]). Returns totals and the top groups.",
      inputSchema: {
        database: z.string(),
        data_source_name: z.string().optional(),
        where: z.record(z.string(), z.unknown()).optional(),
        filter: z.record(z.string(), z.unknown()).optional(),
        group_by: z.union([z.string(), z.object({ property: z.string(), by: z.enum(DATE_BUCKETS).optional() })]).optional(),
        metrics: z
          .array(z.union([z.string(), z.object({ op: z.enum(METRIC_OPS), property: z.string().optional() })]))
          .default(["count"])
          .describe('e.g. ["count", "sum:Points", "avg:Estimate"]'),
        sort: z.enum(["value_desc", "value_asc", "key_asc", "key_desc"]).optional(),
        top: z.number().int().min(1).max(500).default(50),
        max_rows: z.number().int().min(1).max(50_000).default(DEFAULT_MAX_ROWS),
      },
      annotations: READ,
    },
    safe(async ({ database, data_source_name, where, filter, group_by, metrics, sort, top, max_rows }) => {
      const ds = await resolveDataSource(database, data_source_name);
      const parsed = metrics.map((m) => parseMetric(ds, m));
      const group = group_by === undefined ? undefined : typeof group_by === "string" ? { property: group_by } : group_by;
      const groupProp = group ? resolvePropertyName(ds, group.property).name : undefined;
      if (group?.by && groupProp && !["date", "created_time", "last_edited_time", "formula"].includes(ds.properties[groupProp].type)) {
        throw new Error(`"${groupProp}" isn't a date, so it can't be bucketed by ${group.by}.`);
      }
      const { pages, more } = await queryAll(ds.id, { filter: await combinedFilter(ds, where, filter), max: max_rows });
      const result = aggregate(pages, {
        metrics: parsed,
        ...(groupProp ? { group_by: { property: groupProp, ...(group?.by ? { by: group.by } : {}) } } : {}),
        ...(sort ? { sort } : {}),
        top,
      });
      const notes: string[] = [];
      if (more) notes.push(`Only the first ${max_rows} matching rows were counted; raise max_rows or narrow the filter.`);
      // Relation groups are page ids; show the related rows' titles instead.
      if (groupProp && ds.properties[groupProp].type === "relation") {
        for (const g of result.groups) {
          if (g.key === EMPTY_KEY) continue;
          try {
            const p = await read(() => notion().pages.retrieve({ page_id: g.key }));
            if (isFullPage(p)) {
              const t = Object.values(p.properties).find((x) => x.type === "title");
              g.id = g.key;
              g.key = t && t.type === "title" ? plain(t.title) || "(untitled)" : g.key;
            }
          } catch {
            // Keep the id if the related page isn't readable.
          }
        }
      }
      const truncatedRefs = groupProp && ["relation", "people"].includes(ds.properties[groupProp].type)
        && pages.some((p) => ((p.properties[groupProp] as unknown as Record<string, unknown[]>)[ds.properties[groupProp].type] ?? []).length >= 25);
      if (truncatedRefs) notes.push(`Some rows have 25+ values in "${groupProp}"; Notion's query results include only the first 25 of those.`);
      return ok({
        database: dataSourceTitle(ds),
        rows: pages.length,
        totals: result.totals,
        ...(groupProp ? { group_by: groupProp + (group?.by ? ` (${group.by})` : ""), group_count: result.group_count, groups: result.groups } : {}),
        ...(result.group_count > top ? { note_groups: `Showing the top ${top} of ${result.group_count} groups by ${metricName(parsed[0])}.` } : {}),
        ...(notes.length ? { notes } : {}),
      });
    })
  );

  server.registerTool(
    "notion_bulk_create",
    {
      title: "Bulk Create Rows",
      description:
        `Create up to ${MAX_BULK_CREATE} database rows from JSON objects (\`rows\`) or CSV (\`csv\` text or \`csv_path\`). Column/key names ` +
        "match properties forgivingly; values follow notion_update_properties rules (relations accept related rows' titles). " +
        "Empty CSV cells are left unset. Every row is validated before anything is written, and all problems are reported by " +
        "row. Defaults to dry_run=true. Rows that fail while writing are reported; the rest stay. One notion_undo trashes every " +
        "created row.",
      inputSchema: {
        database: z.string(),
        data_source_name: z.string().optional(),
        rows: z.array(z.record(z.string(), z.unknown())).max(MAX_BULK_CREATE).optional(),
        csv: z.string().optional(),
        csv_path: z.string().optional().describe("Local CSV file (from the working directory or temp folder)."),
        allow_new_options: z.boolean().default(false),
        dry_run: z.boolean().default(true),
      },
      annotations: { ...WRITE, idempotentHint: false },
    },
    safe(async ({ database, data_source_name, rows, csv, csv_path, allow_new_options, dry_run }) => {
      const sources = [rows, csv, csv_path].filter((x) => x !== undefined).length;
      if (sources !== 1) throw new Error("Give exactly one of `rows`, `csv`, or `csv_path`.");
      const ds = await resolveDataSource(database, data_source_name);
      let input: Record<string, unknown>[];
      if (rows) input = rows;
      else {
        const text = csv ?? (await fs.readFile(await checkUploadPath(csv_path as string), "utf8"));
        // Empty cells mean "leave unset", not "clear".
        input = parseCsv(text).map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== "")));
      }
      if (input.length === 0) throw new Error("No rows to create.");
      if (input.length > MAX_BULK_CREATE) throw new Error(`${input.length} rows is over the ${MAX_BULK_CREATE}-row limit per call; split the input.`);

      const prepared: { index: number; payload: Record<string, unknown> }[] = [];
      const errors: { row: number; error: string }[] = [];
      const notes = new Set<string>();
      for (let i = 0; i < input.length; i++) {
        try {
          const r = await preparePayload(ds, input[i], allow_new_options);
          r.notes.forEach((n) => notes.add(n));
          prepared.push({ index: i, payload: r.payload });
        } catch (e) {
          errors.push({ row: i + 1, error: (e as Error).message.replace(/^Nothing was written\. Fix these first:\n- /, "").replace(/\n- /g, "; ") });
        }
      }
      if (errors.length) {
        return ok({
          valid: prepared.length,
          invalid: errors.length,
          errors: errors.slice(0, 50),
          ...(errors.length > 50 ? { more_errors: errors.length - 50 } : {}),
          note: "Nothing was written. Fix these rows and try again.",
        });
      }
      const noteList = [...notes].slice(0, 20);
      if (dry_run) {
        return ok({
          dry_run: true,
          database: dataSourceTitle(ds),
          rows: prepared.length,
          columns: [...new Set(prepared.flatMap((p) => Object.keys(p.payload)))],
          ...(noteList.length ? { notes: noteList } : {}),
          next_step: "Confirm with the user, then call again with dry_run=false.",
        });
      }

      const undo: UndoOp[] = [];
      const failed: { row: number; error: string }[] = [];
      await mapLimited(prepared, async (p) => {
        try {
          const created = await call(() => notion().pages.create({ parent: { type: "data_source_id", data_source_id: ds.id }, properties: p.payload } as never));
          undo.push({ kind: "page_trash", page_id: created.id, in_trash: true });
        } catch (e) {
          failed.push({ row: p.index + 1, error: (e as Error).message });
        }
      });
      failed.sort((a, b) => a.row - b.row);
      if ([...notes].some((n) => n.startsWith("creates new option"))) invalidateSchema(ds.id);
      const journalId = undo.length ? await record("notion_bulk_create", `Created ${undo.length} rows in "${dataSourceTitle(ds)}"`, undo) : undefined;
      return ok({
        created: undo.length,
        ...(failed.length ? { failed, note: "The other rows were created; retry just the failed rows." } : {}),
        ...(noteList.length ? { notes: noteList } : {}),
        ...(journalId ? { undo_id: journalId } : {}),
      });
    })
  );
}
