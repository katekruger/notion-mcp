import { collectPaginatedAPI, isFullDataSource, isFullUser } from "@notionhq/client";
import type { DataSourceObjectResponse, PageObjectResponse, UserObjectResponse } from "@notionhq/client";
import { call, isNotFound, normalizeId, notion } from "./notion.js";
import { forApi, fromInlineMarkdown, plain, toRequest } from "./richtext.js";

export type PropertyConfig = DataSourceObjectResponse["properties"][string];
export type PageProperty = PageObjectResponse["properties"][string];

interface CacheEntry {
  at: number;
  ds: DataSourceObjectResponse;
}
const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

export function invalidateSchema(dataSourceId: string): void {
  cache.delete(dataSourceId);
}

async function fetchDataSource(id: string): Promise<DataSourceObjectResponse> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ds;
  const res = await call(() => notion().dataSources.retrieve({ data_source_id: id }));
  if (!isFullDataSource(res)) throw new Error(`Could not read data source ${id}.`);
  cache.set(id, { at: Date.now(), ds: res });
  return res;
}

/**
 * Accepts a database URL/id or a data source id and returns the data source.
 * Databases with several data sources need `sourceName` to pick one.
 */
export async function resolveDataSource(idOrUrl: string, sourceName?: string): Promise<DataSourceObjectResponse> {
  const id = normalizeId(idOrUrl);
  try {
    return await fetchDataSource(id);
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  const db = await call(() => notion().databases.retrieve({ database_id: id }));
  const sources = "data_sources" in db ? db.data_sources : [];
  if (sources.length === 0) throw new Error(`Database ${id} has no data sources this integration can see.`);
  let chosen = sources[0];
  if (sources.length > 1) {
    const match = sourceName
      ? sources.find((s) => s.name.toLowerCase() === sourceName.toLowerCase())
      : undefined;
    if (!match) {
      throw new Error(
        `This database has ${sources.length} data sources: ${sources.map((s) => `"${s.name}" (${s.id})`).join(", ")}. ` +
          "Pass the data source id, or set data_source_name."
      );
    }
    chosen = match;
  }
  return fetchDataSource(chosen.id);
}

export function dataSourceTitle(ds: DataSourceObjectResponse): string {
  return plain(ds.title) || "(untitled)";
}

export function pageDataSourceId(page: PageObjectResponse): string | null {
  const parent = page.parent as { type: string; data_source_id?: string };
  return parent.type === "data_source_id" && parent.data_source_id ? parent.data_source_id : null;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/** Resolve a property name the way a person would type it: exact, then case/punctuation-insensitive, then near-miss. */
export function resolvePropertyName(ds: DataSourceObjectResponse, name: string): { name: string; note?: string } {
  const names = Object.keys(ds.properties);
  if (names.includes(name)) return { name };
  const byNorm = names.filter((n) => norm(n) === norm(name));
  if (byNorm.length === 1) return { name: byNorm[0], note: `"${name}" matched property "${byNorm[0]}"` };
  const near = names.filter((n) => distance(norm(n), norm(name)) <= 2);
  if (near.length === 1) return { name: near[0], note: `"${name}" matched property "${near[0]}" (closest spelling)` };
  throw new Error(`No property "${name}" in "${dataSourceTitle(ds)}". Properties: ${names.map((n) => `"${n}"`).join(", ")}.`);
}

let userCache: UserObjectResponse[] | null = null;
async function allUsers(): Promise<UserObjectResponse[]> {
  if (userCache) return userCache;
  let users;
  try {
    users = await collectPaginatedAPI(
      (args: { start_cursor?: string }) => call(() => notion().users.list(args)),
      {}
    );
  } catch (e) {
    // Personal access tokens get "Personal access tokens cannot list users" (verified live).
    throw new Error(
      `Can't look up people by name or email with this token (${(e as Error).message}). ` +
        "Pass Notion user ids instead; notion_get_page shows them on existing people properties."
    );
  }
  userCache = users.filter(isFullUser) as UserObjectResponse[];
  return userCache;
}

async function resolveUser(v: string): Promise<string> {
  if (/^[0-9a-f-]{32,36}$/i.test(v)) return normalizeId(v);
  const users = await allUsers();
  const lower = v.toLowerCase();
  const match = users.find(
    (u) =>
      (u.type === "person" && u.person.email?.toLowerCase() === lower) ||
      (u.name ?? "").toLowerCase() === lower
  );
  if (!match) {
    const emailHidden = v.includes("@") && !users.some((u) => u.type === "person" && u.person.email);
    throw new Error(
      `No workspace user matches "${v}". Use an email, exact name, or user id.` +
        (emailHidden
          ? " Notion returned no emails at all, so the integration likely lacks the \"Read user information including email addresses\" capability; enable it in the integration settings or use a name or id."
          : "")
    );
  }
  return match.id;
}

/** Notion rejects relation and people arrays longer than this in one write. */
export const MAX_REFERENCES = 100;

function checkReferenceCount(propName: string, kind: string, count: number): void {
  if (count > MAX_REFERENCES) {
    throw new Error(`"${propName}": Notion accepts at most ${MAX_REFERENCES} ${kind} per write; got ${count}.`);
  }
}

const READ_ONLY = new Set([
  "formula",
  "rollup",
  "created_time",
  "created_by",
  "last_edited_time",
  "last_edited_by",
  "unique_id",
  "verification",
  "button",
]);

function toList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
  return [value];
}

function matchOption(
  options: ReadonlyArray<{ name: string }>,
  value: string,
  propName: string,
  allowNew: boolean,
  kind: string
): { name: string; isNew: boolean } {
  const exact = options.find((o) => o.name === value);
  if (exact) return { name: exact.name, isNew: false };
  const loose = options.filter((o) => norm(o.name) === norm(value));
  if (loose.length === 1) return { name: loose[0].name, isNew: false };
  if (allowNew && kind !== "status") return { name: value, isNew: true };
  const hint = kind === "status"
    ? " Status options can't be created from a page update; add it in Notion first."
    : " Pass allow_new_options: true to create it.";
  throw new Error(
    `"${value}" is not an option of ${kind} "${propName}". Options: ${options.map((o) => `"${o.name}"`).join(", ") || "(none)"}.${hint}`
  );
}

export interface Coerced {
  payload: Record<string, unknown>;
  notes: string[];
}

/** Turn a friendly value into the exact Notion payload for this property, or explain why it can't. */
export async function coerceValue(
  propName: string,
  config: PropertyConfig,
  value: unknown,
  allowNewOptions: boolean
): Promise<Coerced> {
  const notes: string[] = [];
  const t = config.type;
  if (READ_ONLY.has(t)) throw new Error(`"${propName}" is a ${t} property and is computed by Notion; it can't be set.`);
  const isEmpty = value === null || value === "" || (Array.isArray(value) && value.length === 0);

  switch (t) {
    case "title":
    case "rich_text": {
      const text = isEmpty ? "" : String(value);
      return { payload: { [t]: text ? forApi(fromInlineMarkdown(text)) : [] }, notes };
    }
    case "number": {
      if (isEmpty) return { payload: { number: null }, notes };
      const n = typeof value === "number" ? value : Number(String(value).replace(/[,$%\s]/g, ""));
      if (!Number.isFinite(n)) throw new Error(`"${propName}" is a number property; "${String(value)}" isn't a number.`);
      return { payload: { number: n }, notes };
    }
    case "checkbox": {
      if (typeof value === "boolean") return { payload: { checkbox: value }, notes };
      const s = String(value).toLowerCase().trim();
      if (["true", "yes", "y", "1", "checked", "done"].includes(s)) return { payload: { checkbox: true }, notes };
      if (["false", "no", "n", "0", "unchecked", ""].includes(s)) return { payload: { checkbox: false }, notes };
      throw new Error(`"${propName}" is a checkbox; use true or false.`);
    }
    case "select":
    case "status": {
      if (isEmpty) return { payload: { [t]: null }, notes };
      const options = t === "select" ? config.select.options : config.status.options;
      const r = matchOption(options, String(value), propName, allowNewOptions, t);
      if (r.isNew) notes.push(`creates new option "${r.name}" on "${propName}"`);
      else if (r.name !== String(value)) notes.push(`"${String(value)}" matched option "${r.name}"`);
      return { payload: { [t]: { name: r.name } }, notes };
    }
    case "multi_select": {
      if (isEmpty) return { payload: { multi_select: [] }, notes };
      const names = toList(value).map((v) => {
        const r = matchOption(config.multi_select.options, String(v), propName, allowNewOptions, "multi_select");
        if (r.isNew) notes.push(`creates new option "${r.name}" on "${propName}"`);
        return { name: r.name };
      });
      return { payload: { multi_select: names }, notes };
    }
    case "date": {
      if (isEmpty) return { payload: { date: null }, notes };
      const obj = typeof value === "object" && value !== null
        ? (value as { start?: string; end?: string | null; time_zone?: string | null })
        : { start: String(value) };
      for (const d of [obj.start, obj.end]) {
        if (d && Number.isNaN(Date.parse(d))) throw new Error(`"${propName}": "${d}" isn't a valid date. Use ISO format like 2026-10-01 or 2026-10-01T14:00:00-04:00.`);
      }
      if (!obj.start) throw new Error(`"${propName}": a date needs a start.`);
      return { payload: { date: { start: obj.start, end: obj.end ?? null, ...(obj.time_zone ? { time_zone: obj.time_zone } : {}) } }, notes };
    }
    case "url":
    case "phone_number": {
      return { payload: { [t]: isEmpty ? null : String(value) }, notes };
    }
    case "email": {
      if (isEmpty) return { payload: { email: null }, notes };
      const s = String(value).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new Error(`"${propName}": "${s}" doesn't look like an email address.`);
      return { payload: { email: s }, notes };
    }
    case "people": {
      if (isEmpty) return { payload: { people: [] }, notes };
      const list = toList(value);
      checkReferenceCount(propName, "people", list.length);
      const ids = await Promise.all(list.map((v) => resolveUser(String(v))));
      return { payload: { people: ids.map((id) => ({ id })) }, notes };
    }
    case "relation": {
      if (isEmpty) return { payload: { relation: [] }, notes };
      const list = toList(value);
      checkReferenceCount(propName, "relations", list.length);
      const ids = list.map((v) => ({ id: normalizeId(String(v)) }));
      return { payload: { relation: ids }, notes };
    }
    default:
      throw new Error(`Setting "${t}" properties isn't supported yet ("${propName}").`);
  }
}

/** Human/model-friendly value for a page property. */
export function simplify(prop: PageProperty): unknown {
  const p = prop as unknown as Record<string, unknown> & { type: string };
  const v = p[p.type] as unknown;
  switch (p.type) {
    case "title":
    case "rich_text":
      return plain(v as Parameters<typeof plain>[0]);
    case "select":
    case "status":
      return v ? (v as { name: string }).name : null;
    case "multi_select":
      return (v as { name: string }[]).map((o) => o.name);
    case "people":
      return (v as { id: string; name?: string }[]).map((u) => u.name ?? u.id);
    case "relation":
      return (v as { id: string }[]).map((r) => r.id);
    case "date":
      return v ? ((v as { end?: string | null }).end ? v : (v as { start: string }).start) : null;
    case "formula": {
      const f = v as Record<string, unknown> & { type: string };
      return f[f.type] ?? null;
    }
    case "rollup": {
      const r = v as Record<string, unknown> & { type: string };
      if (r.type === "array") return `(rollup: ${(r.array as unknown[]).length} items)`;
      return r[r.type] ?? null;
    }
    case "files":
      return (v as { name: string }[]).map((f) => f.name);
    case "created_by":
    case "last_edited_by":
      return (v as { name?: string; id: string }).name ?? (v as { id: string }).id;
    case "unique_id": {
      const u = v as { prefix: string | null; number: number | null };
      return u.number === null ? null : `${u.prefix ? u.prefix + "-" : ""}${u.number}`;
    }
    default:
      return v ?? null;
  }
}

export function simplifyAll(page: PageObjectResponse): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(page.properties)) out[name] = simplify(prop);
  return out;
}

