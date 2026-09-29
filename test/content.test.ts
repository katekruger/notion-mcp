// Offline checks for Phase 2 content: inline rich text, markdown parsing, block building.
import { test } from "vitest";
import assert from "node:assert/strict";
import type { BlockObjectResponse, Client } from "@notionhq/client";
import { forApi, fromInlineMarkdown, normalizeColor, USER_LOOKUP } from "../src/services/richtext.js";
import { markdownToSpecs } from "../src/services/markdown.js";
import { appendSpecs, blockToSpec, buildBlock, normalizeSpecs, type BlockSpec } from "../src/services/blocks.js";
import { setClientForTests } from "../src/services/notion.js";

const PAGE = "3ea4c9c1e28b809c9a5dc0d2d61ff8d7";
const PAGE_ID = "3ea4c9c1-e28b-809c-9a5d-c0d2d61ff8d7";

test("inline: nested formatting, colors, and links", () => {
  const r = fromInlineMarkdown('a <span color="red_bg">**bold [x](https://e.com)**</span> <u>u</u> ~~s~~ *i* `c`');
  const bold = r.find((s) => s.type === "text" && s.text.content === "bold ");
  assert.deepEqual(bold && "annotations" in bold ? bold.annotations : null, { bold: true, color: "red_background" });
  const link = r.find((s) => s.type === "text" && s.text.content === "x");
  assert.ok(link && link.type === "text" && link.text.link?.url === "https://e.com");
  assert.deepEqual((link as { annotations?: unknown }).annotations, { bold: true, color: "red_background" });
  assert.ok(r.some((s) => s.type === "text" && s.text.content === "u" && s.annotations?.underline));
  assert.ok(r.some((s) => s.type === "text" && s.text.content === "s" && s.annotations?.strikethrough));
  assert.ok(r.some((s) => s.type === "text" && s.text.content === "i" && s.annotations?.italic));
  assert.ok(r.some((s) => s.type === "text" && s.text.content === "c" && s.annotations?.code));
});

test("inline: equations, but prices stay text", () => {
  const r = fromInlineMarkdown("cost $5 and $10, area $\\pi r^2$ and $`x^2`$");
  assert.deepEqual(r.filter((s) => s.type === "equation").map((s) => (s.type === "equation" ? s.equation.expression : "")), ["\\pi r^2", "x^2"]);
  assert.ok(r[0].type === "text" && r[0].text.content.startsWith("cost $5 and $10"));
});

test("inline: mentions in Notion's markdown form", () => {
  const r = fromInlineMarkdown(
    `<mention-page url="https://app.notion.com/p/${PAGE}">Test</mention-page> <mention-date start="2026-10-01"/> ` +
      '<mention-user email="kate@example.com"/> <mention-user id="' + PAGE + '"/>'
  );
  const mentions = r.filter((s) => s.type === "mention").map((s) => (s.type === "mention" ? s.mention : null));
  assert.deepEqual(mentions, [
    { page: { id: PAGE_ID } },
    { date: { start: "2026-10-01" } },
    { user: { id: USER_LOOKUP + "kate@example.com" } },
    { user: { id: PAGE_ID } },
  ]);
  assert.throws(() => fromInlineMarkdown('<mention-date start="soon"/>'), /mention-date/);
});

test("colors: short and long forms, bad names rejected", () => {
  assert.equal(normalizeColor("yellow_bg"), "yellow_background");
  assert.equal(normalizeColor("Blue"), "blue");
  assert.throws(() => normalizeColor("teal"), /Unknown color/);
});

