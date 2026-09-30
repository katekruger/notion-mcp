import { collectPaginatedAPI, isFullBlock } from "@notionhq/client";
import type { BlockObjectResponse, RichTextItemResponse } from "@notionhq/client";
import { call, normalizeId, notion, read } from "./notion.js";
import { forApi, fromInlineMarkdown, normalizeColor, plain, toRequest, type RichTextReq } from "./richtext.js";
import { fileRef, isUrl, reuploadUrl, uploadLocalFile } from "./files.js";
import { resolveUserMentions } from "./schema.js";
import { markdownToSpecs } from "./markdown.js";
import { checkMermaid } from "./mermaid.js";

export { markdownToSpecs };

/** Blocks whose main content is one rich text array (editable with notion_patch_block / notion_replace_text). */
export const RICH_TEXT_TYPES = new Set([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "heading_4",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "toggle",
  "quote",
  "callout",
  "code",
]);

const HEADINGS = new Set(["heading_1", "heading_2", "heading_3", "heading_4"]);
const MEDIA_TYPES = new Set(["image", "file", "pdf", "video", "audio"]);

export interface TreeNode {
  id: string;
  type: string;
  text: string;
  depth: number;
  has_children: boolean;
  checked?: boolean;
  last_edited_time: string;
  children: TreeNode[];
}

type BlockContent = Record<string, unknown> & { rich_text?: RichTextItemResponse[] };

export function blockContent(block: BlockObjectResponse): BlockContent {
  return (block as unknown as Record<string, BlockContent>)[block.type] ?? {};
}

export function blockText(block: BlockObjectResponse): string {
  const c = blockContent(block);
  if (Array.isArray(c.rich_text)) return plain(c.rich_text);
  if (block.type === "child_page") return block.child_page.title;
  if (block.type === "child_database") return block.child_database.title;
  if (block.type === "equation") return block.equation.expression;
  if (block.type === "bookmark") return block.bookmark.url;
  if (block.type === "embed") return block.embed.url;
  if (block.type === "table_row") return block.table_row.cells.map((c) => plain(c)).join(" | ");
  if (block.type === "link_to_page") {
    const l = block.link_to_page as { type: string; page_id?: string; database_id?: string };
    return l.page_id ?? l.database_id ?? "";
  }
  if (MEDIA_TYPES.has(block.type)) {
    const m = c as { type?: string; external?: { url: string }; file?: { url: string }; name?: string; caption?: RichTextItemResponse[] };
    return plain(m.caption) || m.name || (m.type === "external" ? m.external?.url : "") || "";
  }
  return "";
}

export async function listChildren(blockId: string): Promise<BlockObjectResponse[]> {
  const items = await collectPaginatedAPI(
    (args: { block_id: string; start_cursor?: string }) => read(() => notion().blocks.children.list(args)),
    { block_id: blockId }
  );
  return items.filter(isFullBlock);
}

/** Read a block tree breadth-limited by depth and total block count. */
export async function getTree(
  rootId: string,
  maxDepth: number,
  maxBlocks: number
): Promise<{ nodes: TreeNode[]; truncated: boolean; raw: Map<string, BlockObjectResponse> }> {
  const raw = new Map<string, BlockObjectResponse>();
  let count = 0;
  let truncated = false;

  async function walk(parentId: string, depth: number): Promise<TreeNode[]> {
    if (count >= maxBlocks) {
      truncated = true;
      return [];
    }
    const blocks = await listChildren(parentId);
    const nodes: TreeNode[] = [];
    for (const b of blocks) {
      if (count >= maxBlocks) {
        truncated = true;
        break;
      }
      count++;
      raw.set(b.id, b);
      const node: TreeNode = {
        id: b.id,
        type: b.type,
        text: blockText(b),
        depth,
        has_children: b.has_children,
        last_edited_time: b.last_edited_time,
        children: [],
      };
      if (b.type === "to_do") node.checked = b.to_do.checked;
      // Don't descend into child pages/databases; they're separate documents.
      if (b.has_children && depth < maxDepth && b.type !== "child_page" && b.type !== "child_database") {
        node.children = await walk(b.id, depth + 1);
      } else if (b.has_children && depth >= maxDepth) {
        truncated = true;
      }
      nodes.push(node);
    }
    return nodes;
  }

  const nodes = await walk(rootId, 0);
  return { nodes, truncated, raw };
}

