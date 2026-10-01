// Polling automations: rules (rules.json in the home folder, or NOTION_PLUS_RULES) are evaluated as database queries and/or on a schedule.
// Matching rows get row actions through the same write paths the tools use; rule-level `then` actions (refresh a
// chart, build a report, create a page) run once per firing. Everything a run writes is one journal entry per rule.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DataSourceObjectResponse, PageObjectResponse } from "@notionhq/client";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { call, isNotFound, normalizeId, notion, requestCount, updatePage } from "./notion.js";
import { log } from "./log.js";
import { removeLeftovers } from "./workflow/actions.js";
import { appendSpecs, markdownToSpecs, PartialWriteError } from "./blocks.js";
import { blockSpecSchema } from "./specSchema.js";
import { forApi, fromInlineMarkdown, plain, textToTitle } from "./richtext.js";
import { buildWhereFilter, dataSourceTitle, resolveDataSource, resolvePropertyName, simplify, withFullProperties } from "./schema.js";
import { insertedBlocks, record, type UndoOp } from "./journal.js";
import { preparePayload, snapshot } from "./writes.js";
import { queryAll } from "./query.js";
import { readJson, revisionOf, updateJson, withLock, writeJson, type Loaded } from "./store.js";
import { stateDir } from "./workspace.js";
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

/**
 * Where rules live: NOTION_PLUS_RULES (the GitHub workflow points it at the repo's automations/rules.json), else
 * rules.json in the home folder, which survives reinstalling or upgrading the server.
 */
export function rulesPath(): string {
  if (process.env.NOTION_PLUS_RULES) return path.resolve(process.env.NOTION_PLUS_RULES);
  return path.join(homeDir(), "rules.json");
}

/** Whether rules are the repo's file, so edits need a commit to reach the scheduled workflow. */
export function rulesInRepo(): boolean {
  return Boolean(process.env.NOTION_PLUS_RULES) && path.resolve(process.env.NOTION_PLUS_RULES as string) === path.resolve(repoRulesPath());
}

/** The rules file next to the code (automations/rules.json in a checkout; empty in a bundle). */
export function repoRulesPath(): string {
  // dist/services/automations.js and src/services/automations.ts both sit two levels below the repo root.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "automations", "rules.json");
}

/**
 * Before 0.10, rules defaulted to the file next to the code. The first time the home folder has no rules file,
 * adopt that one if it has rules, so upgrading doesn't lose them.
 */
async function adoptRepoRules(file: string): Promise<void> {
  try {
    await fs.access(file);
    return;
  } catch {
    /* no rules file yet */
  }
  let legacy: RulesFile;
  try {
    legacy = await loadRulesWithRevision(repoRulesPath(), false).then((l) => l.data);
  } catch {
    return;
  }
  if (!legacy.rules.length) return;
  await withLock(file, async () => {
    try {
      await fs.access(file);
    } catch {
      await writeJson(file, legacy, { trailingNewline: true });
      log("info", "automation.rules_adopted", { from: repoRulesPath(), to: file, rules: legacy.rules.length });
    }
  });
}

function parseRules(file: string) {
  return (json: unknown): RulesFile => {
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
  };
}

const emptyRules = (): RulesFile => ({ version: 1, timezone: "UTC", rules: [] });

/** The rules file with its revision (a content hash), for edits that must not overwrite someone else's change. */
export async function loadRulesWithRevision(file = rulesPath(), adopt = true): Promise<Loaded<RulesFile>> {
  if (adopt && !process.env.NOTION_PLUS_RULES && file === rulesPath()) await adoptRepoRules(file);
  return readJson(file, parseRules(file), emptyRules);
}

export async function loadRules(file = rulesPath()): Promise<RulesFile> {
  return (await loadRulesWithRevision(file)).data;
}

/** Replace the whole rules file (under its lock). Prefer editRules, which applies a change to the current file. */
export async function saveRules(data: RulesFile, file = rulesPath()): Promise<string> {
  return withLock(file, () => writeJson(file, data, { trailingNewline: true }));
}

