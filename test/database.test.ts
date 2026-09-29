// Offline checks for Phase 3: where operators, aggregation, CSV, schema requests.
import { test } from "vitest";
import assert from "node:assert/strict";
import type { DataSourceObjectResponse, PageObjectResponse } from "@notionhq/client";
import { buildWhereFilter, resolveRelativeDate } from "../src/services/schema.js";
import { aggregate, bucket, groupKeys, numericValue } from "../src/services/aggregate.js";
import { parseCsv } from "../src/services/csv.js";
import { configToRequest, needsSecondPass, propertyRequest, type PropertySpec } from "../src/services/dbschema.js";
import { inferStatusGroup } from "../src/tools/schema.js";

const ds = {
  id: "ds",
  title: [],
  properties: {
    Name: { id: "t", name: "Name", type: "title", title: {} },
    Status: { id: "s", name: "Status", type: "status", status: { options: [{ id: "1", name: "Done" }, { id: "2", name: "At Risk" }], groups: [] } },
    Due: { id: "d", name: "Due", type: "date", date: {} },
    Points: { id: "p", name: "Points", type: "number", number: { format: "number" } },
    Tags: { id: "g", name: "Tags", type: "multi_select", multi_select: { options: [{ id: "a", name: "Q3" }, { id: "b", name: "Q4" }] } },
    Flag: { id: "f", name: "Flag", type: "checkbox", checkbox: {} },
    Rel: { id: "r", name: "Rel", type: "relation", relation: { data_source_id: "other", type: "single_property" } },
  },
} as unknown as DataSourceObjectResponse;

test("relative dates resolve against now", () => {
  const now = new Date("2026-09-29T12:00:00Z");
  process.env.NOTION_PLUS_TIMEZONE = "UTC";
  assert.equal(resolveRelativeDate("today", now), "2026-09-29");
  assert.equal(resolveRelativeDate("+7d", now), "2026-10-06");
  assert.equal(resolveRelativeDate("-2w", now), "2026-09-15");
  assert.equal(resolveRelativeDate("+1m", now), "2026-10-29");
  assert.equal(resolveRelativeDate("2026-01-01", now), "2026-01-01");
});

test("where: operators, in, or/and, empties, and timestamps", async () => {
  process.env.NOTION_PLUS_TIMEZONE = "UTC";
  const f = await buildWhereFilter(ds, {
    status: { in: ["done", "at risk"] },
    Points: { ">": 5, "<=": 10 },
    Due: { before: "2026-10-01" },
    Tags: "Q4",
    or: [{ Flag: true }, { Name: { contains: "urgent" } }],
    "$last_edited": { after: "2026-09-01" },
    Rel: null,
  });
  assert.deepEqual(f, {
    and: [
      { or: [{ property: "Status", status: { equals: "Done" } }, { property: "Status", status: { equals: "At Risk" } }] },
      { property: "Points", number: { greater_than: 5 } },
      { property: "Points", number: { less_than_or_equal_to: 10 } },
      { property: "Due", date: { before: "2026-10-01" } },
      { property: "Tags", multi_select: { contains: "Q4" } },
      { or: [{ property: "Flag", checkbox: { equals: true } }, { property: "Name", title: { contains: "urgent" } }] },
      { timestamp: "last_edited_time", last_edited_time: { after: "2026-09-01" } },
      { property: "Rel", relation: { is_empty: true } },
    ],
  });
});

test("where: bad operators and values explain themselves", async () => {
  await assert.rejects(buildWhereFilter(ds, { Points: { contains: 3 } }), /supports: =, !=, >/);
  await assert.rejects(buildWhereFilter(ds, { Due: { before: "someday" } }), /isn't a date/);
  await assert.rejects(buildWhereFilter(ds, { Status: "Nope" }), /not an option/);
  await assert.rejects(buildWhereFilter(ds, { or: [] }), /non-empty list/);
});

function row(props: Record<string, unknown>): PageObjectResponse {
  const properties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    const t = (ds.properties as Record<string, { type: string }>)[k].type;
    properties[k] =
      t === "status" ? { type: t, status: v === null ? null : { name: v } }
      : t === "multi_select" ? { type: t, multi_select: (v as string[]).map((name) => ({ name })) }
      : t === "date" ? { type: t, date: v === null ? null : { start: v, end: null } }
      : t === "title" ? { type: t, title: [{ plain_text: v }] }
      : { type: t, [t]: v };
  }
  return { id: String(props.Name), properties } as unknown as PageObjectResponse;
}

const rows = [
  row({ Name: "a", Status: "Done", Points: 3, Tags: ["Q3"], Due: "2026-09-02", Flag: true }),
  row({ Name: "b", Status: "Done", Points: 5, Tags: ["Q3", "Q4"], Due: "2026-10-15", Flag: false }),
  row({ Name: "c", Status: "At Risk", Points: null, Tags: [], Due: null, Flag: true }),
];

test("aggregate: totals, group by status with sums, multi-select counts rows in each group", () => {
  const r = aggregate(rows, { group_by: { property: "Status" }, metrics: [{ op: "count" }, { op: "sum", property: "Points" }, { op: "avg", property: "Points" }] });
  assert.deepEqual(r.totals, { count: 3, sum_Points: 8, avg_Points: 4 });
  assert.deepEqual(r.groups, [
    { key: "Done", count: 2, sum_Points: 8, avg_Points: 4 },
    { key: "At Risk", count: 1, sum_Points: null, avg_Points: null },
  ]);
  const tags = aggregate(rows, { group_by: { property: "Tags" }, metrics: [{ op: "count" }] });
  assert.deepEqual(tags.groups.map((g) => [g.key, g.count]), [["Q3", 2], ["(empty)", 1], ["Q4", 1]]);
});