export function flatten(nodes: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const visit = (list: TreeNode[]): void => {
    for (const n of list) {
      out.push(n);
      visit(n.children);
    }
  };
  visit(nodes);
  return out;
}

export function renderTree(nodes: TreeNode[]): string {
  return flatten(nodes)
    .map((n) => {
      const indent = "  ".repeat(n.depth);
      const box = n.type === "to_do" ? (n.checked ? "[x] " : "[ ] ") : "";
      const text = n.text.length > 300 ? n.text.slice(0, 300) + "…" : n.text;
      return `${indent}- (${n.type}) ${box}${text}  ⟨${n.id}⟩`;
    })
    .join("\n");
}


const LANGUAGE_ALIASES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", py: "python",
  sh: "shell", zsh: "shell", bash: "bash", yml: "yaml", md: "markdown", rb: "ruby",
  rs: "rust", "c++": "c++", cpp: "c++", cs: "c#", csharp: "c#", golang: "go", kt: "kotlin",
  text: "plain text", txt: "plain text", plaintext: "plain text", "": "plain text",
};

export function normalizeLanguage(lang: string | undefined): string {
  const l = (lang ?? "").trim().toLowerCase();
  return LANGUAGE_ALIASES[l] ?? l;
}

/**
 * A block to create. `text` is inline markdown; `rich_text`/`cells` carry exact rich text (used when copying).
 * Structured shorthands: `rows` for tables, `columns` for column layouts, `tabs` for tab blocks.
 */
export interface BlockSpec {
  type: string;
  text?: string;
  rich_text?: RichTextReq[];
  checked?: boolean;
  language?: string;
  caption?: string;
  /** Callout icon: an emoji, an image URL, or a local image path. `emoji` is the older name. */
  icon?: string;
  emoji?: string;
  color?: string;
  toggleable?: boolean;
  children?: BlockSpec[];
  rows?: string[][];
  cells?: RichTextReq[][];
  header_row?: boolean;
  header_column?: boolean;
  columns?: BlockSpec[][];
  tabs?: { title: string; children?: BlockSpec[] }[];
  /** bookmark/embed URL; media URL or local file path; link_to_page page URL/id. */
  url?: string;
  /** Media only: download `url` and upload it again (for Notion-hosted files whose links expire). */
  reupload?: boolean;
  name?: string;
  expression?: string;
  /** synced_block: id/URL of the original to reference. Omit to create a new original from `children`. */
  synced_from?: string;
  /** Internal: set during preparation. */
  file_upload_id?: string;
  icon_ref?: Record<string, unknown>;
}

export const CREATABLE_TYPES = [
  "paragraph", "heading_1", "heading_2", "heading_3", "heading_4", "bulleted_list_item", "numbered_list_item",
  "to_do", "toggle", "quote", "callout", "code", "divider", "table", "table_row", "column_list", "column", "tab",
  "table_of_contents", "breadcrumb", "bookmark", "embed", "equation", "synced_block", "link_to_page",
  "image", "file", "pdf", "video", "audio",
];

/** Types Notion won't create without children in the same request. */
const REQUIRES_CHILDREN = new Set(["table", "column_list", "column", "tab"]);
/** Types that can't have children at all. */
const NO_CHILDREN = new Set([
  "divider", "table_row", "table_of_contents", "breadcrumb", "bookmark", "embed", "equation", "link_to_page", "code",
  ...MEDIA_TYPES,
]);

function richFromSpec(spec: BlockSpec, text = spec.text): RichTextReq[] {
  if (spec.rich_text) return spec.rich_text;
  if (spec.type === "code") return [{ type: "text", text: { content: text ?? "" } }];
  return fromInlineMarkdown(text ?? "");
}

/**
 * Expand shorthands (rows, columns, tabs) into children, and check every spec, before anything is written.
 * Returns a new tree; the input is not modified.
 */
export function normalizeSpecs(specs: BlockSpec[], where = "blocks"): BlockSpec[] {
  return specs.map((s, i) => normalizeSpec(s, `${where}[${i}]`));
}

