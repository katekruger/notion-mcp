// Property-write helpers shared by the page tools and the automations runner.
import { isFullPage } from "@notionhq/client";
import type { DataSourceObjectResponse, PageObjectResponse } from "@notionhq/client";
import { read, notion } from "./notion.js";
import { coerceValue, resolvePropertyName, restoreValue, simplify } from "./schema.js";
import type { UndoOp } from "./journal.js";

/** Validate friendly values against the schema; reports every problem at once. */
export async function preparePayload(
  ds: DataSourceObjectResponse,
  values: Record<string, unknown>,
  allowNew: boolean
): Promise<{ payload: Record<string, Record<string, unknown>>; notes: string[] }> {
  const payload: Record<string, Record<string, unknown>> = {};
  const notes: string[] = [];
  const errors: string[] = [];
  for (const [raw, value] of Object.entries(values)) {
    try {
      const r = resolvePropertyName(ds, raw);
      if (r.note) notes.push(r.note);
      const c = await coerceValue(r.name, ds.properties[r.name], value, allowNew);
      payload[r.name] = c.payload;
      notes.push(...c.notes);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  // Report every problem at once so the model can fix them in a single retry.
  if (errors.length) throw new Error(`Nothing was written. Fix these first:\n- ${errors.join("\n- ")}`);
  return { payload, notes };
}

/** Retrieve a page, failing clearly on partial responses. */
export async function getFullPage(id: string): Promise<PageObjectResponse> {
  const p = await read(() => notion().pages.retrieve({ page_id: id }));
  if (!isFullPage(p)) throw new Error(`Could not read page ${id}.`);
  return p;
}

/** Simple values of the named properties, for previews. */
export function beforeAfter(page: PageObjectResponse, names: string[]): Record<string, unknown> {
  return Object.fromEntries(names.map((n) => [n, simplify(page.properties[n])]));
}

/** Undo op that restores the named properties to their values on this page object. */
export function snapshot(page: PageObjectResponse, names: string[]): UndoOp {
  const properties: Record<string, unknown> = {};
  for (const n of names) {
    const v = restoreValue(page.properties[n]);
    if (v) properties[n] = v;
  }
  return { kind: "page_properties", page_id: page.id, properties };
}
