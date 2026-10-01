// The extended chart catalog: every type compiles and renders, reference lines layer correctly, palettes and raw
// Vega-Lite specs are checked, and charts describe themselves for alt text. SVG output is snapshotted (text, so the
// comparison is the same on every platform).
import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { circleLayout, sankeyLayout } from "../src/services/graphlayout.js";
import { CHART_DATA_SHAPES, checkCustomSpec, describeChart, renderChart, renderSvg, resolvePalette, vegaLiteSpec, type ChartRow, type ChartType } from "../src/services/charts.js";

const cats = ["Q1", "Q2", "Q3", "Q4"];
const SAMPLES: Record<string, ChartRow[]> = {
  histogram: Array.from({ length: 60 }, (_, i) => ({ x: i, y: (i * 37) % 50 })),
  heatmap: ["Mon", "Tue"].flatMap((d) => cats.map((c, i) => ({ x: c, y: i + d.length, series: d }))),
  boxplot: ["A", "B"].flatMap((g, j) => Array.from({ length: 20 }, (_, i) => ({ x: g, y: ((i * 7) % 13) + j * 4 }))),
  waterfall: [{ x: "Start", y: 100 }, { x: "Up", y: 40 }, { x: "Down", y: -15 }, { x: "End", y: 0, series: "total" }],
  funnel: [{ x: "Visit", y: 1000 }, { x: "Signup", y: 400 }, { x: "Paid", y: 50 }],
  bullet: [{ x: "Revenue", y: 70, series: "actual" }, { x: "Revenue", y: 80, series: "target" }],
  small_multiples: ["East", "West"].flatMap((r, j) => cats.map((c, i) => ({ x: c, y: i * j + 1, series: r }))),
  dual_axis: cats.flatMap((c, i) => [{ x: c, y: 100 + i, series: "Revenue" }, { x: c, y: 0.1 * i, series: "Margin" }]),
  treemap: [{ x: "Docs", y: 40, series: "Eng" }, { x: "Ads", y: 25, series: "Mktg" }, { x: "API", y: 30, series: "Eng" }],
  sankey: [{ x: "Visit", y: 100, series: "Signup" }, { x: "Visit", y: 300, series: "Leave" }, { x: "Signup", y: 40, series: "Paid" }, { x: "Signup", y: 60, series: "Leave" }],
  network: [{ x: "Ana", y: 3, series: "Kim" }, { x: "Kim", y: 1, series: "Lee" }, { x: "Lee", y: 2, series: "Ana" }],
};

test("every new chart type compiles and renders to SVG", async () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), Object.keys(CHART_DATA_SHAPES).sort());
  for (const [type, rows] of Object.entries(SAMPLES)) {
    const built = vegaLiteSpec({ type: type as ChartType, title: type }, rows);
    const svg = await renderSvg(built.spec, built.engine ?? "vega-lite");
    assert.match(svg, /^<svg/, type);
    assert.ok(svg.includes(type), `${type}: title missing from the SVG`);
  }
}, 60_000);

test("SVG snapshots stay stable", async () => {
  for (const type of ["waterfall", "funnel", "treemap", "sankey", "network"] as const) {
    const built = vegaLiteSpec({ type, title: type }, SAMPLES[type]);
    expect(await renderSvg(built.spec, built.engine ?? "vega-lite")).toMatchSnapshot(type);
  }
}, 60_000);

test("type requirements fail with the data shape in the message", () => {
  assert.throws(() => vegaLiteSpec({ type: "heatmap" }, [{ x: "a", y: 1 }]), /series on every row/);
  assert.throws(() => vegaLiteSpec({ type: "dual_axis" }, [{ x: "a", y: 1, series: "s" }]), /exactly two series/);
  assert.throws(() => vegaLiteSpec({ type: "bullet" }, [{ x: "a", y: 1 }]), /target rows/);
  assert.throws(() => vegaLiteSpec({ type: "funnel" }, [{ x: "a", y: -1 }]), /negative/);
  assert.throws(() => vegaLiteSpec({ type: "sankey" }, [{ x: "a", y: 1 }]), /series on every row/);
  assert.throws(() => vegaLiteSpec({ type: "network" }, [{ x: "a", y: 0, series: "b" }]), /positive/);
  assert.throws(() => vegaLiteSpec({ type: "sankey" }, [{ x: "a", y: 1, series: "b" }, { x: "b", y: 1, series: "a" }]), /loop back/);
  assert.throws(() => vegaLiteSpec({ type: "sankey" }, [{ x: "a", y: 1, series: "a" }]), /into itself/);
});

test("Sankey layout: columns by depth, sinks last, flow conserved, ribbons stacked without overlap", () => {
  const { nodes, links } = sankeyLayout(
    [
      { from: "Visit", to: "Signup", value: 100 },
      { from: "Visit", to: "Leave", value: 300 },
      { from: "Signup", to: "Paid", value: 40 },
      { from: "Signup", to: "Leave", value: 60 },
      { from: "Visit", to: "Signup", value: 0 }, // merged into the first
    ],
    400,
    200
  );
  const at = Object.fromEntries(nodes.map((n) => [n.name, n]));
  assert.deepEqual([at.Visit.column, at.Signup.column, at.Paid.column, at.Leave.column], [0, 1, 2, 2]);
  assert.equal(at.Leave.value, 360);
  assert.equal(at.Visit.value, 400);
  assert.equal(links.length, 4);
  // Heights are proportional to value on one shared scale.
  const k = (at.Visit.y1 - at.Visit.y0) / 400;
  for (const n of nodes) assert.ok(Math.abs(n.y1 - n.y0 - n.value * k) < 1e-6, n.name);
  // Nothing leaves the drawing area, and nodes in a column don't overlap.
  for (const n of nodes) assert.ok(n.y0 >= -1e-6 && n.y1 <= 200 + 1e-6 && n.x1 <= 400 + 1e-6, n.name);
  const col2 = nodes.filter((n) => n.column === 2).sort((a, b) => a.y0 - b.y0);
  assert.ok(col2[0].y1 <= col2[1].y0);
  // Same input, same picture.
  assert.deepEqual(sankeyLayout([{ from: "a", to: "b", value: 1 }], 100, 50), sankeyLayout([{ from: "a", to: "b", value: 1 }], 100, 50));
  assert.throws(() => sankeyLayout(Array.from({ length: 61 }, (_, i) => ({ from: `n${i}`, to: `m${i}`, value: 1 })), 100, 100), /too many/);
});