test("markdown: Notion's own export parses back into the same structure", () => {
  const md = [
    "# H1",
    "#### H4",
    '## Toggle H2 {toggle="true"}',
    "\tinside",
    '<span color="red">red</span> text {color="blue"}',
    '<callout icon="⚠️" color="red_bg">',
    "\tNote!",
    "\t- detail",
    "</callout>",
    "<details>",
    "<summary>Toggle</summary>",
    "\t- a",
    "\t\t- b",
    "\t\t\t- c",
    "</details>",
    "```mermaid",
    "graph TD; A-->B",
    "```",
    "$$",
    "E=mc^2",
    "$$",
    '<table header-row="true">',
    "<tr>",
    "<td>A</td>",
    "<td>B</td>",
    "</tr>",
    "<tr>",
    "<td>1</td>",
    "<td>2</td>",
    "</tr>",
    "</table>",
    "<columns>",
    "\t<column>",
    "\t\tleft",
    "\t</column>",
    "\t<column>",
    "\t\tright",
    "\t</column>",
    "</columns>",
    '<table_of_contents color="gray"/>',
    '<embed src="https://www.youtube.com/watch?v=x"></embed>',
    "![](https://e.com/a.png)",
    '<synced_block url="https://app.notion.com/p/abc#3ea4c9c1e28b8188902de022414fae3d">',
    "\tsynced content",
    "</synced_block>",
    "<tabs>",
    "\t<tab>",
    "\t\tTab A",
    "\t\tpane A",
    "\t</tab>",
    "</tabs>",
    "- [x] task",
    "> quoted",
    "1. one",
    "---",
  ].join("\n");
  const s = markdownToSpecs(md);
  assert.deepEqual(
    s.map((b) => b.type),
    ["heading_1", "heading_4", "heading_2", "paragraph", "callout", "toggle", "code", "equation", "table", "column_list",
      "table_of_contents", "embed", "image", "synced_block", "tab", "to_do", "quote", "numbered_list_item", "divider"]
  );
  assert.equal(s[2].toggleable, true);
  assert.equal(s[2].children?.[0].text, "inside");
  assert.equal(s[3].color, "blue");
  assert.equal(s[4].text, "Note!");
  assert.equal(s[4].icon, "⚠️");
  assert.equal(s[4].children?.[0].type, "bulleted_list_item");
  assert.equal(s[5].text, "Toggle");
  assert.equal(s[5].children?.[0].children?.[0].children?.[0].text, "c"); // three levels deep
  assert.equal(s[6].language, "mermaid");
  assert.equal(s[7].expression, "E=mc^2");
  assert.deepEqual(s[8].rows, [["A", "B"], ["1", "2"]]);
  assert.equal(s[8].header_row, true);
  assert.equal(s[9].columns?.length, 2);
  assert.equal(s[13].synced_from, "https://app.notion.com/p/abc#3ea4c9c1e28b8188902de022414fae3d");
  assert.deepEqual(s[14].tabs, [{ title: "Tab A", children: [{ type: "paragraph", text: "pane A" }] }]);
});

test("markdown: GitHub alerts, pipe tables, and space-indented nesting", () => {
  const s = markdownToSpecs(
    ["> [!WARNING] Careful", "> second line", "", "| Name | Q3 |", "|---|---:|", "| a \\| b | 1 |", "", "- one", "    - two", "        - three"].join("\n")
  );
  assert.equal(s[0].type, "callout");
  assert.equal(s[0].icon, "⚠️");
  assert.equal(s[0].color, "yellow_background");
  assert.equal(s[0].text, "Careful");
  assert.equal(s[0].children?.[0].text, "second line");
  assert.deepEqual(s[1].rows, [["Name", "Q3"], ["a | b", "1"]]);
  assert.equal(s[2].children?.[0].children?.[0].text, "three");
});

