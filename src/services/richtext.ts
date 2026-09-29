import type { RichTextItemResponse } from "@notionhq/client";
import { normalizeId } from "./notion.js";

export interface Annotations {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  code?: boolean;
  color?: string;
}

/** Request-shaped rich text segment. Only `text` segments are editable; others are atomic. */
export type RichTextReq =
  | { type: "text"; text: { content: string; link?: { url: string } | null }; annotations?: Annotations }
  | { type: "mention"; mention: Record<string, unknown>; annotations?: Annotations; plain_text?: string }
  | { type: "equation"; equation: { expression: string }; annotations?: Annotations };

const MAX_SEGMENT = 2000;
/** Notion rejects rich text arrays longer than this (per block, per property). */
export const MAX_RICH_TEXT_ITEMS = 100;

export function plain(rt: ReadonlyArray<RichTextItemResponse> | undefined): string {
  return (rt ?? []).map((r) => r.plain_text).join("");
}

function cleanAnnotations(a: Annotations | undefined): Annotations | undefined {
  if (!a) return undefined;
  const out: Annotations = {};
  if (a.bold) out.bold = true;
  if (a.italic) out.italic = true;
  if (a.strikethrough) out.strikethrough = true;
  if (a.underline) out.underline = true;
  if (a.code) out.code = true;
  if (a.color && a.color !== "default") out.color = a.color;
  return Object.keys(out).length ? out : undefined;
}

/** Convert response rich text into request form, preserving formatting, links, and mentions. */
export function toRequest(rt: ReadonlyArray<RichTextItemResponse> | undefined): RichTextReq[] {
  const out: RichTextReq[] = [];
  for (const r of rt ?? []) {
    const annotations = cleanAnnotations(r.annotations as Annotations);
    if (r.type === "text") {
      out.push({
        type: "text",
        text: { content: r.text.content, link: r.text.link ? { url: r.text.link.url } : null },
        ...(annotations ? { annotations } : {}),
      });
    } else if (r.type === "equation") {
      out.push({ type: "equation", equation: { expression: r.equation.expression }, ...(annotations ? { annotations } : {}) });
    } else {
      const m = r.mention as unknown as Record<string, unknown> & { type: string };
      const inner = m[m.type] as Record<string, unknown> | undefined;
      let mention: Record<string, unknown> | null = null;
      if ((m.type === "page" || m.type === "database" || m.type === "user") && inner && typeof inner.id === "string") {
        mention = { [m.type]: { id: inner.id } };
      } else if (m.type === "date" && inner) {
        mention = { date: inner };
      }
      if (mention) {
        out.push({ type: "mention", mention, plain_text: r.plain_text, ...(annotations ? { annotations } : {}) });
      } else {
        // Mention types the API can't write back (link previews, templates): keep the visible text.
        out.push({ type: "text", text: { content: r.plain_text, link: r.href ? { url: r.href } : null }, ...(annotations ? { annotations } : {}) });
      }
    }
  }
  return out;
}

/**
 * Strip helper-only fields before sending to Notion, and split long segments.
 * Throws if the result would exceed Notion's 100-item cap, rather than silently dropping text.
 */
export function forApi(segments: RichTextReq[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const s of segments) {
    if (s.type === "text") {
      const content = s.text.content;
      if (content.length === 0) continue;
      for (let i = 0; i < content.length; i += MAX_SEGMENT) {
        out.push({
          type: "text",
          text: { content: content.slice(i, i + MAX_SEGMENT), ...(s.text.link ? { link: s.text.link } : {}) },
          ...(s.annotations ? { annotations: s.annotations } : {}),
        });
      }
    } else if (s.type === "mention") {
      out.push({ type: "mention", mention: s.mention, ...(s.annotations ? { annotations: s.annotations } : {}) });
    } else {
      out.push({ type: "equation", equation: s.equation, ...(s.annotations ? { annotations: s.annotations } : {}) });
    }
  }
  if (out.length > MAX_RICH_TEXT_ITEMS) {
    throw new Error(
      `This text needs ${out.length} rich text segments, but Notion allows ${MAX_RICH_TEXT_ITEMS} per block or property ` +
        `(each segment holds up to ${MAX_SEGMENT} characters or one formatting run). Split it across several blocks.`
    );
  }
  return out;
}

export function segmentText(s: RichTextReq): string {
  if (s.type === "text") return s.text.content;
  if (s.type === "equation") return s.equation.expression;
  return s.plain_text ?? "";
}

export const COLORS = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;
export const BLOCK_COLORS: readonly string[] = [...COLORS, ...COLORS.filter((c) => c !== "default").map((c) => `${c}_background`)];

/** Accepts API colors ("red_background") and Notion markdown's short form ("red_bg"). Throws on anything else. */
export function normalizeColor(color: string): string {
  const c = color.trim().toLowerCase().replace(/_bg$/, "_background");
  if (!BLOCK_COLORS.includes(c)) throw new Error(`Unknown color "${color}". Use one of: ${BLOCK_COLORS.join(", ")}.`);
  return c;
}

