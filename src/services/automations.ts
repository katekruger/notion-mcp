// Polling automations: rules in automations/rules.json are evaluated as database queries and/or on a schedule.
// Matching rows get row actions through the same write paths the tools use; rule-level `then` actions (refresh a
// chart, build a report, create a page) run once per firing. Everything a run writes is one journal entry per rule.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DataSourceObjectResponse, PageObjectResponse } from "@notionhq/client";
import { z } from "zod";
import { call, isNotFound, normalizeId, notion } from "./notion.js";
import { appendSpecs, markdownToSpecs, PartialWriteError } from "./blocks.js";
import { blockSpecSchema } from "./specSchema.js";
import { forApi, fromInlineMarkdown, plain, textToTitle } from "./richtext.js";
import { buildWhereFilter, dataSourceTitle, resolveDataSource, resolvePropertyName, simplify, withFullProperties } from "./schema.js";
import { insertedBlocks, record, type UndoOp } from "./journal.js";
import { preparePayload, snapshot } from "./writes.js";
import { queryAll } from "./query.js";
import { homeDir } from "./files.js";
import { isDue, nextOccurrence, toCron } from "./schedule.js";
import { buildReport, chartSourceSchema, chartSpecSchema, refreshChart, ReportError, reportArgsShape, rowSchema } from "./visualops.js";
import { getChart } from "./chartstore.js";

// ---------- rules file ----------

const relativeSchema = z
  .object({
    property: z.string().describe('A date, created_time, or last_edited_time property, or "$created" / "$last_edited".'),
    older_than_days: z.number().nonnegative().optional(),
    newer_than_days: z.number().nonnegative().optional(),
  })
  .refine((r) => (r.older_than_days === undefined) !== (r.newer_than_days === undefined), {
    message: "Set exactly one of older_than_days or newer_than_days.",
  });

const actionSchema = z.union([
  z.object({ set: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ append: z.union([z.string(), z.array(blockSpecSchema)]) }).strict(),
  z.object({ comment: z.string().min(1) }).strict(),
  z.object({ trash: z.literal(true) }).strict(),
]);

const chartRecipeSchema = z
  .object({
    block_id: z.string(),
    chart: chartSpecSchema,
    source: chartSourceSchema.optional(),
    data: z.array(rowSchema).optional(),
  })
  .strict()
  .refine((r) => Boolean(r.source) !== Boolean(r.data), { message: "A chart recipe needs `source` or `data`." });

const thenSchema = z.union([
  z
    .object({
      refresh_chart: z
        .union([z.string(), chartRecipeSchema])
        .describe("Image block made by notion_create_chart or a report. Saved rules carry the chart's recipe so any machine can redraw it."),
    })
    .strict(),
  z
    .object({
      build_report: z
        .object({ ...reportArgsShape, replace_previous: z.boolean().default(true).describe("Trash the report this rule built last time.") })
        .strict(),
    })
    .strict(),
  z
    .object({
      create_page: z
        .object({
          parent: z.string().describe("Page or database."),
          title: z.string(),
          template: z.string().optional(),
          properties: z.record(z.string(), z.unknown()).optional(),
          markdown: z.string().optional(),
        })
        .strict(),
    })
    .strict(),
]);