function normalizeSpec(input: BlockSpec, where: string): BlockSpec {
  const spec: BlockSpec = { ...input };
  const t = spec.type;
  const fail = (msg: string): never => {
    throw new Error(`${where} (${t}): ${msg}`);
  };
  if (!CREATABLE_TYPES.includes(t)) {
    throw new Error(`${where}: unsupported block type "${t}". Use one of: ${CREATABLE_TYPES.join(", ")}.`);
  }
  if (spec.color) spec.color = normalizeColor(spec.color);
  if (t === "table") {
    if (spec.rows) {
      if (spec.rows.length === 0) fail("a table needs at least one row.");
      const width = Math.max(...spec.rows.map((r) => r.length));
      spec.children = spec.rows.map((r) => ({ type: "table_row", rows: [[...r, ...Array<string>(width - r.length).fill("")]] }));
      delete spec.rows;
    }
    if (!spec.children?.length || spec.children.some((c) => c.type !== "table_row")) fail("give `rows` (arrays of cell text).");
  }
  if (t === "table_row") {
    if (spec.rows) {
      spec.cells = spec.rows[0].map((cell) => fromInlineMarkdown(cell));
      delete spec.rows;
    }
    if (!spec.cells) fail("a table row needs cells.");
  }
  if (t === "column_list") {
    if (spec.columns) {
      spec.children = spec.columns.map((col) => ({ type: "column", children: col }));
      delete spec.columns;
    }
    const cols = spec.children ?? [];
    if (cols.length < 2 || cols.some((c) => c.type !== "column")) fail("give `columns`: at least 2 lists of blocks.");
    if (cols.some((c) => !c.children?.length)) fail("every column needs at least one block.");
  }
  if (t === "tab") {
    if (spec.tabs) {
      spec.children = spec.tabs.map((tab) => ({ type: "paragraph", text: tab.title, children: tab.children }));
      delete spec.tabs;
    }
    if (!spec.children?.length || spec.children.some((c) => c.type !== "paragraph")) {
      fail("give `tabs`: [{title, children}], one per tab.");
    }
  }
  if ((t === "bookmark" || t === "embed") && !spec.url) fail("needs `url`.");
  if ((t === "bookmark" || t === "embed") && spec.url && !isUrl(spec.url)) fail(`"${spec.url}" isn't an http(s) URL.`);
  if (MEDIA_TYPES.has(t) && !spec.url && !spec.file_upload_id) fail("needs `url` (a web URL or a local file path).");
  if (t === "link_to_page" && !spec.url) fail("needs `url` (the page's link or id).");
  if (t === "equation" && !spec.expression && !spec.text) fail("needs `expression` (KaTeX).");
  if (t === "synced_block" && spec.synced_from && spec.children?.length) {
    fail("a reference (synced_from) shows the original's content; it can't have its own children.");
  }
  if (t === "synced_block" && !spec.synced_from && !spec.children?.length) fail("a new synced block needs children.");
  if (spec.toggleable && !HEADINGS.has(t)) fail("`toggleable` only applies to headings.");
  if (spec.checked !== undefined && t !== "to_do") fail("`checked` only applies to to_do.");
  if (spec.language !== undefined && t !== "code") fail("`language` only applies to code.");
  if (NO_CHILDREN.has(t) && spec.children?.length) fail(`${t} blocks can't have children.`);
  if (RICH_TEXT_TYPES.has(t) || t === "table_row") {
    // Surfaces bad inline syntax (unknown colors, malformed mentions) and the 100-segment cap now.
    if (t === "table_row") spec.cells?.forEach((c) => forApi(c));
    else forApi(richFromSpec(spec));
  }
  if (t === "code" && normalizeLanguage(spec.language) === "mermaid" && !spec.rich_text) {
    try {
      checkMermaid(spec.text ?? "");
    } catch (e) {
      fail((e as Error).message);
    }
  }
  if (spec.caption) forApi(fromInlineMarkdown(spec.caption));
  if (spec.children) spec.children = spec.children.map((c, i) => normalizeSpec(c, `${where}.children[${i}]`));
  return spec;
}

/** Upload local files, re-upload expiring Notion files, and resolve icons. Runs after validation, before writing. */
async function prepareSpecs(specs: BlockSpec[]): Promise<void> {
  for (const spec of specs) {
    if (MEDIA_TYPES.has(spec.type) && spec.url && !spec.file_upload_id) {
      if (spec.reupload) spec.file_upload_id = await reuploadUrl(spec.url, spec.name);
      else if (!isUrl(spec.url)) spec.file_upload_id = await uploadLocalFile(spec.url, spec.name);
    }
    const icon = spec.icon ?? spec.emoji;
    if (spec.type === "callout" && icon && !spec.icon_ref) {
      spec.icon_ref = isUrl(icon) || /[\\/.]/.test(icon) ? await fileRef(icon) : { type: "emoji", emoji: icon };
    }
    if (spec.children) await prepareSpecs(spec.children);
  }
}

