// Offline checks for request-shaping logic. No network: Notion calls go to a fake client.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@notionhq/client";
import { setClientForTests } from "../src/services/notion.js";
import { forApi, fromInlineMarkdown, MAX_RICH_TEXT_ITEMS } from "../src/services/richtext.js";
import { appendSpecs, markdownToSpecs, type BlockSpec } from "../src/services/blocks.js";
import { coerceValue, withFullProperties, type PageProperty, type PropertyConfig } from "../src/services/schema.js";
import type { PageObjectResponse } from "@notionhq/client";

interface AppendCall {
  block_id: string;
  children: Record<string, unknown>[];
  position?: Record<string, unknown>;
}

/** Fake that records append calls and returns sequential ids. */
function fakeAppendClient(): { calls: AppendCall[]; client: Client } {
  const calls: AppendCall[] = [];
  let n = 0;
  const client = {
    blocks: {
      children: {
        append: async (args: AppendCall) => {
          calls.push(args);
          return { results: args.children.map(() => ({ id: `b${++n}` })) };
        },
      },
    },
  } as unknown as Client;
  return { calls, client };
}

/** Deepest nesting inside one append request (1 = no children). */
function depth(block: Record<string, unknown>): number {
  const inner = block[block.type as string] as { children?: Record<string, unknown>[] } | undefined;
  const kids = inner?.children ?? [];
  return 1 + (kids.length ? Math.max(...kids.map(depth)) : 0);
}

test("forApi splits segments at 2000 chars", () => {
  const out = forApi([{ type: "text", text: { content: "x".repeat(4500) } }]);
  assert.equal(out.length, 3);
});

test("forApi rejects more than 100 segments instead of truncating", () => {
  assert.throws(() => forApi([{ type: "text", text: { content: "x".repeat(2000 * MAX_RICH_TEXT_ITEMS + 1) } }]), /100/);
  assert.equal(forApi([{ type: "text", text: { content: "x".repeat(2000 * MAX_RICH_TEXT_ITEMS) } }]).length, 100);
  const many = fromInlineMarkdown(Array.from({ length: 60 }, (_, i) => `**b${i}** p`).join(" "));
  assert.throws(() => forApi(many), /rich text segments/);
});

test("appendSpecs keeps every request within 2 nesting levels and preserves structure", async () => {
  const { calls, client } = fakeAppendClient();
  setClientForTests(client);
  const specs: BlockSpec[] = [
    {
      type: "bulleted_list_item",
      text: "L1",
      children: [{ type: "bulleted_list_item", text: "L2", children: [{ type: "bulleted_list_item", text: "L3", children: [{ type: "paragraph", text: "L4" }] }] }],
    },
    { type: "paragraph", text: "flat", children: [{ type: "paragraph", text: "leaf" }] },
  ];
  const ids = await appendSpecs("root", specs);
  assert.deepEqual(ids, ["b1", "b2"]);
  for (const c of calls) for (const b of c.children) assert.ok(depth(b) <= 2, `request to ${c.block_id} nests ${depth(b)} levels`);
  // Root append: L1 without inline children (its child has children), "flat" with its leaf inline.
  assert.equal(calls[0].block_id, "root");
  assert.equal(depth(calls[0].children[0]), 1);
  assert.equal(depth(calls[0].children[1]), 2);
  // Then L2 under L1 (b1), L3+L4 inline under L2 (b3).
  assert.deepEqual(calls.slice(1).map((c) => c.block_id), ["b1", "b3"]);
  assert.equal(depth(calls[2].children[0]), 2);
  setClientForTests(null);
});

test("appendSpecs chunks at 100 and anchors later chunks after the previous one", async () => {
  const { calls, client } = fakeAppendClient();
  setClientForTests(client);
  const specs = Array.from({ length: 250 }, (_, i) => ({ type: "paragraph", text: `p${i}` }));
  const ids = await appendSpecs("root", specs, { type: "start" });
  assert.equal(ids.length, 250);
  assert.deepEqual(calls.map((c) => c.children.length), [100, 100, 50]);
  assert.deepEqual(calls[0].position, { type: "start" });
  assert.deepEqual(calls[1].position, { type: "after_block", after_block: { id: "b100" } });
  assert.deepEqual(calls[2].position, { type: "after_block", after_block: { id: "b200" } });
  setClientForTests(null);
});