export const ruleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, digits, and dashes."),
    name: z.string().optional(),
    enabled: z.boolean().default(true),
    schedule: z
      .string()
      .optional()
      .describe('When to run: "hourly", "daily 09:00", "weekdays 09:00", "weekly mon 09:00", "monthly 1 09:00", or cron. Omit to check every run.'),
    database: z.string().optional().describe("Database URL/id or data source id (needed with `when`)."),
    data_source_name: z.string().optional(),
    when: z
      .object({
        where: z.record(z.string(), z.unknown()).optional(),
        filter: z.record(z.string(), z.unknown()).optional(),
        relative: z.array(relativeSchema).optional(),
      })
      .refine((w) => w.where || w.filter || w.relative?.length, { message: "A rule needs at least one condition." })
      .optional(),
    actions: z.array(actionSchema).default([]).describe("Applied to every matching row."),
    then: z.array(thenSchema).default([]).describe("Run once per firing, after the row actions (only if a row was acted on, when there's a `when`)."),
    marker: z
      .string()
      .optional()
      .describe("Checkbox property the runner sets after acting, and requires to be unchecked, so actions run once per row."),
    allow_new_options: z.boolean().default(false),
    limit: z.number().int().min(1).max(500).default(50).describe("Max rows acted on per run; the rest wait for the next run."),
  })
  .superRefine((r, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (r.schedule) {
      try {
        toCron(r.schedule);
      } catch (e) {
        issue((e as Error).message);
      }
    }
    if (r.when && !r.database) issue("A rule with `when` needs `database`.");
    if (!r.when && !r.schedule) issue("A rule needs a `when` condition, a `schedule`, or both.");
    if (r.actions.length && !r.when) issue("Row `actions` need a `when` condition to pick the rows; use `then` for actions that don't act on rows.");
    if (!r.actions.length && !r.then.length) issue("A rule needs `actions` (per row) or `then` (once per run).");
    if (r.when && !r.actions.length && !r.schedule) {
      issue("A rule with only `then` actions and a `when` condition would fire every run while rows match; add a `schedule`.");
    }
  });
export type Rule = z.infer<typeof ruleSchema>;
export type Action = z.infer<typeof actionSchema>;
export type ThenAction = z.infer<typeof thenSchema>;

export const rulesFileSchema = z.object({
  version: z.literal(1),
  timezone: z
    .string()
    .default("UTC")
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "Not a valid IANA time zone, e.g. America/New_York.")
    .describe("IANA zone used for schedules and {{today}}."),
  rules: z.array(ruleSchema),
});
export type RulesFile = z.infer<typeof rulesFileSchema>;

/** Rules live in the repo so the scheduled workflow and local edits share one file. */
export function rulesPath(): string {
  if (process.env.NOTION_PLUS_RULES) return path.resolve(process.env.NOTION_PLUS_RULES);
  // dist/services/automations.js and src/services/automations.ts both sit two levels below the repo root.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "automations", "rules.json");
}

export async function loadRules(file = rulesPath()): Promise<RulesFile> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return { version: 1, timezone: "UTC", rules: [] };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} isn't valid JSON: ${(e as Error).message}`);
  }
  const parsed = rulesFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${file} is invalid:\n- ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n- ")}`);
  }
  const ids = new Set<string>();
  for (const r of parsed.data.rules) {
    if (ids.has(r.id)) throw new Error(`${file}: duplicate rule id "${r.id}".`);
    ids.add(r.id);
  }
  return parsed.data;
}

export async function saveRules(data: RulesFile, file = rulesPath()): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await fs.rename(tmp, file);
}

// ---------- run state ----------

export interface RuleState {
  /** The scheduled occurrence this rule last fired for. */
  last_fired?: string;
  /** Report page this rule built last (for build_report replace_previous). */
  last_report_page?: string;
}
interface StateFile {
  rules: Record<string, RuleState>;
}

export function statePath(): string {
  return process.env.NOTION_PLUS_STATE ? path.resolve(process.env.NOTION_PLUS_STATE) : path.join(homeDir(), "automation-state.json");
}

export async function loadState(): Promise<StateFile> {
  try {
    const s = JSON.parse(await fs.readFile(statePath(), "utf8")) as StateFile;
    return { rules: s.rules ?? {} };
  } catch {
    return { rules: {} };
  }
}

async function saveState(state: StateFile): Promise<void> {
  await fs.mkdir(path.dirname(statePath()), { recursive: true });
  const tmp = statePath() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, statePath());
}

export function runLogPath(): string {
  return path.join(homeDir(), "automation-runs.jsonl");
}

// ---------- templates ----------

