// Polling automations: rules in automations/rules.json are evaluated as database queries,
// and matching rows get actions applied through the same write paths the tools use.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isFullPage } from "@notionhq/client";
import type { DataSourceObjectResponse, PageObjectResponse } from "@notionhq/client";
import { z } from "zod";
import { call, notion } from "./notion.js";
import { appendSpecs, markdownToSpecs, type BlockSpec } from "./blocks.js";
import { forApi, fromInlineMarkdown, plain } from "./richtext.js";
import { buildWhereFilter, dataSourceTitle, resolveDataSource, resolvePropertyName, simplify, withFullProperties } from "./schema.js";
import { record, type UndoOp } from "./journal.js";
import { preparePayload, snapshot } from "./writes.js";

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

const blockSpec: z.ZodType<BlockSpec> = z.lazy(() =>
  z.object({
    type: z.string(),
    text: z.string().optional(),
    checked: z.boolean().optional(),
    language: z.string().optional(),
    emoji: z.string().optional(),
    color: z.string().optional(),
    children: z.array(blockSpec).optional(),
  })
);

const actionSchema = z.union([
  z.object({ set: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ append: z.union([z.string(), z.array(blockSpec)]) }).strict(),
  z.object({ comment: z.string().min(1) }).strict(),
  z.object({ trash: z.literal(true) }).strict(),
]);

export const ruleSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, digits, and dashes."),
  name: z.string().optional(),
  enabled: z.boolean().default(true),
  database: z.string().describe("Database URL/id or data source id."),
  data_source_name: z.string().optional(),
  when: z
    .object({
      where: z.record(z.string(), z.unknown()).optional(),
      filter: z.record(z.string(), z.unknown()).optional(),
      relative: z.array(relativeSchema).optional(),
    })
    .refine((w) => w.where || w.filter || w.relative?.length, { message: "A rule needs at least one condition." }),
  actions: z.array(actionSchema).min(1),
  marker: z
    .string()
    .optional()
    .describe("Checkbox property the runner sets after acting, and requires to be unchecked, so actions run once per row."),
  allow_new_options: z.boolean().default(false),
  limit: z.number().int().min(1).max(500).default(50).describe("Max rows acted on per run; the rest wait for the next run."),
});
export type Rule = z.infer<typeof ruleSchema>;
export type Action = z.infer<typeof actionSchema>;

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
    .describe("IANA zone used for {{today}}."),
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
    if (!ctx.page) throw new Error(`{{${key}}} needs a page.`);
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