/** Prefix marking a user mention that still needs an email/name lookup (see resolveUserMentions). */
export const USER_LOOKUP = "lookup:";

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-z_-]+)="([^"]*)"/gi)) out[m[1].toLowerCase()] = m[2];
  return out;
}

function mentionFromTag(kind: string, a: Record<string, string>, inner: string): Record<string, unknown> {
  const ref = a.url ?? a.id ?? inner;
  switch (kind) {
    case "page":
    case "database":
      if (!ref) throw new Error(`<mention-${kind}> needs url="…" (a Notion link or id).`);
      return { [kind]: { id: normalizeId(ref) } };
    case "user": {
      const v = (a.id ?? a.email ?? a.url ?? inner).replace(/^user:\/\//, "").trim();
      if (!v) throw new Error('<mention-user> needs id="…", email="…", or the person\'s name inside it.');
      return { user: { id: /^[0-9a-f-]{32,36}$/i.test(v) ? normalizeId(v) : USER_LOOKUP + v } };
    }
    case "date": {
      const start = a.start ?? inner;
      if (!start || Number.isNaN(Date.parse(start))) throw new Error(`<mention-date> needs start="YYYY-MM-DD" (got "${start}").`);
      return { date: { start, ...(a.end ? { end: a.end } : {}) } };
    }
    default:
      throw new Error(`Unknown mention type "${kind}". Use mention-page, mention-database, mention-user, or mention-date.`);
  }
}

// Earliest-match inline grammar. Wrapping forms recurse so formatting nests (e.g. a bold link inside a colored span).
const INLINE = new RegExp(
  [
    String.raw`(?<span><span\b([^>]*)>([\s\S]*?)</span>)`,
    String.raw`(?<mentionSelf><mention-(page|database|user|date)\b([^>]*?)/>)`,
    String.raw`(?<mention><mention-(page|database|user|date)\b([^>]*)>([\s\S]*?)</mention-\8>)`,
    String.raw`(?<eqNotion>\$` + "`" + String.raw`([^` + "`" + String.raw`]+)` + "`" + String.raw`\$)`,
    String.raw`(?<eq>(?<![\w$\\])\$(?![\s\d])([^$\n]+?)(?<!\s)\$(?![\w$]))`,
    String.raw`(?<bold>\*\*([\s\S]+?)\*\*)`,
    String.raw`(?<strike>~~([\s\S]+?)~~)`,
    String.raw`(?<under><u>([\s\S]+?)</u>)`,
    String.raw`(?<code>` + "`" + String.raw`([^` + "`" + String.raw`]+)` + "`" + ")",
    String.raw`(?<link>\[([^\]]+)\]\(((?:https?://|mailto:|/)[^)\s]*)\))`,
    String.raw`(?<italic>(?<![\w*])\*(?![\s*])([^*]+?)(?<!\s)\*(?![\w*]))`,
    String.raw`(?<italic2>(?<![\w_])_(?![\s_])([^_]+?)(?<!\s)_(?![\w_]))`,
  ].join("|"),
  "g"
);

function withAnn(base: Annotations | undefined, add: Annotations): Annotations {
  return { ...(base ?? {}), ...add };
}

function parseInline(input: string, ann: Annotations | undefined, url: string | undefined, out: RichTextReq[]): void {
  const pushText = (content: string, a: Annotations | undefined, link: string | undefined): void => {
    if (!content) return;
    const clean = cleanAnnotations(a);
    out.push({ type: "text", text: { content, link: link ? { url: link } : null }, ...(clean ? { annotations: clean } : {}) });
  };
  const re = new RegExp(INLINE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    pushText(input.slice(last, m.index), ann, url);
    last = m.index + m[0].length;
    const g = m.groups ?? {};
    const clean = cleanAnnotations(ann);
    if (g.span !== undefined) {
      const a = attrs(m[2]);
      const add: Annotations = {};
      if (a.color) add.color = normalizeColor(a.color);
      if (a.underline === "true") add.underline = true;
      if (a.bold === "true") add.bold = true;
      if (a.italic === "true") add.italic = true;
      parseInline(m[3], withAnn(ann, add), url, out);
    } else if (g.mentionSelf !== undefined) {
      out.push({ type: "mention", mention: mentionFromTag(m[5], attrs(m[6]), ""), ...(clean ? { annotations: clean } : {}) });
    } else if (g.mention !== undefined) {
      const inner = m[10];
      out.push({ type: "mention", mention: mentionFromTag(m[8], attrs(m[9]), inner), plain_text: inner, ...(clean ? { annotations: clean } : {}) });
    } else if (g.eqNotion !== undefined) {
      out.push({ type: "equation", equation: { expression: m[12] }, ...(clean ? { annotations: clean } : {}) });
    } else if (g.eq !== undefined) {
      out.push({ type: "equation", equation: { expression: m[14] }, ...(clean ? { annotations: clean } : {}) });
    } else if (g.bold !== undefined) parseInline(m[16], withAnn(ann, { bold: true }), url, out);
    else if (g.strike !== undefined) parseInline(m[18], withAnn(ann, { strikethrough: true }), url, out);
    else if (g.under !== undefined) parseInline(m[20], withAnn(ann, { underline: true }), url, out);
    else if (g.code !== undefined) pushText(m[22], withAnn(ann, { code: true }), url);
    else if (g.link !== undefined) parseInline(m[24], ann, m[25], out);
    else if (g.italic !== undefined) parseInline(m[27], withAnn(ann, { italic: true }), url, out);
    else if (g.italic2 !== undefined) parseInline(m[29], withAnn(ann, { italic: true }), url, out);
  }
  pushText(input.slice(last), ann, url);
}

/**
 * Parse inline markdown into rich text. Formatting nests.
 * Markdown: **bold**, *italic* or _italic_, `code`, ~~strike~~, <u>underline</u>, [text](url), $x^2$ (inline equation).
 * Notion's markdown tags (as returned by page markdown reads): <span color="red">…</span> (also red_bg / red_background,
 * underline="true"), $`x`$, <mention-page url="…"/>, <mention-database url="…"/>, <mention-user id|email="…"/>,
 * <mention-date start="2026-10-01" end="…"/>. A "$" followed by a digit or space is literal, so prices stay text.
 */
export function fromInlineMarkdown(input: string): RichTextReq[] {
  const out: RichTextReq[] = [];
  parseInline(input, undefined, undefined, out);
  return out;
}

/** Collect user mentions that still need a lookup, so callers can resolve them before sending. */
export function pendingUserLookups(value: unknown, out: { user: { id: string } }[] = []): { user: { id: string } }[] {
  if (Array.isArray(value)) value.forEach((v) => pendingUserLookups(v, out));
  else if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const u = o.user as { id?: unknown } | undefined;
    if (u && typeof u.id === "string" && u.id.startsWith(USER_LOOKUP)) out.push(o as { user: { id: string } });
    for (const v of Object.values(o)) pendingUserLookups(v, out);
  }
  return out;
}

