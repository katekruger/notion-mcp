// Database views: friendly definitions (property names, "sum:Estimate") → Notion's id-based view configuration.
import { z } from "zod";
import type { DataSourceObjectResponse } from "@notionhq/client";
import { buildWhereFilter, resolvePropertyName } from "./schema.js";

export const VIEW_TYPES = ["table", "board", "list", "calendar", "timeline", "gallery", "form", "chart", "map", "dashboard"] as const;
export const CHART_VIEW_TYPES = ["column", "bar", "line", "donut", "number"] as const;
export const VIEW_AGGREGATORS = [
  "count", "count_values", "sum", "average", "median", "min", "max", "range", "unique", "empty", "not_empty", "percent_empty",
  "percent_not_empty", "checked", "unchecked", "percent_checked", "percent_unchecked", "earliest_date", "latest_date", "date_range",
] as const;
const DATE_GROUPS = ["relative", "day", "week", "month", "year"] as const;

const groupSchema = z.union([
  z.string(),
  z.object({
    property: z.string(),
    by: z.enum(DATE_GROUPS).optional().describe("dates: relative, day, week, month, year"),
    status_by: z.enum(["option", "group"]).optional().describe("status: each option (default) or To-do/In progress/Complete"),
    hide_empty: z.boolean().optional(),
    sort: z.enum(["manual", "ascending", "descending"]).optional(),
  }),
]);
type GroupInput = z.infer<typeof groupSchema>;

export const viewSpecSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(VIEW_TYPES),
    where: z.record(z.string(), z.unknown()).optional().describe("Filter, same syntax as notion_query."),
    filter: z.record(z.string(), z.unknown()).optional().describe("Raw Notion filter."),
    sorts: z.array(z.object({ property: z.string(), direction: z.enum(["ascending", "descending"]).default("ascending") })).optional(),
    group_by: groupSchema.optional().describe("board (required), table, list, timeline: the property to group by."),
    sub_group_by: groupSchema.optional().describe("board only"),
    properties: z.array(z.string()).optional().describe("Properties to show, in order; the rest are hidden."),
    date: z.string().optional().describe("calendar, timeline: the date property."),
    end_date: z.string().optional().describe("timeline: a separate end-date property."),
    zoom: z.enum(["day", "week", "bi_week", "month", "quarter", "year"]).optional().describe("timeline"),
    map_by: z.string().optional().describe("map: the place property."),
    cover: z.string().optional().describe('gallery, board: "page_cover", "page_content", "none", or a files property'),
    card_size: z.enum(["small", "medium", "large"]).optional(),
    chart: z
      .object({
        type: z.enum(CHART_VIEW_TYPES),
        x: groupSchema.optional().describe("column/bar/line/donut: the property on the x axis (or donut slices)."),
        y: z.string().default("count").describe('What to measure: "count", or "sum:Estimate", "average:Points", …'),
        stack_by: groupSchema.optional().describe("column/bar/line: split each bar or line by this property."),
        color: z.enum(["auto", "colorful", "gray", "blue", "yellow", "green", "purple", "teal", "orange", "pink", "red"]).optional(),
        labels: z.boolean().optional().describe("Show data labels."),
        cumulative: z.boolean().optional(),
        height: z.enum(["small", "medium", "large", "extra_large"]).optional(),
        sort: z.enum(["manual", "x_ascending", "x_descending", "y_ascending", "y_descending"]).optional(),
        caption: z.string().optional(),
      })
      .optional()
      .describe("chart views"),
  })
  .strict();
export type ViewSpec = z.infer<typeof viewSpecSchema>;

function prop(ds: DataSourceObjectResponse, name: string): { id: string; name: string; type: string } {
  const r = resolvePropertyName(ds, name);
  const p = ds.properties[r.name];
  return { id: p.id, name: r.name, type: p.type };
}

