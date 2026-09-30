// Offline checks for Phase 4: view requests, chart specs and rendering, chart data, Mermaid.
import { test } from "vitest";
import assert from "node:assert/strict";
import type { DataSourceObjectResponse, PageObjectResponse } from "@notionhq/client";
import { aggregation, groupByConfig, stripResponseOnly, viewRequest, describeView } from "../src/services/views.js";
import { foldSeries, PALETTE, renderChart, vegaLiteSpec } from "../src/services/charts.js";
import { pointsFromPages } from "../src/services/chartdata.js";
import { checkMermaid, ganttChart } from "../src/services/mermaid.js";
import { normalizeSpecs } from "../src/services/blocks.js";

const ds = {
  id: "ds",
  title: [],
  parent: { type: "database_id", database_id: "db" },
  properties: {
    Task: { id: "t", name: "Task", type: "title", title: {} },
    Status: { id: "s", name: "Status", type: "status", status: { options: [{ id: "1", name: "Done" }], groups: [] } },
    Owner: { id: "o", name: "Owner", type: "people", people: {} },
    Due: { id: "d", name: "Due", type: "date", date: {} },
    Est: { id: "e", name: "Est", type: "number", number: { format: "number" } },
    Where: { id: "w", name: "Where", type: "place", place: {} },
  },
} as unknown as DataSourceObjectResponse;

test("views: board, timeline, and chart requests use property ids", async () => {
  const board = await viewRequest(ds, { name: "Board", type: "board", group_by: "status" });
  assert.deepEqual(board, {
    name: "Board", type: "board",
    configuration: { type: "board", group_by: { type: "status", group_by: "option", property_id: "s", sort: { type: "manual" } } },
  });
  const tl = await viewRequest(ds, { name: "TL", type: "timeline", date: "Due", zoom: "week", sorts: [{ property: "due", direction: "ascending" }] });
  assert.deepEqual(tl, { name: "TL", type: "timeline", sorts: [{ property: "Due", direction: "ascending" }], configuration: { type: "timeline", date_property_id: "d", preference: { zoom_level: "week" } } });
  const chart = await viewRequest(ds, { name: "Per owner", type: "chart", chart: { type: "bar", x: "Owner", y: "sum:Est", stack_by: "Status", labels: true } });
  assert.deepEqual(chart.configuration, {
    type: "chart", chart_type: "bar",
    x_axis: { type: "person", property_id: "o", sort: { type: "manual" } },
    y_axis: { aggregator: "sum", property_id: "e" },
    stack_by: { type: "status", group_by: "option", property_id: "s", sort: { type: "manual" } },
    show_data_labels: true,
  });
  const num = await viewRequest(ds, { name: "Total", type: "chart", chart: { type: "number", y: "count" } });
  assert.deepEqual(num.configuration, { type: "chart", chart_type: "number", value: { aggregator: "count" } });
  const map = await viewRequest(ds, { name: "Map", type: "map", map_by: "Where" });
  assert.deepEqual(map.configuration, { type: "map", map_by: "w" });
});

test("views: misuse is explained", async () => {
  await assert.rejects(viewRequest(ds, { name: "B", type: "board" }), /needs `group_by`/);
  await assert.rejects(viewRequest(ds, { name: "C", type: "calendar", date: "Est" }), /isn't a date/);
  await assert.rejects(viewRequest(ds, { name: "X", type: "table", date: "Due" }), /only applies to calendar\/timeline/);
  await assert.rejects(viewRequest(ds, { name: "N", type: "chart", chart: { type: "number", x: "Owner", y: "count" } }), /no x axis/);
  assert.throws(() => groupByConfig(ds, { property: "Est", by: "week" }), /isn't a date/);
  assert.throws(() => aggregation(ds, "sum"), /needs a property/);
  assert.deepEqual(groupByConfig(ds, { property: "Due", by: "week" }), { type: "date", group_by: "week", property_id: "d", sort: { type: "ascending" } });
});

test("views: responses convert back to requests and to readable names", () => {
  const view = {
    id: "v", name: "B", type: "board", url: "u", filter: { property: "s", status: { equals: "Done" } }, sorts: null,
    configuration: { type: "board", group_by: { type: "status", property_id: "s", property_name: "Status", group_by: "option", sort: { type: "manual" } } },
  };
  assert.deepEqual(stripResponseOnly(view.configuration), { type: "board", group_by: { type: "status", property_id: "s", group_by: "option", sort: { type: "manual" } } });
  const d = describeView(ds, view);
  assert.deepEqual((d.configuration as { group_by: unknown }).group_by, { type: "status", property: "Status", group_by: "option", sort: { type: "manual" } });
  assert.deepEqual(d.filter, { property: "Status", status: { equals: "Done" } });
  // Data sources give encoded ids; views give them decoded.
  const encoded = { ...ds, properties: { ...ds.properties, Odd: { id: "%40C%3D", name: "Odd", type: "number", number: {} } } } as unknown as DataSourceObjectResponse;
  assert.deepEqual(describeView(encoded, { id: "v", name: "x", type: "table", filter: { property: "@C=", number: { equals: 1 } } }).filter, { property: "Odd", number: { equals: 1 } });
});

test("charts: series fold into Other past the palette; colors follow series order", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ x: "a", y: 10 - i, series: `s${i}` }));
  const folded = foldSeries(rows, 8);
  assert.equal(new Set(folded.rows.map((r) => r.series)).size, 8);
  assert.deepEqual(folded.folded, ["s7", "s8", "s9"]);
  const { spec, notes } = vegaLiteSpec({ type: "stacked_column", title: "T" }, rows);
  assert.match(notes[0], /combined into "Other"/);
  const color = (spec as unknown as { encoding: { color: { scale: { range: string[] } } } }).encoding.color;
  assert.deepEqual(color.scale.range, PALETTE);
});

