// Copy, move, and duplicate helpers. The API has no block move or page duplicate, so these read the source,
// rebuild it as specs, write it at the destination, and (for moves) trash the original.
import { isFullBlock, isFullPage } from "@notionhq/client";
import type { BlockObjectResponse, PageObjectResponse } from "@notionhq/client";
import { call, normalizeId, notion, read } from "./notion.js";
import { appendSpecs, blockText, blockToSpec, getTree, type BlockSpec, type TreeNode } from "./blocks.js";
import { reuploadUrl } from "./files.js";
import { restoreValue } from "./schema.js";
import { textToTitle, plain } from "./richtext.js";
import type { UndoOp } from "./journal.js";

/** Largest subtree copied in one call. */
export const MAX_COPY_BLOCKS = 3000;

export interface Skipped {
  id: string;
  type: string;
  reason: string;
}

export interface SubtreeSpecs {
  specs: BlockSpec[];
  blockCount: number;
  /** Child pages found inside the subtree (not at its top), which specs can't carry. */
  nestedPages: { id: string; title: string }[];
  skipped: Skipped[];
  /** Original synced blocks inside the subtree; moving them would break their references. */
  syncedOriginals: string[];
}

const REASONS: Record<string, string> = {
  child_page: "sub-page (copied separately as a page)",
  child_database: "database (the API can't copy databases; recreate or link it in Notion)",
  unsupported: "block type the API can't read or create",
  meeting_notes: "meeting notes (read-only in the API)",
  transcription: "transcription (read-only in the API)",
  template: "template button (deprecated, can't be created)",
  link_preview: "link preview (can't be created through the API)",
};

function convert(nodes: TreeNode[], raw: Map<string, BlockObjectResponse>, out: Omit<SubtreeSpecs, "specs" | "blockCount">): BlockSpec[] {
  const specs: BlockSpec[] = [];
  for (const node of nodes) {
    const block = raw.get(node.id);
    if (!block) continue;
    const kids = convert(node.children, raw, out);
    if (block.type === "synced_block" && !(block.synced_block.synced_from as { block_id?: string } | null)?.block_id) {
      out.syncedOriginals.push(block.id);
    }
    const spec = blockToSpec(block, kids);
    if (spec) specs.push(spec);
    else if (block.type === "child_page") out.nestedPages.push({ id: block.id, title: block.child_page.title });
    else out.skipped.push({ id: block.id, type: block.type, reason: REASONS[block.type] ?? `${block.type} can't be recreated through the API` });
  }
  return specs;
}

/** Read a block's children (all levels) as specs that recreate them. */
export async function childrenAsSpecs(parentId: string): Promise<SubtreeSpecs> {
  const tree = await getTree(parentId, 50, MAX_COPY_BLOCKS);
  if (tree.truncated) throw new Error(`More than ${MAX_COPY_BLOCKS} blocks under ${parentId}; copy smaller sections (notion_copy_blocks with specific block ids).`);
  const out = { nestedPages: [], skipped: [], syncedOriginals: [] };
  const specs = convert(tree.nodes, tree.raw, out);
  return { specs, blockCount: tree.raw.size, ...out };
}

export async function getBlock(id: string): Promise<BlockObjectResponse> {
  const b = await read(() => notion().blocks.retrieve({ block_id: id }));
  if (!isFullBlock(b)) throw new Error(`Could not read block ${id}.`);
  return b;
}

export async function getPage(id: string): Promise<PageObjectResponse> {
  const p = await read(() => notion().pages.retrieve({ page_id: id }));
  if (!isFullPage(p)) throw new Error(`Could not read page ${id}.`);
  return p;
}

/** One block with its whole subtree as a spec, or null (with the reason) if it can't be recreated. */
export async function blockAsSpec(block: BlockObjectResponse): Promise<{ spec: BlockSpec | null; sub: SubtreeSpecs }> {
  const sub: SubtreeSpecs =
    block.has_children && block.type !== "child_page" && block.type !== "child_database"
      ? await childrenAsSpecs(block.id)
      : { specs: [], blockCount: 0, nestedPages: [], skipped: [], syncedOriginals: [] };
  if (block.type === "synced_block" && !(block.synced_block.synced_from as { block_id?: string } | null)?.block_id) {
    sub.syncedOriginals.unshift(block.id);
  }
  return { spec: blockToSpec(block, sub.specs), sub: { ...sub, blockCount: sub.blockCount + 1 } };
}

/** Icon or cover in request form. Notion-hosted files are uploaded again, since their links expire. */
export async function copyFileObject(obj: unknown): Promise<Record<string, unknown> | null> {
  const o = obj as { type?: string; emoji?: string; external?: { url: string }; file?: { url: string }; custom_emoji?: { id: string } } | null;
  if (!o?.type) return null;
  if (o.type === "emoji" && o.emoji) return { type: "emoji", emoji: o.emoji };
  if (o.type === "external" && o.external) return { type: "external", external: { url: o.external.url } };
  if (o.type === "custom_emoji" && o.custom_emoji) return { type: "custom_emoji", custom_emoji: { id: o.custom_emoji.id } };
  if (o.type === "file" && o.file) return { type: "file_upload", file_upload: { id: await reuploadUrl(o.file.url) } };
  return null;
}

