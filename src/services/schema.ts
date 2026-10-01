import { collectPaginatedAPI, isFullDataSource, isFullUser } from "@notionhq/client";
import type { DataSourceObjectResponse, PageObjectResponse, UserObjectResponse } from "@notionhq/client";
import { read, isNotFound, normalizeId, notion } from "./notion.js";
import { isUrl, uploadLocalFile } from "./files.js";
import { forApi, fromInlineMarkdown, pendingUserLookups, plain, toRequest, USER_LOOKUP } from "./richtext.js";
import { config } from "../config.js";

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
  const res = await read(() => notion().dataSources.retrieve({ data_source_id: id }));
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
  const db = await read(() => notion().databases.retrieve({ database_id: id }));
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
      (args: { start_cursor?: string }) => read(() => notion().users.list(args)),
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

/** Replace user mentions written by email or name (see fromInlineMarkdown) with user ids, in place. */
export async function resolveUserMentions(payload: unknown): Promise<void> {
  for (const m of pendingUserLookups(payload)) m.user = { id: await resolveUser(m.user.id.slice(USER_LOOKUP.length)) };
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
  "button",
]);

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** Relation values may be page ids/URLs or titles of rows in the related database. Titles must match exactly one row. */
const relationTitleCache = new Map<string, { at: number; id: string }>();