export function buildPattern(find: string, regex: boolean, caseSensitive: boolean): RegExp {
  const source = regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(source, caseSensitive ? "g" : "gi");
  } catch (e) {
    throw new Error(`Invalid regex "${find}": ${(e as Error).message}`);
  }
}

/**
 * Replace matches across a rich text array while keeping each segment's formatting.
 * The replacement inherits the formatting of the segment where the match starts.
 * Matches that overlap a mention or equation are skipped (reported in `skipped`).
 */
export function replaceInRichText(
  segments: RichTextReq[],
  pattern: RegExp,
  replacement: string,
  maxReplacements: number
): { segments: RichTextReq[]; count: number; skipped: number } {
  const work: RichTextReq[] = segments.map((s) =>
    s.type === "text" ? { ...s, text: { ...s.text } } : s
  );
  const offsets: number[] = [];
  let full = "";
  for (const s of work) {
    offsets.push(full.length);
    full += segmentText(s);
  }
  const single = new RegExp(pattern.source, pattern.flags.replace("g", ""));
  const matches: { start: number; end: number; text: string }[] = [];
  const g = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(full)) !== null && matches.length < maxReplacements) {
    if (m[0].length === 0) {
      g.lastIndex++;
      continue;
    }
    matches.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  }

  let count = 0;
  let skipped = 0;
  for (const match of [...matches].reverse()) {
    const touched: number[] = [];
    for (let i = 0; i < work.length; i++) {
      const segStart = offsets[i];
      const segEnd = segStart + segmentText(segments[i]).length;
      if (segEnd > match.start && segStart < match.end) touched.push(i);
    }
    if (touched.length === 0 || touched.some((i) => work[i].type !== "text")) {
      skipped++;
      continue;
    }
    const replaced = match.text.replace(single, replacement);
    const first = touched[0];
    const lastIdx = touched[touched.length - 1];
    const firstSeg = work[first] as Extract<RichTextReq, { type: "text" }>;
    const startInFirst = match.start - offsets[first];
    if (first === lastIdx) {
      const endInFirst = match.end - offsets[first];
      firstSeg.text.content =
        firstSeg.text.content.slice(0, startInFirst) + replaced + firstSeg.text.content.slice(endInFirst);
    } else {
      firstSeg.text.content = firstSeg.text.content.slice(0, startInFirst) + replaced;
      for (const i of touched.slice(1, -1)) (work[i] as Extract<RichTextReq, { type: "text" }>).text.content = "";
      const lastSeg = work[lastIdx] as Extract<RichTextReq, { type: "text" }>;
      lastSeg.text.content = lastSeg.text.content.slice(match.end - offsets[lastIdx]);
    }
    count++;
  }
  return {
    segments: work.filter((s) => s.type !== "text" || s.text.content.length > 0),
    count,
    skipped,
  };
}

export function textToTitle(text: string): Record<string, unknown>[] {
  return forApi([{ type: "text", text: { content: text } }]);
}
