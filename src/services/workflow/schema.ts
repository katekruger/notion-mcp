// Workflow spec, version 2: a trigger and a list of typed steps. Steps run in order; each can be skipped by a
// condition, retried, and time-limited, and later steps read earlier steps' outputs with ${steps.<id>.<path>}.
// Control steps (foreach, switch, run_workflow) contain steps of their own; approval and delay pause the run
// durably until a person approves in Notion or the time comes.
import { z } from "zod";
import { toCron } from "../schedule.js";
import { blockSpecSchema } from "../specSchema.js";

const id = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i, "Use letters, digits, - and _.");

export const WEBHOOK_EVENTS = [
  "page.created",
  "page.content_updated",
  "page.properties_updated",
  "page.moved",
  "page.deleted",
  "page.undeleted",
  "comment.created",
  "data_source.content_updated",
  "data_source.schema_updated",
] as const;

export const triggerSchema = z
  .object({
    manual: z.boolean().optional().describe("Run with notion_workflow action=run (always allowed)."),
    schedule: z.string().optional().describe('"daily 09:00", "weekdays 09:00", cron, …'),
    webhook: z
      .object({
        events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
        database: z.string().optional().describe("Only events for pages in this database."),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (t.schedule) {
      try {
        toCron(t.schedule);
      } catch (e) {
        ctx.addIssue({ code: "custom", message: (e as Error).message });
      }
    }
  });

const retrySchema = z
  .object({
    attempts: z.number().int().min(1).max(10).default(3),
    backoff_seconds: z.number().min(0).max(600).default(5),
  })
  .strict();

/** Fields every step may carry, besides its one action. */
const common = {
  id,
  if: z.string().optional().describe("Run only when this ${…} reference is set and not empty/false/0."),
  retry: retrySchema.optional(),
  timeout_seconds: z.number().int().min(1).max(3600).optional(),
  continue_on_error: z.boolean().optional().describe("A failure here doesn't fail the run (the step's error is in its output)."),
};

export type Step = z.infer<typeof stepBase> & StepAction;

const stepBase = z.object(common);

/** Every action a step can take. Strings anywhere may use ${trigger.…}, ${steps.<id>.…}, ${item}, ${secret:NAME}. */
export type StepAction =
  | { query: { database: string; data_source_name?: string; where?: Record<string, unknown>; limit?: number } }
  | { set: { page: string; values: Record<string, unknown>; allow_new_options?: boolean } }
  | { append: { page: string; markdown?: string; blocks?: unknown[] } }
  | { comment: { page: string; text: string } }
  | { create_page: { parent: string; title: string; properties?: Record<string, unknown>; markdown?: string; icon?: string } }
  | { move_page: { page: string; to: string } }
  | { duplicate_page: { page: string; to?: string; title?: string } }
  | { trash: { page: string } }
  | { replace_text: { page: string; find: string; replace: string } }
  | { export_markdown: { page: string } }
  | { render_template: { name: string; variables?: Record<string, unknown>; parent: string } }
  | { http: { url: string; method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; headers?: Record<string, string>; body?: unknown } }
  | { slack: { webhook: string; text: string } }
  | { foreach: { items: string; as?: string; steps: Step[]; max?: number } }
  | { switch: { on: string; cases: Record<string, Step[]>; default?: Step[] } }
  | { approval: { page: string; property?: string; comment_keyword?: string; message?: string; expires_hours?: number } }
  | { delay: { minutes: number } }
  | { run_workflow: { id: string; with?: Record<string, unknown> } };

export const ACTIONS = [
  "query", "set", "append", "comment", "create_page", "move_page", "duplicate_page", "trash", "replace_text",
  "export_markdown", "render_template", "http", "slack", "foreach", "switch", "approval", "delay", "run_workflow",
] as const;

const page = z.string().describe("Page URL or id, or a ${…} reference to one.");

export const stepSchema: z.ZodType<Step> = z.lazy(() =>
  z.union([
    stepBase.extend({ query: z.object({ database: z.string(), data_source_name: z.string().optional(), where: z.record(z.string(), z.unknown()).optional(), limit: z.number().int().min(1).max(500).optional() }).strict() }).strict(),
    stepBase.extend({ set: z.object({ page, values: z.record(z.string(), z.unknown()), allow_new_options: z.boolean().optional() }).strict() }).strict(),
    stepBase
      .extend({ append: z.object({ page, markdown: z.string().optional(), blocks: z.array(blockSpecSchema).optional() }).strict().refine((a) => Boolean(a.markdown) !== Boolean(a.blocks), { message: "append needs markdown or blocks." }) })
      .strict(),
    stepBase.extend({ comment: z.object({ page, text: z.string().min(1) }).strict() }).strict(),
    stepBase.extend({ create_page: z.object({ parent: z.string(), title: z.string(), properties: z.record(z.string(), z.unknown()).optional(), markdown: z.string().optional(), icon: z.string().optional() }).strict() }).strict(),
    stepBase.extend({ move_page: z.object({ page, to: z.string() }).strict() }).strict(),
    stepBase.extend({ duplicate_page: z.object({ page, to: z.string().optional(), title: z.string().optional() }).strict() }).strict(),
    stepBase.extend({ trash: z.object({ page }).strict() }).strict(),
    stepBase.extend({ replace_text: z.object({ page, find: z.string().min(1), replace: z.string() }).strict() }).strict(),
    stepBase.extend({ export_markdown: z.object({ page }).strict() }).strict(),
    stepBase.extend({ render_template: z.object({ name: z.string(), variables: z.record(z.string(), z.unknown()).optional(), parent: z.string() }).strict() }).strict(),
    stepBase
      .extend({
        http: z
          .object({
            url: z.string(),
            method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
            headers: z.record(z.string(), z.string()).optional(),
            body: z.unknown().optional(),
          })
          .strict(),
      })
      .strict(),
    stepBase.extend({ slack: z.object({ webhook: z.string().describe("${secret:NAME} holding a Slack incoming-webhook URL"), text: z.string() }).strict() }).strict(),
    stepBase.extend({ foreach: z.object({ items: z.string(), as: id.optional(), steps: z.array(stepSchema).min(1), max: z.number().int().min(1).max(500).optional() }).strict() }).strict(),
    stepBase.extend({ switch: z.object({ on: z.string(), cases: z.record(z.string(), z.array(stepSchema)), default: z.array(stepSchema).optional() }).strict() }).strict(),
    stepBase
      .extend({
        approval: z
          .object({
            page,
            property: z.string().optional().describe("Checkbox that approves when checked."),
            comment_keyword: z.string().optional().describe('A comment containing this word approves (e.g. "approved").'),
            message: z.string().optional().describe("Posted as a comment when the run starts waiting."),
            expires_hours: z.number().min(0.1).max(24 * 30).optional(),
          })
          .strict()
          .refine((a) => a.property || a.comment_keyword, { message: "approval needs a checkbox `property` or a `comment_keyword`." }),
      })
      .strict(),
    stepBase.extend({ delay: z.object({ minutes: z.number().min(1).max(60 * 24 * 30) }).strict() }).strict(),
    stepBase.extend({ run_workflow: z.object({ id, with: z.record(z.string(), z.unknown()).optional() }).strict() }).strict(),
  ])
);

export const notifySchema = z.union([
  z.object({ slack: z.string().describe("${secret:NAME} with a Slack incoming-webhook URL") }).strict(),
  z.object({ http: z.string().describe("URL (must be allowed by NOTION_PLUS_HTTP_ALLOW)") }).strict(),
  z.object({ comment: z.string().describe("Page to comment on") }).strict(),
]);

export const workflowSchema = z
  .object({
    version: z.literal(2),
    id,
    name: z.string().optional(),
    enabled: z.boolean().default(true),
    trigger: triggerSchema.default({ manual: true }),
    inputs: z.record(z.string(), z.unknown()).default({}).describe("Default inputs, available as ${inputs.<name>}."),
    steps: z.array(stepSchema).min(1),
    on_failure: z.array(notifySchema).default([]).describe("Where to say a run failed or stopped part-way."),
  })
  .strict()
  .superRefine((w, ctx) => {
    const seen = new Set<string>();
    const walk = (steps: Step[]) => {
      for (const s of steps) {
        if (seen.has(s.id)) ctx.addIssue({ code: "custom", message: `Step id "${s.id}" is used twice; ids must be unique in a workflow.` });
        seen.add(s.id);
        if ("foreach" in s) walk(s.foreach.steps);
        if ("switch" in s) {
          for (const c of Object.values(s.switch.cases)) walk(c);
          if (s.switch.default) walk(s.switch.default);
        }
      }
    };
    walk(w.steps);
  });

export type Workflow = z.infer<typeof workflowSchema>;

export function actionOf(step: Step): (typeof ACTIONS)[number] {
  const a = ACTIONS.find((k) => k in step);
  if (!a) throw new Error(`Step "${step.id}" has no action.`);
  return a;
}

export function parseWorkflow(raw: unknown): Workflow {
  const r = workflowSchema.safeParse(raw);
  if (!r.success) throw new Error(`The workflow is invalid:\n- ${r.error.issues.map((i) => `${i.path.join(".") || "workflow"}: ${i.message}`).join("\n- ")}`);
  return r.data;
}
