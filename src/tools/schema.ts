import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { call, notion } from "../services/notion.js";
import { dataSourceTitle, invalidateSchema, resolveDataSource, resolvePropertyName } from "../services/schema.js";
import { history, record, undo } from "../services/journal.js";
import { ok, READ, safe, WRITE } from "./util.js";

const PROPERTY_TYPES = [
  "rich_text", "number", "select", "multi_select", "status", "date", "people", "files",
  "checkbox", "url", "email", "phone_number", "relation", "formula", "created_time",
  "created_by", "last_edited_time", "last_edited_by", "unique_id",
] as const;

const COLORS = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;

export function registerSchemaTools(server: McpServer): void {
  server.registerTool(
    "notion_add_property",
    {
      title: "Add Database Property",
      description:
        "Add a property (column) to a database. For select/multi_select pass `options`; for relation pass `relation_database`; " +
        "for number pass `number_format` (number, dollar, percent, …); for formula pass `formula_expression`. " +
        "Status properties get Notion's default options (edit them in Notion). Reversible with notion_undo.",
      inputSchema: {
        database: z.string(),
        data_source_name: z.string().optional(),
        name: z.string().min(1),
        type: z.enum(PROPERTY_TYPES),
        options: z.array(z.string()).optional(),
        relation_database: z.string().optional(),
        two_way: z.boolean().default(false).describe("For relations: also add a synced property on the other database."),
        number_format: z.string().optional(),
        formula_expression: z.string().optional(),
        id_prefix: z.string().optional().describe("For unique_id properties."),
      },
      annotations: { ...WRITE, idempotentHint: false },
    },
    safe(async (a) => {
      const ds = await resolveDataSource(a.database, a.data_source_name);
      if (ds.properties[a.name]) throw new Error(`"${dataSourceTitle(ds)}" already has a property named "${a.name}".`);
      let config: Record<string, unknown> = {};
      if (a.type === "select" || a.type === "multi_select") {
        config = { options: (a.options ?? []).map((name, i) => ({ name, color: COLORS[(i + 1) % COLORS.length] })) };
      } else if (a.type === "relation") {
        if (!a.relation_database) throw new Error("Relation properties need relation_database.");
        const target = await resolveDataSource(a.relation_database);
        config = a.two_way
          ? { data_source_id: target.id, type: "dual_property", dual_property: {} }
          : { data_source_id: target.id, type: "single_property", single_property: {} };
      } else if (a.type === "number") {
        config = { format: a.number_format ?? "number" };
      } else if (a.type === "formula") {
        if (!a.formula_expression) throw new Error("Formula properties need formula_expression.");
        config = { expression: a.formula_expression };
      } else if (a.type === "unique_id") {
        config = { prefix: a.id_prefix ?? null };
      }
      await call(() =>
        notion().dataSources.update({ data_source_id: ds.id, properties: { [a.name]: { type: a.type, [a.type]: config } } } as never)
      );
      invalidateSchema(ds.id);
      const journalId = await record("notion_add_property", `Added "${a.name}" (${a.type}) to "${dataSourceTitle(ds)}"`, [
        { kind: "schema", data_source_id: ds.id, properties: { [a.name]: null } },
      ]);
      return ok({ added: a.name, type: a.type, database: dataSourceTitle(ds), undo_id: journalId });
    })
  );

  server.registerTool(
    "notion_update_options",
    {
      title: "Update Select Options",
      description:
        "Add options to a select or multi-select property. Existing options and every row using them are preserved. " +
        "Renaming options isn't possible through the Notion API (it silently ignores renames), so `rename` returns an error " +
        "that explains the workaround. notion_undo removes the added options, which also clears them from any rows that used them since.",
      inputSchema: {
        database: z.string(),
        data_source_name: z.string().optional(),
        property: z.string(),
        add: z.array(z.string()).optional(),
        rename: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
      },
      annotations: WRITE,
    },
    safe(async ({ database, data_source_name, property, add, rename }) => {
      const ds = await resolveDataSource(database, data_source_name);
      const { name } = resolvePropertyName(ds, property);
      const config = ds.properties[name];
      if (config.type !== "select" && config.type !== "multi_select") {
        throw new Error(`"${name}" is a ${config.type} property. Status options can only be edited in Notion.`);
      }
      const current = config.type === "select" ? config.select.options : config.multi_select.options;
      const next = current.map((o) => ({ id: o.id, name: o.name, color: o.color }));
      if (rename?.length) {
        // Verified live on API 2025-09-03: renames by option id are accepted but silently ignored,
        // and dropping an option deletes it and clears it from every row. So refuse rather than pretend.
        throw new Error(
          "Notion's API can't rename select options (it accepts the request and ignores it). Rename it in Notion, or: " +
            "add the new option with `add`, move rows with notion_bulk_update, then delete the old option in Notion."
        );
      }
      const added: string[] = [];
      for (const newName of add ?? []) {
        if (next.some((o) => o.name.toLowerCase() === newName.toLowerCase())) continue;
        next.push({ id: "", name: newName, color: COLORS[(next.length + 1) % COLORS.length] });
        added.push(newName);
      }
      if (added.length === 0) return ok({ property: name, added, note: "All options already exist; nothing changed." });
      const payload = next.map((o) => (o.id ? { id: o.id, name: o.name, color: o.color } : { name: o.name, color: o.color }));
      await call(() =>
        notion().dataSources.update({ data_source_id: ds.id, properties: { [name]: { [config.type]: { options: payload } } } } as never)
      );
      invalidateSchema(ds.id);
      const restore = current.map((o) => ({ id: o.id, name: o.name, color: o.color }));
      const journalId = await record("notion_update_options", `Added ${added.map((a) => `"${a}"`).join(", ")} to "${name}" (undo clears them from rows)`, [
        { kind: "schema", data_source_id: ds.id, properties: { [config.id]: { [config.type]: { options: restore } } } },
      ]);
      return ok({ property: name, added, undo_id: journalId });
    })
  );

  server.registerTool(
    "notion_rename_property",
    {
      title: "Rename Property",
      description: "Rename a database property. Formulas and views that reference it keep working. Reversible with notion_undo.",
      inputSchema: {
        database: z.string(),
        data_source_name: z.string().optional(),
        from: z.string(),
        to: z.string().min(1),
      },
      annotations: WRITE,
    },
    safe(async ({ database, data_source_name, from, to }) => {
      const ds = await resolveDataSource(database, data_source_name);
      const { name } = resolvePropertyName(ds, from);
      const propId = ds.properties[name].id;
      await call(() => notion().dataSources.update({ data_source_id: ds.id, properties: { [propId]: { name: to } } } as never));
      invalidateSchema(ds.id);
      const journalId = await record("notion_rename_property", `Renamed "${name}" → "${to}"`, [
        { kind: "schema", data_source_id: ds.id, properties: { [propId]: { name } } },
      ]);
      return ok({ renamed: { from: name, to }, undo_id: journalId });
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