export interface TemplateContext {
  now: Date;
  timezone: string;
  page?: PageObjectResponse;
}

/** YYYY-MM-DD for `now` in the given IANA zone. */
export function isoDate(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function templateValue(key: string, ctx: TemplateContext): string {
  if (key === "today") return isoDate(ctx.now, ctx.timezone);
  if (key === "now") return ctx.now.toISOString();
  if (key.startsWith("page.")) {
    if (!ctx.page) throw new Error(`{{${key}}} needs a row; it can't be used in \`then\` actions.`);
    const name = key.slice(5);
    if (name === "id") return ctx.page.id;
    if (name === "url") return ctx.page.url;
    const prop = ctx.page.properties[name];
    if (!prop) throw new Error(`{{${key}}}: the row has no property "${name}".`);
    const v = simplify(prop);
    return v === null || v === undefined ? "" : Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  throw new Error(`Unknown template {{${key}}}. Use {{today}}, {{now}}, {{page.<Property>}}, {{page.id}}, or {{page.url}}.`);
}

/** Fill {{…}} placeholders in every string inside a value. */
export function render<T>(value: T, ctx: TemplateContext): T {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, key: string) => templateValue(key, ctx)) as T;
  }
  if (Array.isArray(value)) return value.map((v) => render(v, ctx)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, render(v, ctx)])) as T;
  }
  return value;
}

// ---------- conditions ----------

type When = NonNullable<Rule["when"]>;

/** Turn relative-date conditions into Notion filters, computed against `now`. */
export function relativeFilters(ds: DataSourceObjectResponse, relative: When["relative"], now: Date): Record<string, unknown>[] {
  return (relative ?? []).map((r) => {
    const days = (r.older_than_days ?? r.newer_than_days) as number;
    const edge = new Date(now.getTime() - days * 86_400_000).toISOString();
    const cmp = r.older_than_days !== undefined ? { before: edge } : { on_or_after: edge };
    if (r.property === "$created") return { timestamp: "created_time", created_time: cmp };
    if (r.property === "$last_edited") return { timestamp: "last_edited_time", last_edited_time: cmp };
    const { name } = resolvePropertyName(ds, r.property);
    const type = ds.properties[name].type;
    if (type === "date") return { property: name, date: cmp };
    if (type === "created_time" || type === "last_edited_time") return { timestamp: type, [type]: cmp };
    throw new Error(`"${name}" is a ${type} property; relative conditions need a date, created_time, or last_edited_time property.`);
  });
}

/** Property names a raw Notion filter refers to. */
function filterProperties(filter: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(filter)) filter.forEach((f) => filterProperties(f, out));
  else if (filter && typeof filter === "object") {
    const o = filter as Record<string, unknown>;
    if (typeof o.property === "string") out.add(o.property);
    Object.values(o).forEach((v) => filterProperties(v, out));
  }
  return out;
}

function norm(v: unknown): string {
  return typeof v === "string" ? v.toLowerCase().replace(/[^a-z0-9]/g, "") : JSON.stringify(v);
}

const isEmptyValue = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/**
 * Whether a value written by the rule still satisfies the condition on that property.
 * true: still matches (would loop); false: no longer matches; null: can't tell (dates, numbers, raw filters).
 */
export function stillMatches(condition: unknown, written: unknown): boolean | null {
  if (typeof written === "string" && written.includes("{{")) return isEmptyValue(condition) ? false : null;
  if (condition === null || condition === "") return isEmptyValue(written);
  if (condition === undefined) return null;
  if (typeof condition !== "object" || Array.isArray(condition)) return norm(condition) === norm(written);
  let verdict: boolean | null = true;
  for (const [op, v] of Object.entries(condition as Record<string, unknown>)) {
    let r: boolean | null;
    switch (op) {
      case "=": case "==": case "is": case "equals":
        r = norm(v) === norm(written);
        break;
      case "!=": case "not": case "is_not": case "does_not_equal":
        r = norm(v) !== norm(written);
        break;
      case "in":
        r = Array.isArray(v) ? v.some((x) => norm(x) === norm(written)) : null;
        break;
      case "not_in":
        r = Array.isArray(v) ? !v.some((x) => norm(x) === norm(written)) : null;
        break;
      case "is_empty":
        r = v === false ? !isEmptyValue(written) : isEmptyValue(written);
        break;
      case "is_not_empty":
        r = !isEmptyValue(written);
        break;
      default:
        r = null;
    }
    if (r === false) return false;
    if (r === null) verdict = null;
  }
  return verdict;
}

