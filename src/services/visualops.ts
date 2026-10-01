// Chart refresh and report building, shared by the tools and the automation runner. Neither records a journal
// entry itself: callers get the undo ops and record them (one entry per tool call or per automation rule).
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { isFullBlock } from "@notionhq/client";
import type { DataSourceObjectResponse, PageObjectResponse } from "@notionhq/client";
import { call, createPage, normalizeId, notion, read, updateBlock } from "./notion.js";
import { buildWhereFilter, dataSourceTitle, resolveDataSource, resolvePropertyName, simplify } from "./schema.js";
import { appendSpecs, type BlockSpec } from "./blocks.js";
import { CHART_THEMES, CHART_TYPES, renderChart, type ChartRow, type ChartSpec } from "./charts.js";
import { chartSourceSchema, parseMetric, pointsFromDatabase, pointsFromPages, type ChartSource } from "./chartdata.js";
import { getChart, saveChart, saveImageCopy } from "./chartstore.js";
import { viewRequest, type ViewSpec } from "./views.js";
import { ganttChart, type GanttTask } from "./mermaid.js";
import { computeMetric, groupKeys } from "./aggregate.js";
import { queryAll } from "./query.js";
import { uploadBytes } from "./files.js";
import { plain, textToTitle } from "./richtext.js";
import type { UndoOp } from "./journal.js";
import { safeFetch } from "./fetch.js";

export { chartSourceSchema };

/** A write that stopped partway; `undo` reverts what landed. */
export class ReportError extends Error {
  constructor(
    message: string,
    readonly undo: UndoOp[]
  ) {
    super(message);
    this.name = "ReportError";
  }
}

export const chartSpecSchema = z
  .object({
    type: z.enum(CHART_TYPES),
    title: z.string().optional(),
    subtitle: z.string().optional(),
    x_label: z.string().optional(),
    y_label: z.string().optional(),
    value_format: z.string().optional().describe('"number", "percent", "currency", or a d3-format string'),
    width: z.number().int().min(240).max(1600).optional(),
    height: z.number().int().min(160).max(1200).optional(),
    sort_by_value: z.boolean().optional(),
    theme: z
      .enum(CHART_THEMES)
      .optional()
      .describe("Image surface: light (default), dark (Notion's dark background), or transparent with gray text that reads in both themes"),
  })
  .strict();

export const rowSchema = z.object({ x: z.union([z.string(), z.number()]), y: z.number(), series: z.string().optional() });

export type Placement = { type: "database" } | { type: "page"; page: string; after_block?: string } | { type: "dashboard"; view_id: string; row?: number };

export async function createView(ds: DataSourceObjectResponse, databaseId: string, spec: ViewSpec, placement: Placement): Promise<{ view: Record<string, unknown>; undo: UndoOp }> {
  const body = await viewRequest(ds, spec);
  const req: Record<string, unknown> = { data_source_id: ds.id, ...body };
  if (placement.type === "database") req.database_id = databaseId;
  else if (placement.type === "page") {
    req.create_database = {
      parent: { type: "page_id", page_id: normalizeId(placement.page) },
      ...(placement.after_block ? { position: { type: "after_block", block_id: normalizeId(placement.after_block) } } : {}),
    };
  } else {
    req.view_id = normalizeId(placement.view_id);
    req.placement = placement.row === undefined ? { type: "new_row" } : { type: "existing_row", row_index: placement.row };
  }
  const view = (await call(() => notion().views.create(req as never))) as unknown as Record<string, unknown>;
  const linked = placement.type === "page" ? (view.parent as { database_id?: string } | undefined)?.database_id : undefined;
  return { view, undo: { kind: "view_delete", view_id: String(view.id), ...(linked ? { linked_block_id: linked } : {}) } };
}

export async function databaseIdOf(ds: DataSourceObjectResponse): Promise<string> {
  const parent = ds.parent as { type: string; database_id?: string };
  if (parent.type === "database_id" && parent.database_id) return parent.database_id;
  throw new Error("Couldn't find the database this data source belongs to.");
}

