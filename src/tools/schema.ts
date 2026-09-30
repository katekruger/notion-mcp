import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DataSourceObjectResponse } from "@notionhq/client";
import { call, normalizeId, notion } from "../services/notion.js";
import { dataSourceTitle, describeSchema, invalidateSchema, resolveDataSource, resolvePropertyName, restoreValue } from "../services/schema.js";
import { history, record, undo, type UndoOp } from "../services/journal.js";
import {
  configToRequest,
  needsSecondPass,
  propertyRequest,
  propertySpecSchema,
  STATUS_GROUPS,
  type OptionInput,
  type PropertySpec,
} from "../services/dbschema.js";
import { queryAll } from "../services/query.js";
import { COLORS, textToTitle } from "../services/richtext.js";
import { fileRef } from "../services/files.js";
import { iconRef } from "./pages.js";
import { ok, READ, safe, WRITE } from "./util.js";

/** Largest number of rows whose values a property delete snapshots for undo. */
const MAX_DELETE_SNAPSHOT = 2000;

/** Status options without a group all land in "To-do" (verified live), so guess a group from the name. */
export function inferStatusGroup(name: string): (typeof STATUS_GROUPS)[number] {
  const n = name.toLowerCase();
  if (/\b(done|complete|completed|closed|shipped|finished|resolved|archived|cancel+ed|won|lost)\b/.test(n)) return "Complete";
  if (/\b(progress|doing|active|review|blocked|at risk|started|waiting|testing|qa|ongoing)\b/.test(n)) return "In progress";
  return "To-do";
}

function withStatusGroups(spec: PropertySpec, notes: string[]): PropertySpec {
  if (spec.type !== "status" || !spec.options?.length) return spec;
  const inferred: string[] = [];
  const options = spec.options.map((o): OptionInput => {
    const opt = typeof o === "string" ? { name: o } : o;
    if (opt.group) return opt;
    const group = inferStatusGroup(opt.name);
    inferred.push(`${opt.name} → ${group}`);
    return { ...opt, group };
  });
  if (inferred.length) notes.push(`Status groups for "${spec.name}" guessed from names: ${inferred.join(", ")}. Pass {name, group} to choose.`);
  return { ...spec, options };
}

/** Config that keeps a property as it is, so a description can be changed alone. Null where that isn't safe. */
function unchangedConfig(config: DataSourceObjectResponse["properties"][string]): Record<string, unknown> | null {
  const t = config.type as string;
  const c = config as unknown as Record<string, unknown>;
  const inner = (c[t] ?? {}) as Record<string, unknown>;
  if (t === "select" || t === "multi_select" || t === "status") return { [t]: { options: (inner.options as { id: string }[]).map((o) => ({ id: o.id })) } };
  if (t === "number") return { number: { format: inner.format } };
  if (t === "formula") return { formula: { expression: inner.expression } };
  if (["relation", "rollup", "unique_id", "button"].includes(t)) return null;
  return { [t]: {} };
}