/**
 * A polling rule must stop matching a row once it has acted on it, or it would act again every run.
 * That holds when it trashes the row, uses a marker, or writes a value its condition no longer matches.
 * Returns a reason when the rule can't be shown to stop matching.
 */
export function selfClearingProblem(ds: DataSourceObjectResponse, rule: Rule): string | null {
  if (!rule.when || rule.actions.length === 0) return null;
  if (rule.marker) return null;
  if (rule.actions.some((a) => "trash" in a)) return null;
  const condition = new Map<string, unknown>();
  for (const [k, v] of Object.entries(rule.when.where ?? {})) {
    if (k === "or" || k === "and") continue;
    condition.set(k.startsWith("$") ? k : resolvePropertyName(ds, k).name, v);
  }
  for (const k of filterProperties(rule.when.filter)) if (!condition.has(k)) condition.set(resolvePropertyName(ds, k).name, undefined);
  for (const r of rule.when.relative ?? []) {
    if (!r.property.startsWith("$")) condition.set(resolvePropertyName(ds, r.property).name, undefined);
  }
  for (const a of rule.actions) {
    if (!("set" in a)) continue;
    for (const [k, v] of Object.entries(a.set)) {
      const name = resolvePropertyName(ds, k).name;
      if (!condition.has(name)) continue;
      // Raw filters and relative dates can't be evaluated here; changing the property they check is taken as clearing.
      const verdict = condition.get(name) === undefined ? false : stillMatches(condition.get(name), v);
      if (verdict === false) return null;
    }
  }
  return (
    `Rule "${rule.id}" would match the same rows again on every run: none of its actions writes a value its condition ` +
    'stops matching. Set a property the condition checks to a value outside the condition, trash the row, or add ' +
    '"marker": "<checkbox property>" so each row is handled once.'
  );
}

/** Validate a rule against the live schema: property names, set values, templates, and self-clearing. */
export async function checkRule(
  rule: Rule,
  timezone: string,
  now = new Date()
): Promise<{ ds: DataSourceObjectResponse | null; filter: Record<string, unknown> | null }> {
  if (!rule.when) {
    await checkThen(rule);
    return { ds: null, filter: null };
  }
  const ds = await resolveDataSource(rule.database as string, rule.data_source_name);
  if (rule.marker) {
    const { name } = resolvePropertyName(ds, rule.marker);
    if (ds.properties[name].type !== "checkbox") throw new Error(`Marker "${name}" must be a checkbox property.`);
  }
  const problem = selfClearingProblem(ds, rule);
  if (problem) throw new Error(problem);
  for (const a of rule.actions) {
    if ("set" in a) {
      // Validate names and static values now; page templates are checked per row.
      const staticOnly = Object.fromEntries(Object.entries(a.set).filter(([, v]) => !JSON.stringify(v).includes("{{page.")));
      await preparePayload(ds, render(staticOnly, { now, timezone }), rule.allow_new_options);
    }
  }
  await checkThen(rule);
  return { ds, filter: await buildFilter(ds, rule.when, rule.marker, now) };
}

async function checkThen(rule: Rule): Promise<void> {
  for (const t of rule.then) {
    if ("refresh_chart" in t) {
      if (typeof t.refresh_chart === "string" && !(await getChart(normalizeId(t.refresh_chart)))) {
        throw new Error(
          `refresh_chart: block ${t.refresh_chart} isn't a chart made by notion_create_chart or a report on this machine, and the rule doesn't carry its recipe.`
        );
      }
    } else if ("build_report" in t) {
      await resolveDataSource(t.build_report.database, t.build_report.data_source_name);
    } else if ("create_page" in t) {
      normalizeId(t.create_page.parent);
    }
  }
}

