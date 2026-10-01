// Every tool result has the same shape; truncation always leaves valid JSON.
import { test } from "vitest";
import assert from "node:assert/strict";
import { APIErrorCode, APIResponseError } from "@notionhq/client";
import { CHARACTER_LIMIT, envelope, fail, ok, unwrap, type Envelope } from "../src/tools/util.js";
import { config, ConfigError } from "../src/config.js";

const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text) as Envelope;

test("known fields are lifted to fixed places; the rest stays in data", () => {
  const e = envelope({ page_id: "p1", undo_id: "abc123", notes: ["n1"], note: "n2", next_step: "do x", next_cursor: "c9", total: 40 });
  assert.equal(e.status, "ok");
  assert.deepEqual(e.undo, { id: "abc123", coverage: "full" });
  assert.deepEqual(e.warnings, ["n1", "n2"]);
  assert.deepEqual(e.next_actions, ["do x"]);
  assert.deepEqual(e.pagination, { next_cursor: "c9", total: 40 });
  assert.deepEqual(e.data, { page_id: "p1", total: 40 });
  assert.match(e.summary, /page_id: p1/);
});

test("status words in results map to the envelope status; errors set isError", () => {
  assert.equal(envelope({ status: "partial" }).status, "partial");
  const failed = ok({ status: "failed", rule: "x" });
  assert.equal(failed.isError, true);
  assert.equal(parse(failed).status, "error");
  assert.equal(ok({ status: "succeeded" }).isError, undefined);
});

test("prose results keep their text as data, with a one-line summary", () => {
  const r = parse(ok("# Heading\nbody"));
  assert.equal(r.data, "# Heading\nbody");
  assert.equal(r.summary, "Heading");
});

test("fail returns the error envelope with the actionable message", () => {
  const r = fail(new APIResponseError({ code: APIErrorCode.ObjectNotFound, status: 404, message: "x", headers: {}, rawBodyText: "{}", additional_data: undefined, request_id: undefined }));
  assert.equal(r.isError, true);
  const e = parse(r);
  assert.equal(e.status, "error");
  assert.equal(e.data, null);
  assert.match(e.error ?? "", /shared|Connections|not found/i);
});

test("large results shrink lists inside data and always stay valid JSON under the limit", () => {
  const rows = Array.from({ length: 5000 }, (_, i) => ({ id: `row-${i}`, text: "x".repeat(40) }));
  const r = ok({ count: rows.length, rows, undo_id: "u1" });
  const text = r.content[0].text;
  assert.ok(text.length <= CHARACTER_LIMIT);
  const e = JSON.parse(text) as Envelope & { data: { rows: unknown[] } };
  assert.ok(e.data.rows.length < rows.length);
  assert.match(e.truncated ?? "", /omitted/);
  assert.equal(e.undo?.id, "u1", "the envelope survives truncation");

  const huge = ok("y".repeat(CHARACTER_LIMIT * 2));
  assert.ok(huge.content[0].text.length <= CHARACTER_LIMIT);
  assert.ok(JSON.parse(huge.content[0].text));

  const unshrinkable = ok({ blob: "z".repeat(CHARACTER_LIMIT * 2) });
  const u = JSON.parse(unshrinkable.content[0].text) as Envelope;
  assert.equal(u.data, null);
  assert.match(u.truncated ?? "", /too large/);
});

test("unwrap gives scripts the shape tools built", () => {
  const { json, text, env } = unwrap(ok({ a: 1, undo_id: "u", notes: ["w"] }));
  assert.equal(env?.status, "ok");
  assert.deepEqual(json, { a: 1, undo_id: "u", notes: ["w"] });
  assert.ok(text.includes('"status"'));
  assert.deepEqual(unwrap(ok([1, 2])).json, [1, 2]);
  assert.equal(unwrap(ok("plain")).text, "plain");
});

test("config: defaults, and every bad value named at once", () => {
  const c = config({ NOTION_TOKEN: "secret", NOTION_TIMEOUT_MS: "" });
  assert.equal(c.NOTION_TIMEOUT_MS, 30_000);
  assert.equal(c.NOTION_VERSION, "2026-03-11");
  assert.throws(
    () => config({ NOTION_TIMEOUT_MS: "abc", NOTION_VERSION: "latest", NOTION_PLUS_TIMEZONE: "Mars/Base", NOTION_PLUS_LOG: "loud" }),
    (e: unknown) => e instanceof ConfigError && e.problems.length === 4
  );
});