export function pageTitle(page: PageObjectResponse): string {
  const t = Object.values(page.properties).find((p) => p.type === "title");
  return t && t.type === "title" ? plain(t.title) || "(untitled)" : "(untitled)";
}

export type PageParent = { page_id: string } | { data_source_id: string };

/** Where a page lives, in the form pages.create / pages.move accept, or null (workspace, inside a block). */
export function parentOf(page: PageObjectResponse): PageParent | null {
  const p = page.parent as { type: string; page_id?: string; data_source_id?: string };
  if (p.type === "page_id" && p.page_id) return { page_id: p.page_id };
  if (p.type === "data_source_id" && p.data_source_id) return { data_source_id: p.data_source_id };
  return null;
}

export interface DuplicateResult {
  page_id: string;
  url?: string;
  blocks: number;
  subpages: number;
  skipped: Skipped[];
  notes: string[];
}

/**
 * Duplicate a page: title, icon, cover, writable properties (when staying in the same database), and content.
 * Sub-pages are duplicated recursively after the content (Notion lists child pages where they were created,
 * so they land at the end). Databases inside the page are reported, not copied.
 */
export async function duplicatePage(
  source: PageObjectResponse,
  parent: PageParent,
  opts: { title?: string; includeSubpages: boolean; depth?: number },
  undo: UndoOp[]
): Promise<DuplicateResult> {
  const notes: string[] = [];
  const sameDataSource = "data_source_id" in parent && parentOf(source) && "data_source_id" in (parentOf(source) as PageParent) &&
    (parentOf(source) as { data_source_id: string }).data_source_id === parent.data_source_id;
  const properties: Record<string, unknown> = {};
  const titleEntry = Object.entries(source.properties).find(([, p]) => p.type === "title");
  const title = opts.title ?? `${pageTitle(source)} (copy)`;
  if (sameDataSource) {
    for (const [name, prop] of Object.entries(source.properties)) {
      if (prop.type === "title") continue;
      const v = restoreValue(prop);
      if (v) properties[name] = v;
    }
  } else if ("data_source_id" in parent) {
    notes.push("Copied into a different database: only the title was carried over; set other properties with notion_update_properties.");
  }
  const titleName = "data_source_id" in parent ? (sameDataSource && titleEntry ? titleEntry[0] : await titlePropertyName(parent.data_source_id)) : "title";
  properties[titleName] = { title: textToTitle(title) };

  const body: Record<string, unknown> = { parent, properties };
  const icon = await copyFileObject(source.icon);
  const cover = await copyFileObject(source.cover);
  if (icon) body.icon = icon;
  if (cover) body.cover = cover;

  const content = await childrenAsSpecs(source.id);
  const created = await call(() => notion().pages.create(body as never));
  undo.push({ kind: "page_trash", page_id: created.id, in_trash: true });
  if (content.specs.length) await appendSpecs(created.id, content.specs);
  let subpages = 0;
  const skipped = [...content.skipped];
  if (content.nestedPages.length && opts.includeSubpages) {
    if ((opts.depth ?? 0) >= 5) {
      notes.push(`Stopped at 5 levels of sub-pages; ${content.nestedPages.length} deeper sub-page(s) were not copied.`);
    } else {
      for (const sp of content.nestedPages) {
        const child = await getPage(sp.id);
        // Trashing the new top page also trashes these, so their own undo entries aren't needed.
        const r = await duplicatePage(child, { page_id: created.id }, { title: sp.title, includeSubpages: true, depth: (opts.depth ?? 0) + 1 }, []);
        subpages += 1 + r.subpages;
        skipped.push(...r.skipped);
      }
      notes.push("Sub-pages were copied to the end of the new page (the API can't place a sub-page between blocks).");
    }
  } else if (content.nestedPages.length) {
    skipped.push(...content.nestedPages.map((p) => ({ id: p.id, type: "child_page", reason: "sub-page (include_subpages is off)" })));
  }
  return { page_id: created.id, url: "url" in created ? created.url : undefined, blocks: content.blockCount, subpages, skipped, notes };
}

async function titlePropertyName(dataSourceId: string): Promise<string> {
  const ds = await read(() => notion().dataSources.retrieve({ data_source_id: dataSourceId }));
  const props = (ds as { properties?: Record<string, { type: string }> }).properties ?? {};
  return Object.entries(props).find(([, p]) => p.type === "title")?.[0] ?? "title";
}

/** A short description of a block for previews. */
export function describeBlock(b: BlockObjectResponse): string {
  const text = blockText(b);
  return `${b.type}${text ? `: ${text.length > 80 ? text.slice(0, 80) + "…" : text}` : ""}`;
}

export function resolvePageParentInput(input: string, isDatabase: boolean, dataSourceId?: string): PageParent {
  return isDatabase && dataSourceId ? { data_source_id: dataSourceId } : { page_id: normalizeId(input) };
}
