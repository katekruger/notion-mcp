// Undo against a fake client: conflict checks for inserted blocks use one parent listing.
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@notionhq/client";

process.env.NOTION_PLUS_HOME = mkdtempSync(path.join(os.tmpdir(), "notion-plus-journal-test-"));
const { insertedBlocks, record, undo } = await import("../src/services/journal.js");
const { setClientForTests } = await import("../src/services/notion.js");

test("undo of an insert checks freshness with one listing, then trashes every block", async () => {
  const ids = Array.from({ length: 5 }, (_, i) => `blk-${i}`);
  const id = await record("notion_insert_blocks", "test insert", insertedBlocks(ids, "parent-1"));
  const calls = { list: 0, retrieve: 0, del: 0 };
  const old = "2000-01-01T00:00:00.000Z";
  setClientForTests({
    blocks: {
      children: {
        list: async () => {
          calls.list++;
          return { results: ids.map((b) => ({ id: b, last_edited_time: old })), has_more: false, next_cursor: null };
        },
      },
      retrieve: async () => {
        calls.retrieve++;
        return {};
      },
      delete: async () => {
        calls.del++;
        return {};
      },
    },
  } as unknown as Client);
  try {
    const r = await undo(id);
    assert.equal(r.applied, 5);
    assert.deepEqual(calls, { list: 1, retrieve: 0, del: 5 });
  } finally {
    setClientForTests(null);
  }
});

test("undo refuses when an inserted block was edited in a later minute", async () => {
  const id = await record("notion_insert_blocks", "test insert 2", insertedBlocks(["x1"], "parent-2"));
  const later = new Date(Date.now() + 5 * 60_000).toISOString();
  let deleted = 0;
  setClientForTests({
    blocks: {
      children: { list: async () => ({ results: [{ id: "x1", last_edited_time: later }], has_more: false, next_cursor: null }) },
      delete: async () => {
        deleted++;
        return {};
      },
    },
  } as unknown as Client);
  try {
    await assert.rejects(undo(id), /Nothing was undone/);
    assert.equal(deleted, 0);
    const forced = await undo(id, { force: true });
    assert.equal(forced.conflicts.length, 1);
    assert.equal(deleted, 1);
  } finally {
    setClientForTests(null);
  }
});
