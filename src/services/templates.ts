// Reusable page templates: a declarative, versioned spec that renders to Notion blocks. A template has variables
// (checked before anything is written), loops over lists, conditions, named parts it can reuse, and slots the caller
// fills. Components cover text (markdown), callouts, columns, toggles, KPI numbers computed from a database, chart
// images, live database views, tables (static or from a query), and Mermaid Gantt charts. Rendering is two steps:
// compile (reads only: resolves variables, computes numbers, plans charts) and write. Preview stops after compile.
import path from "node:path";
import { z } from "zod";
import type { DataSourceObjectResponse, PageObjectResponse } from "@notionhq/client";
import { appendSpecs, markdownToSpecs, PartialWriteError, type BlockSpec } from "./blocks.js";
import { call, createPage, normalizeId } from "./notion.js";
import { textToTitle } from "./richtext.js";
import { insertedBlocks, type UndoOp } from "./journal.js";
import { blockSpecSchema } from "./specSchema.js";
import { buildWhereFilter, dataSourceTitle, resolveDataSource, resolvePropertyName, simplify } from "./schema.js";
import { queryAll } from "./query.js";
import { computeMetric } from "./aggregate.js";
import { parseMetric, pointsFromDatabase, chartSourceSchema, type ChartSource } from "./chartdata.js";
import { chartDataBlocks, chartSpecSchema, createView, databaseIdOf, ganttTasks, renderAndUpload, rowSchema, summaryLine, type Placement } from "./visualops.js";
import { viewSpecSchema, type ViewSpec } from "./views.js";
import { ganttChart } from "./mermaid.js";
import { type ChartRow, type ChartSpec } from "./charts.js";
import { readJson, updateJson } from "./store.js";
import { homeDir } from "./files.js";
import { BUILTIN_TEMPLATES } from "./templates-builtin.js";

// ---------- spec ----------

const varSchema = z
  .object({
    type: z.enum(["string", "number", "boolean", "date", "list", "object"]),
    required: z.boolean().default(false),
    default: z.unknown().optional(),
    description: z.string().optional(),
  })
  .strict();

const conditionSchema = z.union([
  z.string().describe("A variable path; true when it's set and not empty/false/0."),
  z
    .object({
      var: z.string(),
      equals: z.unknown().optional(),
      not: z.unknown().optional(),
      in: z.array(z.unknown()).optional(),
      gt: z.number().optional(),
      lt: z.number().optional(),
      empty: z.boolean().optional(),
    })
    .strict(),
]);

/** An object or list, or a whole "{{variable}}" that holds one (resolved before use). */
type Where = Record<string, unknown> | string;

export type TemplateNode =
  | { markdown: string }
  | { heading: string; level?: 1 | 2 | 3 }
  | { callout: string; icon?: string; color?: string }
  | { toggle: string; children: TemplateNode[] }
  | { columns: TemplateNode[][] }
  | { divider: true }
  | { kpis: { label: string; value?: string | number; metric?: { database: string; data_source_name?: string; value: string; where?: Record<string, unknown> } }[] | string }
  | { chart: { spec: ChartSpec; data?: ChartRow[] | string; source?: Omit<ChartSource, "where"> & { where?: Where }; data_table?: boolean; format?: "png" | "svg" } }
  | { view: { database: string; data_source_name?: string; view: ViewSpec } }
  | { table: { header?: string[]; rows?: (string | number)[][] | string; query?: { database: string; data_source_name?: string; properties?: string[] | string; where?: Where; limit?: number } } }
  | { summary: { database: string; data_source_name?: string; where?: Where; icon?: string } }
  | {
      gantt: {
        title?: string;
        tasks?: { name: string; start: string; end?: string | null; section?: string; status?: "done" | "active" | "crit" | null }[] | string;
        query?: { database: string; data_source_name?: string; start: string; end?: string; section?: string; where?: Where; limit?: number };
      };
    }
  | { each: string; as: string; blocks: TemplateNode[] }
  | { if: z.infer<typeof conditionSchema>; then: TemplateNode[]; else?: TemplateNode[] }
  | { part: string; with?: Record<string, unknown> }
  | { slot: string; default?: TemplateNode[] }
  | { blocks: BlockSpec[] };

