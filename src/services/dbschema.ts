// Friendly property definitions → Notion schema requests, and existing schema → requests that re-create it (for undo).
import { z } from "zod";
import type { DataSourceObjectResponse } from "@notionhq/client";
import { COLORS } from "./richtext.js";
import { resolveDataSource, resolvePropertyName, type PropertyConfig } from "./schema.js";

export const PROPERTY_TYPES = [
  "title", "rich_text", "number", "select", "multi_select", "status", "date", "people", "files", "checkbox", "url",
  "email", "phone_number", "relation", "rollup", "formula", "created_time", "created_by", "last_edited_time",
  "last_edited_by", "unique_id", "place", "button",
] as const;

export const ROLLUP_FUNCTIONS = [
  "count", "count_values", "empty", "not_empty", "unique", "show_unique", "percent_empty", "percent_not_empty", "sum",
  "average", "median", "min", "max", "range", "earliest_date", "latest_date", "date_range", "checked", "unchecked",
  "percent_checked", "percent_unchecked", "count_per_group", "percent_per_group", "show_original",
] as const;

export const STATUS_GROUPS = ["To-do", "In progress", "Complete"] as const;

const optionSchema = z.union([
  z.string(),
  z.object({
    name: z.string().min(1),
    color: z.enum(COLORS).optional(),
    group: z.enum(STATUS_GROUPS).optional().describe("status only"),
    description: z.string().optional(),
  }),
]);
export type OptionInput = z.infer<typeof optionSchema>;

export const propertySpecSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(PROPERTY_TYPES),
    description: z.string().optional(),
    options: z
      .array(optionSchema)
      .optional()
      .describe('select, multi_select, status: names, or {name, color, group}. Status groups: "To-do", "In progress", "Complete".'),
    number_format: z.string().optional().describe("number: number, number_with_commas, percent, dollar, euro, pound, yen, …"),
    formula: z.string().optional().describe('formula: Notion formula, e.g. prop("Est") * 2'),
    relation: z
      .object({
        database: z.string().describe('Related database URL/id, or "self" for a relation within the same database.'),
        two_way: z.boolean().default(false),
        related_name: z.string().optional().describe("two_way: name of the property created on the other database."),
      })
      .optional(),
    rollup: z
      .object({
        relation: z.string().describe("Relation property on this database."),
        property: z.string().describe("Property on the related database to roll up."),
        function: z.enum(ROLLUP_FUNCTIONS).default("show_original"),
      })
      .optional(),
    prefix: z.string().optional().describe("unique_id: ID prefix, e.g. PRJ"),
  })
  .strict();
export type PropertySpec = z.infer<typeof propertySpecSchema>;

function optionRequests(options: OptionInput[] | undefined, type: string): Record<string, unknown>[] {
  const seen = new Set<string>();
  return (options ?? []).map((o, i) => {
    const opt = typeof o === "string" ? { name: o } : o;
    const key = opt.name.toLowerCase();
    if (seen.has(key)) throw new Error(`Option "${opt.name}" is listed twice.`);
    seen.add(key);
    if ("group" in opt && opt.group && type !== "status") throw new Error(`Option "${opt.name}": \`group\` only applies to status properties.`);
    return {
      name: opt.name,
      color: opt.color ?? COLORS[(i + 1) % COLORS.length],
      ...("group" in opt && opt.group ? { group: opt.group } : {}),
      ...("description" in opt && opt.description ? { description: opt.description } : {}),
    };
  });
}

/**
 * The schema request for one property. `self` is the data source being created or edited (for self-relations and rollups);
 * pass null when creating a database, and self-relations/rollups are deferred by the caller.
 */
