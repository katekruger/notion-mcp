// Offline checks for Phase 1 foundations: retries, undo conflict detection, partial writes, response sizing.
import { test } from "vitest";
import assert from "node:assert/strict";
import { RequestTimeoutError, type Client } from "@notionhq/client";
import { call, isTransientNetworkError, setClientForTests } from "../src/services/notion.js";
import { findConflicts, undoTarget, type JournalEntry } from "../src/services/journal.js";
import { appendSpecs, PartialWriteError } from "../src/services/blocks.js";
import { CHARACTER_LIMIT, fitToLimit } from "../src/tools/util.js";

const timeout = () => new RequestTimeoutError();
const fetchFailed = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });

test("isTransientNetworkError recognizes timeouts and connection failures only", () => {
  assert.equal(isTransientNetworkError(timeout()), true);
  assert.equal(isTransientNetworkError(fetchFailed()), true);
  assert.equal(isTransientNetworkError(new Error("validation failed")), false);
  assert.equal(isTransientNetworkError(null), false);
});

test("call retries idempotent calls after a network failure", { timeout: 15_000 }, async () => {
  let n = 0;
  const result = await call(async () => {
    if (++n < 3) throw fetchFailed();
    return "ok";
  }, { idempotent: true });
  assert.equal(result, "ok");
  assert.equal(n, 3);
});

test("call never retries non-idempotent writes, since the first attempt may have landed", async () => {
  let n = 0;
  await assert.rejects(call(async () => {
    n++;
    throw timeout();
  }));
  assert.equal(n, 1);
});

const entry = (at: string, undo: JournalEntry["undo"], id = "e1"): JournalEntry => ({ id, at, tool: "t", summary: "s", undo, undone: false });

test("findConflicts flags objects edited in a later minute, ignores the write's own minute", () => {
  const e = entry("2026-09-29T10:15:40.000Z", [
    { kind: "page_properties", page_id: "p1", properties: {} },
    { kind: "page_properties", page_id: "p2", properties: {} },
    { kind: "block_update", block_id: "b1", payload: {} },
  ]);
  const edited = new Map<string, string | null>([
    ["p1", "2026-09-29T10:15:00.000Z"], // the write itself
    ["p2", "2026-09-29T10:17:00.000Z"], // later
    ["b1", null], // gone
  ]);
  const later = entry("2026-09-29T10:17:05.000Z", [{ kind: "page_properties", page_id: "p2", properties: {} }], "e2");
  const conflicts = findConflicts(e, edited, [e, later]);
  assert.deepEqual(conflicts.map((c) => c.id), ["p2"]);
  assert.deepEqual(conflicts[0].later_entries, ["e2"]);
});

test("findConflicts compares exact edit times exactly (views), minute-rounded ones by minute", () => {
  const e = entry("2026-09-30T15:51:02.654Z", [{ kind: "view_update", view_id: "v", payload: {} }]);
  assert.deepEqual(findConflicts(e, new Map([["v", "2026-09-30T15:51:02.527Z"]])), []);
  assert.equal(findConflicts(e, new Map([["v", "2026-09-30T15:51:03.100Z"]])).length, 1);
});

test("undoTarget: restores and comment deletes can't clobber newer edits; trashing inserted content can", () => {
  assert.equal(undoTarget({ kind: "comment_delete", comment_id: "c" }), null);
  assert.equal(undoTarget({ kind: "block_trash", block_id: "b", in_trash: false }), null);
  assert.deepEqual(undoTarget({ kind: "block_trash", block_id: "b", in_trash: true }), { kind: "block", id: "b" });
  assert.equal(undoTarget({ kind: "schema", data_source_id: "d", properties: {} }), null);
});

test("appendSpecs reports which top-level blocks landed when a later request fails", async () => {
  let n = 0;
  let calls = 0;
  setClientForTests({
    blocks: {
      children: {
        append: async (args: { children: unknown[] }) => {
          if (++calls === 2) throw new Error("boom");
          return { results: args.children.map(() => ({ id: `b${++n}` })) };
        },
      },
    },
  } as unknown as Client);
  try {
    const specs = Array.from({ length: 150 }, (_, i) => ({ type: "paragraph", text: `p${i}` }));
    const err = await appendSpecs("root", specs).then(
      () => null,
      (e: unknown) => e
    );
    assert.ok(err instanceof PartialWriteError);
    assert.equal(err.createdIds.length, 100);
    assert.match(err.message, /boom/);
  } finally {
    setClientForTests(null);
  }
});

test("fitToLimit keeps valid JSON by shrinking the longest list, and says so", () => {
  const rows = Array.from({ length: 2000 }, (_, i) => ({ id: `row-${i}`, text: "x".repeat(40) }));
  const text = fitToLimit({ count: rows.length, rows });
  assert.ok(text.length <= CHARACTER_LIMIT);
  const parsed = JSON.parse(text) as { rows: unknown[]; truncated: string; count: number };
  assert.equal(parsed.count, 2000);
  assert.ok(parsed.rows.length < 2000 && parsed.rows.length > 100);
  assert.match(parsed.truncated, /omitted/);
});

test("fitToLimit leaves small results alone and cuts long strings with a hint", () => {
  assert.equal(fitToLimit({ a: 1 }), JSON.stringify({ a: 1 }, null, 2));
  const cut = fitToLimit("y".repeat(CHARACTER_LIMIT + 10));
  assert.match(cut, /Truncated/);
});

test("mapLimited keeps order and never runs more than the limit at once", async () => {
  const { mapLimited } = await import("../src/services/notion.js");
  let active = 0;
  let peak = 0;
  const out = await mapLimited([5, 1, 4, 2, 3], async (x) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, x * 5));
    active--;
    return x * 10;
  }, 3);
  assert.deepEqual(out, [50, 10, 40, 20, 30]);
  assert.equal(peak, 3);
});

test("reads retry Notion gateway errors; writes don't", { timeout: 15_000 }, async () => {
  const { APIResponseError } = await import("@notionhq/client");
  const gateway = () => Object.assign(Object.create(APIResponseError.prototype), { status: 502, code: "service_unavailable", message: "502", name: "APIResponseError" });
  let n = 0;
  const r = await call(async () => {
    if (++n < 2) throw gateway();
    return "ok";
  }, { idempotent: true });
  assert.equal(r, "ok");
  let w = 0;
  await assert.rejects(call(async () => {
    w++;
    throw gateway();
  }));
  assert.equal(w, 1);
});
