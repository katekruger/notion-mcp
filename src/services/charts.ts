// Chart images: data → Vega-Lite → SVG → PNG, styled to one validated palette so every chart reads as one system.
// Colors are the reference categorical palette (light mode; Notion pages show images as-is in either theme),
// assigned in fixed slot order and folded into "Other" past eight series.
import * as vega from "vega";
import * as vl from "vega-lite";
import { Resvg } from "@resvg/resvg-js";

export const CHART_TYPES = [
  "bar", "column", "stacked_bar", "stacked_column", "grouped_column", "line", "area", "stacked_area", "pie", "donut", "scatter",
] as const;
export type ChartType = (typeof CHART_TYPES)[number];

/** Validated categorical order (see the dataviz reference palette); order is the CVD-safety mechanism. */
export const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
const SURFACE = "#ffffff";
const TEXT = "#0b0b0b";
const TEXT_2 = "#52514e";
const GRID = "#e8e7e3";
const FONT = "Inter, -apple-system, Segoe UI, Helvetica, Arial, DejaVu Sans, sans-serif";
/** Scatter/bubble colors must stay distinguishable across every pair; only the first three slots are. */
const MAX_SCATTER_SERIES = 3;
const MAX_SERIES = PALETTE.length;

export interface ChartRow {
  x: string | number;
  y: number;
  series?: string;
}

export interface ChartSpec {
  type: ChartType;
  title?: string;
  subtitle?: string;
  x_label?: string;
  y_label?: string;
  /** "number" (1,234), "percent" (0.12 → 12%), "currency" ($1,234), or a d3-format string. */
  value_format?: string;
  width?: number;
  height?: number;
  /** Sort categories by value (descending) instead of input order. Ignored for time series. */
  sort_by_value?: boolean;
}

function d3Format(f: string | undefined): string {
  if (!f || f === "number") return ",.4~g";
  if (f === "percent") return ".0%";
  if (f === "currency") return "$,.0f";
  return f;
}

/** Fold series past the palette's capacity into "Other", keeping the largest by total. */
export function foldSeries(rows: ChartRow[], max: number): { rows: ChartRow[]; folded: string[] } {
  const totals = new Map<string, number>();
  for (const r of rows) if (r.series !== undefined) totals.set(r.series, (totals.get(r.series) ?? 0) + Math.abs(r.y));
  if (totals.size <= max) return { rows, folded: [] };
  const keep = new Set([...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, max - 1).map(([s]) => s));
  const folded = [...totals.keys()].filter((s) => !keep.has(s));
  const merged = new Map<string, ChartRow>();
  for (const r of rows) {
    const series = r.series !== undefined && !keep.has(r.series) ? "Other" : r.series;
    const key = `${r.x}\u0000${series}`;
    const m = merged.get(key);
    if (m) m.y += r.y;
    else merged.set(key, { ...r, series });
  }
  return { rows: [...merged.values()], folded };
}

function isTemporal(rows: ChartRow[]): boolean {
  return rows.length > 0 && rows.every((r) => typeof r.x === "string" && /^\d{4}-\d{2}(-\d{2})?/.test(r.x));
}

/** Series in first-seen order, so a series keeps its color whatever the values do. */
function seriesOrder(rows: ChartRow[]): string[] {
  return [...new Set(rows.flatMap((r) => (r.series === undefined ? [] : [r.series])))];
}

export function checkChart(spec: ChartSpec, rows: ChartRow[]): string[] {
  const notes: string[] = [];
  if (rows.length === 0) throw new Error("The chart has no data.");
  if (rows.length > 5000) throw new Error(`${rows.length} data points is too many for one chart; aggregate first (notion_aggregate).`);
  for (const r of rows) if (typeof r.y !== "number" || !Number.isFinite(r.y)) throw new Error(`Value for "${r.x}" isn't a number.`);
  const multi = seriesOrder(rows).length > 1;
  if ((spec.type === "pie" || spec.type === "donut") && multi) throw new Error("Pie and donut charts take one series; use stacked_column for several.");
  if ((spec.type === "pie" || spec.type === "donut") && rows.some((r) => r.y < 0)) throw new Error("Pie and donut charts can't show negative values.");
  if ((spec.type === "pie" || spec.type === "donut") && new Set(rows.map((r) => r.x)).size > 6) {
    notes.push("More than 6 slices are hard to compare; a bar chart would read better.");
  }
  return notes;
}