async function buildFilter(ds: DataSourceObjectResponse, when: When, marker: string | undefined, now: Date): Promise<Record<string, unknown>> {
  const clauses: Record<string, unknown>[] = [];
  if (when.where) {
    const w = await buildWhereFilter(ds, when.where);
    if (w) clauses.push(w);
  }
  if (when.filter) clauses.push(when.filter);
  clauses.push(...relativeFilters(ds, when.relative, now));
  if (marker) clauses.push({ property: resolvePropertyName(ds, marker).name, checkbox: { equals: false } });
  return clauses.length === 1 ? clauses[0] : { and: clauses };
}

// ---------- running ----------

function pageTitle(page: PageObjectResponse): string {
  const t = Object.values(page.properties).find((p) => p.type === "title");
  return t && t.type === "title" ? plain(t.title) || "(untitled)" : "(untitled)";
}

function describeAction(a: Action): string {
  if ("set" in a) return `set ${Object.entries(a.set).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")}`;
  if ("append" in a) return typeof a.append === "string" ? `append "${a.append.slice(0, 60)}"` : `append ${a.append.length} blocks`;
  if ("comment" in a) return `comment "${a.comment.slice(0, 60)}"`;
  return "trash";
}

function describeThen(t: ThenAction): string {
  if ("refresh_chart" in t) return `refresh chart ${typeof t.refresh_chart === "string" ? t.refresh_chart : t.refresh_chart.block_id}`;
  if ("build_report" in t) return `build report "${t.build_report.title ?? "report"}"${t.build_report.replace_previous ? " (replacing the last one)" : ""}`;
  return `create page "${t.create_page.title}"`;
}

export interface RuleResult {
  rule: string;
  database: string;
  dry_run: boolean;
  /** Set when a schedule isn't due: why the rule didn't run. */
  skipped?: string;
  next_run?: string;
  matched: number;
  more_waiting: boolean;
  acted: number;
  rows: { id: string; title: string; actions: string[]; error?: string }[];
  then: { action: string; result?: string; error?: string }[];
  undo_id?: string;
  error?: string;
}

export interface RunOptions {
  dryRun: boolean;
  now?: Date;
  /** Run scheduled rules even if they aren't due (manual runs). */
  force?: boolean;
  /** Stop writing once this many rows have been acted on across the run. */
  budget?: { remaining: number };
  state?: StateFile;
}

/** Scheduled rules fire for an occurrence once; with no record, only for an occurrence within this window. */
const CATCH_UP_MS = 70 * 60_000;

