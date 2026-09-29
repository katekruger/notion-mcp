import { collectPaginatedAPI, isFullBlock } from "@notionhq/client";
import type { BlockObjectResponse, RichTextItemResponse } from "@notionhq/client";
import { call, read, notion } from "./notion.js";
import { forApi, fromInlineMarkdown, plain, toRequest, type RichTextReq } from "./richtext.js";

export const RICH_TEXT_TYPES = new Set([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "toggle",
  "quote",
  "callout",
  "code",
]);

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

export interface BlockSpec {
  type: string;
  text?: string;
  checked?: boolean;
  language?: string;
  emoji?: string;
  color?: string;
  children?: BlockSpec[];
}

export function specToBlock(spec: BlockSpec): Record<string, unknown> {
  const { type } = spec;
  if (type === "divider") return { type: "divider", divider: {} };
  if (!RICH_TEXT_TYPES.has(type)) {
    throw new Error(
      `Unsupported block type "${type}". Use one of: ${[...RICH_TEXT_TYPES].join(", ")}, divider.`
    );
  }
  const rich = type === "code"
    ? forApi([{ type: "text", text: { content: spec.text ?? "" } }])
    : forApi(fromInlineMarkdown(spec.text ?? ""));
  const content: Record<string, unknown> = { rich_text: rich };
  if (type === "to_do") content.checked = spec.checked ?? false;
  if (type === "code") content.language = normalizeLanguage(spec.language);
  if (type === "callout") content.icon = { type: "emoji", emoji: spec.emoji ?? "💡" };
  if (spec.color) content.color = spec.color;
  if (spec.children?.length) content.children = spec.children.map(specToBlock);
  return { type, [type]: content };
}

/**
 * Convert a predictable markdown subset into block specs:
 * #/##/### headings, - or * bullets, 1. numbered, - [ ] / - [x] to-dos, > quotes,
 * ``` fenced code, --- dividers, and blank-line separated paragraphs.
 * Two-space or tab indentation nests list items one level.
 */
