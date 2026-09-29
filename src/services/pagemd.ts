// Read a page as markdown with Notion's endpoint, then fill the blocks it can't render with tags that
// markdownToSpecs accepts, so the result can be edited and written back.
import { isFullBlock } from "@notionhq/client";
import { isNotFound, notion, read } from "./notion.js";
import { plain } from "./richtext.js";

export interface PageMarkdown {
  markdown: string;
  /** Blocks still shown as <unknown …/>: can't be written back as markdown. */
  unknown: { id: string; type: string }[];
  truncated: boolean;
}

function attr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** The id at the end of an <unknown url="…#<block id>"> link. */
export function unknownBlockId(url: string): string | null {
  const m = url.match(/#([0-9a-f]{32})$/i);
  if (!m) return null;
  const h = m[1].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Replace the <unknown> tags we can render; leave the rest. `render` maps block id → replacement (or null). */
export function fillUnknown(markdown: string, render: Map<string, string | null>): { markdown: string; unknown: { id: string; type: string }[] } {
  const unknown: { id: string; type: string }[] = [];
  const out = markdown.replace(/<unknown url="([^"]*)" alt="([^"]*)"\/>/g, (whole, url: string, alt: string) => {
    const id = unknownBlockId(url);
    const rep = id ? render.get(id) : null;
    if (rep) return rep;
    unknown.push({ id: id ?? url, type: alt });
    return whole;
  });
  return { markdown: out, unknown };
}

async function renderUnknown(id: string): Promise<string | null> {
  let b;
  try {
    b = await read(() => notion().blocks.retrieve({ block_id: id }));
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
  if (!isFullBlock(b)) return null;
  const caption = (c: unknown) => {
    const text = plain((c as { caption?: Parameters<typeof plain>[0] }).caption);
    return text ? ` caption="${attr(text)}"` : "";
  };
  switch (b.type) {
    case "breadcrumb":
      return "<breadcrumb/>";
    case "bookmark":
      return `<bookmark url="${attr(b.bookmark.url)}"${caption(b.bookmark)}/>`;
    case "link_to_page": {
      const l = b.link_to_page as { type: string; page_id?: string; database_id?: string };
      const target = l.page_id ?? l.database_id;
      return target ? `<link-to-page url="${target}"/>` : null;
    }
    case "file":
    case "pdf":
    case "video":
    case "audio": {
      const m = (b as unknown as Record<string, { type: string; external?: { url: string }; file?: { url: string } }>)[b.type];
      const url = m.type === "external" ? m.external?.url : m.file?.url;
      return url ? `<${b.type} src="${attr(url)}"${caption(m)}/>` : null;
    }
    default:
      return null;
  }
}

export async function readPageMarkdown(pageId: string): Promise<PageMarkdown> {
  const res = await read(() => notion().pages.retrieveMarkdown({ page_id: pageId }));
  const ids = new Set<string>(res.unknown_block_ids ?? []);
  for (const m of res.markdown.matchAll(/<unknown url="([^"]*)"/g)) {
    const id = unknownBlockId(m[1]);
    if (id) ids.add(id);
  }
  const render = new Map<string, string | null>();
  for (const id of ids) render.set(id, await renderUnknown(id));
  const filled = fillUnknown(res.markdown, render);
  // Notion flags `truncated` when blocks came back as <unknown>; only the ones we couldn't fill still matter.
  return { markdown: filled.markdown, unknown: filled.unknown, truncated: Boolean(res.truncated) && filled.unknown.length > 0 };
}
