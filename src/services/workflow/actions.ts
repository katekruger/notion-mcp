// What each workflow step does. Steps that create something (pages, blocks, comments) can be retried after a crash
// without creating it twice: the engine records when a step started, and if a run resumes a step that started but
// never finished, `reconcile` first looks for what that attempt already made (created since it started, matching
// its title or text) and adopts or removes it. HTTP steps send an Idempotency-Key header so receivers can do the same.
import type { DataSourceObjectResponse, PageObjectResponse } from "@notionhq/client";
import { call, createPage, isNotFound, normalizeId, notion, read, updatePage } from "../notion.js";
import { buildWhereFilter, dataSourceTitle, resolveDataSource, simplifyAll } from "../schema.js";
import { queryAll } from "../query.js";
import { appendSpecs, blockText, listChildren, markdownToSpecs, PartialWriteError, type BlockSpec } from "../blocks.js";
import { forApi, fromInlineMarkdown, textToTitle } from "../richtext.js";
import { preparePayload, getFullPage, snapshot } from "../writes.js";
import { insertedBlocks, type UndoOp } from "../journal.js";
import { readPageMarkdown } from "../pagemd.js";
import { safeFetch } from "../fetch.js";
import { callTool } from "./bridge.js";
import type { StepAction } from "./schema.js";

export interface StepRun {
  undo: UndoOp[];
  /** When this attempt (or the interrupted one, on resume) started. */
  startedAt: string;
  /** The step started before and never finished: look for its effects before acting again. */
  resumed: boolean;
  /** Stable per run and step (and loop item): the Idempotency-Key for HTTP steps. */
  key: string;
}

/** A page reference may be an id, a URL, or a row from a query step ({id, …}). */
export function pageId(ref: unknown): string {
  if (ref && typeof ref === "object" && typeof (ref as { id?: unknown }).id === "string") return normalizeId((ref as { id: string }).id);
  if (typeof ref === "string") return normalizeId(ref);
  throw new Error(`Expected a page (an id, a URL, or a row from a query step); got ${JSON.stringify(ref)?.slice(0, 80)}.`);
}

function minuteBefore(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 60_000) * 60_000 - 60_000;
}

function plainOf(markdownText: string | undefined): string {
  return (markdownText ? fromInlineMarkdown(markdownText) : []).map((s) => (s.type === "text" ? s.text.content : "")).join("");
}