test("network layout: nodes on a circle inside the canvas, degree is total weight", () => {
  const { nodes, edges } = circleLayout([{ from: "a", to: "b", value: 2 }, { from: "b", to: "c", value: 1 }], 400, 300);
  assert.equal(nodes.length, 3);
  assert.deepEqual(nodes.map((n) => n.degree), [2, 3, 1]);
  const r = nodes.map((n) => Math.hypot(n.x - 200, n.y - 150));
  for (const d of r) assert.ok(Math.abs(d - r[0]) < 0.05);
  for (const n of nodes) assert.ok(n.x > 0 && n.x < 400 && n.y > 0 && n.y < 300);
  assert.equal(nodes[0].y < 150, true); // starts at the top
  assert.deepEqual([edges[0].x1, edges[0].y1], [nodes[0].x, nodes[0].y]);
});

test("annotations add labeled reference layers; skipped where they'd mislead", () => {
  const rows = cats.map((c, i) => ({ x: c, y: i }));
  const out = vegaLiteSpec({ type: "line", annotations: [{ at: "Q2", label: "Launch" }, { value: 2, label: "Target" }] }, rows).spec as unknown as { layer: unknown[] };
  assert.equal(out.layer.length, 5, "the line plus a rule and a label per annotation");
  const dual = vegaLiteSpec({ type: "dual_axis", annotations: [{ value: 1, label: "x" }] }, SAMPLES.dual_axis);
  assert.ok(dual.notes.some((n) => /Value lines aren't drawn/.test(n)));
});

test("palettes: named, custom, and invalid", () => {
  assert.equal(resolvePalette("warm")[0], "#eb6834");
  assert.deepEqual(resolvePalette(["#111111", "#222222"]), ["#111111", "#222222"]);
  assert.throws(() => resolvePalette("neon"), /Unknown palette/);
  assert.throws(() => resolvePalette(["red", "blue"]), /hex color/);
  const spec = vegaLiteSpec({ type: "column", palette: ["#111111", "#222222"] }, [{ x: "a", y: 1 }]).spec as unknown as { layer: { encoding: { color: { value: string } } }[] };
  assert.equal(spec.layer[0].encoding.color.value, "#111111");
});

test("raw Vega-Lite: inline data only, no links or images, bounded size; house theme applied", () => {
  assert.throws(() => checkCustomSpec({ data: { url: "https://example.com/x.csv" }, mark: "bar" }), /can't load or link/);
  assert.throws(() => checkCustomSpec({ data: { values: [] }, mark: "image" }), /image marks/);
  assert.throws(() => checkCustomSpec({ data: { values: [] }, mark: "point", encoding: { href: { field: "u" } } }), /can't load or link/);
  assert.throws(() => checkCustomSpec({ data: { values: Array.from({ length: 5001 }, () => ({ a: 1 })) }, mark: "point" }), /too many|bytes/);
  assert.throws(() => checkCustomSpec({ data: { values: [] }, mark: "point", width: 5000 }), /width/);
  const ok = checkCustomSpec({ data: { values: [{ a: 1 }] }, mark: "point" }, "dark") as unknown as { background: string; config: { font: string } };
  assert.equal(ok.background, "#191919");
  assert.match(ok.config.font, /Inter/);
});

test("raw Vega-Lite takes the requested theme where it sets no colors of its own", () => {
  const spec = { mark: "bar", data: { values: [{ a: 1 }] }, encoding: { x: { field: "a", type: "quantitative" } } };
  assert.equal((checkCustomSpec(spec, "dark") as { background: string }).background, "#191919");
  assert.equal((checkCustomSpec(spec, "transparent") as { background: string }).background, "transparent");
  assert.equal((checkCustomSpec({ ...spec, background: "#fff000" }, "dark") as { background: string }).background, "#fff000");
});

test("charts describe themselves for alt text and data tables", async () => {
  assert.match(describeChart({ type: "column", title: "Sales" }, [{ x: "A", y: 5 }, { x: "B", y: 2 }]), /Column chart "Sales": 2 categories\. Highest: A \(5\); lowest: B \(2\); total 7\./);
  assert.match(describeChart({ type: "waterfall" }, SAMPLES.waterfall), /2 increases and 1 decreases, ending at 125/);
  assert.match(describeChart({ type: "histogram" }, SAMPLES.histogram), /of 60 values/);
  assert.match(describeChart({ type: "sankey" }, SAMPLES.sankey), /Sankey chart: 4 flows between 4 stages, 500 in all\. Largest: Visit to Leave \(300\)/);
  assert.match(describeChart({ type: "network" }, SAMPLES.network), /3 nodes and 3 links\. Strongest: Ana and Kim \(3\)/);
  const r = await renderChart({ type: "funnel", title: "F" }, SAMPLES.funnel, "svg");
  assert.equal(r.format, "svg");
  assert.match(r.alt, /3 stages from Visit \(1,000\) to Paid \(50\), 5% of the first/);
}, 30_000);