/** Turn relative-date conditions into Notion filters, computed against `now`. */
export function relativeFilters(ds: DataSourceObjectResponse, relative: Rule["when"]["relative"], now: Date): Record<string, unknown>[] {
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

function same(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (typeof v === "string" ? v.toLowerCase().replace(/[^a-z0-9]/g, "") : JSON.stringify(v));
  return norm(a) === norm(b);
}

/**
 * A polling rule must stop matching a row once it has acted on it, or it would act again every run.
 * That holds when it trashes the row, uses a marker, or sets a property its condition checks to a different value.
 * Returns a reason when the rule can't be shown to stop matching.
 */
export function selfClearingProblem(ds: DataSourceObjectResponse, rule: Rule): string | null {
  if (rule.marker) return null;
  if (rule.actions.some((a) => "trash" in a)) return null;
  const condition = new Map<string, unknown>();
  for (const [k, v] of Object.entries(rule.when.where ?? {})) condition.set(resolvePropertyName(ds, k).name, v);
  for (const k of filterProperties(rule.when.filter)) if (!condition.has(k)) condition.set(resolvePropertyName(ds, k).name, undefined);
  for (const r of rule.when.relative ?? []) {
    if (!r.property.startsWith("$")) condition.set(resolvePropertyName(ds, r.property).name, undefined);
  }
  for (const a of rule.actions) {
    if (!("set" in a)) continue;
    for (const [k, v] of Object.entries(a.set)) {
      const name = resolvePropertyName(ds, k).name;
      if (!condition.has(name)) continue;
      const wanted = condition.get(name);
      if (wanted === undefined || !same(wanted, v)) return null;
    }
  }
  return (
    `Rule "${rule.id}" would match the same rows again on every run: none of its actions changes what its condition checks. ` +
    'Set a property the condition checks to a different value, trash the row, or add "marker": "<checkbox property>" so each row is handled once.'
  );
}

/** Validate a rule against the live schema: property names, set values, templates, and self-clearing. */
export async function checkRule(rule: Rule, timezone: string, now = new Date()): Promise<{ ds: DataSourceObjectResponse; filter: Record<string, unknown> }> {
  const ds = await resolveDataSource(rule.database, rule.data_source_name);
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
  return { ds, filter: await buildFilter(ds, rule, now) };
}

async function buildFilter(ds: DataSourceObjectResponse, rule: Rule, now: Date): Promise<Record<string, unknown>> {
  const clauses: Record<string, unknown>[] = [];
  if (rule.when.where) {
    const w = await buildWhereFilter(ds, rule.when.where);
    if (w) clauses.push(w);
  }
  if (rule.when.filter) clauses.push(rule.when.filter);
  clauses.push(...relativeFilters(ds, rule.when.relative, now));
  if (rule.marker) clauses.push({ property: resolvePropertyName(ds, rule.marker).name, checkbox: { equals: false } });
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

export interface RuleResult {
  rule: string;
  database: string;
  dry_run: boolean;
  matched: number;
  more_waiting: boolean;
  acted: number;
  rows: { id: string; title: string; actions: string[]; error?: string }[];
  undo_id?: string;
  error?: string;
}

export interface RunOptions {
  dryRun: boolean;
  now?: Date;
  /** Stop writing once this many rows have been acted on across the run. */
  budget?: { remaining: number };
}

/** Evaluate one rule. Dry runs only read; real runs write and record one journal entry for the rule. */
export async function runRule(rule: Rule, timezone: string, opts: RunOptions): Promise<RuleResult> {
  const now = opts.now ?? new Date();
  const result: RuleResult = { rule: rule.id, database: rule.database, dry_run: opts.dryRun, matched: 0, more_waiting: false, acted: 0, rows: [] };
  let ds: DataSourceObjectResponse;
  let filter: Record<string, unknown>;
  try {
    ({ ds, filter } = await checkRule(rule, timezone, now));
    result.database = dataSourceTitle(ds);
  } catch (e) {
    result.error = (e as Error).message;
    return result;
  }

  const pages: PageObjectResponse[] = [];
  let cursor: string | null = null;
  do {
    const res = await call(() =>
      notion().dataSources.query({
        data_source_id: ds.id,
        filter,
        page_size: Math.min(100, rule.limit + 1),
        result_type: "page",
        ...(cursor ? { start_cursor: cursor } : {}),
      } as never)
    );
    for (const r of res.results) if (isFullPage(r as PageObjectResponse)) pages.push(r as PageObjectResponse);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor && pages.length <= rule.limit);
  result.matched = pages.length > rule.limit ? rule.limit : pages.length;
  result.more_waiting = pages.length > rule.limit || Boolean(cursor);
  const targets = pages.slice(0, rule.limit);

  const undo: UndoOp[] = [];
  let commented = 0;
  // Order within a row: property writes, content, comment, then trash last so earlier actions can still reach it.
  const ordered = [...rule.actions].sort((a, b) => rank(a) - rank(b));
  const markerName = rule.marker ? resolvePropertyName(ds, rule.marker).name : null;

  for (const page of targets) {
    const ctx: TemplateContext = { now, timezone, page };
    const row = { id: page.id, title: pageTitle(page), actions: ordered.map((a) => describeAction(render(a, ctx))) as string[] };
    if (markerName) row.actions.push(`check ${markerName}`);
    result.rows.push(row);
    if (opts.dryRun) continue;
    if (opts.budget && opts.budget.remaining <= 0) {
      (row as { error?: string }).error = "skipped: run write budget used up";
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
          const ids = await appendSpecs(page.id, specs);
          undo.push(...ids.map((id) => ({ kind: "block_trash", block_id: id, in_trash: true }) as UndoOp));
        } else if ("comment" in a) {
          const text = render(a.comment, ctx);
          await call(() => notion().comments.create({ parent: { page_id: page.id }, rich_text: forApi(fromInlineMarkdown(text)) } as never));
          commented++;
        } else if ("trash" in a) {
          await call(() => notion().pages.update({ page_id: page.id, in_trash: true } as never));
          undo.push({ kind: "page_trash", page_id: page.id, in_trash: false });
        }
      }
      result.acted++;
      if (opts.budget) opts.budget.remaining--;
    } catch (e) {
      (row as { error?: string }).error = (e as Error).message;
    }
  }

  if (!opts.dryRun && (undo.length || commented)) {
    result.undo_id = await record(
      "automations",
      `Rule "${rule.id}" acted on ${result.acted} rows in "${result.database}"`,
      undo,
      commented ? `${commented} comments can't be removed through the API; delete them in Notion if needed` : undefined
    );
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
  const results: RuleResult[] = [];
  for (const rule of rules) results.push(await runRule(rule, data.timezone, { ...opts, budget }));
  return results;
}

/** Markdown summary used for the CLI and the GitHub Actions job summary. */
export function summarize(results: RuleResult[]): string {
  if (results.length === 0) return "No enabled rules.";
  const lines: string[] = [];
  for (const r of results) {
    const head = r.error
      ? `### ${r.rule}: error\n${r.error}`
      : `### ${r.rule} (${r.database}): ${r.dry_run ? `would act on ${r.matched}` : `acted on ${r.acted} of ${r.matched}`} rows` +
        `${r.more_waiting ? " (more waiting for the next run)" : ""}${r.undo_id ? `, undo_id \`${r.undo_id}\`` : ""}`;
    lines.push(head);
    for (const row of r.rows.slice(0, 50)) {
      lines.push(`- ${row.title} (${row.id}): ${row.actions.join("; ")}${row.error ? ` **failed: ${row.error}**` : ""}`);
    }
    if (r.rows.length > 50) lines.push(`- …and ${r.rows.length - 50} more`);
  }
  return lines.join("\n");
}
