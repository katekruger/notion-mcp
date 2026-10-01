import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { normalizeId } from "../services/notion.js";
import { childrenAsSpecs } from "../services/copy.js";
import { record, type UndoOp } from "../services/journal.js";
import {
  compileTemplate,
  deleteTemplate,
  diffLines,
  estimateRequests,
  getTemplate,
  listTemplates,
  outline,
  parseTemplate,
  saveTemplate,
  writeTemplate,
  type Template,
  type TemplateNode,
} from "../services/templates.js";
import { config } from "../config.js";
import { ok, safe, WRITE } from "./util.js";

const FORMAT_HELP =
  "A template is {version: 1, name, description?, variables: {name: {type: string|number|boolean|date|list|object, required?, " +
  "default?, description?}}, parts?: {name: [nodes]}, title, icon?, blocks: [nodes]}. Strings use {{variable}} (also " +
  "{{item.field}} in loops, {{item_index}}, {{today}}, {{now}}); a string that is exactly one {{variable}} passes lists and " +
  "objects through. Nodes: {markdown}, {heading, level?}, {callout, icon?, color?}, {toggle, children}, {columns: [[nodes], …]}, " +
  "{divider: true}, {kpis: [{label, value} | {label, metric: {database, value: \"count\"|\"sum:Prop\", where?}}]}, " +
  "{chart: {spec (as notion_create_chart), data | source, data_table?, format?}}, {view: {database, view (as notion_views)}} " +
  "(top level only), {table: {header?, rows} | {query: {database, properties?, where?, limit?}}}, {gantt: {title?, tasks}}, " +
  "{each: \"list\", as: \"item\", blocks}, {if: \"var\" | {var, equals|not|in|gt|lt|empty}, then, else?}, {part: name, with?}, " +
  "{slot: name, default?} (filled by `slots`), {blocks: [raw block specs]}.";

export function registerTemplateTools(server: McpServer): void {
  server.registerTool(
    "notion_template",
    {
      title: "Page Templates",
      description:
        "Build pages from reusable templates instead of many block calls. Built-in templates: weekly-executive-report, " +
        "content-brief, launch-plan, research-dossier; save your own. Actions: list, get (a template's full spec, a good " +
        "starting point), validate (check a template, and with `variables` that it compiles), preview (the page outline, " +
        "block count, charts, views, estimated requests, and, with `compare_to`, what differs from an existing page; writes " +
        "nothing), render (create the page under `parent`, or append to `append_to`; charts are rendered and uploaded, live " +
        "views placed; notion_undo removes it), save, delete, export (your saved templates), import. " +
        FORMAT_HELP,
      inputSchema: {
        action: z.enum(["list", "get", "validate", "preview", "render", "save", "delete", "export", "import"]),
        name: z.string().optional().describe("Template name (get, preview, render, delete)."),
        template: z.record(z.string(), z.unknown()).optional().describe("A template spec (validate, save, or preview/render without saving)."),
        templates: z.array(z.record(z.string(), z.unknown())).optional().describe("import: template specs."),
        variables: z.record(z.string(), z.unknown()).default({}),
        slots: z
          .record(z.string(), z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]))
          .optional()
          .describe("Fill named slots with markdown, or with template nodes."),
        parent: z.string().optional().describe("render: page to create the new page under."),
        append_to: z.string().optional().describe("render: existing page to append to instead."),
        compare_to: z.string().optional().describe("preview: an existing page to compare the result with."),
      },
      annotations: WRITE,
    },
    safe(async (a) => {
      const pick = async (): Promise<Template> => {
        if (a.template) return parseTemplate(a.template);
        if (!a.name) throw new Error(`action=${a.action} needs \`name\` or \`template\`.`);
        return getTemplate(a.name);
      };
      const compile = (t: Template) =>
        compileTemplate(t, a.variables, { ...(a.slots ? { slots: a.slots as Record<string, string | TemplateNode[]> } : {}), timezone: config().timezone });

      switch (a.action) {
        case "list": {
          const all = await listTemplates();
          return ok({
            templates: all.map(({ template: t, builtin }) => ({
              name: t.name,
              ...(t.description ? { description: t.description } : {}),
              builtin,
              variables: Object.fromEntries(Object.entries(t.variables).map(([k, v]) => [k, `${v.type}${v.required ? " (required)" : ""}`])),
            })),
          });
        }
        case "get": {
          if (!a.name) throw new Error("action=get needs `name`.");
          return ok({ template: await getTemplate(a.name) });
        }
        case "validate": {
          const t = await pick();
          if (!Object.keys(a.variables).length) return ok({ valid: true, name: t.name, note: "The spec is valid. Pass `variables` to also check that it compiles with them." });
          const c = await compile(t);
          return ok({ valid: true, name: t.name, title: c.title, blocks: outline(c.specs).length, charts: c.charts.length, views: c.views.length });
        }
        case "preview": {
          const t = await pick();
          const c = await compile(t);
          const lines = outline(c.specs);
          const diff = a.compare_to ? diffLines(outline((await childrenAsSpecs(normalizeId(a.compare_to))).specs), lines) : undefined;
          return ok({
            title: c.title,
            outline: lines,
            blocks: lines.length,
            charts: c.charts.map((x) => `${x.spec.type}: ${x.spec.title ?? "(untitled)"} (${x.rows.length} points)`),
            views: c.views.map((v) => `${v.view.type} view "${v.view.name}"`),
            estimated_requests: estimateRequests(c) + c.reads,
            ...(diff ? { compared_to: a.compare_to, diff } : {}),
            ...(c.notes.length ? { notes: c.notes } : {}),
            next_step: "Call action=render with parent (new page) or append_to (existing page) to write it.",
          });
        }
        case "render": {
          if (Boolean(a.parent) === Boolean(a.append_to)) throw new Error("action=render needs `parent` (new page) or `append_to` (existing page).");
          const t = await pick();
          const c = await compile(t);
          const undo: UndoOp[] = [];
          try {
            const r = await writeTemplate(c, a.parent ? { parent: a.parent } : { appendTo: a.append_to as string }, undo);
            const journalId = await record("notion_template", `Rendered template "${t.name}" (${r.page_id})`, undo);
            return ok({ template: t.name, title: c.title, ...r, undo_id: journalId });
          } catch (e) {
            if (undo.length) {
              const journalId = await record("notion_template", `Partly rendered template "${t.name}"`, undo);
              throw new Error(`${(e as Error).message} What was written can be removed with notion_undo ${journalId}.`);
            }
            throw e;
          }
        }
        case "save": {
          if (!a.template) throw new Error("action=save needs `template`.");
          const t = parseTemplate(a.template);
          await saveTemplate(t);
          return ok({ saved: t.name, note: "Saved in templates.json in the server's home folder; a saved template replaces a built-in one with the same name." });
        }
        case "delete": {
          if (!a.name) throw new Error("action=delete needs `name`.");
          const removed = await deleteTemplate(a.name);
          return ok(removed ? { deleted: a.name } : `No saved template "${a.name}" (built-in templates can't be deleted).`);
        }
        case "export": {
          const saved = (await listTemplates()).filter((x) => !x.builtin).map((x) => x.template);
          return ok({ templates: saved, count: saved.length });
        }
        case "import": {
          if (!a.templates?.length) throw new Error("action=import needs `templates`.");
          const parsed = a.templates.map(parseTemplate);
          for (const t of parsed) await saveTemplate(t);
          return ok({ imported: parsed.map((t) => t.name) });
        }
      }
    })
  );
}