/** A group-by configuration for any groupable property type. */
export function groupByConfig(ds: DataSourceObjectResponse, input: GroupInput): Record<string, unknown> {
  const g = typeof input === "string" ? { property: input } : input;
  const p = prop(ds, g.property);
  const common = { property_id: p.id, sort: { type: g.sort ?? (["date", "created_time", "last_edited_time", "number"].includes(p.type) ? "ascending" : "manual") }, ...(g.hide_empty !== undefined ? { hide_empty_groups: g.hide_empty } : {}) };
  if (g.by && !["date", "created_time", "last_edited_time"].includes(p.type)) throw new Error(`"${p.name}" isn't a date, so \`by\` doesn't apply.`);
  if (g.status_by && p.type !== "status") throw new Error(`"${p.name}" isn't a status, so \`status_by\` doesn't apply.`);
  switch (p.type) {
    case "select":
    case "multi_select":
    case "relation":
    case "checkbox":
    case "number":
      return { type: p.type, ...common };
    case "status":
      return { type: "status", group_by: g.status_by ?? "option", ...common };
    case "people":
      return { type: "person", ...common };
    case "created_by":
    case "last_edited_by":
      return { type: p.type, ...common };
    case "date":
    case "created_time":
    case "last_edited_time":
      return { type: p.type, group_by: g.by ?? "month", ...common };
    case "title":
    case "rich_text":
    case "url":
    case "email":
    case "phone_number":
      return { type: p.type === "rich_text" ? "text" : p.type, group_by: "exact", ...common };
    default:
      throw new Error(`Views can't group by "${p.name}" (${p.type}).`);
  }
}

/** "count" or "sum:Estimate" → a chart aggregation. */
export function aggregation(ds: DataSourceObjectResponse, input: string): Record<string, unknown> {
  const [rawOp, ...rest] = input.split(":");
  const op = rawOp.trim() === "avg" ? "average" : rawOp.trim();
  if (!(VIEW_AGGREGATORS as readonly string[]).includes(op)) throw new Error(`Unknown measure "${rawOp}". Use: ${VIEW_AGGREGATORS.join(", ")}.`);
  const name = rest.join(":").trim();
  if (op === "count") return { aggregator: "count" };
  if (!name) throw new Error(`"${op}" needs a property, e.g. "${op}:Estimate".`);
  return { aggregator: op, property_id: prop(ds, name).id };
}

const needs = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

/** Build the create/update body (type, name, filter, sorts, configuration) for a view. */
export async function viewRequest(ds: DataSourceObjectResponse, v: ViewSpec): Promise<Record<string, unknown>> {
  const t = v.type;
  const only = (field: keyof ViewSpec, types: string[]) => needs(v[field] === undefined || types.includes(t), `\`${field}\` only applies to ${types.join("/")} views.`);
  only("chart", ["chart"]);
  only("date", ["calendar", "timeline"]);
  only("end_date", ["timeline"]);
  only("zoom", ["timeline"]);
  only("map_by", ["map"]);
  only("sub_group_by", ["board"]);
  only("cover", ["gallery", "board"]);
  only("card_size", ["gallery", "board"]);
  only("group_by", ["table", "board", "list", "timeline", "gallery"]);
  const config: Record<string, unknown> = { type: t };
  if (v.properties) config.properties = v.properties.map((name) => ({ property_id: prop(ds, name).id, visible: true }));
  if (v.group_by) config.group_by = groupByConfig(ds, v.group_by);
  switch (t) {
    case "board":
      needs(Boolean(v.group_by), "A board needs `group_by` (usually a status or select property).");
      if (v.sub_group_by) config.sub_group_by = groupByConfig(ds, v.sub_group_by);
      break;
    case "calendar":
    case "timeline": {
      needs(Boolean(v.date), `A ${t} needs \`date\` (a date property).`);
      const d = prop(ds, v.date as string);
      needs(["date", "created_time", "last_edited_time"].includes(d.type), `"${d.name}" isn't a date property.`);
      config.date_property_id = d.id;
      if (v.end_date) config.end_date_property_id = prop(ds, v.end_date).id;
      if (v.zoom) config.preference = { zoom_level: v.zoom };
      if (t === "timeline" && v.properties) {
        config.table_properties = config.properties;
        config.show_table = true;
      }
      break;
    }
    case "map": {
      needs(Boolean(v.map_by), "A map needs `map_by` (a place property).");
      const m = prop(ds, v.map_by as string);
      needs(m.type === "place", `"${m.name}" isn't a place property.`);
      config.map_by = m.id;
      break;
    }
    case "chart": {
      const c = v.chart;
      needs(Boolean(c), "A chart view needs `chart: {type, x, y}`.");
      const chart = c as NonNullable<ViewSpec["chart"]>;
      config.chart_type = chart.type;
      if (chart.type === "number") {
        needs(!chart.x, "A number chart has no x axis; give just `y`.");
        config.value = aggregation(ds, chart.y);
      } else {
        needs(Boolean(chart.x), `A ${chart.type} chart needs \`x\` (the property to group by).`);
        config.x_axis = groupByConfig(ds, chart.x as GroupInput);
        config.y_axis = aggregation(ds, chart.y);
        if (chart.stack_by) {
          needs(chart.type !== "donut", "Donut charts can't be stacked.");
          config.stack_by = groupByConfig(ds, chart.stack_by);
        }
      }
      if (chart.color) config.color_theme = chart.color;
      if (chart.labels !== undefined) config.show_data_labels = chart.labels;
      if (chart.cumulative !== undefined) config.cumulative = chart.cumulative;
      if (chart.height) config.height = chart.height;
      if (chart.sort) config.sort = chart.sort;
      if (chart.caption) config.caption = chart.caption;
      if (chart.type === "donut") config.donut_labels = "name_and_value";
      break;
    }
  }
  if (v.cover) {
    const c = v.cover;
    config.cover = c === "page_cover" || c === "page_content" ? { type: c } : c === "none" ? null : { type: "property", property_id: prop(ds, c).id };
  }
  if (v.card_size) config.cover_size = v.card_size;
  const where = v.where ? await buildWhereFilter(ds, v.where) : undefined;
  const filter = where && v.filter ? { and: [where, v.filter] } : (where ?? v.filter);
  const sorts = v.sorts?.map((s) => ({ property: prop(ds, s.property).name, direction: s.direction }));
  return {
    name: v.name,
    type: t,
    ...(filter ? { filter } : {}),
    ...(sorts ? { sorts } : {}),
    ...(Object.keys(config).length > 1 ? { configuration: config } : {}),
  };
}