test("aggregate: date buckets, checked, distinct, min/max dates, top", () => {
  const byMonth = aggregate(rows, { group_by: { property: "Due", by: "month" }, metrics: [{ op: "count" }] });
  assert.deepEqual(byMonth.groups.map((g) => g.key), ["(empty)", "2026-09", "2026-10"]);
  const r = aggregate(rows, {
    metrics: [{ op: "checked", property: "Flag" }, { op: "percent_checked", property: "Flag" }, { op: "distinct", property: "Tags" }, { op: "min", property: "Due" }, { op: "median", property: "Points" }],
  });
  assert.deepEqual(r.totals, { checked_Flag: 2, percent_checked_Flag: 66.6667, distinct_Tags: 2, min_Due: "2026-09-02", median_Points: 4 });
  assert.equal(aggregate(rows, { group_by: { property: "Tags" }, metrics: [{ op: "count" }], top: 1 }).groups.length, 1);
});

test("aggregate helpers: buckets, keys, numbers", () => {
  assert.equal(bucket("2026-10-05", "week"), "2026-W41");
  assert.equal(bucket("2026-12-31", "quarter"), "2026-Q4");
  assert.equal(bucket("2027-01-01T10:00:00.000Z", "week"), "2026-W53");
  assert.deepEqual(groupKeys(undefined), ["(empty)"]);
  assert.equal(numericValue({ type: "formula", formula: { type: "number", number: 7 } } as never), 7);
});

test("csv: quotes, commas, newlines, BOM, and header checks", () => {
  const r = parseCsv('﻿Name,Notes,Points\r\n"Smith, J","said ""hi""\nthen left",3\n\nB,,4\n');
  assert.deepEqual(r, [
    { Name: "Smith, J", Notes: 'said "hi"\nthen left', Points: "3" },
    { Name: "B", Notes: "", Points: "4" },
  ]);
  assert.throws(() => parseCsv("A,A\n1,2"), /repeats/);
  assert.throws(() => parseCsv("A\n1,2"), /2 fields/);
  assert.throws(() => parseCsv('A\n"open'), /never closed/);
});

test("status groups are guessed from option names", () => {
  assert.equal(inferStatusGroup("Done"), "Complete");
  assert.equal(inferStatusGroup("At Risk"), "In progress");
  assert.equal(inferStatusGroup("In Progress"), "In progress");
  assert.equal(inferStatusGroup("Backlog"), "To-do");
});

test("propertyRequest: options with colors and groups, formats, rollups; misuse is rejected", async () => {
  const status = await propertyRequest({ name: "Status", type: "status", options: ["Todo", { name: "Done", group: "Complete", color: "green" }] }, null);
  assert.deepEqual(status, { type: "status", status: { options: [{ name: "Todo", color: "gray" }, { name: "Done", color: "green", group: "Complete" }] } });
  assert.deepEqual(await propertyRequest({ name: "Est", type: "number", number_format: "dollar", description: "Estimate" }, null), {
    type: "number", number: { format: "dollar" }, description: "Estimate",
  });
  assert.deepEqual(await propertyRequest({ name: "N", type: "rollup", rollup: { relation: "Rel", property: "Name", function: "count" } }, ds), {
    type: "rollup", rollup: { relation_property_name: "Rel", rollup_property_name: "Name", function: "count" },
  });
  await assert.rejects(propertyRequest({ name: "X", type: "text" as never, options: ["a"] } as PropertySpec, null));
  await assert.rejects(propertyRequest({ name: "X", type: "number", options: ["a"] }, null), /only applies to/);
  await assert.rejects(propertyRequest({ name: "X", type: "select", options: ["a", "A"] }, null), /twice/);
  await assert.rejects(propertyRequest({ name: "X", type: "formula" }, null), /needs `formula`/);
});

test("self relations and rollups over them wait for a second pass", () => {
  const specs: PropertySpec[] = [
    { name: "Parent", type: "relation", relation: { database: "self", two_way: false } },
    { name: "Parent count", type: "rollup", rollup: { relation: "Parent", property: "Name", function: "count" } },
    { name: "Est", type: "number" },
  ];
  assert.deepEqual(specs.map((s) => needsSecondPass(s, specs)), [true, true, false]);
});

test("configToRequest re-creates select, status (with groups), and rollups for undo", () => {
  const src = {
    ...ds,
    properties: {
      ...ds.properties,
      St: { id: "x", name: "St", type: "status", status: { options: [{ id: "1", name: "Done", color: "green" }], groups: [{ name: "Complete", option_ids: ["1"] }] } },
      Roll: { id: "y", name: "Roll", type: "rollup", rollup: { relation_property_id: "r", rollup_property_name: "Name", function: "count" } },
    },
  } as unknown as DataSourceObjectResponse;
  const props = src.properties as Record<string, never>;
  assert.deepEqual(configToRequest(src, props.St), { type: "status", status: { options: [{ name: "Done", color: "green", group: "Complete" }] } });
  assert.deepEqual(configToRequest(src, props.Roll), { type: "rollup", rollup: { relation_property_name: "Rel", rollup_property_name: "Name", function: "count" } });
  assert.equal(configToRequest(src, props.Name), null);
});