test("markdown: unknown blocks and unclosed containers fail clearly", () => {
  assert.throws(() => markdownToSpecs('<unknown url="x" alt="bookmark"/>'), /can't be written/);
  assert.throws(() => markdownToSpecs("<callout>\n\ttext"), /never closed/);
});

test("normalizeSpecs: shorthands expand and bad specs fail before writing", () => {
  const [table] = normalizeSpecs([{ type: "table", rows: [["a", "b"], ["c"]], header_row: true }]);
  assert.equal(table.children?.length, 2);
  assert.equal(table.children?.[1].cells?.length, 2); // short rows padded
  assert.throws(() => normalizeSpecs([{ type: "column_list", columns: [[{ type: "paragraph", text: "x" }]] }]), /at least 2/);
  assert.throws(() => normalizeSpecs([{ type: "divider", children: [{ type: "paragraph" }] }]), /can't have children/);
  assert.throws(() => normalizeSpecs([{ type: "paragraph", color: "teal" }]), /Unknown color/);
  assert.throws(() => normalizeSpecs([{ type: "bookmark", url: "not a url" }]), /http/);
});

test("buildBlock: columns carry their content inline; deeper content is deferred by path", () => {
  const [spec] = normalizeSpecs([
    {
      type: "column_list",
      columns: [[{ type: "paragraph", text: "left", children: [{ type: "paragraph", text: "deep" }] }], [{ type: "paragraph", text: "right" }]],
    },
  ]);
  const { block, deferred } = buildBlock(spec);
  const cols = (block.column_list as { children: Record<string, { children: unknown[] }>[] }).children;
  assert.equal(cols.length, 2);
  assert.equal(cols[0].column.children.length, 1);
  assert.deepEqual(deferred, [{ path: [0, 0], specs: [{ type: "paragraph", text: "deep" }] }]);
});

test("buildBlock: a table over 100 rows inlines 100 and defers the rest onto the table", () => {
  const [spec] = normalizeSpecs([{ type: "table", rows: Array.from({ length: 130 }, (_, i) => [`r${i}`]) }]);
  const { block, deferred } = buildBlock(spec);
  assert.equal((block.table as { children: unknown[] }).children.length, 100);
  assert.equal(deferred[0].path.length, 0);
  assert.equal(deferred[0].specs.length, 30);
});

test("appendSpecs writes deferred column content to the right nested block", async () => {
  const calls: { block_id: string; n: number }[] = [];
  let n = 0;
  const children = new Map<string, string[]>();
  setClientForTests({
    blocks: {
      children: {
        append: async (args: { block_id: string; children: Record<string, unknown>[] }) => {
          calls.push({ block_id: args.block_id, n: args.children.length });
          const ids = args.children.map(() => `b${++n}`);
          // Record nested ids the way Notion would create them, so listing can find them.
          args.children.forEach((c, i) => {
            const inner = c[c.type as string] as { children?: Record<string, unknown>[] };
            const kidIds = (inner.children ?? []).map((k) => {
              const id = `b${++n}`;
              const gk = (k[k.type as string] as { children?: unknown[] }).children ?? [];
              children.set(id, gk.map(() => `b${++n}`));
              return id;
            });
            children.set(ids[i], kidIds);
          });
          return { results: ids.map((id) => ({ id })) };
        },
        list: async ({ block_id }: { block_id: string }) => ({
          results: (children.get(block_id) ?? []).map((id) => ({ id, object: "block", type: "paragraph", paragraph: { rich_text: [] }, has_children: false })),
          has_more: false,
          next_cursor: null,
        }),
      },
    },
  } as unknown as Client);
  try {
    await appendSpecs("root", [
      { type: "column_list", columns: [[{ type: "paragraph", text: "left", children: [{ type: "paragraph", text: "deep" }] }], [{ type: "paragraph", text: "right" }]] },
    ]);
    // First the column list with both columns and their first-level content, then "deep" under "left".
    assert.equal(calls.length, 2);
    assert.equal(calls[0].block_id, "root");
    const left = children.get(children.get("b1")?.[0] ?? "")?.[0];
    assert.equal(calls[1].block_id, left);
  } finally {
    setClientForTests(null);
  }
});

test("blockToSpec round-trips a callout, a hosted image, and turns an original synced block into a reference", () => {
  const callout = {
    id: "c1", type: "callout", has_children: false,
    callout: { rich_text: [{ type: "text", text: { content: "hi", link: null }, annotations: { bold: true, color: "default" }, plain_text: "hi" }], icon: { type: "emoji", emoji: "🔥" }, color: "red_background" },
  } as unknown as BlockObjectResponse;
  const spec = blockToSpec(callout, []) as BlockSpec;
  assert.equal(spec.icon, "🔥");
  assert.equal(spec.color, "red_background");
  assert.deepEqual(forApi(spec.rich_text ?? []), [{ type: "text", text: { content: "hi" }, annotations: { bold: true } }]);
  const img = { id: "i1", type: "image", has_children: false, image: { type: "file", file: { url: "https://s3/x.png?sig" }, caption: [] } } as unknown as BlockObjectResponse;
  assert.deepEqual(blockToSpec(img, []), { type: "image", url: "https://s3/x.png?sig", reupload: true });
  const synced = { id: "orig", type: "synced_block", has_children: true, synced_block: { synced_from: null } } as unknown as BlockObjectResponse;
  assert.deepEqual(blockToSpec(synced, [{ type: "paragraph", text: "x" }]), { type: "synced_block", synced_from: "orig" });
  const childPage = { id: "p", type: "child_page", has_children: true, child_page: { title: "Sub" } } as unknown as BlockObjectResponse;
  assert.equal(blockToSpec(childPage, []), null);
});