/** Payload that would set this property back to its current value (for undo). Null if not writable. */
export function restoreValue(prop: PageProperty): Record<string, unknown> | null {
  const p = prop as unknown as Record<string, unknown> & { type: string };
  const v = p[p.type] as unknown;
  switch (p.type) {
    case "title":
    case "rich_text":
      return { [p.type]: forApi(toRequest(v as Parameters<typeof toRequest>[0])) };
    case "number":
    case "checkbox":
    case "url":
    case "email":
    case "phone_number":
      return { [p.type]: v };
    case "select":
    case "status":
      return { [p.type]: v ? { name: (v as { name: string }).name } : null };
    case "multi_select":
      return { multi_select: (v as { name: string }[]).map((o) => ({ name: o.name })) };
    case "date":
      return { date: v ?? null };
    case "people":
    case "relation":
      return { [p.type]: (v as { id: string }[]).map((x) => ({ id: x.id })) };
    default:
      return null;
  }
}

// Page objects include at most 25 items for these property types; longer values are silently cut.
const TRUNCATED_TYPES = new Set(["title", "rich_text", "relation", "people"]);
const PAGE_OBJECT_ITEM_LIMIT = 25;

/** Read every item of one paginated page property (title, rich_text, relation, people). */
async function retrieveAllItems(pageId: string, propertyId: string): Promise<unknown[]> {
  const items: unknown[] = [];
  let cursor: string | undefined;
  do {
    const res = (await call(() =>
      notion().pages.properties.retrieve({ page_id: pageId, property_id: propertyId, ...(cursor ? { start_cursor: cursor } : {}) })
    )) as unknown as { object: string; results?: Record<string, unknown>[]; has_more?: boolean; next_cursor?: string | null };
    if (res.object !== "list" || !res.results) return items;
    for (const r of res.results) items.push(r[r.type as string]);
    cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
  } while (cursor);
  return items;
}