async function runThen(t: ThenAction, ctx: TemplateContext, rule: Rule, state: RuleState, undo: UndoOp[]): Promise<string> {
  if ("refresh_chart" in t) {
    const rc = t.refresh_chart;
    const r = await refreshChart(
      typeof rc === "string" ? { block_id: rc } : { block_id: rc.block_id, chart: rc.chart, ...(rc.source ? { source: rc.source } : {}), ...(rc.data ? { data: rc.data } : {}) }
    );
    undo.push(...r.undo);
    return `redrew ${r.points} points`;
  }
  if ("build_report" in t) {
    const { replace_previous, ...args } = render(t.build_report, ctx);
    let r;
    try {
      r = await buildReport(args);
    } catch (e) {
      if (e instanceof ReportError) undo.push(...e.undo);
      throw e;
    }
    undo.push(...r.undo);
    if (replace_previous && state.last_report_page) {
      try {
        await call(() => notion().pages.update({ page_id: state.last_report_page as string, in_trash: true } as never));
        undo.push({ kind: "page_trash", page_id: state.last_report_page, in_trash: false });
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    }
    state.last_report_page = r.page_id;
    return `report ${r.url ?? r.page_id}`;
  }
  const c = render(t.create_page, ctx);
  let ds: DataSourceObjectResponse | null = null;
  try {
    ds = await resolveDataSource(c.parent);
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  const body: Record<string, unknown> = {};
  if (ds) {
    const titleProp = Object.values(ds.properties).find((p) => p.type === "title")?.name as string;
    const { payload } = await preparePayload(ds, { ...(c.properties ?? {}), [titleProp]: c.title }, rule.allow_new_options);
    body.parent = { type: "data_source_id", data_source_id: ds.id };
    body.properties = payload;
    if (c.template) {
      const { resolveTemplate } = await import("../tools/pages.js");
      body.template = await resolveTemplate(ds.id, c.template);
    }
  } else {
    if (c.template || c.properties) throw new Error("create_page: templates and properties need a database parent.");
    body.parent = { type: "page_id", page_id: normalizeId(c.parent) };
    body.properties = { title: { title: textToTitle(c.title) } };
  }
  const created = await call(() => notion().pages.create(body as never));
  undo.push({ kind: "page_trash", page_id: created.id, in_trash: true });
  if (c.markdown) await appendSpecs(created.id, markdownToSpecs(c.markdown));
  return `page ${"url" in created ? created.url : created.id}`;
}

/** Evaluate one rule. Dry runs only read; real runs write and record one journal entry for the rule. */
export async function runRule(rule: Rule, timezone: string, opts: RunOptions): Promise<RuleResult> {
  const now = opts.now ?? new Date();
  const result: RuleResult = { rule: rule.id, database: rule.database ?? "", dry_run: opts.dryRun, matched: 0, more_waiting: false, acted: 0, rows: [], then: [] };
  const state = opts.state ?? { rules: {} };
  const rs = (state.rules[rule.id] ??= {});

  let occurrence: Date | null = null;
  if (rule.schedule) {
    const cron = toCron(rule.schedule);
    const due = isDue(rule.schedule, now, timezone, rs.last_fired, CATCH_UP_MS);
    occurrence = due.occurrence;
    const next = nextOccurrence(cron, now, timezone);
    if (next) result.next_run = next.toISOString();
    if (!due.due && !opts.force) {
      result.skipped = rs.last_fired
        ? `not due (last ran for ${rs.last_fired}; next ${next?.toISOString() ?? "unknown"})`
        : `not due (next ${next?.toISOString() ?? "unknown"})`;
      return result;
    }
  }

  let ds: DataSourceObjectResponse | null;
  let filter: Record<string, unknown> | null;
  try {
    ({ ds, filter } = await checkRule(rule, timezone, now));
    if (ds) result.database = dataSourceTitle(ds);
  } catch (e) {
    result.error = (e as Error).message;
    return result;
  }

  const undo: UndoOp[] = [];
  if (ds && filter) {
    const { pages, more } = await queryAll(ds.id, { filter, max: rule.limit });
    result.matched = pages.length;
    result.more_waiting = more;
    // Order within a row: property writes, content, comment, then trash last so earlier actions can still reach it.
    const ordered = [...rule.actions].sort((a, b) => rank(a) - rank(b));
    const markerName = rule.marker ? resolvePropertyName(ds, rule.marker).name : null;
    for (const page of pages) {
      const ctx: TemplateContext = { now, timezone, page };
      const row = { id: page.id, title: pageTitle(page), actions: ordered.map((a) => describeAction(render(a, ctx))) as string[] } as RuleResult["rows"][number];
      if (markerName) row.actions.push(`check ${markerName}`);
      result.rows.push(row);
      if (opts.dryRun) continue;
      if (opts.budget && opts.budget.remaining <= 0) {
        row.error = "skipped: run write budget used up";
        result.more_waiting = true;
        continue;
      }
      try {
        const values: Record<string, unknown> = {};
        for (const a of ordered) if ("set" in a) Object.assign(values, render(a.set, ctx));
        if (markerName) values[markerName] = true;
        if (Object.keys(values).length) {
          const { payload } = await preparePayload(ds, values, rule.allow_new_options);
          const names = Object.keys(payload);
          undo.push(snapshot(await withFullProperties(page, names), names));
          await call(() => notion().pages.update({ page_id: page.id, properties: payload } as never));
        }
        for (const a of ordered) {
          if ("append" in a) {
            const content = render(a.append, ctx);
            const specs = typeof content === "string" ? markdownToSpecs(content) : content;
            let ids: string[];
            try {
              ids = await appendSpecs(page.id, specs);
            } catch (e) {
              if (e instanceof PartialWriteError) undo.push(...insertedBlocks(e.createdIds, page.id));
              throw e;
            }
            undo.push(...insertedBlocks(ids, page.id));
          } else if ("comment" in a) {
            const text = render(a.comment, ctx);
            const c = await call(() => notion().comments.create({ parent: { page_id: page.id }, rich_text: forApi(fromInlineMarkdown(text)) } as never));
            undo.push({ kind: "comment_delete", comment_id: c.id });
          } else if ("trash" in a) {
            await call(() => notion().pages.update({ page_id: page.id, in_trash: true } as never));
            undo.push({ kind: "page_trash", page_id: page.id, in_trash: false });
          }
        }
        result.acted++;
        if (opts.budget) opts.budget.remaining--;
      } catch (e) {
        row.error = (e as Error).message;
      }
    }
  }

  // Rule-level actions: once per firing; with a condition, only when rows were acted on (or would be, in a dry run).
  const rowsHappened = !rule.when || (opts.dryRun ? result.matched > 0 : result.acted > 0);
  if (rule.then.length && rowsHappened) {
    const ctx: TemplateContext = { now, timezone };
    for (const t of rule.then) {
      let described: string;
      try {
        described = describeThen(render(t, ctx));
      } catch {
        described = describeThen(t);
      }
      const entry: RuleResult["then"][number] = { action: described };
      result.then.push(entry);
      if (opts.dryRun) continue;
      try {
        entry.result = await runThen(t, ctx, rule, rs, undo);
      } catch (e) {
        entry.error = (e as Error).message;
      }
    }
  }

  if (!opts.dryRun) {
    if (undo.length) {
      const what = [result.acted ? `acted on ${result.acted} rows` : "", result.then.length ? `ran ${result.then.length} follow-up action(s)` : ""].filter(Boolean).join(" and ");
      result.undo_id = await record("automations", `Rule "${rule.id}" ${what || "ran"}${result.database ? ` in "${result.database}"` : ""}`, undo);
    }
    // A scheduled rule counts as fired once it ran without a rule-level error, even if some rows failed.
    if (rule.schedule && occurrence) rs.last_fired = occurrence.toISOString();
  }
  return result;
}

function rank(a: Action): number {
  return "set" in a ? 0 : "append" in a ? 1 : "comment" in a ? 2 : 3;
}

/** Run every enabled rule (or one by id). A failing rule is reported and the rest still run. */
export async function runAll(opts: RunOptions & { ruleId?: string; maxWrites?: number; file?: string }): Promise<RuleResult[]> {
  const data = await loadRules(opts.file);
  const rules = opts.ruleId ? data.rules.filter((r) => r.id === opts.ruleId) : data.rules.filter((r) => r.enabled);
  if (opts.ruleId && rules.length === 0) throw new Error(`No rule "${opts.ruleId}". Rules: ${data.rules.map((r) => r.id).join(", ") || "(none)"}.`);
  const budget = { remaining: opts.maxWrites ?? 200 };
  const state = await loadState();
  const results: RuleResult[] = [];
  for (const rule of rules) {
    try {
      results.push(await runRule(rule, data.timezone, { ...opts, budget, state }));
    } catch (e) {
      results.push({ rule: rule.id, database: rule.database ?? "", dry_run: opts.dryRun, matched: 0, more_waiting: false, acted: 0, rows: [], then: [], error: (e as Error).message });
    }
  }
  if (!opts.dryRun) await saveState(state);
  await appendRunLog(opts, results);
  return results;
}

async function appendRunLog(opts: RunOptions, results: RuleResult[]): Promise<void> {
  const line = {
    at: (opts.now ?? new Date()).toISOString(),
    dry_run: opts.dryRun,
    ...(opts.force ? { forced: true } : {}),
    rules: results.map((r) => ({
      rule: r.rule,
      ...(r.skipped ? { skipped: r.skipped } : {}),
      matched: r.matched,
      acted: r.acted,
      then: r.then.map((t) => (t.error ? `${t.action}: failed` : t.action)),
      failed_rows: r.rows.filter((x) => x.error && !x.error.startsWith("skipped")).length,
      ...(r.undo_id ? { undo_id: r.undo_id } : {}),
      ...(r.error ? { error: r.error } : {}),
    })),
  };
  try {
    await fs.mkdir(homeDir(), { recursive: true });
    await fs.appendFile(runLogPath(), JSON.stringify(line) + "\n");
  } catch {
    // The run log is a convenience; a write failure shouldn't fail the run.
  }
}

/**
 * Copy each refreshed chart's recipe from this machine's chart store into the rule, so the rule works on any
 * machine (such as the GitHub Actions runner). Returns the rule unchanged when there's nothing to embed.
 */
export async function embedChartRecipes(rule: Rule): Promise<{ rule: Rule; embedded: string[] }> {
  const embedded: string[] = [];
  const then: ThenAction[] = [];
  for (const t of rule.then) {
    if ("refresh_chart" in t && typeof t.refresh_chart === "string") {
      const stored = await getChart(normalizeId(t.refresh_chart));
      if (stored) {
        embedded.push(stored.block_id);
        then.push({ refresh_chart: { block_id: stored.block_id, chart: stored.spec, ...(stored.source ? { source: stored.source } : { data: stored.data ?? [] }) } });
        continue;
      }
    }
    then.push(t);
  }
  return { rule: embedded.length ? { ...rule, then } : rule, embedded };
}

/** Markdown summary used for the CLI, the MCP tool, and the GitHub Actions job summary. */
export function summarize(results: RuleResult[]): string {
  if (results.length === 0) return "No enabled rules.";
  const lines: string[] = [];
  for (const r of results) {
    if (r.error) {
      lines.push(`### ${r.rule}: error\n${r.error}`);
      continue;
    }
    if (r.skipped) {
      lines.push(`### ${r.rule}: ${r.skipped}`);
      continue;
    }
    const verb = r.dry_run ? `would act on ${r.matched}` : `acted on ${r.acted} of ${r.matched}`;
    lines.push(
      `### ${r.rule}${r.database ? ` (${r.database})` : ""}: ${verb} rows` +
        `${r.more_waiting ? " (more waiting for the next run)" : ""}${r.undo_id ? `, undo_id \`${r.undo_id}\`` : ""}`
    );
    for (const row of r.rows.slice(0, 50)) {
      lines.push(`- ${row.title} (${row.id}): ${row.actions.join("; ")}${row.error ? ` **failed: ${row.error}**` : ""}`);
    }
    if (r.rows.length > 50) lines.push(`- …and ${r.rows.length - 50} more`);
    for (const t of r.then) lines.push(`- then ${r.dry_run ? "would " : ""}${t.action}${t.result ? `: ${t.result}` : ""}${t.error ? ` **failed: ${t.error}**` : ""}`);
  }
  return lines.join("\n");
}

/** True when any rule or row failed (for the CLI exit code and the failure notification). */
export function anyFailed(results: RuleResult[]): boolean {
  return results.some((r) => r.error || r.rows.some((row) => row.error && !row.error.startsWith("skipped")) || r.then.some((t) => t.error));
}