/** Drop response-only fields (resolved names, ids of generated parts) so a configuration can be sent back. */
export function stripResponseOnly(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripResponseOnly);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !/^(property_name|date_property_name|end_date_property_name|x_axis_property_name|y_axis_property_name)$/.test(k))
        .map(([k, v]) => [k, stripResponseOnly(v)])
    );
  }
  return value;
}

/** What `views.update` needs to put a view back the way it is now (for undo). */
export function viewRestorePayload(view: Record<string, unknown>): Record<string, unknown> {
  return {
    name: view.name,
    filter: view.filter ?? null,
    sorts: view.sorts ?? null,
    ...(view.configuration && (view.configuration as { type?: string }).type !== "dashboard" ? { configuration: stripResponseOnly(view.configuration) } : {}),
  };
}

/** A readable summary of a view: property ids replaced with names. */
export function describeView(ds: DataSourceObjectResponse | null, view: Record<string, unknown>): Record<string, unknown> {
  // Data sources report property ids URL-encoded ("%40CPF"); views report them decoded ("@CPF"). Match either.
  const decode = (id: string) => {
    try {
      return decodeURIComponent(id);
    } catch {
      return id;
    }
  };
  const names = new Map<string, string>();
  for (const p of ds ? Object.values(ds.properties) : []) {
    names.set(p.id, p.name);
    names.set(decode(p.id), p.name);
  }
  const rename = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(rename);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (/_name$/.test(k)) continue;
        if ((k === "property_id" || k === "property" || /_property_id$/.test(k) || k === "map_by") && typeof x === "string") {
          out[k.replace(/_id$/, "")] = names.get(x) ?? names.get(decode(x)) ?? x;
        } else out[k] = rename(x);
      }
      return out;
    }
    return v;
  };
  return {
    id: view.id,
    name: view.name,
    type: view.type,
    url: view.url,
    ...(view.filter ? { filter: rename(view.filter) } : {}),
    ...(view.sorts ? { sorts: rename(view.sorts) } : {}),
    ...(view.configuration ? { configuration: rename(view.configuration) } : {}),
  };
}