async function dataSourceOrNull(ref: string): Promise<DataSourceObjectResponse | null> {
  try {
    return await resolveDataSource(ref);
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/**
 * An interrupted append may have left part of its blocks on the page. Remove the run of top-level blocks it left
 * (created since the attempt started, starting with the same text as the first block), so appending again doesn't
 * duplicate them. Returns how many were removed.
 */
export async function removeLeftovers(pageIdValue: string, specs: BlockSpec[], startedAt: string): Promise<number> {
  const first = plainOf(specs[0]?.text);
  if (!first) return 0;
  const since = minuteBefore(startedAt);
  const kids = await listChildren(pageIdValue);
  const start = kids.findIndex((b) => new Date(b.created_time).getTime() >= since && blockText(b) === first);
  if (start < 0) return 0;
  // The leftover run: from that block, the blocks created since the attempt started, at most as many as it appends.
  const run = kids.slice(start, start + specs.length).filter((b) => new Date(b.created_time).getTime() >= since);
  for (const b of run) await call(() => notion().blocks.delete({ block_id: b.id }));
  return run.length;
}

/** HTTP hosts steps may call: NOTION_PLUS_HTTP_ALLOW, comma-separated (`*.example.com` matches subdomains). */
export function hostAllowed(host: string, extra: string[] = []): boolean {
  const allow = [...(process.env.NOTION_PLUS_HTTP_ALLOW ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean), ...extra];
  const h = host.toLowerCase();
  return allow.some((a) => (a.startsWith("*.") ? h.endsWith(a.slice(1)) : h === a));
}

async function httpCall(url: string, opts: { method: string; headers: Record<string, string>; body?: unknown; key: string; extraAllow?: string[] }): Promise<{ status: number; body: unknown }> {
  const u = new URL(url);
  if (!hostAllowed(u.hostname, opts.extraAllow)) {
    throw new Error(`${u.hostname} isn't in NOTION_PLUS_HTTP_ALLOW. Add it (comma-separated hosts) to let workflows call it.`);
  }
  const body = opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  const res = await safeFetch(url, {
    method: opts.method,
    headers: { ...(body !== undefined && typeof opts.body !== "string" ? { "content-type": "application/json" } : {}), "idempotency-key": opts.key, ...opts.headers },
    ...(body !== undefined ? { body } : {}),
    maxBytes: 2 * 1024 * 1024,
    timeoutMs: 30_000,
  });
  const text = new TextDecoder().decode(res.body).slice(0, 20_000);
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (res.status >= 400) throw new Error(`${opts.method} ${u.hostname}${u.pathname} answered HTTP ${res.status}: ${text.slice(0, 300)}`);
  return { status: res.status, body: parsed };
}

/** Run one (already resolved) non-control action. Returns the step's output. */
export async function runAction(a: StepAction, r: StepRun): Promise<unknown> {
  const n = notion();
  if ("query" in a) {
    const q = a.query;
    const ds = await resolveDataSource(q.database, q.data_source_name);
    const filter = q.where ? await buildWhereFilter(ds, q.where) : undefined;
    const { pages, more } = await queryAll(ds.id, { ...(filter ? { filter } : {}), max: q.limit ?? 100 });
    const titleName = Object.values(ds.properties).find((p) => p.type === "title")?.name;
    return {
      database: dataSourceTitle(ds),
      count: pages.length,
      more,
      rows: pages.map((p: PageObjectResponse) => {
        const props = simplifyAll(p);
        return { id: p.id, url: p.url, title: titleName ? props[titleName] : "", ...props };
      }),
    };
  }
  if ("set" in a) {
    const id = pageId(a.set.page);
    const page = await getFullPage(id);
    const dsId = (page.parent as { data_source_id?: string }).data_source_id;
    if (!dsId) throw new Error(`Page ${id} isn't a database row; set changes row properties.`);
    const ds = await resolveDataSource(dsId);
    const { payload } = await preparePayload(ds, a.set.values, a.set.allow_new_options ?? false);
    r.undo.push(snapshot(page, Object.keys(payload)));
    await call(() => updatePage({ page_id: id, properties: payload }));
    return { page_id: id, set: Object.keys(payload) };
  }
  if ("append" in a) {
    const id = pageId(a.append.page);
    const specs = a.append.markdown ? markdownToSpecs(a.append.markdown) : (a.append.blocks as BlockSpec[]);
    if (r.resumed) await removeLeftovers(id, specs, r.startedAt);
    let ids: string[];
    try {
      ids = await appendSpecs(id, specs);
    } catch (e) {
      if (e instanceof PartialWriteError) r.undo.push(...insertedBlocks(e.createdIds, id));
      throw e;
    }
    r.undo.push(...insertedBlocks(ids, id));
    return { page_id: id, block_ids: ids };
  }
  if ("comment" in a) {
    const id = pageId(a.comment.page);
    if (r.resumed) {
      const since = minuteBefore(r.startedAt);
      const want = plainOf(a.comment.text);
      const res = await read(() => n.comments.list({ block_id: id, page_size: 100 }));
      const done = res.results.find((c) => new Date(c.created_time).getTime() >= since && c.rich_text.map((t) => t.plain_text).join("") === want);
      if (done) return { comment_id: done.id, page_id: id, adopted: true };
    }
    const c = await call(() => n.comments.create({ parent: { page_id: id }, rich_text: forApi(fromInlineMarkdown(a.comment.text)) } as never));
    r.undo.push({ kind: "comment_delete", comment_id: c.id });
    return { comment_id: c.id, page_id: id };
  }
  if ("create_page" in a) {
    const c = a.create_page;
    const ds = await dataSourceOrNull(c.parent);
    const since = minuteBefore(r.startedAt);
    if (r.resumed) {
      // Find the page an interrupted attempt created: same title, created since it started.
      if (ds) {
        const titleName = Object.values(ds.properties).find((p) => p.type === "title")?.name as string;
        const { pages } = await queryAll(ds.id, { filter: { and: [{ property: titleName, title: { equals: c.title } }, { timestamp: "created_time", created_time: { on_or_after: new Date(since).toISOString() } }] }, max: 1 });
        if (pages[0]) return { page_id: pages[0].id, url: pages[0].url, adopted: true };
      } else {
        const hit = (await listChildren(pageId(c.parent))).find((b) => b.type === "child_page" && b.child_page.title === c.title && new Date(b.created_time).getTime() >= since);
        if (hit) return { page_id: hit.id, adopted: true };
      }
    }
    const body: Record<string, unknown> = {};
    if (ds) {
      const titleName = Object.values(ds.properties).find((p) => p.type === "title")?.name as string;
      const { payload } = await preparePayload(ds, { ...(c.properties ?? {}), [titleName]: c.title }, false);
      body.parent = { type: "data_source_id", data_source_id: ds.id };
      body.properties = payload;
    } else {
      if (c.properties) throw new Error("create_page: properties need a database parent.");
      body.parent = { type: "page_id", page_id: pageId(c.parent) };
      body.properties = { title: { title: textToTitle(c.title) } };
    }
    if (c.icon) body.icon = { type: "emoji", emoji: c.icon };
    const created = await call(() => createPage(body as never));
    r.undo.push({ kind: "page_trash", page_id: created.id, in_trash: true });
    if (c.markdown) await appendSpecs(created.id, markdownToSpecs(c.markdown));
    return { page_id: created.id, url: "url" in created ? created.url : undefined };
  }
  if ("move_page" in a) {
    const id = pageId(a.move_page.page);
    const page = await getFullPage(id);
    const ds = await dataSourceOrNull(a.move_page.to);
    const parent = ds ? { type: "data_source_id", data_source_id: ds.id } : { type: "page_id", page_id: pageId(a.move_page.to) };
    r.undo.push({ kind: "page_move", page_id: id, parent: page.parent as unknown as Record<string, unknown> });
    await call(() => n.pages.move({ page_id: id, parent } as never));
    return { page_id: id, moved_to: a.move_page.to };
  }
  if ("trash" in a) {
    const id = pageId(a.trash.page);
    await call(() => updatePage({ page_id: id, in_trash: true }));
    r.undo.push({ kind: "page_trash", page_id: id, in_trash: false });
    return { page_id: id, trashed: true };
  }
  if ("duplicate_page" in a) {
    const d = a.duplicate_page;
    return callTool("notion_duplicate_page", { page: pageId(d.page), ...(d.to ? { to: d.to } : {}), ...(d.title ? { title: d.title } : {}) });
  }
  if ("replace_text" in a) {
    return callTool("notion_replace_text", { page: pageId(a.replace_text.page), find: a.replace_text.find, replace: a.replace_text.replace, dry_run: false });
  }
  if ("render_template" in a) {
    const t = a.render_template;
    return callTool("notion_template", { action: "render", name: t.name, variables: t.variables ?? {}, parent: t.parent });
  }
  if ("export_markdown" in a) {
    const md = await readPageMarkdown(pageId(a.export_markdown.page));
    return { markdown: md.markdown };
  }
  if ("http" in a) {
    const h = a.http;
    return httpCall(h.url, { method: h.method ?? (h.body === undefined ? "GET" : "POST"), headers: h.headers ?? {}, body: h.body, key: r.key });
  }
  if ("slack" in a) {
    const u = new URL(a.slack.webhook);
    if (u.hostname !== "hooks.slack.com") throw new Error("slack.webhook must be a https://hooks.slack.com/… incoming-webhook URL.");
    await httpCall(a.slack.webhook, { method: "POST", headers: {}, body: { text: a.slack.text }, key: r.key, extraAllow: ["hooks.slack.com"] });
    return { sent: true };
  }
  throw new Error(`Not an action step: ${Object.keys(a).join(", ")}`);
}

/** Has a page's approval checkbox been checked, or a comment with the keyword been posted since `since`? */
export async function approvalGiven(a: { page: string; property?: string; comment_keyword?: string }, since: string): Promise<boolean> {
  const id = pageId(a.page);
  if (a.property) {
    const page = await getFullPage(id);
    const prop = Object.entries(page.properties).find(([k]) => k.toLowerCase() === a.property?.toLowerCase())?.[1];
    if (!prop) throw new Error(`Approval property "${a.property}" isn't on page ${id}.`);
    if (prop.type !== "checkbox") throw new Error(`Approval property "${a.property}" must be a checkbox.`);
    if (prop.checkbox) return true;
  }
  if (a.comment_keyword) {
    const word = a.comment_keyword.toLowerCase();
    const t = new Date(since).getTime();
    const res = await read(() => notion().comments.list({ block_id: id, page_size: 100 }));
    if (res.results.some((c) => new Date(c.created_time).getTime() >= t - 60_000 && c.rich_text.map((x) => x.plain_text).join("").toLowerCase().includes(word))) return true;
  }
  return false;
}
