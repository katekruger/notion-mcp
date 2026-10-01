// The extended chart catalog: every type compiles and renders, reference lines layer correctly, palettes and raw
// Vega-Lite specs are checked, and charts describe themselves for alt text. SVG output is snapshotted (text, so the
// comparison is the same on every platform).
import { test, expect } from "vitest";
import assert from "node:assert/strict";
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
  for (const type of ["waterfall", "funnel", "treemap"] as const) {
    const built = vegaLiteSpec({ type, title: type }, SAMPLES[type]);
    expect(await renderSvg(built.spec, built.engine ?? "vega-lite")).toMatchSnapshot(type);
  }
}, 60_000);

test("type requirements fail with the data shape in the message", () => {
  assert.throws(() => vegaLiteSpec({ type: "heatmap" }, [{ x: "a", y: 1 }]), /series on every row/);
  assert.throws(() => vegaLiteSpec({ type: "dual_axis" }, [{ x: "a", y: 1, series: "s" }]), /exactly two series/);
  assert.throws(() => vegaLiteSpec({ type: "bullet" }, [{ x: "a", y: 1 }]), /target rows/);
  assert.throws(() => vegaLiteSpec({ type: "funnel" }, [{ x: "a", y: -1 }]), /negative/);
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

test("charts describe themselves for alt text and data tables", async () => {
  assert.match(describeChart({ type: "column", title: "Sales" }, [{ x: "A", y: 5 }, { x: "B", y: 2 }]), /Column chart "Sales": 2 categories\. Highest: A \(5\); lowest: B \(2\); total 7\./);
  assert.match(describeChart({ type: "waterfall" }, SAMPLES.waterfall), /2 increases and 1 decreases, ending at 125/);
  assert.match(describeChart({ type: "histogram" }, SAMPLES.histogram), /of 60 values/);
  const r = await renderChart({ type: "funnel", title: "F" }, SAMPLES.funnel, "svg");
  assert.equal(r.format, "svg");
  assert.match(r.alt, /3 stages from Visit \(1,000\) to Paid \(50\), 5% of the first/);
}, 30_000);