test("charts: invalid data and chart misuse fail clearly", () => {
  assert.throws(() => vegaLiteSpec({ type: "bar" }, []), /no data/);
  assert.throws(() => vegaLiteSpec({ type: "pie" }, [{ x: "a", y: 1, series: "s" }, { x: "a", y: 1, series: "t" }]), /one series/);
  assert.throws(() => vegaLiteSpec({ type: "donut" }, [{ x: "a", y: -1 }]), /negative/);
  assert.throws(() => vegaLiteSpec({ type: "scatter" }, [{ x: "a", y: 1 }]), /numeric x/);
  assert.throws(() => vegaLiteSpec({ type: "bar" }, [{ x: "a", y: Number.NaN }]), /isn't a number/);
});

test("charts: every type renders to a PNG", { timeout: 30_000 }, async () => {
  const cats = [{ x: "A", y: 3 }, { x: "B", y: 5 }, { x: "C", y: 2 }];
  const multi = ["A", "B"].flatMap((x) => [{ x, y: 2, series: "s1" }, { x, y: 3, series: "s2" }]);
  const time = ["2026-09-01", "2026-09-08"].flatMap((x) => [{ x, y: 1, series: "a" }, { x, y: 2, series: "b" }]);
  const cases: [Parameters<typeof renderChart>[0]["type"], typeof cats][] = [
    ["bar", cats], ["column", cats], ["stacked_bar", multi], ["stacked_column", multi], ["grouped_column", multi],
    ["line", time], ["area", time], ["stacked_area", time], ["pie", cats], ["donut", cats],
    ["scatter", [{ x: 1, y: 2 }, { x: 2, y: 3 }] as never],
  ];
  for (const [type, rows] of cases) {
    const { png } = await renderChart({ type, title: type }, rows);
    assert.deepEqual([...png.slice(1, 4)], [0x50, 0x4e, 0x47], `${type} is not a PNG`);
    assert.ok(png.length > 2000, `${type} rendered almost nothing`);
  }
});

function page(props: Record<string, unknown>): PageObjectResponse {
  return {
    id: "p",
    properties: {
      Owner: { type: "people", people: (props.Owner as string[]).map((name) => ({ name, id: name })) },
      Status: { type: "status", status: { name: props.Status } },
      Est: { type: "number", number: props.Est },
      Due: { type: "date", date: { start: props.Due, end: null } },
    },
  } as unknown as PageObjectResponse;
}

test("chart points: grouping, series, metrics, empty groups, date order", () => {
  const pages = [
    page({ Owner: ["Ada"], Status: "Done", Est: 5, Due: "2026-10-12" }),
    page({ Owner: ["Ada", "Alan"], Status: "Todo", Est: 3, Due: "2026-09-02" }),
    page({ Owner: [], Status: "Todo", Est: 1, Due: "2026-09-30" }),
  ];
  assert.deepEqual(pointsFromPages(pages, { x: "Owner", metric: { op: "count" }, includeEmpty: false }), [{ x: "Ada", y: 2 }, { x: "Alan", y: 1 }]);
  assert.deepEqual(pointsFromPages(pages, { x: "Owner", series: "Status", metric: { op: "sum", property: "Est" }, includeEmpty: true }), [
    { x: "Ada", y: 5, series: "Done" }, { x: "Ada", y: 3, series: "Todo" }, { x: "Alan", y: 3, series: "Todo" }, { x: "(empty)", y: 1, series: "Todo" },
  ]);
  assert.deepEqual(pointsFromPages(pages, { x: "Due", by: "month", metric: { op: "count" }, includeEmpty: false }).map((p) => p.x), ["2026-09", "2026-10"]);
  assert.equal(pointsFromPages(pages, { x: "Owner", metric: { op: "count" }, includeEmpty: false, top: 1 }).length, 1);
});

test("mermaid: gantt builder escapes names and marks status; checker catches common mistakes", () => {
  const g = ganttChart("Plan: Q4", [
    { name: "Design: v2", start: "2026-10-01", end: "2026-10-05", section: "Ada", status: "done" },
    { name: "Build #1", start: "2026-10-06", section: "Ada", status: "crit" },
  ]);
  assert.equal(g, [
    "gantt", "    title Plan Q4", "    dateFormat YYYY-MM-DD", "    axisFormat %b %d", "    section Ada",
    "    Design v2 :done, t1, 2026-10-01, 2026-10-05", "    Build 1 :crit, t2, 2026-10-06, 1d",
  ].join("\n"));
  checkMermaid(g);
  checkMermaid("flowchart TD\n  A[Start] --> B{Ok?}");
  assert.throws(() => checkMermaid("A --> B"), /start with a type/);
  assert.throws(() => checkMermaid("flowchart TD\n  A[Start --> B"), /unbalanced/);
  assert.throws(() => checkMermaid("gantt\n  title x"), /no tasks/);
  assert.throws(() => normalizeSpecs([{ type: "code", language: "mermaid", text: "nonsense" }]), /start with a type/);
});