/** Render a chart image and upload it; returns the upload id and the PNG. */
export async function renderAndUpload(spec: ChartSpec, points: ChartRow[]): Promise<{ uploadId: string; png: Uint8Array; notes: string[] }> {
  const { png, notes } = await renderChart(spec, points);
  const name = `${(spec.title ?? "chart").replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "chart"}.png`;
  const uploadId = await uploadBytes(png, name, "image/png");
  return { uploadId, png, notes };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function captionFor(spec: ChartSpec, label: string | undefined): unknown[] {
  return textToTitle(`${label ?? spec.title ?? "Chart"} · updated ${today()}`);
}


export interface RefreshArgs {
  block_id: string;
  chart?: ChartSpec;
  data?: ChartRow[];
  source?: ChartSource;
  caption?: string;
}

/** Re-render a chart image in place from its stored recipe (or the given one). */
export async function refreshChart(args: RefreshArgs): Promise<{ undo: UndoOp[]; refreshed: string; points: number; rows_scanned?: number; notes?: string[]; note?: string }> {
  const { chart, data, source, caption } = args;
  const blockId = normalizeId(args.block_id);
    const stored = await getChart(blockId);
    const spec = chart ?? stored?.spec;
    const src = source ?? (data ? undefined : stored?.source);
    const rows = data ?? (src ? undefined : stored?.data);
    if (!spec || (!src && !rows)) throw new Error("This image wasn't made by notion_create_chart here, so give `chart` and `data` or `source` to redraw it.");
    const block = await read(() => notion().blocks.retrieve({ block_id: blockId }));
    if (!isFullBlock(block) || block.type !== "image") throw new Error(`Block ${blockId} isn't an image.`);
    const got = src ? await pointsFromDatabase(src) : null;
    const points = got?.points ?? (rows as ChartRow[]);
    // Keep the current image so undo can put it back (Notion won't take an old file link back).
    const img = block.image as { type: string; file?: { url: string }; external?: { url: string } };
    const url = img.type === "file" ? img.file?.url : img.external?.url;
    let copy: string | null = null;
    if (url) {
      try {
        const res = await safeFetch(url, { maxBytes: 20 * 1024 * 1024, timeoutMs: 30_000 });
        if (res.status >= 200 && res.status < 300) copy = await saveImageCopy(blockId, res.body);
      } catch {
        // Without a copy, the refresh still happens; it's just recorded as not undoable.
      }
    }
    const { uploadId, notes } = await renderAndUpload(spec, points);
    const cap = caption ? textToTitle(caption) : captionFor(spec, got?.label);
    await call(() => updateBlock({ block_id: blockId, image: { file_upload: { id: uploadId }, caption: cap } }));
    const now = new Date().toISOString();
    await saveChart({ block_id: blockId, page_id: stored?.page_id ?? "", spec, ...(src ? { source: src } : { data: points }), created: stored?.created ?? now, updated: now });
    const undo: UndoOp[] = copy ? [{ kind: "image_restore", block_id: blockId, path: copy, caption: (block.image as { caption: unknown[] }).caption }] : [];
    return { undo, refreshed: blockId, points: points.length, ...(got ? { rows_scanned: got.rows } : {}), ...(notes.length ? { notes } : {}), ...(copy ? {} : { note: "The previous image couldn't be downloaded, so undo can't restore it." }) };
}

export const kpiSchema = z.object({ label: z.string(), value: z.string().default("count").describe('"count", "sum:Estimate", …'), where: z.record(z.string(), z.unknown()).optional() });
export const reportChartSchema = z.object({
  title: z.string(),
  type: z.enum(CHART_TYPES).default("column"),
  x: z.union([z.string(), z.object({ property: z.string(), by: z.enum(["day", "week", "month", "quarter", "year"]).optional() })]),
  y: z.string().default("count"),
  series: z.string().optional(),
  where: z.record(z.string(), z.unknown()).optional(),
  native: z.boolean().optional().describe("Live Notion chart view (default where Notion supports the type) or a rendered image."),
  theme: z.enum(CHART_THEMES).optional().describe("Rendered images only: light (default), dark, or transparent."),
});

export const reportArgsShape = {
  database: z.string(),
  data_source_name: z.string().optional(),
  parent: z.string().describe("Page to create the report under."),
  title: z.string().optional(),
  where: z.record(z.string(), z.unknown()).optional().describe("Limits every section to these rows."),
  summary: z.boolean().default(true),
  kpis: z.array(kpiSchema).max(4).optional().describe("Default: total rows plus a count per status group."),
  charts: z.array(reportChartSchema).max(6).optional(),
  table: z
    .object({
      title: z.string(),
      where: z.record(z.string(), z.unknown()).optional(),
      properties: z.array(z.string()).optional(),
      sort: z.object({ property: z.string(), direction: z.enum(["ascending", "descending"]).default("ascending") }).optional(),
      limit: z.number().int().min(1).max(50).default(20),
      linked_view: z.boolean().default(false).describe("Also add a live, filtered table view below it."),
    })
    .optional(),
  gantt: z
    .object({
      title: z.string().default("Timeline"),
      start: z.string().describe("Start (or only) date property"),
      end: z.string().optional(),
      section: z.string().optional().describe("Group tasks into sections by this property (e.g. Owner)."),
      where: z.record(z.string(), z.unknown()).optional(),
      limit: z.number().int().min(1).max(80).default(40),
    })
    .optional(),
};
export const reportArgsSchema = z.object(reportArgsShape);
export type ReportArgs = z.infer<typeof reportArgsSchema>;

/** Build a report page. Returns what was built and the undo ops (trash the page). */
export async function buildReport(a: ReportArgs) {
  const ds = await resolveDataSource(a.database, a.data_source_name);
  const dbTitle = dataSourceTitle(ds);
  const scope = a.where ? await buildWhereFilter(ds, a.where) : undefined;
  const { pages: all, more } = await queryAll(ds.id, { ...(scope ? { filter: scope } : {}), max: 10_000 });
  const notes: string[] = [];
  if (more) notes.push("More than 10,000 rows matched; the report covers the first 10,000.");
  const titleProp = Object.values(ds.properties).find((p) => p.type === "title")?.name as string;
  const statusProp = Object.values(ds.properties).find((p) => p.type === "status");
  const completeIds = statusProp && statusProp.type === "status" ? statusProp.status.groups.find((g) => g.name === "Complete")?.option_ids ?? [] : [];
  const completeNames = statusProp && statusProp.type === "status" ? statusProp.status.options.filter((o) => completeIds.includes(o.id)).map((o) => o.name) : [];
  const isComplete = (p: PageObjectResponse) => Boolean(statusProp && completeNames.includes(String(simplify(p.properties[statusProp.name]) ?? "")));
  const dueProp = Object.values(ds.properties).find((p) => p.type === "date" && /due|deadline|end|target/i.test(p.name)) ?? Object.values(ds.properties).find((p) => p.type === "date");
  const now = today();
  const dateOf = (p: PageObjectResponse, name: string): string | null => {
    const v = simplify(p.properties[name]);
    return typeof v === "string" ? v.slice(0, 10) : v && typeof v === "object" ? String((v as { start: string }).start).slice(0, 10) : null;
  };
  const filterPages = async (where?: Record<string, unknown>): Promise<PageObjectResponse[]> => {
    if (!where) return all;
    const f = await buildWhereFilter(ds, where);
    return (await queryAll(ds.id, { filter: scope && f ? { and: [scope, f] } : (f ?? scope), max: 10_000 })).pages;
  };

  const specs: BlockSpec[] = [];
  const dbMention = `<mention-database url="${(ds.parent as { database_id?: string }).database_id ?? ds.id}"/>`;
  specs.push({ type: "paragraph", text: `Built from ${dbMention} on <mention-date start="${now}"/>${a.where ? " (filtered)" : ""}.`, color: "gray" });

  if (a.summary) {
    const parts = [`**${all.length}** ${all.length === 1 ? "row" : "rows"}`];
    if (statusProp) {
      const done = all.filter(isComplete).length;
      parts.push(`**${done}** complete (${all.length ? Math.round((done / all.length) * 100) : 0}%)`);
    }
    if (statusProp && dueProp) {
      const overdue = all.filter((p) => !isComplete(p) && (dateOf(p, dueProp.name) ?? "9999") < now).length;
      parts.push(`**${overdue}** overdue`);
    }
    specs.push({ type: "callout", icon: "📊", color: "gray_background", text: parts.join(" · ") });
  }

  // KPIs: numbers side by side.
  let kpis = a.kpis;
  if (!kpis && statusProp && statusProp.type === "status") {
    kpis = [{ label: "Total", value: "count" }, ...statusProp.status.groups.filter((g) => g.option_ids.length > 0).map((g) => ({ label: g.name, value: "count", where: { [statusProp.name]: { in: statusProp.status.options.filter((o) => g.option_ids.includes(o.id)).map((o) => o.name) } } }))].filter((k, i, arr) => i === 0 || arr.length <= 4);
  }
  if (kpis?.length) {
    const cells: BlockSpec[][] = [];
    for (const k of kpis) {
      const rows = await filterPages(k.where);
      const v = computeMetric(parseMetric(ds, k.value), rows);
      const shown = typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(v ?? "–");
      cells.push([{ type: "callout", icon: "▪️", color: "default", text: `**${shown}**\n${k.label}` }]);
    }
    specs.push(cells.length === 1 ? cells[0][0] : { type: "column_list", columns: cells });
  }

  // Charts: live views where Notion supports the type, images otherwise.
  const NATIVE: Record<string, { type: "column" | "bar" | "line" | "donut"; stacked: boolean }> = {
    column: { type: "column", stacked: false }, bar: { type: "bar", stacked: false }, line: { type: "line", stacked: false },
    donut: { type: "donut", stacked: false }, pie: { type: "donut", stacked: false },
    stacked_column: { type: "column", stacked: true }, stacked_bar: { type: "bar", stacked: true },
  };
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "notion-plus-report-"));
  const nativeCharts: { headingIndex: number; spec: ViewSpec; where?: Record<string, unknown> }[] = [];
  const imageCharts: { index: number; spec: ChartSpec; source: ChartSource }[] = [];
  for (const c of a.charts ?? []) {
    const native = NATIVE[c.type];
    const useNative = c.native ?? Boolean(native && (!c.series || native.stacked));
    specs.push({ type: "heading_2", text: c.title });
    if (useNative) {
      if (!native) throw new Error(`Chart "${c.title}": Notion's chart views don't do ${c.type}; leave native unset for an image.`);
      const xName = typeof c.x === "string" ? c.x : c.x.property;
      const xGroup = typeof c.x === "string" ? xName : { property: xName, ...(c.x.by && c.x.by !== "quarter" ? { by: c.x.by } : {}) };
      const y = c.y === "count" ? "count" : c.y.replace(/^avg:/, "average:");
      nativeCharts.push({
        headingIndex: specs.length - 1,
        spec: { name: c.title, type: "chart", chart: { type: native.type, x: xGroup, y, ...(c.series ? { stack_by: c.series } : {}), labels: true, height: "medium" } },
        ...(c.where ? { where: c.where } : {}),
      });
    } else {
      const where = a.where && c.where ? { and: [a.where, c.where] } : (a.where ?? c.where);
      const source: ChartSource = { database: ds.id, x: c.x, y: c.y, ...(c.series ? { series: c.series } : {}), ...(where ? { where } : {}), include_empty: false, max_rows: 10_000 };
      const rows = c.where ? await filterPages(c.where) : all;
      const xName = resolvePropertyName(ds, typeof c.x === "string" ? c.x : c.x.property).name;
      const points = pointsFromPages(rows, { x: xName, ...(typeof c.x !== "string" && c.x.by ? { by: c.x.by } : {}), ...(c.series ? { series: resolvePropertyName(ds, c.series).name } : {}), metric: parseMetric(ds, c.y), includeEmpty: false });
      const spec: ChartSpec = { type: c.type, title: c.title, ...(c.theme ? { theme: c.theme } : {}) };
      const { png, notes: n2 } = await renderChart(spec, points);
      notes.push(...n2.map((x) => `${c.title}: ${x}`));
      const file = path.join(tmpDir, `chart-${imageCharts.length + 1}.png`);
      await fs.writeFile(file, png);
      specs.push({ type: "image", url: file, caption: `${c.title} · updated ${now}` });
      imageCharts.push({ index: specs.length - 1, spec, source });
    }
  }

  // Table of key rows.
  let tableHeading = -1;
  if (a.table) {
    const t = a.table;
    let rows = await filterPages(t.where);
    const props = (t.properties ?? [titleProp, ...(statusProp ? [statusProp.name] : []), ...(dueProp ? [dueProp.name] : [])]).map((p) => resolvePropertyName(ds, p).name);
    if (t.sort) {
      const s = resolvePropertyName(ds, t.sort.property).name;
      const key = (p: PageObjectResponse) => groupKeys(p.properties[s], "day")[0];
      rows = [...rows].sort((x, y) => (t.sort?.direction === "descending" ? -1 : 1) * key(x).localeCompare(key(y)));
    }
    specs.push({ type: "heading_2", text: t.title });
    tableHeading = specs.length - 1;
    if (rows.length === 0) specs.push({ type: "paragraph", text: "Nothing matches right now.", color: "gray" });
    else {
      const cell = (p: PageObjectResponse, name: string): string => {
        if (name === titleProp) return `<mention-page url="${p.id}"/>`;
        const v = simplify(p.properties[name]);
        const s = Array.isArray(v) ? v.join(", ") : v && typeof v === "object" ? JSON.stringify(v) : v === null || v === undefined ? "" : String(v);
        return s.replace(/\|/g, "/");
      };
      specs.push({ type: "table", header_row: true, rows: [props, ...rows.slice(0, t.limit).map((p) => props.map((name) => cell(p, name)))] });
      if (rows.length > t.limit) specs.push({ type: "paragraph", text: `…and ${rows.length - t.limit} more.`, color: "gray" });
    }
  }

  // Gantt of dated work.
  if (a.gantt) {
    const g = a.gantt;
    const start = resolvePropertyName(ds, g.start).name;
    const end = g.end ? resolvePropertyName(ds, g.end).name : undefined;
    const section = g.section ? resolvePropertyName(ds, g.section).name : undefined;
    const rows = (await filterPages(g.where))
      .map((p) => {
        const raw = simplify(p.properties[start]);
        const s = typeof raw === "string" ? raw : raw && typeof raw === "object" ? (raw as { start: string }).start : null;
        const e = end ? dateOf(p, end) : raw && typeof raw === "object" ? ((raw as { end?: string | null }).end ?? null) : null;
        return { p, s, e };
      })
      .filter((r) => r.s)
      .sort((x, y) => String(x.s).localeCompare(String(y.s)))
      .slice(0, g.limit);
    specs.push({ type: "heading_2", text: g.title });
    if (rows.length === 0) specs.push({ type: "paragraph", text: "No dated rows match.", color: "gray" });
    else {
      const tasks: GanttTask[] = rows.map(({ p, s, e }) => ({
        name: plain((p.properties[titleProp] as { title: Parameters<typeof plain>[0] }).title) || "(untitled)",
        start: String(s),
        end: e,
        ...(section ? { section: groupKeys(p.properties[section])[0] } : {}),
        status: isComplete(p) ? "done" : dueProp && (dateOf(p, dueProp.name) ?? "9999") < now ? "crit" : null,
      }));
      specs.push({ type: "code", language: "mermaid", text: ganttChart(undefined, tasks) });
    }
  }
  specs.push({ type: "divider" }, { type: "paragraph", text: `Rebuild this report to refresh the numbers. Image charts refresh with notion_create_chart.`, color: "gray" });

  // Create the page, then fill it.
  const page = await call(() =>
    createPage({ parent: { type: "page_id", page_id: normalizeId(a.parent) }, icon: { type: "emoji", emoji: "📊" }, properties: { title: { title: textToTitle(a.title ?? `${dbTitle} report`) } } })
  );
  const undo: UndoOp[] = [{ kind: "page_trash", page_id: page.id, in_trash: true }];
  try {
    const ids = await appendSpecs(page.id, specs);
    const nowIso = new Date().toISOString();
    for (const ic of imageCharts) await saveChart({ block_id: ids[ic.index], page_id: page.id, spec: ic.spec, source: ic.source, created: nowIso, updated: nowIso });
    const dbId = await databaseIdOf(ds);
    for (const nc of nativeCharts) {
      const where = a.where && nc.where ? { and: [a.where, nc.where] } : (a.where ?? nc.where);
      await createView(ds, dbId, { ...nc.spec, ...(where ? { where } : {}) }, { type: "page", page: page.id, after_block: ids[nc.headingIndex] });
    }
    if (a.table?.linked_view && tableHeading >= 0) {
      const where = a.where && a.table.where ? { and: [a.where, a.table.where] } : (a.where ?? a.table.where);
      // Place it after the static table (the block after the heading).
      await createView(ds, dbId, { name: a.table.title, type: "table", ...(where ? { where } : {}), ...(a.table.properties ? { properties: a.table.properties } : {}) }, { type: "page", page: page.id, after_block: ids[tableHeading + 1] });
    }
  } catch (e) {
    throw new ReportError(`The report page ${page.id} was created but filling it failed: ${(e as Error).message}`, undo);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
  return {
    undo,
    page_id: page.id,
    url: "url" in page ? page.url : undefined,
    rows: all.length,
    sections: {
      summary: a.summary,
      kpis: kpis?.length ?? 0,
      native_charts: nativeCharts.length,
      image_charts: imageCharts.length,
      table: Boolean(a.table),
      gantt: Boolean(a.gantt),
    },
    ...(notes.length ? { notes } : {}),
  };
}
