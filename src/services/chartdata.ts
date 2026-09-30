// Chart points from a database: group rows by one property (and optionally a second, for series) and measure them.
import { z } from "zod";
import type { DataSourceObjectResponse, PageObjectResponse } from "@notionhq/client";
import { buildWhereFilter, dataSourceTitle, resolveDataSource, resolvePropertyName } from "./schema.js";
import { computeMetric, DATE_BUCKETS, EMPTY_KEY, groupKeys, METRIC_OPS, type Metric } from "./aggregate.js";
import { queryAll } from "./query.js";
import type { ChartRow } from "./charts.js";

export const chartSourceSchema = z
  .object({
    database: z.string(),
    data_source_name: z.string().optional(),
    where: z.record(z.string(), z.unknown()).optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
    x: z.union([z.string(), z.object({ property: z.string(), by: z.enum(DATE_BUCKETS).optional() })]).describe("Group rows by this property (the x axis, or pie slices)."),
    y: z.string().default("count").describe('"count", or "sum:Estimate", "avg:Points", "max:Due", …'),
    series: z.string().optional().describe("Split into one series per value of this property (stacked/grouped/multi-line)."),
    include_empty: z.boolean().default(false).describe('Keep the "(empty)" group.'),
    top: z.number().int().min(1).max(100).optional().describe("Keep the largest N groups."),
    max_rows: z.number().int().min(1).max(50_000).default(10_000),
  })
  .strict();
export type ChartSource = z.infer<typeof chartSourceSchema>;

export function parseMetric(ds: DataSourceObjectResponse, input: string): Metric {
  const [rawOp, ...rest] = input.split(":");
  const op = rawOp.trim() === "average" || rawOp.trim() === "mean" ? "avg" : rawOp.trim();
  if (!(METRIC_OPS as readonly string[]).includes(op)) throw new Error(`Unknown measure "${rawOp}". Use: ${METRIC_OPS.join(", ")}.`);
  if (op === "count") return { op: "count" };
  const name = rest.join(":").trim();
  if (!name) throw new Error(`"${op}" needs a property, e.g. "${op}:Estimate".`);
  return { op: op as Metric["op"], property: resolvePropertyName(ds, name).name };
}

/** Group pages into chart points. Pure given the pages, so it can be unit-tested. */
export function pointsFromPages(
  pages: PageObjectResponse[],
  opts: { x: string; by?: (typeof DATE_BUCKETS)[number]; series?: string; metric: Metric; includeEmpty: boolean; top?: number }
): ChartRow[] {
  const cells = new Map<string, { x: string; series?: string; rows: PageObjectResponse[] }>();
  for (const p of pages) {
    const xs = groupKeys(p.properties[opts.x], opts.by);
    const ss = opts.series ? groupKeys(p.properties[opts.series]) : [undefined];
    for (const x of xs) {
      if (x === EMPTY_KEY && !opts.includeEmpty) continue;
      for (const s of ss) {
        const key = `${x}\u0000${s ?? ""}`;
        const cell = cells.get(key) ?? { x, ...(s !== undefined ? { series: s } : {}), rows: [] };
        cell.rows.push(p);
        cells.set(key, cell);
      }
    }
  }
  let points: ChartRow[] = [...cells.values()].map((c) => {
    const v = computeMetric(opts.metric, c.rows);
    return { x: c.x, y: typeof v === "number" ? v : 0, ...(c.series !== undefined ? { series: c.series } : {}) };
  });
  const totals = new Map<string, number>();
  for (const p of points) totals.set(String(p.x), (totals.get(String(p.x)) ?? 0) + p.y);
  const xs = [...totals.keys()];
  // Dates read left to right in time; categories largest first.
  const ordered = opts.by ? xs.sort() : xs.sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0) || a.localeCompare(b));
  const keep = new Set(opts.top ? ordered.slice(0, opts.top) : ordered);
  points = points.filter((p) => keep.has(String(p.x)));
  const rank = new Map(ordered.map((x, i) => [x, i]));
  return points.sort((a, b) => (rank.get(String(a.x)) ?? 0) - (rank.get(String(b.x)) ?? 0));
}

export async function pointsFromDatabase(source: ChartSource): Promise<{ points: ChartRow[]; rows: number; more: boolean; ds: DataSourceObjectResponse; label: string }> {
  const ds = await resolveDataSource(source.database, source.data_source_name);
  const x = typeof source.x === "string" ? { property: source.x } : source.x;
  const xName = resolvePropertyName(ds, x.property).name;
  const series = source.series ? resolvePropertyName(ds, source.series).name : undefined;
  const metric = parseMetric(ds, source.y);
  const where = source.where ? await buildWhereFilter(ds, source.where) : undefined;
  const filter = where && source.filter ? { and: [where, source.filter] } : (where ?? source.filter);
  const { pages, more } = await queryAll(ds.id, { ...(filter ? { filter } : {}), max: source.max_rows });
  const points = pointsFromPages(pages, { x: xName, ...(x.by ? { by: x.by } : {}), ...(series ? { series } : {}), metric, includeEmpty: source.include_empty, ...(source.top ? { top: source.top } : {}) });
  const label = `${dataSourceTitle(ds)}: ${source.y} by ${xName}${x.by ? ` (${x.by})` : ""}${series ? ` and ${series}` : ""}`;
  return { points, rows: pages.length, more, ds, label };
}