export class RulesConflictError extends Error {
  constructor(file: string, expected: string, actual: string | null) {
    super(`${file} changed since it was read (expected revision ${expected}, now ${actual ?? "missing"}). Read it again (action=list) and redo the change.`);
    this.name = "RulesConflictError";
  }
}

/**
 * Apply a change to the current rules file under its lock and return the new revision. With `expectedRevision`,
 * the change is refused if the file changed since that revision was read.
 */
export async function editRules(change: (data: RulesFile) => void, opts: { expectedRevision?: string; file?: string } = {}): Promise<string> {
  const file = opts.file ?? rulesPath();
  return withLock(file, async () => {
    const cur = await loadRulesWithRevision(file);
    if (opts.expectedRevision && opts.expectedRevision !== cur.revision) throw new RulesConflictError(file, opts.expectedRevision, cur.revision);
    change(cur.data);
    return writeJson(file, cur.data, { trailingNewline: true });
  });
}

// ---------- run state ----------

/** Progress on one row whose actions haven't all finished; the next run resumes after the steps in `done`. */
export interface RowCheckpoint {
  /** Revision of the rule the steps belong to; an edited rule starts the row over. */
  rule_rev: string;
  done: string[];
  attempts: number;
  run_id: string;
  last_error?: string;
  /** When the latest attempt started, so a retried append can find blocks the failed attempt left. */
  last_attempt_at?: string;
}

/** A firing whose `then` actions (or rows, for a schedule) haven't all finished. */
export interface PendingFiring {
  /** The scheduled occurrence (ISO time), or "rows:<run id>" for a condition rule's follow-up actions. */
  key: string;
  rule_rev: string;
  run_id: string;
  started: string;
  attempts: number;
  then_done: number[];
  /** The `then` actions were started (rows were acted on, or the rule has no condition). */
  then_started?: boolean;
  last_error?: string;
}

export type RunStatus = "succeeded" | "partial" | "failed" | "skipped";

export interface RuleState {
  /** The scheduled occurrence this rule last completed. Only advances when every step of it succeeded (or was waived). */
  last_fired?: string;
  /** Report page this rule built last (for build_report replace_previous). */
  last_report_page?: string;
  pending?: PendingFiring;
  rows?: Record<string, RowCheckpoint>;
  last_run?: { run_id: string; at: string; status: RunStatus };
}
export interface StateFile {
  rules: Record<string, RuleState>;
}

function parseState(raw: unknown): StateFile {
  const o = raw as { rules?: unknown } | null;
  if (!o || typeof o !== "object" || (o.rules !== undefined && (typeof o.rules !== "object" || o.rules === null || Array.isArray(o.rules)))) {
    throw new Error('expected {"rules": {...}}');
  }
  return { rules: (o.rules as Record<string, RuleState>) ?? {} };
}

export async function statePath(): Promise<string> {
  return process.env.NOTION_PLUS_STATE ? path.resolve(process.env.NOTION_PLUS_STATE) : path.join(await stateDir(), "automation-state.json");
}

/** Automation state. A corrupt or unreadable file stops here instead of reading as "nothing has fired yet". */
export async function loadState(): Promise<StateFile> {
  return (await readJson(await statePath(), parseState, () => ({ rules: {} }))).data;
}

/**
 * Save the rules this run touched, merged into the current file under its lock, so a run never erases what
 * another process recorded for other rules in the meantime.
 */
async function saveState(state: StateFile, touched: Iterable<string>): Promise<void> {
  const ids = [...touched];
  if (!ids.length) return;
  await updateJson<StateFile, null>(await statePath(), parseState, () => ({ rules: {} }), (cur) => {
    for (const id of ids) if (state.rules[id]) cur.rules[id] = state.rules[id];
    return { data: cur, result: null };
  });
}