/**
 * Return a copy of the page where the named properties hold their full values.
 * Only properties that may have been truncated (25+ items) cost an extra request.
 * Used for undo snapshots and before/after previews, which must not lose items.
 */
export async function withFullProperties(page: PageObjectResponse, names: string[]): Promise<PageObjectResponse> {
  const properties = { ...page.properties };
  for (const name of names) {
    const prop = properties[name] as unknown as (Record<string, unknown> & { type: string; id: string }) | undefined;
    if (!prop || !TRUNCATED_TYPES.has(prop.type)) continue;
    const current = prop[prop.type];
    if (!Array.isArray(current) || current.length < PAGE_OBJECT_ITEM_LIMIT) continue;
    const full = await retrieveAllItems(page.id, prop.id);
    properties[name] = { ...prop, [prop.type]: full } as unknown as PageProperty;
  }
  return { ...page, properties };
}

/** Build a Notion filter from simple {Property: value} equality pairs. */
export async function buildWhereFilter(
  ds: DataSourceObjectResponse,
  where: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const clauses: Record<string, unknown>[] = [];
  for (const [rawName, value] of Object.entries(where)) {
    const { name } = resolvePropertyName(ds, rawName);
    const config = ds.properties[name];
    const t = config.type;
    const empty = value === null || value === "";
    if (empty) {
      clauses.push({ property: name, [t]: { is_empty: true } });
      continue;
    }
    switch (t) {
      case "title":
      case "rich_text":
      case "url":
      case "email":
      case "phone_number":
        clauses.push({ property: name, [t]: { equals: String(value) } });
        break;
      case "number":
        clauses.push({ property: name, number: { equals: Number(value) } });
        break;
      case "checkbox": {
        const c = await coerceValue(name, config, value, false);
        clauses.push({ property: name, checkbox: { equals: c.payload.checkbox } });
        break;
      }
      case "select":
      case "status": {
        const c = await coerceValue(name, config, value, false);
        clauses.push({ property: name, [t]: { equals: (c.payload[t] as { name: string }).name } });
        break;
      }
      case "multi_select": {
        const c = await coerceValue(name, config, value, false);
        for (const o of c.payload.multi_select as { name: string }[]) {
          clauses.push({ property: name, multi_select: { contains: o.name } });
        }
        break;
      }
      case "date":
        clauses.push({ property: name, date: { equals: String(value) } });
        break;
      case "people": {
        const c = await coerceValue(name, config, value, false);
        for (const u of c.payload.people as { id: string }[]) clauses.push({ property: name, people: { contains: u.id } });
        break;
      }
      case "relation":
        for (const v of toList(value)) clauses.push({ property: name, relation: { contains: normalizeId(String(v)) } });
        break;
      default:
        throw new Error(`"where" doesn't support ${t} properties ("${name}"); use a raw Notion filter instead.`);
    }
  }
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : { and: clauses };
}

export function describeSchema(ds: DataSourceObjectResponse): Record<string, unknown>[] {
  return Object.values(ds.properties).map((p) => {
    const base: Record<string, unknown> = { name: p.name, type: p.type };
    if (p.type === "select") base.options = p.select.options.map((o) => o.name);
    if (p.type === "multi_select") base.options = p.multi_select.options.map((o) => o.name);
    if (p.type === "status") {
      base.options = p.status.options.map((o) => o.name);
      base.groups = p.status.groups.map((g) => ({
        name: g.name,
        options: p.status.options.filter((o) => g.option_ids.includes(o.id)).map((o) => o.name),
      }));
    }
    if (p.type === "relation") base.related_data_source_id = p.relation.data_source_id;
    if (p.type === "formula") base.expression = p.formula.expression;
    if (p.type === "number") base.format = p.number.format;
    if (READ_ONLY.has(p.type)) base.read_only = true;
    return base;
  });
}
