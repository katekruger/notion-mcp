// Copy a database that sits on a page: schema (every data source), rows with their values and content.
// The API has no database duplicate, so this rebuilds it. Relations inside the copied database point at the
// copied rows; relations to other databases keep pointing there but become one-way, so nothing outside is changed.
import type { DataSourceObjectResponse, DatabaseObjectResponse, PageObjectResponse } from "@notionhq/client";
import { call, mapLimited, notion, read } from "./notion.js";
import { configToRequest } from "./dbschema.js";
import { queryAll } from "./query.js";
import { restoreValue, withFullProperties } from "./schema.js";
import { plain } from "./richtext.js";

/** Rows copied per database; the rest are reported. */
export const MAX_COPY_ROWS = 500;

type PropertyConfig = DataSourceObjectResponse["properties"][string];
type RichText = DatabaseObjectResponse["title"];

export interface DatabaseCopyPlan {
  id: string;
  title: string;
  data_sources: { id: string; name: string; rows: number; more: boolean }[];
}

export interface DatabaseCopyResult {
  source_id: string;
  database_id: string;
  title: string;
  rows: number;
  notes: string[];
}

function richTextRequest(rt: RichText): Record<string, unknown>[] {
  return rt.map((t) => ({ type: "text", text: { content: t.plain_text, ...(t.href ? { link: { url: t.href } } : {}) }, annotations: t.annotations }));
}

/** The database behind a child_database block, or null for a linked view (which the API can't read or recreate). */
export async function readDatabase(blockId: string): Promise<DatabaseObjectResponse | null> {
  try {
    const db = await read(() => notion().databases.retrieve({ database_id: blockId }));
    return "data_sources" in db ? (db as DatabaseObjectResponse) : null;
  } catch {
    return null;
  }
}

async function readSources(db: DatabaseObjectResponse): Promise<DataSourceObjectResponse[]> {
  const out: DataSourceObjectResponse[] = [];
  for (const ref of db.data_sources) {
    out.push((await read(() => notion().dataSources.retrieve({ data_source_id: ref.id }))) as DataSourceObjectResponse);
  }
  return out;
}

export async function planDatabaseCopy(db: DatabaseObjectResponse, withRows: boolean): Promise<DatabaseCopyPlan> {
  const sources = await readSources(db);
  const data_sources = [];
  for (const ds of sources) {
    const q = withRows ? await queryAll(ds.id, { max: MAX_COPY_ROWS }) : { pages: [], more: false };
    data_sources.push({ id: ds.id, name: plain(ds.title) || "(untitled)", rows: q.pages.length, more: q.more });
  }
  return { id: db.id, title: plain(db.title) || "(untitled)", data_sources };
}

/**
 * Split a data source's properties into what can be created with the data source and what must wait until every
 * copied data source exists (relations inside the copy, and rollups over them).
 */
export function splitSchema(
  ds: DataSourceObjectResponse,
  copiedIds: Set<string>
): { first: Record<string, Record<string, unknown>>; later: Record<string, Record<string, unknown>>; notes: string[] } {
  const first: Record<string, Record<string, unknown>> = {};
  const later: Record<string, Record<string, unknown>> = {};
  const notes: string[] = [];
  const deferredRelations = new Set<string>();
  const syncedSides = new Set<string>();
  const props = Object.values(ds.properties) as PropertyConfig[];
  for (const p of props) {
    if (p.type === "title") {
      first[p.name] = { title: {} };
      continue;
    }
    if ((p.type as string) === "button") {
      notes.push(`"${(p as { name: string }).name}" is a button property, which the API can't create; add it in Notion.`);
      continue;
    }
    const req = configToRequest(ds, p);
    if (!req) {
      notes.push(`"${p.name}" (${p.type}) couldn't be recreated.`);
      continue;
    }
    if (p.type === "relation") {
      const rel = p.relation as { data_source_id: string; type: string; dual_property?: { synced_property_name?: string } };
      if (copiedIds.has(rel.data_source_id)) {
        if (syncedSides.has(p.name)) {
          deferredRelations.add(p.name); // created together with its other side
          continue;
        }
        deferredRelations.add(p.name);
        if (rel.type === "dual_property" && rel.dual_property?.synced_property_name) syncedSides.add(rel.dual_property.synced_property_name);
        later[p.name] = req;
      } else {
        // A two-way relation to a database outside the copy would add a property there; keep it one-way.
        if (rel.type === "dual_property") notes.push(`"${p.name}" relates to a database outside the copy, so the copy's relation is one-way.`);
        first[p.name] = { ...req, relation: { data_source_id: rel.data_source_id, type: "single_property", single_property: {} } };
      }
      continue;
    }
    if (p.type === "rollup") {
      const relName = (req.rollup as { relation_property_name: string }).relation_property_name;
      (deferredRelations.has(relName) ? later : first)[p.name] = req;
      continue;
    }
    first[p.name] = req;
  }
  // Rollups can be listed before the relation they use.
  for (const [name, req] of Object.entries(first)) {
    const relName = (req.rollup as { relation_property_name?: string } | undefined)?.relation_property_name;
    if (relName && deferredRelations.has(relName)) later[name] = req;
  }
  const firstOnly = Object.fromEntries(Object.entries(first).filter(([name]) => !(name in later)));
  return { first: firstOnly, later, notes };
}