async function resolveRelationValue(propName: string, dataSourceId: string, v: string): Promise<string> {
  const s = v.trim();
  if (UUID.test(s) || /notion\.(so|site|com)\//.test(s)) return normalizeId(s);
  const key = `${dataSourceId}|${s}`;
  const hit = relationTitleCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.id;
  const target = await fetchDataSource(dataSourceId);
  const titleName = Object.values(target.properties).find((p) => p.type === "title")?.name;
  if (!titleName) throw new Error(`"${propName}": the related database has no title property, so use page ids.`);
  const res = await read(() =>
    notion().dataSources.query({ data_source_id: dataSourceId, filter: { property: titleName, title: { equals: s } }, page_size: 2, result_type: "page" } as never)
  );
  if (res.results.length === 1) {
    relationTitleCache.set(key, { at: Date.now(), id: res.results[0].id });
    return res.results[0].id;
  }
  throw new Error(
    res.results.length === 0
      ? `"${propName}": no row titled "${s}" in "${dataSourceTitle(target)}". Create it first or pass a page id.`
      : `"${propName}": several rows in "${dataSourceTitle(target)}" are titled "${s}"; pass the page id instead.`
  );
}

interface FileInput {
  name?: string;
  url?: string;
  path?: string;
}

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

  if ((t as string) === "place") {
    if (isEmpty) return { payload: { place: null }, notes };
    const p = value as { lat?: unknown; lon?: unknown; name?: unknown; address?: unknown };
    if (typeof p !== "object" || typeof p.lat !== "number" || typeof p.lon !== "number") {
      throw new Error(`"${propName}" is a place; pass {"lat": 40.7, "lon": -74.0, "name": "…", "address": "…"}.`);
    }
    return {
      payload: { place: { lat: p.lat, lon: p.lon, ...(p.name ? { name: String(p.name) } : {}), ...(p.address ? { address: String(p.address) } : {}) } },
      notes,
    };
  }
  if ((t as string) === "verification") {
    const state = typeof value === "object" && value ? (value as { state?: string }).state : String(value ?? "unverified");
    if (state !== "verified" && state !== "unverified") throw new Error(`"${propName}": use "verified" or "unverified".`);
    const date = typeof value === "object" && value ? (value as { date?: unknown }).date : undefined;
    return { payload: { verification: state === "verified" ? { state, ...(date ? { date } : {}) } : { state } }, notes };
  }
  switch (t) {
    case "title":
    case "rich_text": {
      const text = isEmpty ? "" : String(value);
      const rich = text ? forApi(fromInlineMarkdown(text)) : [];
      await resolveUserMentions(rich);
      return { payload: { [t]: rich }, notes };
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
      // "a, b" is two ids only when every part is an id or link; otherwise it's one title that contains a comma.
      const parts = typeof value === "string" ? toList(value) : [];
      const list = typeof value === "string" && !parts.every((x) => UUID.test(String(x)) || /notion\.(so|site|com)\//.test(String(x))) ? [value] : toList(value);
      checkReferenceCount(propName, "relations", list.length);
      const ids: { id: string }[] = [];
      for (const v of list) {
        const id = await resolveRelationValue(propName, config.relation.data_source_id, String(v));
        if (!UUID.test(String(v).trim())) notes.push(`"${String(v)}" matched row ${id} in "${propName}"`);
        ids.push({ id });
      }
      return { payload: { relation: ids }, notes };
    }
    case "files": {
      if (isEmpty) return { payload: { files: [] }, notes };
      const list = (Array.isArray(value) ? value : [value]) as (string | FileInput)[];
      checkReferenceCount(propName, "files", list.length);
      const files: Record<string, unknown>[] = [];
      for (const item of list) {
        const f: FileInput = typeof item === "string" ? (isUrl(item) ? { url: item } : { path: item }) : item;
        const src = f.url ?? f.path;
        if (!src) throw new Error(`"${propName}": each file needs a URL or local path (got ${JSON.stringify(item)}).`);
        const name = (f.name ?? decodeURIComponent(src.split("?")[0].split(/[\\/]/).pop() || "file")).slice(0, 100);
        if (isUrl(src)) files.push({ name, external: { url: src } });
        else files.push({ name, file_upload: { id: await uploadLocalFile(src, name) } });
      }
      return { payload: { files }, notes };
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
      if (r.type === "array") {
        const items = (r.array as PageProperty[]).map((item) => simplify(item));
        const flat = items.flat().filter((x) => x !== null && x !== "");
        return flat.length > 25 ? [...flat.slice(0, 25), `…and ${flat.length - 25} more`] : flat;
      }
      if (r.type === "date") return r.date ? ((r.date as { end?: string | null }).end ? r.date : (r.date as { start: string }).start) : null;
      return r[r.type] ?? null;
    }
    case "files":
      return (v as { name: string }[]).map((f) => f.name);
    case "place": {
      const pl = v as { lat: number; lon: number; name?: string | null; address?: string | null } | null;
      return pl ? { ...(pl.name ? { name: pl.name } : {}), ...(pl.address ? { address: pl.address } : {}), lat: pl.lat, lon: pl.lon } : null;
    }
    case "verification":
      return v ? (v as { state: string }).state : null;
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
    case "files":
      // Notion-hosted files can be sent back by their (signed) URL (verified live).
      return {
        files: (v as { name: string; type: string; external?: { url: string }; file?: { url: string } }[]).map((f) =>
          f.type === "external" ? { name: f.name, external: { url: f.external?.url } } : { name: f.name, file: { url: f.file?.url } }
        ),
      };
    case "place": {
      const pl = v as { lat: number; lon: number; name?: string | null; address?: string | null } | null;
      return { place: pl ? { lat: pl.lat, lon: pl.lon, ...(pl.name ? { name: pl.name } : {}), ...(pl.address ? { address: pl.address } : {}) } : null };
    }
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
    const res = (await read(() =>
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

/** YYYY-MM-DD in the configured zone (NOTION_PLUS_TIMEZONE, else the system zone). */
function localDate(d: Date): string {
  const tz = config().timezone;
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** "today", "tomorrow", "yesterday", "+7d", "-2w", "+1m" → YYYY-MM-DD; anything else is returned as-is. */
export function resolveRelativeDate(v: string, now = new Date()): string {
  const s = v.trim().toLowerCase();
  const day = 86_400_000;
  if (s === "today" || s === "now") return localDate(now);
  if (s === "tomorrow") return localDate(new Date(now.getTime() + day));
  if (s === "yesterday") return localDate(new Date(now.getTime() - day));
  const m = s.match(/^([+-])(\d+)\s*(d|day|days|w|week|weeks|m|month|months|y|year|years)$/);
  if (!m) return v;
  const n = Number(m[2]) * (m[1] === "-" ? -1 : 1);
  const unit = m[3][0];
  if (unit === "d") return localDate(new Date(now.getTime() + n * day));
  if (unit === "w") return localDate(new Date(now.getTime() + n * 7 * day));
  const d = new Date(now);
  if (unit === "m") d.setMonth(d.getMonth() + n);
  else d.setFullYear(d.getFullYear() + n);
  return localDate(d);
}

const OP_ALIASES: Record<string, string> = {
  "=": "equals", "==": "equals", is: "equals", eq: "equals",
  "!=": "does_not_equal", not: "does_not_equal", ne: "does_not_equal", is_not: "does_not_equal",
  ">": "greater_than", gt: "greater_than", ">=": "greater_than_or_equal_to", gte: "greater_than_or_equal_to",
  "<": "less_than", lt: "less_than", "<=": "less_than_or_equal_to", lte: "less_than_or_equal_to",
  not_contains: "does_not_contain",
};

const DATE_OPS: Record<string, string> = {
  equals: "equals", greater_than: "after", less_than: "before", greater_than_or_equal_to: "on_or_after",
  less_than_or_equal_to: "on_or_before", before: "before", after: "after", on_or_before: "on_or_before", on_or_after: "on_or_after",
};
const DATE_RANGES = ["past_week", "past_month", "past_year", "next_week", "next_month", "next_year", "this_week"];

function isOpObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every((k) => k in OP_ALIASES || /^[a-z_]+$/.test(k)) && !("lat" in v) && !("start" in v);
}

/** One clause for `name` of type `t`: operator (already normalized) and value. */
async function clause(ds: DataSourceObjectResponse, name: string, op: string, value: unknown): Promise<Record<string, unknown>> {
  const config = ds.properties[name];
  const t = config.type as string;
  const wrap = (key: string, cond: Record<string, unknown>) =>
    key === "created_time" || key === "last_edited_time" ? { timestamp: key, [key]: cond } : { property: name, [key]: cond };
  if (op === "is_empty" || op === "is_not_empty") {
    const empty = op === "is_empty" ? value !== false : value === false;
    return wrap(t, { [empty ? "is_empty" : "is_not_empty"]: true });
  }
  const bad = (ops: string) => new Error(`"${name}" (${t}) supports: ${ops}. Got "${op}".`);
  switch (t) {
    case "title":
    case "rich_text":
    case "url":
    case "email":
    case "phone_number": {
      const ok = ["equals", "does_not_equal", "contains", "does_not_contain", "starts_with", "ends_with"];
      if (!ok.includes(op)) throw bad(ok.join(", "));
      return wrap(t, { [op]: String(value) });
    }
    case "number":
    case "unique_id": {
      const ok = ["equals", "does_not_equal", "greater_than", "less_than", "greater_than_or_equal_to", "less_than_or_equal_to"];
      if (!ok.includes(op)) throw bad(`=, !=, >, >=, <, <=`);
      const num = typeof value === "number" ? value : Number(String(value).replace(/^[A-Za-z]+-/, "").replace(/[,$%\s]/g, ""));
      if (!Number.isFinite(num)) throw new Error(`"${name}": "${String(value)}" isn't a number.`);
      return wrap(t, { [op]: num });
    }
    case "checkbox": {
      if (op !== "equals" && op !== "does_not_equal") throw bad("=, !=");
      const c = await coerceValue(name, config, value, false);
      return wrap(t, { [op]: c.payload.checkbox });
    }
    case "select":
    case "status": {
      if (op !== "equals" && op !== "does_not_equal") throw bad("=, !=, in, is_empty");
      const c = await coerceValue(name, config, value, false);
      return wrap(t, { [op]: (c.payload[t] as { name: string }).name });
    }
    case "multi_select": {
      if (op !== "contains" && op !== "does_not_contain" && op !== "equals") throw bad("contains, does_not_contain, is_empty");
      const c = await coerceValue(name, config, value, false);
      const names = (c.payload.multi_select as { name: string }[]).map((o) => o.name);
      const key = op === "does_not_contain" ? "does_not_contain" : "contains";
      return names.length === 1 ? wrap(t, { [key]: names[0] }) : { and: names.map((n) => wrap(t, { [key]: n })) };
    }
    case "people":
    case "relation": {
      if (op !== "contains" && op !== "does_not_contain" && op !== "equals") throw bad("contains, does_not_contain, is_empty");
      const c = await coerceValue(name, config, value, false);
      const ids = (c.payload[t] as { id: string }[]).map((o) => o.id);
      const key = op === "does_not_contain" ? "does_not_contain" : "contains";
      return ids.length === 1 ? wrap(t, { [key]: ids[0] }) : { and: ids.map((id) => wrap(t, { [key]: id })) };
    }
    case "date":
    case "created_time":
    case "last_edited_time": {
      if (DATE_RANGES.includes(op)) return wrap(t, { [op]: {} });
      const mapped = DATE_OPS[op];
      if (!mapped) throw bad(`=, before/<, after/>, on_or_before/<=, on_or_after/>=, ${DATE_RANGES.join(", ")}, is_empty`);
      const d = resolveRelativeDate(String(value));
      if (Number.isNaN(Date.parse(d))) throw new Error(`"${name}": "${String(value)}" isn't a date. Use YYYY-MM-DD, "today", or "+7d".`);
      return wrap(t, { [mapped]: d });
    }
    default:
      throw new Error(`"where" doesn't support ${t} properties ("${name}"); use a raw Notion \`filter\` instead.`);
  }
}

/**
 * Build a Notion filter from a friendly `where`:
 * - {"Status": "Done"} equality (names and options matched forgivingly), null for empty
 * - {"Due": {"before": "today"}}, {"Points": {">": 5, "<=": 10}}, {"Tags": {"contains": "Q4"}}, {"Owner": {"is_empty": true}}
 * - {"Status": {"in": ["Done", "Blocked"]}}, {"Due": "past_week"} style ranges via {"Due": {"past_week": true}}
 * - {"or": [{…}, {…}]}, {"and": [...]}, and "$created" / "$last_edited" for timestamps
 * Relative dates: "today", "tomorrow", "yesterday", "+7d", "-2w", "+1m".
 */
export async function buildWhereFilter(
  ds: DataSourceObjectResponse,
  where: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const clauses: Record<string, unknown>[] = [];
  for (const [rawName, value] of Object.entries(where)) {
    if (rawName === "or" || rawName === "and") {
      if (!Array.isArray(value) || value.length === 0) throw new Error(`"${rawName}" takes a non-empty list of conditions.`);
      const parts: Record<string, unknown>[] = [];
      for (const w of value) {
        const f = await buildWhereFilter(ds, w as Record<string, unknown>);
        if (f) parts.push(f);
      }
      clauses.push(parts.length === 1 ? parts[0] : { [rawName]: parts });
      continue;
    }
    const name =
      rawName === "$created" || rawName === "$last_edited"
        ? rawName
        : resolvePropertyName(ds, rawName).name;
    const tsType = name === "$created" ? "created_time" : name === "$last_edited" ? "last_edited_time" : null;
    const target = tsType
      ? { ...ds, properties: { ...ds.properties, [name]: { id: name, name, type: tsType, [tsType]: {} } } } as unknown as DataSourceObjectResponse
      : ds;
    const conds: Record<string, unknown>[] = [];
    if (value === null || value === "") {
      conds.push(await clause(target, name, "is_empty", true));
    } else if (isOpObject(value)) {
      for (const [rawOp, v] of Object.entries(value)) {
        const op = OP_ALIASES[rawOp] ?? rawOp;
        if (op === "in" || op === "not_in") {
          if (!Array.isArray(v) || v.length === 0) throw new Error(`"${name}": "${op}" takes a non-empty list.`);
          const parts = await Promise.all(v.map((x) => clause(target, name, op === "in" ? "equals" : "does_not_equal", x)));
          conds.push(parts.length === 1 ? parts[0] : { [op === "in" ? "or" : "and"]: parts });
        } else if (DATE_RANGES.includes(op) && v === true) {
          conds.push(await clause(target, name, op, true));
        } else {
          conds.push(await clause(target, name, op, v));
        }
      }
    } else {
      const t = target.properties[name].type as string;
      const op = t === "multi_select" || t === "people" || t === "relation" ? "contains" : "equals";
      conds.push(await clause(target, name, op, value));
    }
    clauses.push(...conds);
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
