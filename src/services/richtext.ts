import type { RichTextItemResponse } from "@notionhq/client";

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

/**
 * Parse a small, predictable subset of inline markdown:
 * **bold**, *italic* or _italic_, `code`, ~~strike~~, [text](url).
 * Anything else is literal text.
 */
export function fromInlineMarkdown(input: string): RichTextReq[] {
  const out: RichTextReq[] = [];
  const pattern = /(\*\*([^*]+)\*\*)|(~~([^~]+)~~)|(`([^`]+)`)|(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))|(\*([^*\s][^*]*)\*)|(_([^_\s][^_]*)_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const pushText = (content: string, annotations?: Annotations, url?: string): void => {
    if (!content) return;
    out.push({ type: "text", text: { content, link: url ? { url } : null }, ...(annotations ? { annotations } : {}) });
  };
  while ((m = pattern.exec(input)) !== null) {
    pushText(input.slice(last, m.index));
    if (m[2] !== undefined) pushText(m[2], { bold: true });
    else if (m[4] !== undefined) pushText(m[4], { strikethrough: true });
    else if (m[6] !== undefined) pushText(m[6], { code: true });
    else if (m[8] !== undefined) pushText(m[8], undefined, m[9]);
    else if (m[11] !== undefined) pushText(m[11], { italic: true });
    else if (m[13] !== undefined) pushText(m[13], { italic: true });
    last = m.index + m[0].length;
  }
  pushText(input.slice(last));
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