/** Point relations at copied data sources and rows. */
function remapRelation(req: Record<string, unknown>, dsMap: Map<string, string>): Record<string, unknown> {
  const rel = req.relation as { data_source_id: string } | undefined;
  if (!rel) return req;
  return { ...req, relation: { ...rel, data_source_id: dsMap.get(rel.data_source_id) ?? rel.data_source_id } };
}

const FULL_TYPES = new Set(["title", "rich_text", "relation", "people"]);

/** Copy a database onto a page, after whatever the page already has. */
export async function copyDatabase(
  db: DatabaseObjectResponse,
  parentPageId: string,
  opts: { withRows: boolean; copyContent: (fromPageId: string, toPageId: string) => Promise<void> }
): Promise<DatabaseCopyResult> {
  const notes: string[] = [];
  const sources = await readSources(db);
  const copiedIds = new Set(sources.map((s) => s.id));
  const plans = sources.map((ds) => ({ ds, ...splitSchema(ds, copiedIds) }));
  for (const p of plans) notes.push(...p.notes);

  const [head, ...rest] = plans;
  const title = plain(db.title) || "(untitled)";
  const created = await call(() =>
    notion().databases.create({
      parent: { type: "page_id", page_id: parentPageId },
      title: richTextRequest(db.title),
      ...(db.description.length ? { description: richTextRequest(db.description) } : {}),
      is_inline: db.is_inline,
      ...(db.icon && db.icon.type === "emoji" ? { icon: { type: "emoji", emoji: db.icon.emoji } } : {}),
      initial_data_source: { properties: head.first },
    } as never)
  );
  const createdDb = created as DatabaseObjectResponse;
  const dsMap = new Map<string, string>();
  dsMap.set(head.ds.id, createdDb.data_sources[0].id);
  if (sources.length > 1 || plain(head.ds.title) !== title) {
    await call(() => notion().dataSources.update({ data_source_id: dsMap.get(head.ds.id) as string, title: richTextRequest(head.ds.title) } as never));
  }
  for (const p of rest) {
    const ds = await call(() =>
      notion().dataSources.create({ parent: { type: "database_id", database_id: createdDb.id }, title: richTextRequest(p.ds.title), properties: p.first } as never)
    );
    dsMap.set(p.ds.id, ds.id);
  }
  for (const p of plans) {
    if (!Object.keys(p.later).length) continue;
    const properties = Object.fromEntries(Object.entries(p.later).map(([k, v]) => [k, remapRelation(v, dsMap)]));
    // Relations first, then the rollups that read them.
    const rels = Object.fromEntries(Object.entries(properties).filter(([, v]) => v.type === "relation"));
    const rolls = Object.fromEntries(Object.entries(properties).filter(([, v]) => v.type !== "relation"));
    if (Object.keys(rels).length) await call(() => notion().dataSources.update({ data_source_id: dsMap.get(p.ds.id) as string, properties: rels } as never));
    if (Object.keys(rolls).length) await call(() => notion().dataSources.update({ data_source_id: dsMap.get(p.ds.id) as string, properties: rolls } as never));
  }

  let rows = 0;
  if (opts.withRows) {
    const rowMap = new Map<string, string>();
    const pending: { newId: string; relations: Record<string, { id: string }[]> }[] = [];
    for (const p of plans) {
      const q = await queryAll(p.ds.id, { max: MAX_COPY_ROWS });
      if (q.more) notes.push(`"${plain(p.ds.title) || title}" has more than ${MAX_COPY_ROWS} rows; the first ${MAX_COPY_ROWS} were copied.`);
      const writable = new Set([...Object.keys(p.first), ...Object.keys(p.later)]);
      const internal = new Set(Object.keys(p.later).filter((k) => p.later[k].type === "relation"));
      await mapLimited(q.pages, async (row: PageObjectResponse) => {
        const full = await withFullProperties(row, Object.entries(row.properties).filter(([, v]) => FULL_TYPES.has(v.type)).map(([k]) => k));
        const properties: Record<string, unknown> = {};
        const relations: Record<string, { id: string }[]> = {};
        for (const [name, prop] of Object.entries(full.properties)) {
          if (!writable.has(name)) continue;
          const v = restoreValue(prop);
          if (!v) continue;
          if (internal.has(name)) relations[name] = (v.relation as { id: string }[]) ?? [];
          else properties[name] = v;
        }
        const page = await call(() =>
          notion().pages.create({
            parent: { data_source_id: dsMap.get(p.ds.id) as string },
            properties,
            ...(row.icon && row.icon.type === "emoji" ? { icon: { type: "emoji", emoji: row.icon.emoji } } : {}),
          } as never)
        );
        rowMap.set(row.id, page.id);
        if (Object.values(relations).some((r) => r.length)) pending.push({ newId: page.id, relations });
        await opts.copyContent(row.id, page.id);
      });
      rows += q.pages.length;
    }
    await mapLimited(pending, async ({ newId, relations }) => {
      const properties = Object.fromEntries(
        Object.entries(relations).map(([k, ids]) => [k, { relation: ids.map((r) => rowMap.get(r.id)).filter(Boolean).map((id) => ({ id })) }])
      );
      await call(() => notion().pages.update({ page_id: newId, properties } as never));
    });
  }
  notes.push(`"${title}": views aren't copied; the copy has a default table view (add others with notion_views).`);
  return { source_id: db.id, database_id: createdDb.id, title, rows, notes };
}