/** The request body for one block, without children. */
export function specToBlock(spec: BlockSpec): Record<string, unknown> {
  const t = spec.type;
  const content: Record<string, unknown> = {};
  if (RICH_TEXT_TYPES.has(t)) content.rich_text = forApi(richFromSpec(spec));
  if (t === "to_do") content.checked = spec.checked ?? false;
  if (t === "code") content.language = normalizeLanguage(spec.language);
  if (t === "callout") content.icon = spec.icon_ref ?? { type: "emoji", emoji: spec.icon ?? spec.emoji ?? "💡" };
  if (HEADINGS.has(t) && spec.toggleable) content.is_toggleable = true;
  if (spec.color) content.color = spec.color;
  if (spec.caption && (t === "code" || t === "bookmark" || t === "embed" || MEDIA_TYPES.has(t))) {
    content.caption = forApi(fromInlineMarkdown(spec.caption));
  }
  switch (t) {
    case "table": {
      const first = spec.children?.[0];
      content.table_width = first?.cells?.length ?? 1;
      content.has_column_header = spec.header_row ?? false;
      content.has_row_header = spec.header_column ?? false;
      break;
    }
    case "table_row":
      content.cells = (spec.cells ?? []).map((c) => forApi(c));
      break;
    case "table_of_contents":
      break;
    case "bookmark":
    case "embed":
      content.url = spec.url;
      break;
    case "equation":
      content.expression = spec.expression ?? spec.text;
      break;
    case "link_to_page":
      content.type = "page_id";
      content.page_id = normalizeId(spec.url as string);
      break;
    case "synced_block":
      content.synced_from = spec.synced_from ? { type: "block_id", block_id: normalizeId(spec.synced_from) } : null;
      break;
  }
  if (MEDIA_TYPES.has(t)) {
    if (spec.file_upload_id) {
      content.type = "file_upload";
      content.file_upload = { id: spec.file_upload_id };
    } else {
      content.type = "external";
      content.external = { url: spec.url };
    }
    if (spec.name && t === "file") content.name = spec.name;
  }
  return { type: t, [t]: content };
}

/** Notion accepts at most this many blocks per children array. */
const MAX_CHILDREN_PER_REQUEST = 100;
/** Keep each request well under Notion's per-request block cap (1000). */
const MAX_BLOCKS_PER_REQUEST = 800;
/** A request may carry a block, its children, and their children (verified live). */
const LEVELS_BELOW = 2;

interface Deferred {
  /** Child indices from the created top-level block down to the block that gets `specs` appended. */
  path: number[];
  specs: BlockSpec[];
}

function fitsInline(children: BlockSpec[], levelsLeft: number): boolean {
  if (children.length > MAX_CHILDREN_PER_REQUEST) return false;
  return children.every((c) => !c.children?.length || (levelsLeft > 1 && fitsInline(c.children, levelsLeft - 1)));
}

function countBlocks(block: Record<string, unknown>): number {
  const inner = block[block.type as string] as { children?: Record<string, unknown>[] } | undefined;
  return 1 + (inner?.children ?? []).reduce((n, c) => n + countBlocks(c), 0);
}

/**
 * Build a request block with as much of its subtree inline as Notion allows.
 * Content that doesn't fit is returned as `deferred`, to append once the block's id is known.
 */