export function registerSchemaTools(server: McpServer): void {
  server.registerTool(
    "notion_create_database",
    {
      title: "Create Database",
      description:
        "Create a database under a page with its full schema in one call: select/multi-select/status options (status options can " +
        "name their group: To-do, In progress, Complete), number formats, formulas, relations (one- or two-way, to another " +
        "database or \"self\"), rollups over those relations, unique IDs with a prefix, people, dates, files, places, and more. " +
        "If no title property is given, one called \"Name\" is added. Add rows with notion_bulk_create or notion_create_page. " +
        "notion_undo trashes the database.",
      inputSchema: {
        parent: z.string().describe("Page URL or id to create the database in."),
        title: z.string().min(1),
        description: z.string().optional(),
        properties: z.array(propertySpecSchema).min(1).max(100),
        icon: z.string().optional().describe("Emoji, image URL, or local image path."),
        cover: z.string().optional(),
        inline: z.boolean().default(false).describe("Show the database inline on the parent page instead of as a sub-page."),
      },
      annotations: { ...WRITE, idempotentHint: false },
    },
    safe(async ({ parent, title, description, properties, icon, cover, inline }) => {
      const notes: string[] = [];
      const names = new Set<string>();
      for (const p of properties) {
        const key = p.name.toLowerCase();
        if (names.has(key)) throw new Error(`Property "${p.name}" is listed twice.`);
        names.add(key);
      }
      const titles = properties.filter((p) => p.type === "title");
      if (titles.length > 1) throw new Error("A database has exactly one title property.");
      const specs = (titles.length ? properties : [{ name: "Name", type: "title" as const }, ...properties]).map((p) => withStatusGroups(p, notes));
      if (!titles.length) notes.push('Added a title property "Name".');

      // Everything is validated (and related databases resolved) before the database is created.
      const first: Record<string, unknown> = {};
      const second: PropertySpec[] = [];
      const errors: string[] = [];
      for (const spec of specs) {
        if (needsSecondPass(spec, specs)) {
          second.push(spec);
          continue;
        }
        try {
          first[spec.name] = await propertyRequest(spec, null);
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
      for (const spec of second) if (spec.type === "rollup" && !spec.rollup) errors.push(`Property "${spec.name}" (rollup): needs \`rollup\`.`);
      if (errors.length) throw new Error(`Nothing was created. Fix these first:\n- ${errors.join("\n- ")}`);

      const body: Record<string, unknown> = {
        parent: { type: "page_id", page_id: normalizeId(parent) },
        title: textToTitle(title),
        is_inline: inline,
        initial_data_source: { properties: first },
      };
      if (description) body.description = textToTitle(description);
      if (icon) body.icon = await iconRef(icon);
      if (cover) body.cover = await fileRef(cover);
      const db = (await call(() => notion().databases.create(body as never))) as unknown as { id: string; url?: string; data_sources?: { id: string }[] };
      const undoOps: UndoOp[] = [{ kind: "database_trash", database_id: db.id, in_trash: true }];
      const journalId = await record("notion_create_database", `Created database "${title}" (${db.id})`, undoOps);
      const dsId = db.data_sources?.[0]?.id;
      if (!dsId) throw new Error(`Database ${db.id} was created but Notion returned no data source. undo_id ${journalId} trashes it.`);
      if (second.length) {
        try {
          const self = await resolveDataSource(dsId);
          const extra: Record<string, unknown> = {};
          for (const spec of second.filter((s) => s.type === "relation")) extra[spec.name] = await propertyRequest(spec, self, dsId);
          if (Object.keys(extra).length) await call(() => notion().dataSources.update({ data_source_id: dsId, properties: extra } as never));
          invalidateSchema(dsId);
          const rollups: Record<string, unknown> = {};
          const withRelations = await resolveDataSource(dsId);
          for (const spec of second.filter((s) => s.type === "rollup")) rollups[spec.name] = await propertyRequest(spec, withRelations, dsId);
          if (Object.keys(rollups).length) await call(() => notion().dataSources.update({ data_source_id: dsId, properties: rollups } as never));
        } catch (e) {
          throw new Error(`Database ${db.id} was created, but adding ${second.map((s) => `"${s.name}"`).join(", ")} failed: ${(e as Error).message} undo_id ${journalId} trashes it.`);
        }
      }
      invalidateSchema(dsId);
      // Two-way relations add a property to the other database too.
      for (const spec of specs) if (spec.type === "relation" && spec.relation && spec.relation.database !== "self") invalidateSchema((await resolveDataSource(spec.relation.database)).id);
      const ds = await resolveDataSource(dsId);
      const missing = specs.filter((s) => !ds.properties[s.name]).map((s) => s.name);
      if (missing.length) notes.push(`Notion didn't create: ${missing.join(", ")} (verification properties only exist in wikis).`);
      return ok({
        database_id: db.id,
        data_source_id: dsId,
        url: db.url,
        properties: describeSchema(ds),
        ...(notes.length ? { notes } : {}),
        undo_id: journalId,
      });
    })
  );

  server.registerTool(
    "notion_schema",
    {
      title: "Edit Database Schema",
      description:
        "Change a database's properties. action=add adds a property (same definition as notion_create_database). action=rename " +
        "renames one. action=delete removes one: it defaults to a dry run showing how many rows have values, and snapshots up " +
        "to 2000 rows' values so notion_undo can re-create the property and restore them. action=add_options adds " +
        "select/multi-select/status options (status options take a group). action=set_number_format and action=set_description " +
        "change those settings. Notion's API can't rename or recolor options (it ignores or rejects it); rename them in Notion, " +
        "or add a new option, move rows with notion_bulk_update, and delete the old one in Notion.",
      inputSchema: {
        database: z.string(),
        data_source_name: z.string().optional(),
        action: z.enum(["add", "rename", "delete", "add_options", "set_number_format", "set_description"]),
        property: z.string().optional().describe("Existing property (every action except add)."),
        definition: propertySpecSchema.optional().describe("action=add: the new property."),
        to: z.string().optional().describe("action=rename: new name."),
        options: z
          .array(z.union([z.string(), z.object({ name: z.string(), color: z.enum(COLORS).optional(), group: z.enum(STATUS_GROUPS).optional() })]))
          .optional()
          .describe("action=add_options"),
        number_format: z.string().optional(),
        description: z.string().optional(),
        dry_run: z.boolean().optional().describe("Default true for delete, false otherwise."),
      },
      annotations: { ...WRITE, destructiveHint: true, idempotentHint: false },
    },
    safe(async (a) => {
      const ds = await resolveDataSource(a.database, a.data_source_name);
      const n = notion();
      const update = (properties: Record<string, unknown>) => call(() => n.dataSources.update({ data_source_id: ds.id, properties } as never));
      const title = dataSourceTitle(ds);

      if (a.action === "add") {
        if (!a.definition) throw new Error("action=add needs `definition` ({name, type, …}).");
        if (ds.properties[a.definition.name]) throw new Error(`"${title}" already has a property named "${a.definition.name}".`);
        const notes: string[] = [];
        const spec = withStatusGroups(a.definition, notes);
        await update({ [spec.name]: await propertyRequest(spec, ds, ds.id) });
        invalidateSchema(ds.id);
        if (spec.type === "relation" && spec.relation && spec.relation.database !== "self") invalidateSchema((await resolveDataSource(spec.relation.database)).id);
        const journalId = await record("notion_schema", `Added "${spec.name}" (${spec.type}) to "${title}"`, [
          { kind: "schema", data_source_id: ds.id, properties: { [spec.name]: null } },
        ]);
        return ok({ added: spec.name, type: spec.type, ...(notes.length ? { notes } : {}), undo_id: journalId });
      }

      if (!a.property) throw new Error(`action=${a.action} needs \`property\`.`);
      const { name } = resolvePropertyName(ds, a.property);
      const config = ds.properties[name];

      if (a.action === "rename") {
        if (!a.to) throw new Error("action=rename needs `to`.");
        await update({ [config.id]: { name: a.to } });
        invalidateSchema(ds.id);
        const journalId = await record("notion_schema", `Renamed "${name}" → "${a.to}" in "${title}"`, [
          { kind: "schema", data_source_id: ds.id, properties: { [config.id]: { name } } },
        ]);
        return ok({ renamed: { from: name, to: a.to }, undo_id: journalId });
      }

      if (a.action === "delete") {
        if (config.type === "title") throw new Error("The title property can't be deleted.");
        const restore = configToRequest(ds, config);
        const computed = ["formula", "rollup", "created_time", "created_by", "last_edited_time", "last_edited_by", "unique_id", "button"].includes(config.type);
        let withValues: { id: string; value: Record<string, unknown> }[] = [];
        let more = false;
        if (!computed) {
          const filter = ["checkbox"].includes(config.type)
            ? { property: name, checkbox: { equals: true } }
            : ["place", "verification"].includes(config.type as string)
              ? undefined
              : { property: name, [config.type]: { is_not_empty: true } };
          const res = await queryAll(ds.id, { ...(filter ? { filter } : {}), max: MAX_DELETE_SNAPSHOT });
          more = res.more;
          withValues = res.pages.flatMap((p) => {
            const v = restoreValue(p.properties[name]);
            return v ? [{ id: p.id, value: v }] : [];
          });
        }
        const warnings: string[] = [];
        if (more) warnings.push(`More than ${MAX_DELETE_SNAPSHOT} rows have values; undo can re-create the property but only restore the first ${MAX_DELETE_SNAPSHOT}.`);
        if (!restore) warnings.push("This property's settings can't be re-created exactly, so undo won't bring it back.");
        if (config.type === "relation" && (config as unknown as { relation: { type: string } }).relation.type === "dual_property") {
          warnings.push("This is a two-way relation: deleting it also removes the matching property on the related database, and undo re-creates both.");
        }
        if (config.type === "unique_id") warnings.push("A re-created unique ID renumbers every row.");
        const dry = a.dry_run ?? true;
        if (dry) {
          return ok({
            dry_run: true,
            delete: name,
            type: config.type,
            rows_with_values: computed ? "computed by Notion" : `${withValues.length}${more ? "+" : ""}`,
            ...(warnings.length ? { warnings } : {}),
            next_step: "Confirm with the user, then call again with dry_run=false.",
          });
        }
        await update({ [config.id]: null });
        invalidateSchema(ds.id);
        if (config.type === "relation") invalidateSchema((config as unknown as { relation: { data_source_id: string } }).relation.data_source_id);
        const undoOps: UndoOp[] = [
          ...withValues.map((r) => ({ kind: "page_properties" as const, page_id: r.id, properties: { [name]: r.value }, data_source_id: ds.id })),
          ...(restore ? [{ kind: "schema" as const, data_source_id: ds.id, properties: { [name]: restore } }] : []),
        ];
        const journalId = await record("notion_schema", `Deleted "${name}" from "${title}" (${withValues.length} row values saved)`, undoOps, restore ? undefined : "settings can't be re-created");
        return ok({ deleted: name, values_saved_for_undo: withValues.length, ...(warnings.length ? { warnings } : {}), undo_id: journalId });
      }

      if (a.action === "add_options") {
        if (config.type !== "select" && config.type !== "multi_select" && config.type !== "status") {
          throw new Error(`"${name}" is a ${config.type} property; options belong to select, multi_select, and status.`);
        }
        if (!a.options?.length) throw new Error("action=add_options needs `options`.");
        const inner = (config as unknown as Record<string, { options: { id: string; name: string; color: string }[] }>)[config.type];
        const current = inner.options;
        const added: string[] = [];
        const notes: string[] = [];
        const next: Record<string, unknown>[] = current.map((o) => ({ id: o.id }));
        for (const raw of a.options) {
          const opt = typeof raw === "string" ? { name: raw } : raw;
          if (current.some((o) => o.name.toLowerCase() === opt.name.toLowerCase()) || added.some((x) => x.toLowerCase() === opt.name.toLowerCase())) continue;
          if ("group" in opt && opt.group && config.type !== "status") throw new Error("`group` only applies to status options.");
          let group = "group" in opt ? opt.group : undefined;
          if (config.type === "status" && !group) {
            group = inferStatusGroup(opt.name);
            notes.push(`"${opt.name}" put in group ${group} (guessed from its name).`);
          }
          next.push({ name: opt.name, color: opt.color ?? COLORS[(current.length + added.length + 1) % COLORS.length], ...(group ? { group } : {}) });
          added.push(opt.name);
        }
        if (added.length === 0) return ok({ property: name, added, note: "All options already exist; nothing changed." });
        // Every existing option is sent by id: leaving one out would delete it and clear it from rows.
        await update({ [name]: { [config.type]: { options: next } } });
        invalidateSchema(ds.id);
        const journalId = await record("notion_schema", `Added ${added.map((x) => `"${x}"`).join(", ")} to "${name}" (undo clears them from rows)`, [
          { kind: "schema", data_source_id: ds.id, properties: { [config.id]: { [config.type]: { options: current.map((o) => ({ id: o.id })) } } } },
        ]);
        return ok({ property: name, added, ...(notes.length ? { notes } : {}), undo_id: journalId });
      }

      if (a.action === "set_number_format") {
        if (config.type !== "number") throw new Error(`"${name}" is a ${config.type} property, not a number.`);
        if (!a.number_format) throw new Error("action=set_number_format needs `number_format`.");
        const before = (config as unknown as { number: { format: string } }).number.format;
        await update({ [config.id]: { number: { format: a.number_format } } });
        invalidateSchema(ds.id);
        const journalId = await record("notion_schema", `Set "${name}" format ${before} → ${a.number_format}`, [
          { kind: "schema", data_source_id: ds.id, properties: { [config.id]: { number: { format: before } } } },
        ]);
        return ok({ property: name, format: { from: before, to: a.number_format }, undo_id: journalId });
      }

      // set_description
      if (a.description === undefined) throw new Error("action=set_description needs `description` (\"\" clears it).");
      const same = unchangedConfig(config);
      if (!same) throw new Error(`Descriptions on ${config.type} properties can't be changed safely through the API; edit it in Notion.`);
      const before = (config as unknown as { description?: string | null }).description ?? "";
      await update({ [config.id]: { ...same, description: a.description || null } });
      invalidateSchema(ds.id);
      const journalId = await record("notion_schema", `Set description of "${name}"`, [
        { kind: "schema", data_source_id: ds.id, properties: { [config.id]: { ...same, description: before || null } } },
      ]);
      return ok({ property: name, description: a.description, undo_id: journalId });
    })
  );
}

export function registerSafetyTools(server: McpServer): void {
  server.registerTool(
    "notion_undo",
    {
      title: "Undo",
      description:
        "Revert a change made through this server. With no id, reverts the most recent change that hasn't been undone. " +
        "Use notion_history to find ids. Undo restores the snapshot taken at write time. Before writing, it checks whether anything it " +
        "would restore was edited later (by a person or a later change here) and refuses, listing those objects, unless force is true. " +
        "Edits made within the same minute as the original write can't be detected (Notion rounds edit times to the minute).",
      inputSchema: {
        undo_id: z.string().optional(),
        force: z.boolean().default(false).describe("Overwrite edits made after the original change. Only after confirming with the user."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ undo_id, force }) => {
      const r = await undo(undo_id, { force });
      if (r.applied === 0 && r.failed.length) {
        throw new Error(`Undo of ${r.entry.id} failed; nothing was reverted:\n- ${r.failed.join("\n- ")}`);
      }
      return ok({
        undone: r.entry.id,
        summary: r.entry.summary,
        operations_applied: r.applied,
        ...(r.failed.length ? { failed: r.failed } : {}),
        ...(r.conflicts.length ? { overwrote_later_edits: r.conflicts } : {}),
      });
    })
  );

  server.registerTool(
    "notion_history",
    {
      title: "Change History",
      description: "List recent changes made through this server, newest first, with their undo ids.",
      inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
      annotations: READ,
    },
    safe(async ({ limit }) => {
      const entries = await history(limit);
      if (entries.length === 0) return ok("No changes recorded yet.");
      return ok(
        entries.map((e) => ({
          undo_id: e.id,
          at: e.at,
          tool: e.tool,
          summary: e.summary,
          status: e.undone ? "undone" : e.undo.length ? "undoable" : "not undoable",
        }))
      );
    })
  );
}