/** Build the Vega-Lite spec. Pure, so it can be unit-tested. */
export function vegaLiteSpec(spec: ChartSpec, input: ChartRow[]): { spec: vl.TopLevelSpec; notes: string[] } {
  const notes = checkChart(spec, input);
  const cap = spec.type === "scatter" ? MAX_SCATTER_SERIES : MAX_SERIES;
  const { rows, folded } = foldSeries(input, cap);
  if (folded.length) notes.push(`${folded.length} smaller series were combined into "Other" (${folded.slice(0, 5).join(", ")}${folded.length > 5 ? ", …" : ""}).`);
  const series = seriesOrder(rows);
  const multi = series.length > 1;
  const temporal = isTemporal(rows) && ["line", "area", "stacked_area", "column", "stacked_column", "grouped_column"].includes(spec.type);
  const fmt = d3Format(spec.value_format);
  const width = spec.width ?? 640;
  const height = spec.height ?? 360;
  const color = multi
    ? { field: "series", type: "nominal" as const, scale: { domain: series, range: PALETTE.slice(0, series.length) }, legend: { title: null, orient: "top" as const, direction: "horizontal" as const } }
    : { value: PALETTE[0] };
  const xOrder = [...new Set(rows.map((r) => String(r.x)))];
  const catSort = spec.sort_by_value ? "-y" : xOrder;

  const base = {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    width,
    height,
    background: SURFACE,
    padding: 16,
    // `si` keeps stacks in legend order (first series at the baseline) instead of alphabetical.
    data: { values: rows.map((r) => ({ ...r, x: typeof r.x === "number" ? r.x : String(r.x), si: r.series === undefined ? 0 : series.indexOf(r.series) })) },
    ...(spec.title ? { title: { text: spec.title, ...(spec.subtitle ? { subtitle: spec.subtitle } : {}) } } : {}),
    config: {
      font: FONT,
      view: { stroke: null },
      title: { anchor: "start", fontSize: 16, fontWeight: 600, color: TEXT, subtitleColor: TEXT_2, subtitleFontSize: 12, offset: 12 },
      axis: {
        labelColor: TEXT_2, titleColor: TEXT_2, labelFontSize: 11, titleFontSize: 11, titleFontWeight: 500,
        gridColor: GRID, domainColor: GRID, tickColor: GRID, labelPadding: 6,
      },
      axisX: { grid: false },
      legend: { labelColor: TEXT_2, labelFontSize: 11, symbolType: "circle", symbolSize: 80 },
      bar: { cornerRadiusEnd: 4, discreteBandSize: 24, stroke: SURFACE, strokeWidth: 2 },
      line: { strokeWidth: 2, strokeCap: "round", strokeJoin: "round" },
      point: { size: 80, filled: true, stroke: SURFACE, strokeWidth: 2 },
      arc: { stroke: SURFACE, strokeWidth: 2 },
      text: { color: TEXT_2, fontSize: 11 },
    },
  };

  const yAxis = { title: spec.y_label ?? null, format: fmt, tickCount: 5 };
  const xAxis = { title: spec.x_label ?? null, labelAngle: 0, labelLimit: 120 };
  const horizontal = spec.type === "bar" || spec.type === "stacked_bar";
  const valueLabels = !multi && rows.length <= 16;

  let out: Record<string, unknown>;
  switch (spec.type) {
    case "bar":
    case "column":
    case "stacked_bar":
    case "stacked_column":
    case "grouped_column": {
      const stacked = spec.type.startsWith("stacked");
      const cat = temporal
        ? { field: "x", type: "temporal" as const, timeUnit: "yearmonthdate" as const, axis: { ...xAxis, format: "%b %d" } }
        : { field: "x", type: "nominal" as const, sort: catSort, axis: horizontal ? { title: spec.x_label ?? null, labelLimit: 160 } : xAxis };
      const val = { field: "y", type: "quantitative" as const, axis: { ...yAxis, ...(horizontal ? { grid: true } : {}) }, ...(stacked ? { stack: "zero" as const } : { stack: null }) };
      const enc: Record<string, unknown> = horizontal ? { y: cat, x: val } : { x: cat, y: val };
      enc.color = color;
      if (spec.type === "grouped_column" && multi) enc.xOffset = { field: "series", sort: series };
      if (multi) enc.order = { field: "si", type: "quantitative", sort: "ascending" };
      const bar = { mark: { type: "bar" }, encoding: enc };
      out = valueLabels
        ? {
            ...base,
            layer: [
              bar,
              {
                mark: horizontal ? { type: "text", align: "left", dx: 4 } : { type: "text", baseline: "bottom", dy: -4 },
                encoding: { ...(horizontal ? { y: cat, x: val } : { x: cat, y: val }), text: { field: "y", format: fmt } },
              },
            ],
          }
        : { ...base, ...bar };
      break;
    }
    case "line":
    case "area":
    case "stacked_area": {
      const x = temporal
        ? { field: "x", type: "temporal" as const, axis: { ...xAxis, format: "%b %d" } }
        : typeof rows[0].x === "number"
          ? { field: "x", type: "quantitative" as const, axis: xAxis }
          : { field: "x", type: "ordinal" as const, sort: xOrder, axis: xAxis };
      const y = { field: "y", type: "quantitative" as const, axis: yAxis, ...(spec.type === "stacked_area" ? { stack: "zero" as const } : { stack: null }) };
      const mark =
        spec.type === "line"
          ? { type: "line", point: rows.length <= 40 }
          : { type: "area", line: { strokeWidth: 2 }, opacity: spec.type === "stacked_area" ? 0.85 : 0.25 };
      out = { ...base, mark, encoding: { x, y, color, ...(multi ? { detail: { field: "series" } } : {}) } };
      break;
    }
    case "pie":
    case "donut": {
      const cats = xOrder;
      out = {
        ...base,
        width: Math.min(width, height),
        height: Math.min(width, height),
        encoding: {
          theta: { field: "y", type: "quantitative", stack: true },
          color: { field: "x", type: "nominal", sort: cats, scale: { domain: cats, range: PALETTE.slice(0, Math.min(cats.length, MAX_SERIES)) }, legend: { title: null, orient: "right" } },
          order: { field: "y", type: "quantitative", sort: "descending" },
        },
        layer: [
          { mark: { type: "arc", ...(spec.type === "donut" ? { innerRadius: Math.min(width, height) * 0.22 } : {}), outerRadius: Math.min(width, height) * 0.4 } },
          {
            // Labels wear the text color; the slice beside them carries identity.
            mark: { type: "text", radius: Math.min(width, height) * 0.46, fontSize: 11, color: TEXT_2 },
            encoding: { text: { field: "y", type: "quantitative", format: fmt }, color: { value: TEXT_2 } },
          },
        ],
      };
      if (cats.length > MAX_SERIES) notes.push(`Only the first ${MAX_SERIES} slices get distinct colors; group the rest into "Other" first.`);
      break;
    }
    case "scatter": {
      const numericX = rows.every((r) => typeof r.x === "number");
      if (!numericX) throw new Error("Scatter charts need numeric x values.");
      out = {
        ...base,
        mark: { type: "point", opacity: 1 },
        encoding: {
          x: { field: "x", type: "quantitative", axis: { ...xAxis, grid: true }, scale: { zero: false } },
          y: { field: "y", type: "quantitative", axis: yAxis, scale: { zero: false } },
          color,
        },
      };
      break;
    }
  }
  return { spec: out as unknown as vl.TopLevelSpec, notes };
}

/** Render a Vega-Lite spec to PNG at 2x for crisp display. */
export async function renderPng(spec: vl.TopLevelSpec): Promise<Uint8Array> {
  const compiled = vl.compile(spec).spec;
  const view = new vega.View(vega.parse(compiled), { renderer: "none" });
  const svg = await view.toSVG();
  view.finalize();
  const resvg = new Resvg(svg, {
    background: SURFACE,
    fitTo: { mode: "zoom", value: 2 },
    font: { loadSystemFonts: true, defaultFontFamily: "DejaVu Sans" },
  });
  return new Uint8Array(resvg.render().asPng());
}

export async function renderChart(spec: ChartSpec, rows: ChartRow[]): Promise<{ png: Uint8Array; notes: string[] }> {
  const built = vegaLiteSpec(spec, rows);
  return { png: await renderPng(built.spec), notes: built.notes };
}