export function buildBlock(spec: BlockSpec, levelsLeft = LEVELS_BELOW): { block: Record<string, unknown>; deferred: Deferred[] } {
  const block = specToBlock(spec);
  const kids = spec.children ?? [];
  if (kids.length === 0) return { block, deferred: [] };
  const content = block[spec.type] as Record<string, unknown>;
  if (levelsLeft === 0) {
    if (REQUIRES_CHILDREN.has(spec.type)) {
      throw new Error(`A ${spec.type} is nested too deeply for Notion to create; move it closer to the page's top level.`);
    }
    return { block, deferred: [{ path: [], specs: kids }] };
  }
  if (fitsInline(kids, levelsLeft)) {
    content.children = kids.map((k) => buildBlock(k, levelsLeft - 1).block);
    return { block, deferred: [] };
  }
  if (!REQUIRES_CHILDREN.has(spec.type)) return { block, deferred: [{ path: [], specs: kids }] };
  // Tables, columns, and tabs need children in the create request: inline what fits, defer the rest.
  const inline = kids.slice(0, MAX_CHILDREN_PER_REQUEST);
  const deferred: Deferred[] = [];
  content.children = inline.map((k, i) => {
    const built = buildBlock(k, levelsLeft - 1);
    deferred.push(...built.deferred.map((d) => ({ path: [i, ...d.path], specs: d.specs })));
    return built.block;
  });
  if (kids.length > inline.length) deferred.push({ path: [], specs: kids.slice(inline.length) });
  return { block, deferred };
}

/** Build a request payload that would restore this block's current content (used for undo). */
export function restorePayload(block: BlockObjectResponse): Record<string, unknown> | null {
  if (block.type === "table_row") return { table_row: { cells: block.table_row.cells.map((c) => forApi(toRequest(c))) } };
  if (!RICH_TEXT_TYPES.has(block.type)) return null;
  const c = blockContent(block);
  const content: Record<string, unknown> = { rich_text: forApi(toRequest(c.rich_text)) };
  for (const key of ["checked", "language", "color", "is_toggleable", "icon"]) {
    if (c[key] !== undefined && c[key] !== null) content[key] = c[key];
  }
  if (Array.isArray(c.caption)) content.caption = forApi(toRequest(c.caption as RichTextItemResponse[]));
  return { [block.type]: content };
}

export function currentSegments(block: BlockObjectResponse): RichTextReq[] {
  return toRequest(blockContent(block).rich_text);
}

export type AppendPosition = { type: "end" } | { type: "start" } | { type: "after_block"; after_block_id: string };

/** A multi-request write stopped partway. `createdIds` are the top-level blocks that did land. */
export class PartialWriteError extends Error {
  constructor(
    readonly createdIds: string[],
    readonly cause: unknown
  ) {
    super(`Stopped after creating ${createdIds.length} top-level block(s): ${(cause as Error)?.message ?? String(cause)}`);
    this.name = "PartialWriteError";
  }
}

/**
 * Append block specs under a parent, handling Notion's request limits: at most 100 blocks per children array,
 * a block plus two levels below it per request, and required-children types (tables, columns, tabs).
 * Content that doesn't fit is appended in follow-up requests to the right new block.
 * Every spec is validated and every file uploaded before the first block is written.
 * Returns the ids of the top-level blocks created, in order.
 */
export async function appendSpecs(parentId: string, specs: BlockSpec[], position: AppendPosition = { type: "end" }): Promise<string[]> {
  const normalized = normalizeSpecs(specs);
  normalized.forEach((s) => buildBlock(s)); // structural errors surface before any upload or write
  await prepareSpecs(normalized);
  const createdIds: string[] = [];
  try {
    await appendChunks(parentId, normalized, position, createdIds);
  } catch (e) {
    throw new PartialWriteError(createdIds, e instanceof PartialWriteError ? e.cause : e);
  }
  return createdIds;
}

async function childIdAt(parentId: string, path: number[], cache: Map<string, string[]>): Promise<string> {
  let id = parentId;
  for (const index of path) {
    let kids = cache.get(id);
    if (!kids) {
      kids = (await listChildren(id)).map((b) => b.id);
      cache.set(id, kids);
    }
    const next = kids[index];
    if (!next) throw new Error(`Couldn't find child ${index} of new block ${id} to continue writing nested content.`);
    id = next;
  }
  return id;
}