export async function runLogPath(): Promise<string> {
  return path.join(await stateDir(), "automation-runs.jsonl");
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
/**
 * Properties a rule's condition checks, with the condition on each (undefined when it can't be evaluated here:
 * raw filters, relative dates, and anything inside or/and).
 */
export function conditionProperties(ds: DataSourceObjectResponse, when: When): Map<string, unknown> {
  const condition = new Map<string, unknown>();
  for (const [k, v] of Object.entries(when.where ?? {})) {
    if (k === "or" || k === "and") {
      for (const name of filterProperties(v)) if (!condition.has(name)) condition.set(safeName(ds, name), undefined);
      for (const sub of Array.isArray(v) ? v : [])
        for (const key of Object.keys((sub ?? {}) as object)) if (!key.startsWith("$") && key !== "or" && key !== "and") condition.set(safeName(ds, key), undefined);
      continue;
    }
    condition.set(k.startsWith("$") ? k : resolvePropertyName(ds, k).name, v);
  }
  for (const k of filterProperties(when.filter)) if (!condition.has(k)) condition.set(resolvePropertyName(ds, k).name, undefined);
  for (const r of when.relative ?? []) {
    if (!r.property.startsWith("$")) condition.set(resolvePropertyName(ds, r.property).name, undefined);
  }
  return condition;
}

function safeName(ds: DataSourceObjectResponse, name: string): string {
  try {
    return resolvePropertyName(ds, name).name;
  } catch {
    return name;
  }
}

export function selfClearingProblem(ds: DataSourceObjectResponse, rule: Rule): string | null {
  if (!rule.when || rule.actions.length === 0) return null;
  if (rule.marker) return null;
  if (rule.actions.some((a) => "trash" in a)) return null;
  const condition = conditionProperties(ds, rule.when);
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
  /**
   * succeeded: everything this firing needed is done. partial: some steps failed or were left for the next run
   * (they resume there). failed: nothing needed succeeded, or the rule couldn't run. skipped: not due.
   */
  status: RunStatus;
  /** Set when a schedule isn't due: why the rule didn't run. */
  skipped?: string;
  next_run?: string;
  /** The scheduled occurrence this run worked on. */
  occurrence?: string;
  matched: number;
  more_waiting: boolean;
  acted: number;
  rows: { id: string; title: string; actions: string[]; resumed?: string[]; error?: string }[];
  then: { action: string; result?: string; error?: string; done_earlier?: boolean }[];
  notes?: string[];
  undo_id?: string;
  error?: string;
}

/** Limits for one run across all rules. Anything past a limit is left for the next run. */
export interface RunLimits {
  /** Rows acted on. */
  max_rows?: number;
  /** Notion requests (reads and writes, retries included). */
  max_requests?: number;
  /** Blocks appended by `append` actions. */
  max_blocks?: number;
  max_minutes?: number;
}

export const DEFAULT_LIMITS: Required<RunLimits> = { max_rows: 200, max_requests: 3000, max_blocks: 5000, max_minutes: 20 };

export interface Budget {
  limits: Required<RunLimits>;
  rows: number;
  blocks: number;
  startRequests: number;
  deadline: number;
}

export function newBudget(limits: RunLimits = {}, now = Date.now()): Budget {
  const l = { ...DEFAULT_LIMITS, ...Object.fromEntries(Object.entries(limits).filter(([, v]) => v !== undefined)) } as Required<RunLimits>;
  return { limits: l, rows: 0, blocks: 0, startRequests: requestCount(), deadline: now + l.max_minutes * 60_000 };
}

/** Which limit is used up, if any. */
export function budgetExhausted(b: Budget): string | null {
  if (b.rows >= b.limits.max_rows) return `row limit (${b.limits.max_rows})`;
  if (requestCount() - b.startRequests >= b.limits.max_requests) return `request limit (${b.limits.max_requests})`;
  if (b.blocks >= b.limits.max_blocks) return `block limit (${b.limits.max_blocks})`;
  if (Date.now() >= b.deadline) return `time limit (${b.limits.max_minutes} min)`;
  return null;
}

export interface RunOptions {
  dryRun: boolean;
  now?: Date;
  /** Run scheduled rules even if they aren't due (manual runs). */
  force?: boolean;
  budget?: Budget;
  state?: StateFile;
  runId?: string;
  /** Save the state after each step, so a crash resumes where it stopped. */
  persist?: () => Promise<void>;
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
        await call(() => updatePage({ page_id: state.last_report_page as string, in_trash: true }));
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

interface RowStep {
  id: string;
  describe: string;
  run: () => Promise<void>;
}

const RESUME_NOTE = "(done in an earlier run)";

/**
 * Evaluate one rule. Dry runs only read. Real runs work through each row's steps in a fixed order, saving progress
 * after each: property writes that keep the row matching, then content and comments, then the writes that take the
 * row out of the rule's condition (its marker, or values the condition checks), then trash. So a row is only marked
 * handled once everything before it landed, and a failed row is picked up again next run, skipping the steps that
 * already succeeded. A scheduled occurrence only counts as fired when all of it succeeded.
 */
export async function runRule(rule: Rule, timezone: string, opts: RunOptions): Promise<RuleResult> {
  const now = opts.now ?? new Date();
  const runId = opts.runId ?? `run-${now.getTime().toString(36)}`;
  const result: RuleResult = { rule: rule.id, database: rule.database ?? "", dry_run: opts.dryRun, status: "succeeded", matched: 0, more_waiting: false, acted: 0, rows: [], then: [] };
  const state = opts.state ?? { rules: {} };
  const rs = (state.rules[rule.id] ??= {});
  const rev = revisionOf(JSON.stringify(rule));
  const persist = async () => {
    if (!opts.dryRun && opts.persist) await opts.persist();
  };
  const note = (n: string) => (result.notes ??= []).push(n);

  let occurrence: Date | null = null;
  if (rule.schedule) {
    const cron = toCron(rule.schedule);
    const due = isDue(rule.schedule, now, timezone, rs.last_fired, CATCH_UP_MS);
    occurrence = due.occurrence;
    // An unfinished occurrence stays due until it completes or a newer one arrives, however long ago it started
    // (with no fire history, isDue alone would give up on it after the catch-up window).
    if (!due.due && occurrence && rs.pending?.key === occurrence.toISOString()) due.due = true;
    const next = nextOccurrence(cron, now, timezone);
    if (next) result.next_run = next.toISOString();
    if (!due.due && !opts.force) {
      result.status = "skipped";
      result.skipped = rs.last_fired
        ? `not due (last ran for ${rs.last_fired}; next ${next?.toISOString() ?? "unknown"})`
        : `not due (next ${next?.toISOString() ?? "unknown"})`;
      return result;
    }
    if (occurrence) result.occurrence = occurrence.toISOString();
  }

  // Unfinished work from an earlier run: resume it if it's the same firing of the same rule, otherwise report it.
  let pending = rs.pending;
  if (pending && pending.rule_rev !== rev) {
    note(`The rule changed since firing ${pending.key} stopped part-way; its remaining follow-up actions were dropped.`);
    pending = undefined;
  } else if (pending && rule.schedule && occurrence && pending.key !== occurrence.toISOString() && !pending.key.startsWith("rows:")) {
    note(`Occurrence ${pending.key} didn't finish (${pending.last_error ?? "see earlier runs"}) and is superseded by ${occurrence.toISOString()}.`);
    pending = undefined;
  }
  if (!opts.dryRun && rs.pending !== pending) {
    if (pending) rs.pending = pending;
    else delete rs.pending;
  }

  let ds: DataSourceObjectResponse | null;
  let filter: Record<string, unknown> | null;
  try {
    ({ ds, filter } = await checkRule(rule, timezone, now));
    if (ds) result.database = dataSourceTitle(ds);
  } catch (e) {
    result.error = (e as Error).message;
    result.status = "failed";
    return result;
  }

  const undo: UndoOp[] = [];
  try {
    if (ds && filter) await runRows(rule, ds, filter, { now, timezone, runId, rev, rs, result, undo, opts, persist });

    // Rule-level actions: once per firing; with a condition, only when rows were acted on (or would be, in a dry run),
    // or when an earlier run acted on rows and its follow-up didn't finish.
    const rowsHappened = !rule.when || (opts.dryRun ? result.matched > 0 : result.acted > 0) || Boolean(pending?.then_started);
    if (rule.then.length && rowsHappened) {
      const key = pending?.key ?? (occurrence && !opts.force ? occurrence.toISOString() : `rows:${runId}`);
      const firing: PendingFiring = pending ?? { key, rule_rev: rev, run_id: runId, started: now.toISOString(), attempts: 0, then_done: [] };
      if (!opts.dryRun) {
        firing.attempts++;
        firing.then_started = true;
        rs.pending = firing;
        await persist();
      }
      const ctx: TemplateContext = { now, timezone };
      for (const [i, t] of rule.then.entries()) {
        let described: string;
        try {
          described = describeThen(render(t, ctx));
        } catch {
          described = describeThen(t);
        }
        const entry: RuleResult["then"][number] = { action: described };
        result.then.push(entry);
        if (firing.then_done.includes(i)) {
          entry.done_earlier = true;
          continue;
        }
        if (opts.dryRun) continue;
        try {
          entry.result = await runThen(t, ctx, rule, rs, undo);
          firing.then_done.push(i);
        } catch (e) {
          entry.error = (e as Error).message;
          firing.last_error = `${described}: ${entry.error}`;
        }
        await persist();
      }
    }
  } catch (e) {
    result.error = (e as Error).message;
  } finally {
    if (!opts.dryRun && undo.length) {
      const what = [result.acted ? `acted on ${result.acted} rows` : "", result.then.length ? `ran ${result.then.length} follow-up action(s)` : ""].filter(Boolean).join(" and ");
      result.undo_id = await record("automations", `Rule "${rule.id}" ${what || "ran"}${result.database ? ` in "${result.database}"` : ""}`, undo);
    }
  }

  result.status = ruleStatus(result);
  if (!opts.dryRun) {
    const complete = result.status === "succeeded";
    if (complete) {
      delete rs.pending;
      if (rule.schedule && occurrence) rs.last_fired = occurrence.toISOString();
    } else if (rule.schedule && occurrence && !rs.pending) {
      // Rows failed or were left over: remember the firing, so the next run retries it instead of moving on.
      rs.pending = { key: occurrence.toISOString(), rule_rev: rev, run_id: runId, started: now.toISOString(), attempts: 1, then_done: [], last_error: firstError(result) };
    } else if (rs.pending) {
      rs.pending.last_error = firstError(result) ?? rs.pending.last_error;
    }
    rs.last_run = { run_id: runId, at: now.toISOString(), status: result.status };
    await persist();
  }
  return result;
}

function firstError(r: RuleResult): string | undefined {
  if (r.error) return r.error;
  const row = r.rows.find((x) => x.error);
  if (row) return `${row.title}: ${row.error}`;
  const t = r.then.find((x) => x.error);
  return t ? `${t.action}: ${t.error}` : undefined;
}

/** Overall status of one rule's run (dry runs report what they would do as succeeded). */
export function ruleStatus(r: RuleResult): RunStatus {
  if (r.skipped) return "skipped";
  const rowFailures = r.rows.filter((x) => x.error && !x.error.startsWith("skipped")).length;
  const leftOver = r.rows.filter((x) => x.error?.startsWith("skipped")).length;
  const thenFailures = r.then.filter((t) => t.error).length;
  const thenOk = r.then.filter((t) => t.result || t.done_earlier).length;
  if (r.error) return r.acted || thenOk ? "partial" : "failed";
  if (!rowFailures && !thenFailures) return leftOver ? "partial" : "succeeded";
  return r.acted || thenOk ? "partial" : "failed";
}

interface RowContext {
  now: Date;
  timezone: string;
  runId: string;
  rev: string;
  rs: RuleState;
  result: RuleResult;
  undo: UndoOp[];
  opts: RunOptions;
  persist: () => Promise<void>;
  retrySince?: Map<string, string | undefined>;
}

async function runRows(rule: Rule, ds: DataSourceObjectResponse, filter: Record<string, unknown>, c: RowContext): Promise<void> {
  const { now, timezone, rs, result, opts } = c;
  const { pages, more } = await queryAll(ds.id, { filter, max: rule.limit });
  result.matched = pages.length;
  result.more_waiting = more;
  // Forget progress on rows that stopped matching (fixed by hand, or deleted), when we saw every matching row.
  if (!opts.dryRun && rs.rows && !more) {
    const seen = new Set(pages.map((p) => p.id));
    rs.rows = Object.fromEntries(Object.entries(rs.rows).filter(([id]) => seen.has(id)));
  }
  const markerName = rule.marker ? resolvePropertyName(ds, rule.marker).name : null;
  const checked = rule.when ? conditionProperties(ds, rule.when) : new Map<string, unknown>();
  const retrySince = new Map<string, string | undefined>();
  c.retrySince = retrySince;

  for (const page of pages) {
    const ctx: TemplateContext = { now, timezone, page };
    const steps = rowSteps(rule, ds, page, ctx, markerName, checked, c);
    const saved = rs.rows?.[page.id];
    const done = new Set(saved && saved.rule_rev === c.rev ? saved.done : []);
    const row: RuleResult["rows"][number] = {
      id: page.id,
      title: pageTitle(page),
      actions: steps.map((s) => (done.has(s.id) ? `${s.describe} ${RESUME_NOTE}` : s.describe)),
    };
    if (done.size) row.resumed = [...done];
    result.rows.push(row);
    if (opts.dryRun) continue;
    const limit = opts.budget ? budgetExhausted(opts.budget) : null;
    if (limit) {
      row.error = `skipped: run ${limit} reached; it runs next time`;
      result.more_waiting = true;
      continue;
    }
    const cp: RowCheckpoint = saved && saved.rule_rev === c.rev ? saved : { rule_rev: c.rev, done: [], attempts: 0, run_id: c.runId };
    // A row retried after a failure: appends clean up what the failed attempt may have left.
    retrySince.set(page.id, cp.attempts > 0 ? cp.last_attempt_at : undefined);
    cp.attempts++;
    cp.run_id = c.runId;
    cp.last_attempt_at = new Date().toISOString();
    try {
      for (const step of steps) {
        if (done.has(step.id)) continue;
        await step.run();
        cp.done.push(step.id);
        (rs.rows ??= {})[page.id] = cp;
        await c.persist();
      }
      if (rs.rows) rs.rows = Object.fromEntries(Object.entries(rs.rows).filter(([id]) => id !== page.id));
      result.acted++;
      if (opts.budget) opts.budget.rows++;
    } catch (e) {
      row.error = (e as Error).message;
      cp.last_error = row.error;
      (rs.rows ??= {})[page.id] = cp;
      log("warn", "automation.row_failed", { run_id: c.runId, rule: rule.id, row: page.id, step: steps.find((s) => !cp.done.includes(s.id))?.id, error: row.error });
    }
    await c.persist();
  }
  if (rs.rows && !Object.keys(rs.rows).length) delete rs.rows;
}

/** A row's actions as ordered steps (see runRule). Step ids name the action, so a resumed run skips the right ones. */
function rowSteps(
  rule: Rule,
  ds: DataSourceObjectResponse,
  page: PageObjectResponse,
  ctx: TemplateContext,
  markerName: string | null,
  checked: Map<string, unknown>,
  c: RowContext
): RowStep[] {
  const before: Record<string, unknown> = {};
  const commit: Record<string, unknown> = {};
  for (const a of rule.actions) {
    if (!("set" in a)) continue;
    for (const [k, v] of Object.entries(render(a.set, ctx))) {
      (checked.has(safeName(ds, k)) ? commit : before)[k] = v;
    }
  }
  if (markerName) commit[markerName] = true;
  const writeProps = async (values: Record<string, unknown>) => {
    const { payload } = await preparePayload(ds, values, rule.allow_new_options);
    const names = Object.keys(payload);
    c.undo.push(snapshot(await withFullProperties(page, names), names));
    await call(() => updatePage({ page_id: page.id, properties: payload }));
  };
  const describeSet = (v: Record<string, unknown>) => `set ${Object.entries(v).map(([k, x]) => `${k}=${JSON.stringify(x)}`).join(", ")}`;

  const steps: RowStep[] = [];
  if (Object.keys(before).length) steps.push({ id: "set", describe: describeSet(before), run: () => writeProps(before) });
  rule.actions.forEach((a, i) => {
    if ("append" in a) {
      const content = render(a.append, ctx);
      steps.push({
        id: `append:${i}`,
        describe: describeAction({ append: content }),
        run: async () => {
          const specs = typeof content === "string" ? markdownToSpecs(content) : content;
          const since = c.retrySince?.get(page.id);
          if (since) await removeLeftovers(page.id, specs, since);
          let ids: string[];
          try {
            ids = await appendSpecs(page.id, specs);
          } catch (e) {
            if (e instanceof PartialWriteError) c.undo.push(...insertedBlocks(e.createdIds, page.id));
            throw e;
          }
          c.undo.push(...insertedBlocks(ids, page.id));
          if (c.opts.budget) c.opts.budget.blocks += ids.length;
        },
      });
    }
  });
  rule.actions.forEach((a, i) => {
    if ("comment" in a) {
      const text = render(a.comment, ctx);
      steps.push({
        id: `comment:${i}`,
        describe: describeAction({ comment: text }),
        run: async () => {
          const cm = await call(() => notion().comments.create({ parent: { page_id: page.id }, rich_text: forApi(fromInlineMarkdown(text)) } as never));
          c.undo.push({ kind: "comment_delete", comment_id: cm.id });
        },
      });
    }
  });
  if (Object.keys(commit).length) {
    const shown = Object.fromEntries(Object.entries(commit).filter(([k]) => k !== markerName));
    const describe = [Object.keys(shown).length ? describeSet(shown) : "", markerName ? `check ${markerName}` : ""].filter(Boolean).join("; ");
    steps.push({ id: "commit", describe, run: () => writeProps(commit) });
  }
  if (rule.actions.some((a) => "trash" in a)) {
    steps.push({
      id: "trash",
      describe: "trash",
      run: async () => {
        await call(() => updatePage({ page_id: page.id, in_trash: true }));
        c.undo.push({ kind: "page_trash", page_id: page.id, in_trash: false });
      },
    });
  }
  return steps;
}

export interface RunReport {
  run_id: string;
  status: Exclude<RunStatus, "skipped">;
  results: RuleResult[];
  /** Problems that didn't stop the run (such as the run log not being written). */
  warnings: string[];
}

/** Run every enabled rule (or one by id). A failing rule is reported and the rest still run. */
export async function runAll(opts: RunOptions & { ruleId?: string; limits?: RunLimits; file?: string }): Promise<RunReport> {
  const now = opts.now ?? new Date();
  const runId = `run-${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
  const data = await loadRules(opts.file);
  const rules = opts.ruleId ? data.rules.filter((r) => r.id === opts.ruleId) : data.rules.filter((r) => r.enabled);
  if (opts.ruleId && rules.length === 0) throw new Error(`No rule "${opts.ruleId}". Rules: ${data.rules.map((r) => r.id).join(", ") || "(none)"}.`);
  const budget = newBudget(opts.limits);
  const state = await loadState();
  const warnings: string[] = [];
  const results: RuleResult[] = [];
  log("info", "automation.run_started", { run_id: runId, dry_run: opts.dryRun, rules: rules.map((r) => r.id) });
  for (const rule of rules) {
    try {
      results.push(
        await runRule(rule, data.timezone, { ...opts, now, runId, budget, state, persist: () => saveState(state, [rule.id]) })
      );
    } catch (e) {
      results.push({ rule: rule.id, database: rule.database ?? "", dry_run: opts.dryRun, status: "failed", matched: 0, more_waiting: false, acted: 0, rows: [], then: [], error: (e as Error).message });
    }
    const r = results[results.length - 1];
    log(r.status === "failed" ? "error" : r.status === "partial" ? "warn" : "info", "automation.rule_finished", {
      run_id: runId,
      rule: r.rule,
      status: r.status,
      matched: r.matched,
      acted: r.acted,
      ...(r.undo_id ? { undo_id: r.undo_id } : {}),
      ...(firstError(r) ? { error: firstError(r) } : {}),
    });
  }
  if (!opts.dryRun) await saveState(state, rules.map((r) => r.id));
  const status: RunReport["status"] = results.some((r) => r.status === "failed") ? "failed" : results.some((r) => r.status === "partial") ? "partial" : "succeeded";
  const report: RunReport = { run_id: runId, status, results, warnings };
  await appendRunLog(opts, report);
  log(status === "succeeded" ? "info" : "warn", "automation.run_finished", { run_id: runId, status, warnings });
  return report;
}

async function appendRunLog(opts: RunOptions, report: RunReport): Promise<void> {
  const line = {
    at: (opts.now ?? new Date()).toISOString(),
    run_id: report.run_id,
    status: report.status,
    dry_run: opts.dryRun,
    ...(opts.force ? { forced: true } : {}),
    rules: report.results.map((r) => ({
      rule: r.rule,
      status: r.status,
      ...(r.skipped ? { skipped: r.skipped } : {}),
      ...(r.occurrence ? { occurrence: r.occurrence } : {}),
      matched: r.matched,
      acted: r.acted,
      then: r.then.map((t) => (t.error ? `${t.action}: failed` : t.action)),
      failed_rows: r.rows.filter((x) => x.error && !x.error.startsWith("skipped")).length,
      ...(r.undo_id ? { undo_id: r.undo_id } : {}),
      ...(firstError(r) ? { error: firstError(r) } : {}),
    })),
  };
  try {
    await fs.appendFile(await runLogPath(), JSON.stringify(line) + "\n");
  } catch (e) {
    // The run's work is done; losing its log line is reported, not fatal.
    report.warnings.push(`The run log couldn't be written: ${(e as Error).message}`);
    log("warn", "automation.run_log_failed", { run_id: report.run_id, error: (e as Error).message });
  }
}

/**
 * Mark a rule's unfinished firing as handled without running the rest of it: the occurrence counts as fired, and
 * rows' saved progress is dropped (they start over if they still match). For when a failure can't be fixed or the
 * rest of the work was done by hand.
 */
export async function waive(ruleId: string): Promise<{ waived: string | null; rows: number }> {
  const file = await statePath();
  return updateJson<StateFile, { waived: string | null; rows: number }>(file, parseState, () => ({ rules: {} }), (cur) => {
    const rs = cur.rules[ruleId];
    if (!rs || (!rs.pending && !rs.rows)) return { result: { waived: null, rows: 0 } };
    const key = rs.pending?.key ?? null;
    if (key && !key.startsWith("rows:")) rs.last_fired = key;
    const rows = Object.keys(rs.rows ?? {}).length;
    delete rs.pending;
    delete rs.rows;
    log("info", "automation.waived", { rule: ruleId, firing: key, rows });
    return { data: cur, result: { waived: key, rows } };
  });
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
  return results.some((r) => r.status === "failed" || r.status === "partial");
}
