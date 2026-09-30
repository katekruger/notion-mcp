// Duplicating pages with databases, against a fake workspace. No network.
import { test } from "vitest";
import assert from "node:assert/strict";
import { APIErrorCode, APIResponseError, type Client, type PageObjectResponse } from "@notionhq/client";
import { setClientForTests } from "../src/services/notion.js";
import { readDatabase } from "../src/services/dbcopy.js";
import { duplicatePage } from "../src/services/copy.js";
import type { UndoOp } from "../src/services/journal.js";

function rt(text: string) {
  return [
    {
      type: "text",
      text: { content: text, link: null },
      annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
      plain_text: text,
      href: null,
    },
  ];
}

function block(id: string, type: string, body: Record<string, unknown>, hasChildren = false) {
  return { object: "block", id, type, has_children: hasChildren, in_trash: false, last_edited_time: "2026-09-01T00:00:00.000Z", [type]: body };
}

function page(id: string, title: string, parent: Record<string, unknown>): PageObjectResponse {
  return {
    object: "page",
    id,
    parent,
    icon: null,
    cover: null,
    url: `https://notion.so/${id}`,
    properties: { Name: { id: "title", type: "title", title: rt(title) } },
  } as unknown as PageObjectResponse;
}

function apiError(code: APIErrorCode, status: number): APIResponseError {
  return new APIResponseError({ code, status, message: code, headers: {}, rawBodyText: "{}", additional_data: undefined, request_id: undefined });
}

/**
 * Source page p1: a paragraph and a database db1 with one row r1. The row has a paragraph, a sub-page sp1, and
 * sp1 holds a block the API can't recreate.
 */
function fakeWorkspace() {
  const children: Record<string, unknown[]> = {
    p1: [block("b1", "paragraph", { rich_text: rt("Intro"), color: "default" }), block("db1", "child_database", { title: "Tasks" }, true)],
    r1: [block("rb1", "paragraph", { rich_text: rt("Row body"), color: "default" }), block("sp1", "child_page", { title: "Row notes" }, true)],
    sp1: [block("u1", "unsupported", {})],
  };
  const pages: Record<string, PageObjectResponse> = {
    sp1: page("sp1", "Row notes", { type: "page_id", page_id: "r1" }),
  };
  const created: { id: string; parent: Record<string, unknown> }[] = [];
  const appended: { block_id: string; count: number }[] = [];
  let n = 0;
  const client = {
    blocks: {
      children: {
        list: async ({ block_id }: { block_id: string }) => ({ results: children[block_id] ?? [], has_more: false, next_cursor: null }),
        append: async ({ block_id, children: kids }: { block_id: string; children: unknown[] }) => {
          appended.push({ block_id, count: kids.length });
          return { results: kids.map(() => ({ id: `a${++n}` })) };
        },
      },
    },
    pages: {
      create: async (body: { parent: Record<string, unknown> }) => {
        const id = `new${++n}`;
        created.push({ id, parent: body.parent });
        return { object: "page", id, url: `https://notion.so/${id}` };
      },
      retrieve: async ({ page_id }: { page_id: string }) => pages[page_id],
      update: async () => ({}),
    },
    databases: {
      retrieve: async ({ database_id }: { database_id: string }) => ({
        object: "database",
        id: database_id,
        parent: { type: "page_id", page_id: "p1" },
        title: rt("Tasks"),
        description: [],
        is_inline: false,
        icon: null,
        data_sources: [{ id: "ds1", name: "Tasks" }],
      }),
      create: async () => ({ object: "database", id: `newdb${++n}`, data_sources: [{ id: `newds${n}` }] }),
    },
    dataSources: {
      retrieve: async () => ({ object: "data_source", id: "ds1", title: rt("Tasks"), properties: { Name: { id: "title", name: "Name", type: "title", title: {} } } }),
      update: async () => ({}),
      query: async () => ({ results: [page("r1", "Row", { type: "data_source_id", data_source_id: "ds1" })], has_more: false, next_cursor: null }),
    },
  } as unknown as Client;
  return { client, created, appended };
}

test("readDatabase: not-found means an unreadable view; every other failure is thrown", async () => {
  try {
    setClientForTests({ databases: { retrieve: async () => Promise.reject(apiError(APIErrorCode.ObjectNotFound, 404)) } } as unknown as Client);
    assert.equal(await readDatabase("db1"), null);
    for (const [code, status] of [
      [APIErrorCode.RestrictedResource, 403],
      [APIErrorCode.Unauthorized, 401],
      [APIErrorCode.RateLimited, 429],
    ] as const) {
      setClientForTests({ databases: { retrieve: async () => Promise.reject(apiError(code, status)) } } as unknown as Client);
      await assert.rejects(readDatabase("db1"), (e: unknown) => (e as APIResponseError).code === code);
    }
  } finally {
    setClientForTests(null);
  }
}, 30_000);

test("duplicatePage copies row content recursively and reports what rows couldn't carry", async () => {
  const ws = fakeWorkspace();
  setClientForTests(ws.client);
  try {
    const undo: UndoOp[] = [];
    const r = await duplicatePage(page("p1", "Source", { type: "page_id", page_id: "root" }), { page_id: "root" }, { includeSubpages: true }, undo);
    assert.equal(r.databases.length, 1);
    assert.equal(r.databases[0].rows, 1);
    // The row's sub-page was created under the copied row, not dropped.
    const rowCopy = ws.created.find((c) => "data_source_id" in c.parent);
    assert.ok(rowCopy, "row was created");
    assert.ok(ws.created.some((c) => (c.parent as { page_id?: string }).page_id === rowCopy.id), "row sub-page copied under the row");
    assert.equal(r.subpages, 1);
    // The row's own paragraph was appended to the row copy.
    assert.ok(ws.appended.some((a) => a.block_id === rowCopy.id));
    // The unsupported block two levels down is disclosed, and the copy is marked partial.
    assert.ok(r.skipped.some((s) => s.id === "u1"));
    assert.equal(r.status, "partial");
  } finally {
    setClientForTests(null);
  }
}, 60_000);

test("duplicatePage fails loudly when a database can't be read for a reason other than not-found", async () => {
  const ws = fakeWorkspace();
  (ws.client as unknown as { databases: { retrieve: () => Promise<never> } }).databases.retrieve = async () =>
    Promise.reject(apiError(APIErrorCode.RestrictedResource, 403));
  setClientForTests(ws.client);
  try {
    await assert.rejects(
      duplicatePage(page("p1", "Source", { type: "page_id", page_id: "root" }), { page_id: "root" }, { includeSubpages: true }, []),
      (e: unknown) => (e as APIResponseError).code === APIErrorCode.RestrictedResource
    );
  } finally {
    setClientForTests(null);
  }
}, 30_000);

test("copy_row_content off skips row content and says so", async () => {
  const ws = fakeWorkspace();
  setClientForTests(ws.client);
  try {
    const r = await duplicatePage(
      page("p1", "Source", { type: "page_id", page_id: "root" }),
      { page_id: "root" },
      { includeSubpages: true, copyRowContent: false },
      []
    );
    const rowCopy = ws.created.find((c) => "data_source_id" in c.parent);
    assert.ok(rowCopy);
    assert.ok(!ws.appended.some((a) => a.block_id === rowCopy.id));
    assert.ok(r.databases[0].notes.some((n) => /copy_row_content/.test(n)));
    assert.equal(r.status, "complete");
  } finally {
    setClientForTests(null);
  }
}, 30_000);