async function appendChunks(parentId: string, specs: BlockSpec[], position: AppendPosition, createdIds: string[]): Promise<void> {
  let anchor = position.type === "after_block" ? position.after_block_id : null;
  let first = true;
  for (let i = 0; i < specs.length; ) {
    const built: { block: Record<string, unknown>; deferred: Deferred[] }[] = [];
    let blocks = 0;
    while (i < specs.length && built.length < MAX_CHILDREN_PER_REQUEST) {
      const b = buildBlock(specs[i]);
      const size = countBlocks(b.block);
      if (built.length > 0 && blocks + size > MAX_BLOCKS_PER_REQUEST) break;
      built.push(b);
      blocks += size;
      i++;
    }
    const children = built.map((b) => b.block);
    const payload: Record<string, unknown> = { block_id: parentId, children };
    await resolveUserMentions(payload);
    const pos = anchor ? { type: "after_block", after_block: { id: anchor } } : position.type === "start" && first ? { type: "start" } : { type: "end" };
    first = false;
    const res = await call(() => notion().blocks.children.append({ ...payload, position: pos } as never));
    // The new blocks come first, in order. With position start/after_block, Notion also returns
    // every existing sibling after them (verified live), so take only as many as we sent.
    const ids = res.results.slice(0, built.length).map((r) => r.id);
    createdIds.push(...ids);
    if (ids.length !== built.length) {
      throw new Error(`Notion created ${ids.length} of ${built.length} blocks under ${parentId}; stopping so nesting stays correct.`);
    }
    anchor = ids[ids.length - 1] ?? anchor;
    for (let j = 0; j < built.length; j++) {
      const cache = new Map<string, string[]>();
      // Nested content lives inside ids[j], so trashing that block cleans up a partial nested write too.
      for (const d of built[j].deferred) await appendChunks(await childIdAt(ids[j], d.path, cache), d.specs, { type: "end" }, []);
    }
  }
}

function captionText(c: Record<string, unknown>): RichTextReq[] | undefined {
  return Array.isArray(c.caption) && c.caption.length ? toRequest(c.caption as RichTextItemResponse[]) : undefined;
}

/**
 * Turn an existing block (and its already-read children) back into a spec that recreates it.
 * Returns null for blocks the API can't create (child pages/databases, unsupported, meeting notes, …); the caller decides.
 */
export function blockToSpec(block: BlockObjectResponse, children: BlockSpec[]): BlockSpec | null {
  const t = block.type;
  const c = blockContent(block);
  const spec: BlockSpec = { type: t };
  if (typeof c.color === "string" && c.color !== "default") spec.color = c.color;
  const cap = captionText(c);
  if (cap) spec.caption = cap.map((s) => (s.type === "text" ? s.text.content : "")).join("");
  if (RICH_TEXT_TYPES.has(t)) {
    spec.rich_text = toRequest(c.rich_text);
    if (t === "to_do") spec.checked = Boolean(c.checked);
    if (t === "code") spec.language = String(c.language ?? "plain text");
    if (HEADINGS.has(t) && c.is_toggleable) spec.toggleable = true;
    if (t === "callout") {
      const icon = c.icon as { type: string; emoji?: string; external?: { url: string }; file?: { url: string } } | null;
      if (icon?.type === "emoji" && icon.emoji) spec.icon = icon.emoji;
      else if (icon?.type === "external" && icon.external) spec.icon = icon.external.url;
      else if (icon?.type === "file" && icon.file) spec.icon_ref = { type: "external", external: { url: icon.file.url } };
    }
  } else if (t === "table") {
    spec.header_row = Boolean(c.has_column_header);
    spec.header_column = Boolean(c.has_row_header);
  } else if (t === "table_row") {
    spec.cells = (c.cells as RichTextItemResponse[][]).map((cell) => toRequest(cell));
  } else if (t === "bookmark" || t === "embed") {
    spec.url = String(c.url);
  } else if (t === "equation") {
    spec.expression = String(c.expression);
  } else if (t === "link_to_page") {
    const l = c as { type: string; page_id?: string; database_id?: string };
    if (l.type !== "page_id" || !l.page_id) return null;
    spec.url = l.page_id;
  } else if (t === "synced_block") {
    const from = (c.synced_from as { block_id?: string } | null)?.block_id;
    // Copying an original makes a reference to it, so both stay in sync (and nothing is duplicated).
    spec.synced_from = from ?? block.id;
    return spec;
  } else if (MEDIA_TYPES.has(t)) {
    const m = c as { type: string; external?: { url: string }; file?: { url: string }; name?: string };
    if (m.type === "external" && m.external) spec.url = m.external.url;
    else if (m.type === "file" && m.file) {
      spec.url = m.file.url;
      spec.reupload = true;
    } else return null;
    if (m.name) spec.name = m.name;
  } else if (!["divider", "column_list", "column", "tab", "table_of_contents", "breadcrumb"].includes(t)) {
    return null;
  }
  if (children.length && !NO_CHILDREN.has(t)) spec.children = children;
  return spec;
}