/** A value, or a whole "{{variable}}" holding it (checked again once filled in). */
const VAR_REF = /^\{\{\s*[a-z_][a-z0-9_.]*\s*\}\}$/i;
const orVar = <T extends z.ZodTypeAny>(schema: T) => z.union([schema, z.string().regex(VAR_REF, "Expected a value or a {{variable}}.")]);
const whereOrVar = orVar(z.record(z.string(), z.unknown())).optional();

const kpiItem = z
  .object({
    label: z.string(),
    value: z.union([z.string(), z.number()]).optional(),
    metric: z.object({ database: z.string(), data_source_name: z.string().optional(), value: z.string(), where: z.record(z.string(), z.unknown()).optional() }).strict().optional(),
  })
  .strict()
  .refine((k) => (k.value === undefined) !== (k.metric === undefined), { message: "A KPI needs `value` or `metric`, not both." });

export const nodeSchema: z.ZodType<TemplateNode> = z.lazy(() =>
  z.union([
    z.object({ markdown: z.string() }).strict(),
    z.object({ heading: z.string(), level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional() }).strict(),
    z.object({ callout: z.string(), icon: z.string().optional(), color: z.string().optional() }).strict(),
    z.object({ toggle: z.string(), children: z.array(nodeSchema) }).strict(),
    z.object({ columns: z.array(z.array(nodeSchema)).min(2).max(5) }).strict(),
    z.object({ divider: z.literal(true) }).strict(),
    z
      .object({
        summary: z
          .object({ database: z.string(), data_source_name: z.string().optional(), where: whereOrVar, icon: z.string().optional() })
          .strict()
          .describe("A callout with the row count, completion, and overdue count of a database."),
      })
      .strict(),
    z.object({ kpis: z.union([z.array(kpiItem).min(1).max(6), z.string().describe("A {{variable}} holding the list")]) }).strict(),
    z
      .object({
        chart: z
          .object({
            spec: chartSpecSchema,
            data: z.union([z.array(rowSchema), z.string()]).optional(),
            source: chartSourceSchema.extend({ where: whereOrVar }).optional(),
            data_table: z.boolean().optional(),
            format: z.enum(["png", "svg"]).optional(),
          })
          .strict()
          .refine((c) => (c.data === undefined) !== (c.source === undefined), { message: "A chart needs `data` or `source`." }),
      })
      .strict(),
    z.object({ view: z.object({ database: z.string(), data_source_name: z.string().optional(), view: viewSpecSchema }).strict() }).strict(),
    z
      .object({
        table: z
          .object({
            header: z.array(z.string()).optional(),
            rows: z.union([z.array(z.array(z.union([z.string(), z.number()]))), z.string()]).optional(),
            query: z
              .object({
                database: z.string(),
                data_source_name: z.string().optional(),
                properties: orVar(z.array(z.string())).optional(),
                where: whereOrVar,
                limit: z.number().int().min(1).max(100).optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .refine((t) => (t.rows === undefined) !== (t.query === undefined), { message: "A table needs `rows` or `query`." }),
      })
      .strict(),
    z
      .object({
        gantt: z
          .object({
            title: z.string().optional(),
            tasks: z.union([
              z.array(
                z
                  .object({
                    name: z.string(),
                    start: z.string(),
                    end: z.string().nullable().optional(),
                    section: z.string().optional(),
                    status: z.enum(["done", "active", "crit"]).nullable().optional(),
                  })
                  .strict()
              ),
              z.string(),
            ]).optional(),
            query: z
              .object({
                database: z.string(),
                data_source_name: z.string().optional(),
                start: z.string().describe("Start (or only) date property"),
                end: z.string().optional(),
                section: z.string().optional().describe("Group tasks by this property"),
                where: whereOrVar,
                limit: z.number().int().min(1).max(80).optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .refine((g) => (g.tasks === undefined) !== (g.query === undefined), { message: "A gantt needs `tasks` or `query`." }),
      })
      .strict(),
    z.object({ each: z.string(), as: z.string().regex(/^[a-z_][a-z0-9_]*$/i), blocks: z.array(nodeSchema) }).strict(),
    z.object({ if: conditionSchema, then: z.array(nodeSchema), else: z.array(nodeSchema).optional() }).strict(),
    z.object({ part: z.string(), with: z.record(z.string(), z.unknown()).optional() }).strict(),
    z.object({ slot: z.string(), default: z.array(nodeSchema).optional() }).strict(),
    z.object({ blocks: z.array(blockSpecSchema) }).strict(),
  ])
);

export const templateSchema = z
  .object({
    version: z.literal(1),
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, digits, and dashes."),
    description: z.string().optional(),
    variables: z.record(z.string().regex(/^[a-z_][a-z0-9_]*$/i), varSchema).default({}),
    parts: z.record(z.string(), z.array(nodeSchema)).default({}),
    title: z.string().describe("Page title; may use {{variables}}."),
    icon: z.string().optional(),
    blocks: z.array(nodeSchema).min(1),
  })
  .strict();
export type Template = z.infer<typeof templateSchema>;

// ---------- variables and interpolation ----------

type Context = Record<string, unknown>;

function lookup(ctx: Context, p: string): unknown {
  let cur: unknown = ctx;
  for (const key of p.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export class TemplateError extends Error {
  constructor(readonly problems: string[]) {
    super(`The template can't render:\n- ${problems.join("\n- ")}`);
    this.name = "TemplateError";
  }
}

const VAR = /\{\{\s*([a-zA-Z_][\w.]*)\s*\}\}/g;

/** Replace {{path}} in a string. A string that is exactly one {{path}} yields the raw value (lists, objects, numbers). */
export function interpolate(value: unknown, ctx: Context, problems: string[], where: string): unknown {
  if (typeof value === "string") {
    const whole = value.match(/^\{\{\s*([a-zA-Z_][\w.]*)\s*\}\}$/);
    if (whole) {
      const v = lookup(ctx, whole[1]);
      if (v === undefined) problems.push(`${where}: {{${whole[1]}}} has no value.`);
      return v ?? "";
    }
    return value.replace(VAR, (_, p: string) => {
      const v = lookup(ctx, p);
      if (v === undefined) {
        problems.push(`${where}: {{${p}}} has no value.`);
        return "";
      }
      return typeof v === "object" ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => interpolate(v, ctx, problems, `${where}[${i}]`));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, ctx, problems, `${where}.${k}`)]));
  }
  return value;
}

function today(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/** Check given values against the template's variables, apply defaults, and add built-ins (today, now). */
export function resolveVariables(t: Template, given: Record<string, unknown>, tz = "UTC"): Context {
  const problems: string[] = [];
  const ctx: Context = { today: today(tz), now: new Date().toISOString() };
  for (const [name, v] of Object.entries(t.variables)) {
    const val = given[name] ?? v.default;
    if (val === undefined) {
      if (v.required) problems.push(`Variable "${name}" is required${v.description ? ` (${v.description})` : ""}.`);
      continue;
    }
    const ok =
      v.type === "list" ? Array.isArray(val)
      : v.type === "object" ? typeof val === "object" && val !== null && !Array.isArray(val)
      : v.type === "date" ? typeof val === "string" && /^\d{4}-\d{2}-\d{2}/.test(val)
      : typeof val === v.type;
    if (!ok) problems.push(`Variable "${name}" should be a ${v.type}; got ${JSON.stringify(val).slice(0, 60)}.`);
    ctx[name] = val;
  }
  for (const k of Object.keys(given)) if (!(k in t.variables)) problems.push(`Unknown variable "${k}". This template takes: ${Object.keys(t.variables).join(", ") || "none"}.`);
  if (problems.length) throw new TemplateError(problems);
  return ctx;
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== 0 && v !== "";
}

const norm = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : JSON.stringify(v));

export function evalCondition(c: z.infer<typeof conditionSchema>, ctx: Context): boolean {
  if (typeof c === "string") return truthy(lookup(ctx, c));
  const v = lookup(ctx, c.var);
  if (c.empty !== undefined) return c.empty === !truthy(v);
  if (c.equals !== undefined) return norm(v) === norm(c.equals);
  if (c.not !== undefined) return norm(v) !== norm(c.not);
  if (c.in) return c.in.some((x) => norm(x) === norm(v));
  if (c.gt !== undefined) return typeof v === "number" && v > c.gt;
  if (c.lt !== undefined) return typeof v === "number" && v < c.lt;
  return truthy(v);
}

// ---------- compile ----------

/** A chart to render and upload when writing; the block at `index` (in its list) is its placeholder. */
export interface PlannedChart {
  spec: ChartSpec;
  rows: ChartRow[];
  data_table: boolean;
  format: "png" | "svg";
  /** Path of the placeholder: top-level index, or nested indexes for charts in columns/toggles. */
  path: number[];
}

/** A live view, created after the blocks so it can sit after the block before it. Top level only. */
export interface PlannedView {
  database: string;
  data_source_name?: string;
  view: ViewSpec;
  /** Index of the top-level block it follows (-1: start of page). */
  after: number;
}

export interface Compiled {
  title: string;
  icon?: string;
  specs: BlockSpec[];
  charts: PlannedChart[];
  views: PlannedView[];
  /** Database reads done while compiling. */
  reads: number;
  notes: string[];
}

const MAX_DEPTH = 20;
const MAX_BLOCKS = 1000;

interface CompileState {
  t: Template;
  slots: Record<string, string | TemplateNode[]>;
  tz: string;
  problems: string[];
  charts: PlannedChart[];
  views: PlannedView[];
  notes: string[];
  reads: number;
  blocks: number;
  ds: Map<string, DataSourceObjectResponse>;
}

async function dataSource(st: CompileState, database: string, name?: string): Promise<DataSourceObjectResponse> {
  const key = `${database}\u0000${name ?? ""}`;
  let ds = st.ds.get(key);
  if (!ds) {
    ds = await resolveDataSource(database, name);
    st.ds.set(key, ds);
    st.reads++;
  }
  return ds;
}

async function rowsFor(st: CompileState, ds: DataSourceObjectResponse, where: Where | undefined, max: number): Promise<PageObjectResponse[]> {
  if (typeof where === "string") throw new Error(`"where" should be an object like {"Status": "Done"}; got the text "${where}".`);
  const filter = where ? await buildWhereFilter(ds, where) : undefined;
  st.reads++;
  return (await queryAll(ds.id, { ...(filter ? { filter } : {}), max })).pages;
}

function cellText(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  if (v && typeof v === "object") return JSON.stringify(v);
  return v === null || v === undefined ? "" : String(v);
}

/**
 * Compile nodes into block specs. `pathPrefix` locates nested lists, so charts inside columns or toggles can be
 * found again after writing; `topLevel` is true only for the page's own list (where views can go).
 */
async function compileNodes(nodes: TemplateNode[], ctx: Context, st: CompileState, depth: number, pathPrefix: number[], topLevel: boolean, out: BlockSpec[]): Promise<void> {
  if (depth > MAX_DEPTH) {
    st.problems.push("Parts nest more than 20 levels deep (a part may include itself).");
    return;
  }
  const where = (i: number) => `blocks${pathPrefix.length ? `[${pathPrefix.join("][")}]` : ""}[${i}]`;
  for (const [i, raw] of nodes.entries()) {
    if (st.blocks > MAX_BLOCKS) {
      st.problems.push(`More than ${MAX_BLOCKS} blocks; split the template.`);
      return;
    }
    const at = where(i);
    const n = raw as Record<string, unknown>;
    // Control flow first: these don't interpolate as a whole.
    if ("each" in n) {
      const node = raw as { each: string; as: string; blocks: TemplateNode[] };
      const list = lookup(ctx, node.each);
      if (!Array.isArray(list)) {
        st.problems.push(`${at}: each "${node.each}" isn't a list.`);
        continue;
      }
      for (const [j, item] of list.entries()) await compileNodes(node.blocks, { ...ctx, [node.as]: item, [`${node.as}_index`]: j + 1 }, st, depth + 1, pathPrefix, topLevel, out);
      continue;
    }
    if ("if" in n) {
      const node = raw as { if: z.infer<typeof conditionSchema>; then: TemplateNode[]; else?: TemplateNode[] };
      await compileNodes(evalCondition(node.if, ctx) ? node.then : (node.else ?? []), ctx, st, depth + 1, pathPrefix, topLevel, out);
      continue;
    }
    if ("part" in n) {
      const node = raw as { part: string; with?: Record<string, unknown> };
      const part = st.t.parts[node.part];
      if (!part) {
        st.problems.push(`${at}: no part "${node.part}". Parts: ${Object.keys(st.t.parts).join(", ") || "none"}.`);
        continue;
      }
      const extra = node.with ? (interpolate(node.with, ctx, st.problems, `${at}.with`) as Context) : {};
      await compileNodes(part, { ...ctx, ...extra }, st, depth + 1, pathPrefix, topLevel, out);
      continue;
    }
    if ("slot" in n) {
      const node = raw as { slot: string; default?: TemplateNode[] };
      const fill = st.slots[node.slot];
      if (typeof fill === "string") {
        const specs = markdownToSpecs(fill);
        st.blocks += specs.length;
        out.push(...specs);
      } else await compileNodes(fill ?? node.default ?? [], ctx, st, depth + 1, pathPrefix, topLevel, out);
      continue;
    }

    // Containers: only their own label is filled in here; children are compiled (and filled) in their own scope,
    // so branches not taken and loop bodies never see variables they don't have.
    if ("toggle" in n) {
      const node = raw as { toggle: string; children: TemplateNode[] };
      st.blocks++;
      const children: BlockSpec[] = [];
      await compileNodes(node.children, ctx, st, depth + 1, [...pathPrefix, out.length], false, children);
      out.push({ type: "toggle", text: String(interpolate(node.toggle, ctx, st.problems, `${at}.toggle`)), children });
      continue;
    }
    if ("columns" in n) {
      const node = raw as { columns: TemplateNode[][] };
      st.blocks++;
      const columns: BlockSpec[][] = [];
      for (const [c, col] of node.columns.entries()) {
        const list: BlockSpec[] = [];
        await compileNodes(col, ctx, st, depth + 1, [...pathPrefix, out.length, c], false, list);
        columns.push(list.length ? list : [{ type: "paragraph", text: "" }]);
      }
      out.push({ type: "column_list", columns });
      continue;
    }

    const node = interpolate(raw, ctx, st.problems, at) as TemplateNode;
    st.blocks++;
    if ("markdown" in node) {
      const specs = markdownToSpecs(node.markdown);
      st.blocks += specs.length - 1;
      out.push(...specs);
    } else if ("heading" in node) out.push({ type: `heading_${node.level ?? 2}`, text: node.heading });
    else if ("callout" in node) out.push({ type: "callout", text: node.callout, icon: node.icon ?? "💡", ...(node.color ? { color: node.color } : {}) });
    else if ("divider" in node) out.push({ type: "divider" });
    else if ("blocks" in node) out.push(...(node as { blocks: BlockSpec[] }).blocks);
    else if ("kpis" in node) {
      const parsed = z.array(kpiItem).min(1).max(6).safeParse(node.kpis);
      if (!parsed.success) {
        st.problems.push(`${at}.kpis: expected 1-6 items like {label, value} or {label, metric}: ${parsed.error.issues[0]?.message ?? ""}`);
        continue;
      }
      const cells: BlockSpec[][] = [];
      for (const k of parsed.data) {
        let shown: string;
        if (k.metric) {
          const ds = await dataSource(st, k.metric.database, k.metric.data_source_name);
          const v = computeMetric(parseMetric(ds, k.metric.value), await rowsFor(st, ds, k.metric.where, 10_000));
          shown = typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(v ?? "–");
        } else shown = String(k.value);
        cells.push([{ type: "callout", icon: "▪️", color: "default", text: `**${shown}**\n${k.label}` }]);
      }
      out.push(cells.length === 1 ? cells[0][0] : { type: "column_list", columns: cells });
    } else if ("chart" in node) {
      const c = node.chart;
      let rows: ChartRow[];
      if (c.source) {
        const source = chartSourceSchema.safeParse(c.source);
        if (!source.success) {
          st.problems.push(`${at}.chart.source: ${source.error.issues[0]?.message ?? "invalid"}`);
          continue;
        }
        st.reads++;
        rows = (await pointsFromDatabase(source.data)).points;
      } else {
        const parsed = z.array(rowSchema).safeParse(c.data);
        if (!parsed.success) {
          st.problems.push(`${at}.chart.data: expected rows like [{x, y, series?}].`);
          continue;
        }
        rows = parsed.data;
      }
      // A placeholder the writer replaces with the uploaded image (and its data toggle).
      st.charts.push({ spec: c.spec, rows, data_table: c.data_table ?? false, format: c.format ?? "png", path: [...pathPrefix, out.length] });
      out.push({ type: "paragraph", text: `[chart: ${c.spec.title ?? c.spec.type}]` });
    } else if ("view" in node) {
      if (!topLevel) {
        st.problems.push(`${at}: live views can only be at the top level of the page (not in columns or toggles).`);
        continue;
      }
      st.views.push({ database: node.view.database, ...(node.view.data_source_name ? { data_source_name: node.view.data_source_name } : {}), view: node.view.view, after: out.length - 1 });
    } else if ("table" in node) {
      const t = node.table;
      if (t.query) {
        const ds = await dataSource(st, t.query.database, t.query.data_source_name);
        const titleProp = Object.values(ds.properties).find((p) => p.type === "title")?.name as string;
        const given = t.query.properties;
        if (typeof given === "string") {
          st.problems.push(`${at}.table.query.properties: expected a list of property names.`);
          continue;
        }
        const props = (given?.length ? given : [titleProp]).map((p) => resolvePropertyName(ds, p).name);
        const rows = await rowsFor(st, ds, t.query.where, t.query.limit ?? 20);
        const body = rows.map((p) => props.map((name) => (name === titleProp ? `<mention-page url="${p.id}"/>` : cellText(simplify(p.properties[name])).replace(/\|/g, "/"))));
        out.push(body.length ? { type: "table", header_row: true, rows: [t.header ?? props, ...body] } : { type: "paragraph", text: `Nothing in "${dataSourceTitle(ds)}" matches.`, color: "gray" });
      } else {
        const rows = t.rows;
        if (!Array.isArray(rows) || !rows.every((r) => Array.isArray(r))) {
          st.problems.push(`${at}.table.rows: expected a list of rows (lists of cells).`);
          continue;
        }
        const body = (rows as unknown[][]).map((r) => r.map(cellText));
        out.push({ type: "table", header_row: Boolean(t.header), rows: t.header ? [t.header, ...body] : body });
      }
    } else if ("summary" in node) {
      const ds = await dataSource(st, node.summary.database, node.summary.data_source_name);
      const rows = await rowsFor(st, ds, node.summary.where, 10_000);
      out.push({ type: "callout", icon: node.summary.icon ?? "📊", color: "gray_background", text: summaryLine(ds, rows, today(st.tz)) });
    } else if ("gantt" in node) {
      if (node.gantt.query) {
        const q = node.gantt.query;
        const ds = await dataSource(st, q.database, q.data_source_name);
        const tasks = ganttTasks(ds, await rowsFor(st, ds, q.where, 10_000), { start: q.start, ...(q.end ? { end: q.end } : {}), ...(q.section ? { section: q.section } : {}), limit: q.limit ?? 40 }, today(st.tz));
        out.push(tasks.length ? { type: "code", language: "mermaid", text: ganttChart(node.gantt.title, tasks) } : { type: "paragraph", text: "No dated rows match.", color: "gray" });
        continue;
      }
      const tasks = node.gantt.tasks;
      if (!Array.isArray(tasks)) {
        st.problems.push(`${at}.gantt.tasks: expected a list of tasks.`);
        continue;
      }
      out.push({ type: "code", language: "mermaid", text: ganttChart(node.gantt.title, tasks as never) });
    }
  }
}

export async function compileTemplate(
  t: Template,
  vars: Record<string, unknown>,
  opts: { slots?: Record<string, string | TemplateNode[]>; timezone?: string } = {}
): Promise<Compiled> {
  const tz = opts.timezone ?? "UTC";
  const ctx = resolveVariables(t, vars, tz);
  for (const s of Object.keys(opts.slots ?? {})) if (!JSON.stringify(t).includes(`"slot":"${s}"`)) throw new TemplateError([`This template has no slot "${s}".`]);
  const st: CompileState = { t, slots: opts.slots ?? {}, tz, problems: [], charts: [], views: [], notes: [], reads: 0, blocks: 0, ds: new Map() };
  const specs: BlockSpec[] = [];
  await compileNodes(t.blocks, ctx, st, 0, [], true, specs);
  const title = String(interpolate(t.title, ctx, st.problems, "title"));
  if (st.problems.length) throw new TemplateError(st.problems);
  return { title, ...(t.icon ? { icon: t.icon } : {}), specs, charts: st.charts, views: st.views, reads: st.reads, notes: st.notes };
}

/** Find a block list position from a chart's path, so its placeholder can be swapped. */
export function specAt(specs: BlockSpec[], p: number[]): { list: BlockSpec[]; index: number } {
  let list = specs;
  let i = 0;
  while (i < p.length - 1) {
    const host = list[p[i]];
    if (host.type === "toggle") {
      list = host.children as BlockSpec[];
      i += 1;
    } else if (host.type === "column_list") {
      list = (host.columns as BlockSpec[][])[p[i + 1]];
      i += 2;
    } else throw new Error(`Template path ${p.join(".")} doesn't lead to a block list.`);
  }
  return { list, index: p[p.length - 1] };
}

/** Order block paths element by element (numerically). */
export function comparePaths(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** One line per block, for previews and diffs. */
export function outline(specs: BlockSpec[], depth = 0): string[] {
  const lines: string[] = [];
  for (const s of specs) {
    const text = s.text ?? s.expression ?? (s.rows ? `${s.rows.length} rows` : "");
    lines.push(`${"  ".repeat(depth)}${s.type}${text ? `: ${String(text).replace(/\s+/g, " ").slice(0, 80)}` : ""}`);
    if (s.children) lines.push(...outline(s.children, depth + 1));
    if (s.columns) s.columns.forEach((c, i) => lines.push(`${"  ".repeat(depth + 1)}column ${i + 1}`, ...outline(c, depth + 2)));
  }
  return lines;
}

/** Line diff (longest common subsequence): what rendering would add or drop compared with an existing outline. */
export function diffLines(before: string[], after: string[]): { added: string[]; removed: string[]; unchanged: number } {
  const n = before.length;
  const m = after.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const added: string[] = [];
  const removed: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) removed.push(before[i++]);
    else added.push(after[j++]);
  }
  while (i < n) removed.push(before[i++]);
  while (j < m) added.push(after[j++]);
  return { added, removed, unchanged: lcs[0][0] };
}

/** Rough request count for writing a compiled template. */
export function estimateRequests(c: Compiled): number {
  const blocks = outline(c.specs).length;
  return 1 + Math.ceil(blocks / 100) + c.charts.length * 3 + c.views.length + c.charts.filter((x) => x.data_table).length;
}

// ---------- storage ----------

const file = () => path.join(homeDir(), "templates.json");
const parseStore = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected templates keyed by name");
  return raw as Record<string, unknown>;
};

/** Saved templates plus the built-in ones (a saved template with the same name replaces the built-in). */
export async function listTemplates(): Promise<{ template: Template; builtin: boolean }[]> {
  const saved = (await readJson(file(), parseStore, () => ({}))).data;
  const out = new Map<string, { template: Template; builtin: boolean }>();
  for (const raw of BUILTIN_TEMPLATES) {
    const t = templateSchema.parse(raw);
    out.set(t.name, { template: t, builtin: true });
  }
  for (const [name, raw] of Object.entries(saved)) {
    const parsed = templateSchema.safeParse(raw);
    if (parsed.success) out.set(name, { template: parsed.data, builtin: false });
  }
  return [...out.values()];
}

export async function getTemplate(name: string): Promise<Template> {
  const all = await listTemplates();
  const hit = all.find((x) => x.template.name === name);
  if (!hit) throw new Error(`No template "${name}". Templates: ${all.map((x) => x.template.name).join(", ")}.`);
  return hit.template;
}

export function parseTemplate(raw: unknown): Template {
  const r = templateSchema.safeParse(raw);
  if (!r.success) throw new TemplateError(r.error.issues.map((i) => `${i.path.join(".") || "template"}: ${i.message}`));
  return r.data;
}

export async function saveTemplate(t: Template): Promise<void> {
  await updateJson<Record<string, unknown>, null>(file(), parseStore, () => ({}), (all) => ({ data: { ...all, [t.name]: t }, result: null }));
}

export async function deleteTemplate(name: string): Promise<boolean> {
  return updateJson<Record<string, unknown>, boolean>(file(), parseStore, () => ({}), (all) => {
    if (!(name in all)) return { result: false };
    return { data: Object.fromEntries(Object.entries(all).filter(([k]) => k !== name)), result: true };
  });
}


// ---------- write ----------

export interface RenderResult {
  page_id: string;
  url?: string;
  blocks: number;
  charts: number;
  views: number;
  notes: string[];
}

/**
 * Write a compiled template: render and upload its charts into their placeholders, then create the page (under
 * `parent`) or append to `appendTo`, then add live views after the blocks they follow. Undo ops are pushed as it goes.
 */
export async function writeTemplate(
  c: Compiled,
  target: { parent: string } | { appendTo: string },
  undo: UndoOp[]
): Promise<RenderResult> {
  const notes = [...c.notes];
  const views = c.views.map((v) => ({ ...v }));
  // Deepest and latest first, so inserting a data toggle never shifts a placeholder still to be filled.
  const charts = [...c.charts].sort((a, b) => comparePaths(b.path, a.path));
  for (const ch of charts) {
    const { uploadId, notes: n, alt } = await renderAndUpload(ch.spec, ch.rows, ch.format);
    notes.push(...n.map((x) => `${ch.spec.title ?? ch.spec.type}: ${x}`));
    const { list, index } = specAt(c.specs, ch.path);
    list[index] = { type: "image", file_upload_id: uploadId, caption: ch.spec.title ?? alt.slice(0, 120) };
    if (ch.data_table) {
      list.splice(index + 1, 0, chartDataBlocks(alt, ch.rows));
      if (ch.path.length === 1) for (const v of views) if (v.after >= index) v.after++;
    }
  }

  let pageId: string;
  let url: string | undefined;
  if ("parent" in target) {
    const parent = normalizeId(target.parent);
    const page = await call(() =>
      createPage({
        parent: { page_id: parent },
        ...(c.icon ? { icon: { type: "emoji", emoji: c.icon } } : {}),
        properties: { title: { title: textToTitle(c.title) } },
      })
    );
    pageId = page.id;
    url = "url" in page ? page.url : undefined;
    undo.push({ kind: "page_trash", page_id: pageId, in_trash: true });
  } else pageId = normalizeId(target.appendTo);

  let ids: string[];
  try {
    ids = await appendSpecs(pageId, c.specs);
  } catch (e) {
    if (e instanceof PartialWriteError && !("parent" in target)) undo.push(...insertedBlocks(e.createdIds, pageId));
    throw e;
  }
  if (!("parent" in target)) undo.push(...insertedBlocks(ids, pageId));

  for (const v of views) {
    const ds = await resolveDataSource(v.database, v.data_source_name);
    const placement: Placement = { type: "page", page: pageId, ...(v.after >= 0 && ids[v.after] ? { after_block: ids[v.after] } : {}) };
    const made = await createView(ds, await databaseIdOf(ds), v.view, placement);
    undo.push(made.undo);
  }
  return { page_id: pageId, ...(url ? { url } : {}), blocks: outline(c.specs).length, charts: c.charts.length, views: views.length, notes };
}