export async function propertyRequest(spec: PropertySpec, self: DataSourceObjectResponse | null, selfId?: string): Promise<Record<string, unknown>> {
  const t = spec.type;
  const fail = (msg: string): never => {
    throw new Error(`Property "${spec.name}" (${t}): ${msg}`);
  };
  const only = (field: keyof PropertySpec, types: string[]) => {
    if (spec[field] !== undefined && !types.includes(t)) fail(`\`${field}\` only applies to ${types.join("/")} properties.`);
  };
  only("options", ["select", "multi_select", "status"]);
  only("number_format", ["number"]);
  only("formula", ["formula"]);
  only("relation", ["relation"]);
  only("rollup", ["rollup"]);
  only("prefix", ["unique_id"]);
  let config: Record<string, unknown> = {};
  switch (t) {
    case "select":
    case "multi_select":
    case "status":
      config = spec.options?.length ? { options: optionRequests(spec.options, t) } : {};
      break;
    case "number":
      config = { format: spec.number_format ?? "number" };
      break;
    case "formula":
      if (!spec.formula) fail("needs `formula` (the expression).");
      config = { expression: spec.formula };
      break;
    case "relation": {
      if (!spec.relation) fail("needs `relation: {database, two_way}`.");
      const rel = spec.relation as NonNullable<PropertySpec["relation"]>;
      const targetId = rel.database === "self" ? (selfId ?? self?.id) : (await resolveDataSource(rel.database)).id;
      if (!targetId) fail('"self" relations are added after the database exists.');
      config = rel.two_way
        ? { data_source_id: targetId, type: "dual_property", dual_property: rel.related_name ? { synced_property_name: rel.related_name } : {} }
        : { data_source_id: targetId, type: "single_property", single_property: {} };
      break;
    }
    case "rollup": {
      if (!spec.rollup) fail("needs `rollup: {relation, property, function}`.");
      const r = spec.rollup as NonNullable<PropertySpec["rollup"]>;
      const relName = self ? resolvePropertyName(self, r.relation).name : r.relation;
      if (self && self.properties[relName]?.type !== "relation") fail(`"${relName}" isn't a relation property.`);
      config = { relation_property_name: relName, rollup_property_name: r.property, function: r.function };
      break;
    }
    case "unique_id":
      config = { prefix: spec.prefix ?? null };
      break;
  }
  return { type: t, [t]: config, ...(spec.description ? { description: spec.description } : {}) };
}

/** A property that references something not yet created: self-relations, and rollups over them. */
export function needsSecondPass(spec: PropertySpec, specs: PropertySpec[]): boolean {
  if (spec.type === "relation" && spec.relation?.database === "self") return true;
  if (spec.type === "rollup") {
    const rel = specs.find((s) => s.name.toLowerCase() === spec.rollup?.relation.toLowerCase());
    return Boolean(rel && needsSecondPass(rel, specs));
  }
  return false;
}

/**
 * A request that re-creates an existing property's configuration (used to undo a delete).
 * Returns null for properties that can't be re-created exactly.
 */
export function configToRequest(ds: DataSourceObjectResponse, config: PropertyConfig): Record<string, unknown> | null {
  const c = config as unknown as Record<string, unknown> & { type: string; name: string; description?: string | null };
  const t = c.type;
  const inner = (c[t] ?? {}) as Record<string, unknown>;
  let out: Record<string, unknown> = {};
  switch (t) {
    case "select":
    case "multi_select":
      out = { options: (inner.options as { name: string; color: string; description?: string | null }[]).map((o) => ({ name: o.name, color: o.color })) };
      break;
    case "status": {
      const groups = (inner.groups as { name: string; option_ids: string[] }[]) ?? [];
      out = {
        options: (inner.options as { id: string; name: string; color: string }[]).map((o) => ({
          name: o.name,
          color: o.color,
          ...(groups.find((g) => g.option_ids.includes(o.id)) ? { group: groups.find((g) => g.option_ids.includes(o.id))?.name } : {}),
        })),
      };
      break;
    }
    case "number":
      out = { format: inner.format };
      break;
    case "formula":
      out = { expression: inner.expression };
      break;
    case "relation": {
      const rel = inner as { data_source_id: string; type: string; dual_property?: { synced_property_name?: string } };
      out =
        rel.type === "dual_property"
          ? { data_source_id: rel.data_source_id, type: "dual_property", dual_property: rel.dual_property?.synced_property_name ? { synced_property_name: rel.dual_property.synced_property_name } : {} }
          : { data_source_id: rel.data_source_id, type: "single_property", single_property: {} };
      break;
    }
    case "rollup": {
      const r = inner as { relation_property_name?: string; relation_property_id?: string; rollup_property_name?: string; function: string };
      const relName = r.relation_property_name ?? Object.values(ds.properties).find((p) => p.id === r.relation_property_id)?.name;
      if (!relName || !r.rollup_property_name) return null;
      out = { relation_property_name: relName, rollup_property_name: r.rollup_property_name, function: r.function };
      break;
    }
    case "unique_id":
      out = { prefix: (inner as { prefix?: string | null }).prefix ?? null };
      break;
    case "title":
      return null;
  }
  return { type: t, [t]: out, ...(c.description ? { description: c.description } : {}) };
}
