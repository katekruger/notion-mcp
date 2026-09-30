// Markdown → block specs. Accepts common markdown plus the tags Notion's own markdown export uses, so a page read
// with format "markdown" can be edited and written back. Nesting follows indentation (tabs or spaces), to any depth.
import type { BlockSpec } from "./blocks.js";

interface Line {
  indent: number;
  text: string;
  raw: string;
}

function toLines(md: string): Line[] {
  return md
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((raw) => {
      const lead = raw.match(/^[ \t]*/)?.[0] ?? "";
      const indent = [...lead].reduce((n, ch) => n + (ch === "\t" ? 4 : 1), 0);
      return { indent, text: raw.trim(), raw };
    });
}

function attrsOf(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([a-z_-]+)="([^"]*)"/gi)) out[m[1].toLowerCase()] = m[2];
  return out;
}

/** Trailing {color="blue" toggle="true"} block attributes, as Notion's markdown writes them. */
function splitBlockAttrs(text: string): { text: string; attrs: Record<string, string> } {
  const m = text.match(/\s*\{((?:\s*[a-z_-]+="[^"]*")+)\s*\}\s*$/i);
  if (!m || m.index === undefined) return { text, attrs: {} };
  return { text: text.slice(0, m.index), attrs: attrsOf(m[1]) };
}

function applyAttrs(spec: BlockSpec, attrs: Record<string, string>): BlockSpec {
  if (attrs.color) spec.color = attrs.color;
  if (attrs.toggle === "true" && spec.type.startsWith("heading_")) spec.toggleable = true;
  return spec;
}

/** Strip a common indent (the smallest among non-blank lines) so a nested body parses on its own. */
function dedent(lines: Line[]): Line[] {
  const indents = lines.filter((l) => l.text).map((l) => l.indent);
  const base = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => ({ ...l, indent: l.indent - Math.min(base, l.indent) }));
}

/** Lines after `start` that belong to the block at `indent`: more indented, or blank lines between such. */
function indentedBody(lines: Line[], start: number, indent: number): { body: Line[]; next: number } {
  let j = start;
  let lastContent = start;
  while (j < lines.length && (!lines[j].text || lines[j].indent > indent)) {
    if (lines[j].text) lastContent = j + 1;
    j++;
  }
  return { body: lines.slice(start, lastContent), next: lastContent };
}

const CONTAINERS = ["callout", "details", "columns", "column", "tabs", "tab", "synced_block", "synced_block_reference", "table"];

/** Index of the line closing the container opened at `start`, counting nested containers of the same name. */
function findClose(lines: Line[], start: number, name: string): number {
  let depth = 0;
  const open = new RegExp(`^<${name}(\\s[^>]*)?>`, "i");
  const close = new RegExp(`</${name}>\\s*$`, "i");
  for (let j = start; j < lines.length; j++) {
    const t = lines[j].text;
    if (open.test(t) && !/\/>\s*$/.test(t)) depth++;
    if (close.test(t)) depth--;
    if (depth === 0) return j;
  }
  throw new Error(`Markdown: <${name}> opened on line ${start + 1} is never closed with </${name}>.`);
}

const ALERTS: Record<string, { icon: string; color: string }> = {
  NOTE: { icon: "ℹ️", color: "blue_background" },
  TIP: { icon: "💡", color: "green_background" },
  IMPORTANT: { icon: "❗", color: "purple_background" },
  WARNING: { icon: "⚠️", color: "yellow_background" },
  CAUTION: { icon: "🛑", color: "red_background" },
};

/** First paragraph becomes the container's own text; everything after it becomes children. */
function headAndRest(blocks: BlockSpec[]): { text: string; children: BlockSpec[] } {
  const [first, ...rest] = blocks;
  if (first && first.type === "paragraph" && !first.children?.length) return { text: first.text ?? "", children: rest };
  return { text: "", children: blocks };
}

function parseTableHtml(bodyText: string, attrs: Record<string, string>): BlockSpec {
  const rows: string[][] = [];
  for (const tr of bodyText.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    rows.push([...tr[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((td) => td[1].replace(/\s*\n\s*/g, " ").trim()));
  }
  if (rows.length === 0) throw new Error("Markdown: a <table> needs <tr><td>…</td></tr> rows.");
  return { type: "table", rows, header_row: attrs["header-row"] === "true", header_column: attrs["header-column"] === "true" };
}

function splitPipeRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\" && inner[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (inner[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += inner[i];
  }
  cells.push(cur.trim());
  return cells;
}

const SELF_CLOSING: Record<string, (a: Record<string, string>) => BlockSpec> = {
  table_of_contents: (a) => ({ type: "table_of_contents", ...(a.color ? { color: a.color } : {}) }),
  breadcrumb: () => ({ type: "breadcrumb" }),
  bookmark: (a) => ({ type: "bookmark", url: a.url ?? a.src, ...(a.caption ? { caption: a.caption } : {}) }),
  embed: (a) => ({ type: "embed", url: a.src ?? a.url, ...(a.caption ? { caption: a.caption } : {}) }),
  "link-to-page": (a) => ({ type: "link_to_page", url: a.url ?? a.id }),
  image: (a) => ({ type: "image", url: a.src ?? a.url, ...(a.caption ? { caption: a.caption } : {}) }),
  file: (a) => ({ type: "file", url: a.src ?? a.url, ...(a.name ? { name: a.name } : {}), ...(a.caption ? { caption: a.caption } : {}) }),
  pdf: (a) => ({ type: "pdf", url: a.src ?? a.url, ...(a.caption ? { caption: a.caption } : {}) }),
  video: (a) => ({ type: "video", url: a.src ?? a.url, ...(a.caption ? { caption: a.caption } : {}) }),
  audio: (a) => ({ type: "audio", url: a.src ?? a.url, ...(a.caption ? { caption: a.caption } : {}) }),
  "empty-block": () => ({ type: "paragraph", text: "" }),
};

function parseBlocks(lines: Line[]): BlockSpec[] {
  const out: BlockSpec[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const t = line.text;
    if (!t) {
      i++;
      continue;
    }
    const d = line.indent;

    // Fenced code: keep content verbatim, minus the fence's own indent.
    const fence = t.match(/^(`{3,}|~{3,})\s*([^\s`{]*)?(.*)$/);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !(lines[j].text.startsWith(marker) && lines[j].text.replace(/[`~]/g, "") === "")) {
        body.push(lines[j].raw.replace(new RegExp(`^[ \\t]{0,${d}}`), ""));
        j++;
      }
      if (j >= lines.length) throw new Error(`Markdown: code fence opened on line ${i + 1} is never closed.`);
      out.push({ type: "code", text: body.join("\n"), language: fence[2] || "plain text" });
      i = j + 1;
      continue;
    }

    // Block equation: $$ … $$ (one line or several).
    if (t.startsWith("$$")) {
      const one = t.match(/^\$\$(.+)\$\$$/);
      if (one) {
        out.push({ type: "equation", expression: one[1].trim() });
        i++;
        continue;
      }
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && lines[j].text !== "$$") {
        body.push(lines[j].text);
        j++;
      }
      if (j >= lines.length) throw new Error(`Markdown: $$ opened on line ${i + 1} is never closed.`);
      out.push({ type: "equation", expression: body.join("\n").trim() });
      i = j + 1;
      continue;
    }

    // Containers: <callout>, <details>, <columns>, <tabs>, <synced_block>, <table>.
    const open = t.match(/^<([a-z_]+)(\s[^>]*)?>(.*)$/i);
    if (open && CONTAINERS.includes(open[1].toLowerCase()) && !/\/>\s*$/.test(t)) {
      const name = open[1].toLowerCase();
      const a = attrsOf(open[2] ?? "");
      // One-line form: <callout icon="💡">text</callout>
      const oneLine = open[3].match(new RegExp(`^(.*)</${name}>\\s*$`, "i"));
      const close = oneLine ? i : findClose(lines, i, name);
      const inner = oneLine ? [] : lines.slice(i + 1, close);
      const innerText = oneLine ? oneLine[1] : "";
      i = close + 1;
      if (name === "table") {
        out.push(parseTableHtml(oneLine ? open[3] : inner.map((l) => l.text).join("\n"), a));
        continue;
      }
      if (name === "details") {
        const bodyLines = [...inner];
        let summary = "";
        const sIdx = bodyLines.findIndex((l) => l.text);
        const sm = sIdx >= 0 ? bodyLines[sIdx].text.match(/^<summary>([\s\S]*)<\/summary>$/i) : null;
        if (sm) {
          summary = sm[1];
          bodyLines.splice(sIdx, 1);
        }
        const kids = parseBlocks(dedent(bodyLines));
        out.push(applyAttrs({ type: "toggle", text: summary, ...(kids.length ? { children: kids } : {}) }, a));
        continue;
      }
      if (name === "callout") {
        const { text, children } = oneLine ? { text: innerText, children: [] } : headAndRest(parseBlocks(dedent(inner)));
        out.push({ type: "callout", text, icon: a.icon ?? "💡", ...(a.color ? { color: a.color } : {}), ...(children.length ? { children } : {}) });
        continue;
      }
      if (name === "columns") {
        const columns: BlockSpec[][] = [];
        const body = dedent(inner);
        for (let j = 0; j < body.length; j++) {
          if (!/^<column(\s[^>]*)?>/i.test(body[j].text)) {
            if (body[j].text) throw new Error(`Markdown: inside <columns>, put content in <column> … </column> (found "${body[j].text}").`);
            continue;
          }
          const end = findClose(body, j, "column");
          columns.push(parseBlocks(dedent(body.slice(j + 1, end))));
          j = end;
        }
        out.push({ type: "column_list", columns });
        continue;
      }
      if (name === "tabs") {
        const tabs: { title: string; children?: BlockSpec[] }[] = [];
        const body = dedent(inner);
        for (let j = 0; j < body.length; j++) {
          const m = body[j].text.match(/^<tab(\s[^>]*)?>/i);
          if (!m) continue;
          const end = findClose(body, j, "tab");
          const tabBody = dedent(body.slice(j + 1, end));
          const titleAttr = attrsOf(m[1] ?? "").title;
          let title = titleAttr ?? "";
          let rest = tabBody;
          if (titleAttr === undefined) {
            const k = tabBody.findIndex((l) => l.text);
            title = k >= 0 ? tabBody[k].text : "Tab";
            rest = tabBody.slice(k + 1);
          }
          const kids = parseBlocks(dedent(rest));
          tabs.push({ title, ...(kids.length ? { children: kids } : {}) });
          j = end;
        }
        out.push({ type: "tab", tabs });
        continue;
      }
      if (name === "synced_block" || name === "synced_block_reference") {
        // With a url, reference that existing synced block (writing back a page you read keeps the sync).
        if (a.url) out.push({ type: "synced_block", synced_from: a.url });
        else out.push({ type: "synced_block", children: parseBlocks(dedent(inner)) });
        continue;
      }
      if (name === "column" || name === "tab") throw new Error(`Markdown: <${name}> must be inside <${name}s>.`);
    }

    // Self-closing and simple tags.
    const tag = t.match(/^<([a-z_-]+)(\s[^>]*?)?\s*\/?>(?:\s*<\/\1>)?$/i);
    if (tag) {
      const name = tag[1].toLowerCase();
      if (name === "unknown") {
        const a = attrsOf(tag[2] ?? "");
        throw new Error(
          `Markdown: <unknown alt="${a.alt ?? "?"}"> stands for a block that can't be written as markdown. ` +
            "Leave it out, or copy the original block with notion_copy_blocks."
        );
      }
      const make = SELF_CLOSING[name];
      if (make) {
        out.push(make(attrsOf(tag[2] ?? "")));
        i++;
        continue;
      }
    }

    // Image on its own line: ![caption](url)
    const img = t.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
    if (img) {
      out.push({ type: "image", url: img[2], ...(img[1] ? { caption: img[1] } : {}) });
      i++;
      continue;
    }

    // Pipe table: header row, separator, body rows.
    if (t.startsWith("|") && i + 1 < lines.length && /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(lines[i + 1].text)) {
      const rows = [splitPipeRow(t)];
      let j = i + 2;
      while (j < lines.length && lines[j].text.startsWith("|")) {
        rows.push(splitPipeRow(lines[j].text));
        j++;
      }
      out.push({ type: "table", rows, header_row: true });
      i = j;
      continue;
    }

    // Quotes and GitHub-style alerts (> [!NOTE]).
    if (/^>/.test(t)) {
      const body: string[] = [];
      let j = i;
      while (j < lines.length && /^>/.test(lines[j].text)) {
        body.push(lines[j].text.replace(/^>\s?/, ""));
        j++;
      }
      i = j;
      const alert = body[0].match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
      if (alert) {
        const style = ALERTS[alert[1].toUpperCase()];
        const parsed = parseBlocks(toLines([alert[2], ...body.slice(1)].join("\n")));
        const { text, children } = headAndRest(parsed);
        out.push({ type: "callout", text, icon: style.icon, color: style.color, ...(children.length ? { children } : {}) });
      } else {
        const { text, attrs } = splitBlockAttrs(body.join("\n"));
        out.push(applyAttrs({ type: "quote", text }, attrs));
      }
      continue;
    }

    // Line blocks that can own indented children: headings, list items, to-dos, paragraphs.
    let spec: BlockSpec;
    let m: RegExpMatchArray | null;
    const { text: body, attrs } = splitBlockAttrs(t);
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) spec = { type: "divider" };
    else if ((m = body.match(/^(#{1,4})\s+(.*)$/))) spec = { type: `heading_${m[1].length}`, text: m[2] };
    else if ((m = body.match(/^[-*+]\s+\[( |x|X)\]\s*(.*)$/))) spec = { type: "to_do", text: m[2], checked: m[1].toLowerCase() === "x" };
    else if ((m = body.match(/^[-*+]\s+(.*)$/))) spec = { type: "bulleted_list_item", text: m[1] };
    else if ((m = body.match(/^\d+[.)]\s+(.*)$/))) spec = { type: "numbered_list_item", text: m[1] };
    else spec = { type: "paragraph", text: body };
    applyAttrs(spec, attrs);
    const { body: kidsLines, next } = indentedBody(lines, i + 1, d);
    i = next;
    if (kidsLines.length && spec.type !== "divider") {
      const kids = parseBlocks(dedent(kidsLines));
      if (kids.length) spec.children = kids;
    }
    out.push(spec);
  }
  return out;
}

/**
 * Convert markdown into block specs. Supports:
 * - # to #### headings, with {toggle="true"} and {color="…"} attributes; lists, to-dos, quotes, dividers, paragraphs
 * - nesting by indentation (tabs or spaces), any depth
 * - ``` fenced code (```mermaid for diagrams), $$ block equations $$
 * - pipe tables and <table header-row="true"><tr><td>…</td></tr></table>
 * - > [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION] alerts and <callout icon="…" color="…">…</callout>
 * - <details><summary>…</summary>…</details> toggles; <columns><column>…</column></columns>; <tabs><tab>Title …</tab></tabs>
 * - ![caption](url) images; <bookmark url/>, <embed src/>, <file|pdf|video|audio src/>, <link-to-page url/>,
 *   <table_of_contents/>, <breadcrumb/>, <synced_block> (new) or <synced_block url="…"> (reference)
 * - inline formatting as in fromInlineMarkdown
 */
export function markdownToSpecs(md: string): BlockSpec[] {
  return parseBlocks(toLines(md));
}