export function markdownToSpecs(md: string): BlockSpec[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: BlockSpec[] = [];
  let i = 0;
  let lastTop: BlockSpec | null = null;
  while (i < lines.length) {
    const rawLine = lines[i];
    const fence = rawLine.match(/^```(\w[\w +#-]*)?\s*$/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      const spec: BlockSpec = { type: "code", text: body.join("\n"), language: fence[1]?.trim() || "plain text" };
      out.push(spec);
      lastTop = spec;
      continue;
    }
    const indented = /^( {2,}|\t)/.test(rawLine);
    const line = rawLine.trim();
    i++;
    if (!line) {
      lastTop = null;
      continue;
    }
    let spec: BlockSpec;
    let m: RegExpMatchArray | null;
    if (/^(-{3,}|\*{3,})$/.test(line)) spec = { type: "divider" };
    else if ((m = line.match(/^(#{1,3})\s+(.*)$/))) spec = { type: `heading_${m[1].length}`, text: m[2] };
    else if ((m = line.match(/^[-*]\s+\[( |x|X)\]\s+(.*)$/))) spec = { type: "to_do", text: m[2], checked: m[1].toLowerCase() === "x" };
    else if ((m = line.match(/^[-*]\s+(.*)$/))) spec = { type: "bulleted_list_item", text: m[1] };
    else if ((m = line.match(/^\d+[.)]\s+(.*)$/))) spec = { type: "numbered_list_item", text: m[1] };
    else if ((m = line.match(/^>\s?(.*)$/))) spec = { type: "quote", text: m[1] };
    else spec = { type: "paragraph", text: line };

    const listTypes = ["bulleted_list_item", "numbered_list_item", "to_do"];
    if (indented && lastTop && listTypes.includes(lastTop.type) && listTypes.includes(spec.type)) {
      (lastTop.children ??= []).push(spec);
      continue;
    }
    out.push(spec);
    lastTop = spec;
  }
  return out;
}

/** Build a request payload that would restore this block's current content (used for undo). */
export function restorePayload(block: BlockObjectResponse): Record<string, unknown> | null {
  if (!RICH_TEXT_TYPES.has(block.type)) return null;
  const c = blockContent(block);
  const content: Record<string, unknown> = { rich_text: forApi(toRequest(c.rich_text)) };
  for (const key of ["checked", "language", "color", "is_toggleable", "icon"]) {
    if (c[key] !== undefined && c[key] !== null) content[key] = c[key];
  }
  return { [block.type]: content };
}

export function currentSegments(block: BlockObjectResponse): RichTextReq[] {
  return toRequest(blockContent(block).rich_text);
}

/** Notion accepts at most this many blocks per children array. */
const MAX_CHILDREN_PER_REQUEST = 100;

export type AppendPosition = { type: "end" } | { type: "start" } | { type: "after_block"; after_block_id: string };

/** A spec's children can go inline in the parent's request only if they fit and are leaves (2 nesting levels max). */
function childrenInline(spec: BlockSpec): boolean {
  const kids = spec.children ?? [];
  return kids.length <= MAX_CHILDREN_PER_REQUEST && kids.every((k) => !k.children?.length);
}

/** A multi-request write stopped partway. `createdIds` are the top-level blocks that did land. */
export class PartialWriteError extends Error {
  constructor(
    readonly createdIds: string[],
    readonly cause: unknown
  ) {
    super(
      `Stopped after creating ${createdIds.length} top-level block(s): ${(cause as Error)?.message ?? String(cause)}`
    );
    this.name = "PartialWriteError";
  }
}

/**
 * Append block specs under a parent, handling Notion's request limits:
 * at most 100 blocks per request and 2 levels of nesting per request.
 * Children that don't fit inline are appended in follow-up requests to the
 * newly created block. Returns the ids of the top-level blocks created, in order.
 */
export async function appendSpecs(parentId: string, specs: BlockSpec[], position: AppendPosition = { type: "end" }): Promise<string[]> {
  // Build every block once up front so a bad spec fails before anything is written.
  const check = (list: BlockSpec[]): void => list.forEach((s) => { specToBlock({ ...s, children: undefined }); check(s.children ?? []); });
  check(specs);
  const createdIds: string[] = [];
  try {
    await appendChunks(parentId, specs, position, createdIds);
  } catch (e) {
    if (e instanceof PartialWriteError) throw new PartialWriteError(createdIds, e.cause);
    throw new PartialWriteError(createdIds, e);
  }
  return createdIds;
}

async function appendChunks(parentId: string, specs: BlockSpec[], position: AppendPosition, createdIds: string[]): Promise<void> {
  let anchor = position.type === "after_block" ? position.after_block_id : null;
  for (let i = 0; i < specs.length; i += MAX_CHILDREN_PER_REQUEST) {
    const chunkSpecs = specs.slice(i, i + MAX_CHILDREN_PER_REQUEST);
    const chunk = chunkSpecs.map((s) => specToBlock(childrenInline(s) ? s : { ...s, children: undefined }));
    const pos = anchor
      ? { type: "after_block", after_block: { id: anchor } }
      : position.type === "start" && i === 0
        ? { type: "start" }
        : { type: "end" };
    const res = await call(() => notion().blocks.children.append({ block_id: parentId, children: chunk, position: pos } as never));
    // The new blocks come first, in order. With position start/after_block, Notion also returns
    // every existing sibling after them (verified live), so take only as many as we sent.
    const ids = res.results.slice(0, chunkSpecs.length).map((r) => r.id);
    createdIds.push(...ids);
    if (ids.length !== chunkSpecs.length) {
      throw new Error(`Notion created ${ids.length} of ${chunkSpecs.length} blocks under ${parentId}; stopping so nesting stays correct.`);
    }
    anchor = ids[ids.length - 1] ?? anchor;
    for (let j = 0; j < chunkSpecs.length; j++) {
      const s = chunkSpecs[j];
      // Nested content lives inside ids[j], so trashing that block cleans up a partial nested write too.
      if (s.children?.length && !childrenInline(s)) await appendChunks(ids[j], s.children, { type: "end" }, []);
    }
  }
}