test("appendSpecs sends more than 100 children in follow-up requests", async () => {
  const { calls, client } = fakeAppendClient();
  setClientForTests(client);
  const kids = Array.from({ length: 120 }, (_, i) => ({ type: "paragraph", text: `c${i}` }));
  await appendSpecs("root", [{ type: "toggle", text: "t", children: kids }]);
  assert.deepEqual(calls.map((c) => [c.block_id, c.children.length]), [["root", 1], ["b1", 100], ["b1", 20]]);
  setClientForTests(null);
});

test("appendSpecs validates every spec before writing anything", async () => {
  const { calls, client } = fakeAppendClient();
  setClientForTests(client);
  await assert.rejects(appendSpecs("root", [{ type: "paragraph", text: "ok", children: [{ type: "table", text: "bad" }] }]), /Unsupported block type/);
  assert.equal(calls.length, 0);
  setClientForTests(null);
});

test("markdownToSpecs nests indented list items", () => {
  const specs = markdownToSpecs("- a\n  - b\n- [x] c");
  assert.equal(specs.length, 2);
  assert.equal(specs[0].children?.[0].text, "b");
  assert.equal(specs[1].checked, true);
});

test("coerceValue rejects more than 100 relations or people", async () => {
  const rel = { id: "r", name: "Rel", type: "relation", relation: {} } as unknown as PropertyConfig;
  const ids = Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(32, "0"));
  await assert.rejects(coerceValue("Rel", rel, ids, false), /at most 100/);
  const okIds = ids.slice(0, 100);
  const r = await coerceValue("Rel", rel, okIds, false);
  assert.equal((r.payload.relation as unknown[]).length, 100);
  const people = { id: "p", name: "Who", type: "people", people: {} } as unknown as PropertyConfig;
  await assert.rejects(coerceValue("Who", people, ids, false), /at most 100 people/);
});

test("withFullProperties re-reads only properties that may be truncated", async () => {
  const retrieved: string[] = [];
  const all = Array.from({ length: 30 }, (_, i) => ({ id: `rel-${i}` }));
  setClientForTests({
    pages: {
      properties: {
        retrieve: async ({ property_id, start_cursor }: { property_id: string; start_cursor?: string }) => {
          retrieved.push(property_id);
          const page = start_cursor ? all.slice(20) : all.slice(0, 20);
          return {
            object: "list",
            results: page.map((r) => ({ object: "property_item", type: "relation", relation: r })),
            has_more: !start_cursor,
            next_cursor: start_cursor ? null : "c2",
          };
        },
      },
    },
  } as unknown as Client);
  const page = {
    id: "page",
    properties: {
      Big: { id: "big", type: "relation", relation: all.slice(0, 25) },
      Small: { id: "small", type: "relation", relation: all.slice(0, 3) },
      Num: { id: "num", type: "number", number: 4 },
    } as unknown as Record<string, PageProperty>,
  } as unknown as PageObjectResponse;
  const full = await withFullProperties(page, ["Big", "Small", "Num"]);
  assert.deepEqual(retrieved, ["big", "big"]);
  assert.equal((full.properties.Big as unknown as { relation: unknown[] }).relation.length, 30);
  assert.equal((full.properties.Small as unknown as { relation: unknown[] }).relation.length, 3);
  assert.equal((page.properties.Big as unknown as { relation: unknown[] }).relation.length, 25, "input page is not mutated");
  setClientForTests(null);
});

test("appendSpecs ignores the existing siblings Notion echoes back after start/after_block inserts", async () => {
  const calls: AppendCall[] = [];
  setClientForTests({
    blocks: {
      children: {
        append: async (args: AppendCall) => {
          calls.push(args);
          // Live behavior: new blocks first, then every existing block after the insertion point.
          return { results: [...args.children.map((_, i) => ({ id: `new${calls.length}-${i}` })), { id: "old-1" }, { id: "old-2" }] };
        },
      },
    },
  } as unknown as Client);
  const ids = await appendSpecs("root", [{ type: "paragraph", text: "a" }, { type: "paragraph", text: "b" }], { type: "after_block", after_block_id: "h2" });
  assert.deepEqual(ids, ["new1-0", "new1-1"]);
  setClientForTests(null);
});
