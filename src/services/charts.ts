// Chart images: data → Vega-Lite → SVG → PNG, styled to one validated palette so every chart reads as one system.
// Colors are the reference categorical palette, assigned in fixed slot order and folded into "Other" past eight
// series. Notion shows images as-is in either theme (a page can't swap images by theme), so `theme` picks the
// surface: light, Notion's dark background, or transparent with mid-gray text that reads on both.
// Rendering libraries load on first use: resvg ships a native binary per platform, so a bundle built for another
// platform still starts and serves every other tool, and only chart images report the problem.
import type * as vl from "vega-lite";

export const CHART_TYPES = [
  "bar", "column", "stacked_bar", "stacked_column", "grouped_column", "line", "area", "stacked_area", "pie", "donut", "scatter",
  "histogram", "heatmap", "boxplot", "waterfall", "funnel", "bullet", "small_multiples", "dual_axis", "treemap",
] as const;

/**
 * What each type expects from rows ({x, y, series?}), for tool descriptions and errors.
 */
export const CHART_DATA_SHAPES: Partial<Record<(typeof CHART_TYPES)[number], string>> = {
  histogram: "one row per observation; y is the value (x is ignored). `bins` sets the number of bins.",
  heatmap: "x = column, series = row, y = the cell's value.",
  boxplot: "one row per observation; x = group, y = value.",
  waterfall: 'rows in order; y = change. A row with series "total" shows the running total instead.',
  funnel: "rows in stage order; y = how many reached the stage.",
  bullet: 'per x: a row with series "actual" (or none) and a row with series "target".',
  small_multiples: "x and y as for a line chart; one small panel per series.",
  dual_axis: "exactly two series: the first as columns (left axis), the second as a line (right axis).",
  treemap: "x = item, y = size; optional series groups items (one color per group).",
};

/** Named palettes: the default validated order plus brand-neutral alternatives. Each keeps 8 distinct slots. */
export const PALETTES: Record<string, string[]> = {
  default: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  cool: ["#2a78d6", "#1baf7a", "#4a3aa7", "#0b8fa3", "#7a9cc6", "#008300", "#8a5fc7", "#5b6b7f"],
  warm: ["#eb6834", "#eda100", "#e34948", "#b5562b", "#e87ba4", "#9c6b00", "#c23b6b", "#7f4a2a"],
  mono: ["#1f3b63", "#2a78d6", "#6aa0e0", "#a7c6ee", "#0d1f36", "#4d8ad9", "#88b4ea", "#c9dcf5"],
};
export type ChartType = (typeof CHART_TYPES)[number];

/** Validated categorical order (see the dataviz reference palette); order is the CVD-safety mechanism. */
export const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
export const CHART_THEMES = ["light", "dark", "transparent"] as const;
export type ChartTheme = (typeof CHART_THEMES)[number];
interface Theme {
  /** null leaves the image transparent. */
  surface: string | null;
  text: string;
  text2: string;
  grid: string;
}
const THEMES: Record<ChartTheme, Theme> = {
  light: { surface: "#ffffff", text: "#0b0b0b", text2: "#52514e", grid: "#e8e7e3" },
  // Notion's dark page background, so the image sits flush on dark pages.
  dark: { surface: "#191919", text: "#f0efed", text2: "#a5a4a0", grid: "#373735" },
  // Mid-gray clears 4:1 contrast on both white and Notion's dark background.
  transparent: { surface: null, text: "#7f7e7a", text2: "#7f7e7a", grid: "rgba(127,126,122,0.3)" },
};
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
  /** Image surface; default light. */
  theme?: ChartTheme;
  /** A named palette (default, cool, warm, mono) or your own colors (hex, in slot order). */
  palette?: string | string[];
  /** histogram: number of bins (default 20). */
  bins?: number;
  /** Reference lines: `at` marks a category or x value, `value` marks a level on the value axis. */
  annotations?: { at?: string | number; value?: number; label: string }[];
}

/** Resolve a palette option to colors, checking custom ones. */
export function resolvePalette(p: ChartSpec["palette"]): string[] {
  if (p === undefined) return PALETTES.default;
  if (typeof p === "string") {
    const named = PALETTES[p];
    if (!named) throw new Error(`Unknown palette "${p}". Use ${Object.keys(PALETTES).join(", ")}, or a list of hex colors.`);
    return named;
  }
  if (p.length < 2) throw new Error("A custom palette needs at least 2 colors.");
  for (const c of p) if (!/^#[0-9a-f]{6}$/i.test(c)) throw new Error(`"${c}" isn't a 6-digit hex color like #2a78d6.`);
  return p;
}

/** Relative luminance, for picking readable text on a fill. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function inkOn(hex: string): string {
  return luminance(hex) > 0.35 ? "#0b0b0b" : "#ffffff";
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
  const series = seriesOrder(rows);
  if (spec.type === "heatmap" && !series.length) throw new Error(`Heatmaps need a series on every row (${CHART_DATA_SHAPES.heatmap})`);
  if (spec.type === "dual_axis" && series.length !== 2) throw new Error(`Dual-axis charts need exactly two series; got ${series.length}.`);
  if (spec.type === "small_multiples" && series.length < 2) throw new Error("Small multiples need at least two series (one panel each).");
  if (spec.type === "bullet" && !rows.some((r) => r.series === "target")) throw new Error(`Bullet charts need target rows (${CHART_DATA_SHAPES.bullet})`);
  if ((spec.type === "funnel" || spec.type === "treemap") && rows.some((r) => r.y < 0)) throw new Error(`${spec.type} charts can't show negative values.`);
  if (spec.type === "small_multiples" && series.length > 12) notes.push("More than 12 panels get small; consider filtering to the ones that matter.");
  if (spec.annotations?.length && ["pie", "donut", "treemap", "heatmap", "funnel", "small_multiples"].includes(spec.type)) {
    notes.push(`Annotations aren't drawn on ${spec.type} charts.`);
  }
  if (spec.type === "dual_axis" && spec.annotations?.some((a) => a.value !== undefined)) {
    notes.push("Value lines aren't drawn on dual-axis charts (which axis would they mean?); `at` markers are.");
  }
  return notes;
}

/** Build the Vega-Lite spec. Pure, so it can be unit-tested. */
export function vegaLiteSpec(spec: ChartSpec, input: ChartRow[]): { spec: vl.TopLevelSpec; notes: string[]; engine?: "vega" } {
  const notes = checkChart(spec, input);
  const cap = spec.type === "scatter" ? MAX_SCATTER_SERIES : MAX_SERIES;
  const { rows, folded } = foldSeries(input, cap);
  if (folded.length) notes.push(`${folded.length} smaller series were combined into "Other" (${folded.slice(0, 5).join(", ")}${folded.length > 5 ? ", …" : ""}).`);
  const series = seriesOrder(rows);
  const pal = resolvePalette(spec.palette);
  const multi = series.length > 1;
  const temporal = isTemporal(rows) && ["line", "area", "stacked_area", "column", "stacked_column", "grouped_column", "small_multiples", "dual_axis"].includes(spec.type);
  const fmt = d3Format(spec.value_format);
  const th = THEMES[spec.theme ?? "light"];
  // Separators between bars and slices are drawn in the surface color; with no surface there are none.
  const sep = th.surface ? { stroke: th.surface, strokeWidth: 2 } : { strokeWidth: 0 };
  const width = spec.width ?? 640;
  const height = spec.height ?? 360;
  const color = multi
    ? { field: "series", type: "nominal" as const, scale: { domain: series, range: pal.slice(0, series.length) }, legend: { title: null, orient: "top" as const, direction: "horizontal" as const } }
    : { value: pal[0] };
  const xOrder = [...new Set(rows.map((r) => String(r.x)))];
  const catSort = spec.sort_by_value ? "-y" : xOrder;

  const base = {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    width,
    height,
    background: th.surface ?? "transparent",
    padding: 16,
    // `si` keeps stacks in legend order (first series at the baseline) instead of alphabetical.
    data: { values: rows.map((r) => ({ ...r, x: typeof r.x === "number" ? r.x : String(r.x), si: r.series === undefined ? 0 : series.indexOf(r.series) })) },
    ...(spec.title ? { title: { text: spec.title, ...(spec.subtitle ? { subtitle: spec.subtitle } : {}) } } : {}),
    config: {
      font: FONT,
      view: { stroke: null },
      title: { anchor: "start", fontSize: 16, fontWeight: 600, color: th.text, subtitleColor: th.text2, subtitleFontSize: 12, offset: 12 },
      axis: {
        labelColor: th.text2, titleColor: th.text2, labelFontSize: 11, titleFontSize: 11, titleFontWeight: 500,
        gridColor: th.grid, domainColor: th.grid, tickColor: th.grid, labelPadding: 6,
      },
      axisX: { grid: false },
      legend: { labelColor: th.text2, labelFontSize: 11, symbolType: "circle", symbolSize: 80 },
      bar: { cornerRadiusEnd: 4, discreteBandSize: 24, ...sep },
      line: { strokeWidth: 2, strokeCap: "round", strokeJoin: "round" },
      point: { size: 80, filled: true, ...sep },
      arc: { ...sep },
      text: { color: th.text2, fontSize: 11 },
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
          color: { field: "x", type: "nominal", sort: cats, scale: { domain: cats, range: pal.slice(0, Math.min(cats.length, MAX_SERIES)) }, legend: { title: null, orient: "right" } },
          order: { field: "y", type: "quantitative", sort: "descending" },
        },
        layer: [
          { mark: { type: "arc", ...(spec.type === "donut" ? { innerRadius: Math.min(width, height) * 0.22 } : {}), outerRadius: Math.min(width, height) * 0.4 } },
          {
            // Labels wear the text color; the slice beside them carries identity.
            mark: { type: "text", radius: Math.min(width, height) * 0.46, fontSize: 11, color: th.text2 },
            encoding: { text: { field: "y", type: "quantitative", format: fmt }, color: { value: th.text2 } },
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
    case "histogram": {
      out = {
        ...base,
        mark: { type: "bar", cornerRadiusEnd: 2 },
        encoding: {
          x: { field: "y", type: "quantitative", bin: { maxbins: spec.bins ?? 20 }, axis: { title: spec.x_label ?? null, format: fmt } },
          y: { aggregate: "count", type: "quantitative", axis: { title: spec.y_label ?? "Count", tickCount: 5 } },
          color: { value: pal[0] },
        },
      };
      break;
    }
    case "heatmap": {
      const cols = xOrder;
      const rowsCats = series;
      // One hue from light to full, so darker always means more.
      const range = th.surface === "#191919" ? ["#25313f", pal[0]] : ["#eef4fb", pal[0]];
      out = {
        ...base,
        width: Math.min(width, Math.max(240, cols.length * 48)),
        height: Math.min(height, Math.max(120, rowsCats.length * 32)),
        encoding: {
          x: { field: "x", type: "ordinal", sort: cols, axis: { ...xAxis, labelAngle: cols.length > 8 ? -40 : 0 } },
          y: { field: "series", type: "ordinal", sort: rowsCats, axis: { title: spec.y_label ?? null } },
        },
        layer: [
          { mark: { type: "rect", stroke: th.surface ?? null, strokeWidth: th.surface ? 2 : 0 }, encoding: { color: { field: "y", type: "quantitative", scale: { range }, legend: { title: null, format: fmt } } } },
          ...(cols.length * rowsCats.length <= 120
            ? [{ mark: { type: "text", fontSize: 10 }, encoding: { text: { field: "y", type: "quantitative", format: fmt }, color: { condition: { test: `datum.y > ${heatMid(rows)}`, value: "#ffffff" }, value: "#0b0b0b" } } }]
            : []),
        ],
      };
      break;
    }
    case "boxplot": {
      out = {
        ...base,
        mark: { type: "boxplot", extent: 1.5, size: 28, median: { color: th.surface ?? th.text }, rule: { color: th.text2 }, outliers: { size: 30 } },
        encoding: {
          x: { field: "x", type: "nominal", sort: xOrder, axis: xAxis },
          y: { field: "y", type: "quantitative", axis: yAxis, scale: { zero: false } },
          color: { value: pal[0] },
        },
      };
      break;
    }
    case "waterfall": {
      let running = 0;
      const steps = rows.map((r) => {
        if (r.series === "total") return { x: String(r.x), start: 0, end: running, top: running, kind: "total", label: running };
        const start = running;
        running += r.y;
        return { x: String(r.x), start, end: running, top: Math.max(start, running), kind: r.y >= 0 ? "increase" : "decrease", label: r.y };
      });
      const kinds = ["increase", "decrease", "total"];
      out = {
        ...base,
        data: { values: steps },
        encoding: { x: { field: "x", type: "nominal", sort: steps.map((t) => t.x), axis: xAxis } },
        layer: [
          {
            mark: { type: "bar", cornerRadiusEnd: 0 },
            encoding: {
              y: { field: "start", type: "quantitative", axis: yAxis },
              y2: { field: "end" },
              color: { field: "kind", type: "nominal", scale: { domain: kinds, range: [pal[2], pal[7] ?? pal[1], pal[0]] }, legend: { title: null, orient: "top" } },
            },
          },
          { mark: { type: "text", baseline: "bottom", dy: -4 }, encoding: { y: { field: "top", type: "quantitative" }, text: { field: "label", type: "quantitative", format: fmt } } },
        ],
      };
      break;
    }
    case "funnel": {
      const first = rows[0]?.y || 1;
      const stages = rows.map((r) => ({ x: String(r.x), lo: -r.y / 2, hi: r.y / 2, y: r.y, pct: r.y / first }));
      out = {
        ...base,
        data: { values: stages },
        encoding: { y: { field: "x", type: "nominal", sort: stages.map((t) => t.x), axis: { title: null, labelLimit: 160, domain: false, ticks: false } } },
        layer: [
          { mark: { type: "bar", cornerRadius: 3 }, encoding: { x: { field: "lo", type: "quantitative", axis: null }, x2: { field: "hi" }, color: { value: pal[0] } } },
          {
            mark: { type: "text", color: inkOn(pal[0]), fontWeight: 600 },
            encoding: { x: { datum: 0, type: "quantitative" }, text: { field: "y", type: "quantitative", format: fmt } },
          },
          {
            mark: { type: "text", align: "left", dx: 6 },
            encoding: { x: { field: "hi", type: "quantitative" }, text: { field: "pct", type: "quantitative", format: ".0%" } },
          },
        ],
      };
      break;
    }
    case "bullet": {
      const cats = xOrder;
      const actual = rows.filter((r) => r.series !== "target").map((r) => ({ x: String(r.x), actual: r.y }));
      const target = rows.filter((r) => r.series === "target").map((r) => ({ x: String(r.x), target: r.y }));
      out = {
        ...base,
        height: Math.min(height, Math.max(80, cats.length * 44)),
        data: { values: [...actual, ...target] },
        encoding: { y: { field: "x", type: "nominal", sort: cats, axis: { title: null, labelLimit: 160 } } },
        layer: [
          { mark: { type: "bar", size: 14, cornerRadiusEnd: 3 }, encoding: { x: { field: "actual", type: "quantitative", axis: { ...yAxis, grid: true } }, color: { value: pal[0] } } },
          { mark: { type: "tick", thickness: 3, size: 26, color: th.text }, encoding: { x: { field: "target", type: "quantitative" } } },
        ],
      };
      notes.push("Bars are actuals; the dark ticks are targets.");
      break;
    }
    case "small_multiples": {
      const panels = series;
      const cols = Math.min(4, Math.ceil(Math.sqrt(panels.length)));
      const x = temporal
        ? { field: "x", type: "temporal" as const, axis: { title: null, format: "%b", tickCount: 4 } }
        : typeof rows[0].x === "number"
          ? { field: "x", type: "quantitative" as const, axis: { title: null } }
          : { field: "x", type: "ordinal" as const, sort: xOrder, axis: { title: null, labelAngle: 0 } };
      const { width: _w, height: _h, ...rest } = base;
      void _w;
      void _h;
      out = {
        ...rest,
        facet: { field: "series", type: "nominal", sort: panels, title: null, header: { labelColor: th.text, labelFontSize: 12, labelFontWeight: 600, labelAnchor: "start" } },
        columns: cols,
        resolve: { axis: { x: "independent", y: "independent" } },
        spec: {
          width: Math.max(140, Math.floor((width - 40 * cols) / cols)),
          height: Math.max(100, Math.floor(height / Math.ceil(panels.length / cols)) - 30),
          mark: { type: "area", line: { strokeWidth: 2, color: pal[0] }, color: pal[0], opacity: 0.2 },
          encoding: { x, y: { field: "y", type: "quantitative", axis: { title: null, format: fmt, tickCount: 3 } } },
        },
      };
      break;
    }
    case "dual_axis": {
      const [left, right] = series;
      const x = temporal
        ? { field: "x", type: "temporal" as const, timeUnit: "yearmonthdate" as const, axis: { ...xAxis, format: "%b %d" } }
        : { field: "x", type: "ordinal" as const, sort: xOrder, axis: xAxis };
      out = {
        ...base,
        encoding: { x },
        layer: [
          {
            transform: [{ filter: { field: "series", equal: left } }],
            mark: { type: "bar", opacity: 0.9 },
            encoding: { y: { field: "y", type: "quantitative", axis: { ...yAxis, title: spec.y_label ?? left, titleColor: pal[0] } }, color: { value: pal[0] } },
          },
          {
            transform: [{ filter: { field: "series", equal: right } }],
            mark: { type: "line", point: true, strokeWidth: 2.5 },
            encoding: { y: { field: "y", type: "quantitative", axis: { title: right, titleColor: pal[1], format: fmt, orient: "right", grid: false } }, color: { value: pal[1] } },
          },
        ],
        resolve: { scale: { y: "independent" } },
      };
      break;
    }
    case "treemap": {
      return { spec: treemapSpec(spec, rows, pal, th) as unknown as vl.TopLevelSpec, notes, engine: "vega" };
    }
  }
  if (spec.annotations?.length) out = annotate(out, spec, rows, th, temporal);
  return { spec: out as unknown as vl.TopLevelSpec, notes };
}

/** Midpoint of a heatmap's values, where cell labels switch to white text. */
function heatMid(rows: ChartRow[]): number {
  const ys = rows.map((r) => r.y);
  return (Math.min(...ys) + Math.max(...ys)) / 2;
}

/** Add reference lines to a chart with x and y axes. */
function annotate(out: Record<string, unknown>, spec: ChartSpec, rows: ChartRow[], th: Theme, temporal: boolean): Record<string, unknown> {
  const skip = ["pie", "donut", "treemap", "heatmap", "funnel", "small_multiples"];
  if (skip.includes(spec.type)) return out;
  const horizontal = spec.type === "bar" || spec.type === "stacked_bar" || spec.type === "bullet";
  const valueCh = horizontal ? "x" : "y";
  const catCh = horizontal ? "y" : "x";
  const catType = temporal ? "temporal" : rows.every((r) => typeof r.x === "number") ? "quantitative" : "nominal";
  const layers: Record<string, unknown>[] = [];
  for (const a of spec.annotations ?? []) {
    // Two value axes: a level line would be ambiguous (and get a scale of its own).
    if (a.value !== undefined && spec.type === "dual_axis") continue;
    if (a.value !== undefined) {
      layers.push(
        { data: { values: [{ v: a.value }] }, mark: { type: "rule", strokeDash: [4, 4], color: th.text2, strokeWidth: 1.5 }, encoding: { [valueCh]: { field: "v", type: "quantitative" } } },
        {
          data: { values: [{ v: a.value, t: a.label }] },
          mark: { type: "text", align: horizontal ? "left" : "right", baseline: "bottom", dx: horizontal ? 4 : 0, dy: -3, color: th.text2, fontWeight: 600, ...(horizontal ? {} : { x: { expr: "width" } }) },
          encoding: { [valueCh]: { field: "v", type: "quantitative" }, text: { field: "t" }, ...(horizontal ? { [catCh]: { value: 0 } } : {}) },
        }
      );
    } else if (a.at !== undefined) {
      layers.push(
        { data: { values: [{ c: a.at }] }, mark: { type: "rule", strokeDash: [4, 4], color: th.text2, strokeWidth: 1.5 }, encoding: { [catCh]: { field: "c", type: catType } } },
        {
          data: { values: [{ c: a.at, t: a.label }] },
          mark: { type: "text", align: "left", baseline: "top", dx: 4, dy: 2, color: th.text2, fontWeight: 600, ...(horizontal ? {} : { y: 0 }) },
          encoding: { [catCh]: { field: "c", type: catType }, text: { field: "t" } },
        }
      );
    }
  }
  if (!layers.length) return out;
  // Shared encoding moves into each existing layer, so the reference layers (with their own data) don't inherit it.
  const { mark, encoding, layer, transform, ...rest } = out as Record<string, unknown> & { layer?: Record<string, unknown>[] };
  const existing = layer
    ? layer.map((l) => (encoding ? { ...l, encoding: { ...(encoding as object), ...((l.encoding as object | undefined) ?? {}) } } : l))
    : [{ mark, encoding, ...(transform ? { transform } : {}) }];
  return { ...rest, layer: [...existing, ...layers] };
}

interface TreeNode {
  id: string;
  parent?: string;
  name: string;
  value?: number;
  fill?: string;
  ink?: string;
}

/** Treemaps need Vega's hierarchy transforms (Vega-Lite has none). */
function treemapSpec(spec: ChartSpec, rows: ChartRow[], pal: string[], th: Theme): Record<string, unknown> {
  const width = spec.width ?? 640;
  const height = spec.height ?? 360;
  const groups = seriesOrder(rows);
  const nodes: TreeNode[] = [{ id: "root", name: "root" }];
  groups.forEach((g, i) => nodes.push({ id: `g:${g}`, parent: "root", name: g, fill: pal[i % pal.length] }));
  rows.forEach((r, i) => {
    const gi = r.series === undefined ? i : groups.indexOf(r.series);
    const fill = pal[gi % pal.length];
    nodes.push({ id: `n:${i}`, parent: r.series === undefined ? "root" : `g:${r.series}`, name: String(r.x), value: r.y, fill, ink: inkOn(fill) });
  });
  const fmt = d3Format(spec.value_format);
  return {
    $schema: "https://vega.github.io/schema/vega/v6.json",
    width,
    height,
    padding: 16,
    background: th.surface ?? "transparent",
    ...(spec.title ? { title: { text: spec.title, ...(spec.subtitle ? { subtitle: spec.subtitle } : {}), anchor: "start", fontSize: 16, fontWeight: 600, color: th.text, subtitleColor: th.text2, font: FONT, offset: 12 } } : {}),
    data: [
      {
        name: "tree",
        values: nodes,
        transform: [
          { type: "stratify", key: "id", parentKey: "parent" },
          { type: "treemap", field: "value", sort: { field: "value", order: "descending" }, round: true, method: "squarify", paddingInner: 2, size: [{ signal: "width" }, { signal: "height" }] },
        ],
      },
      { name: "leaves", source: "tree", transform: [{ type: "filter", expr: "datum.value != null && indexof(datum.id, 'n:') === 0" }] },
    ],
    marks: [
      {
        type: "rect",
        from: { data: "leaves" },
        encode: { enter: { x: { field: "x0" }, y: { field: "y0" }, x2: { field: "x1" }, y2: { field: "y1" }, fill: { field: "fill" }, cornerRadius: { value: 3 } } },
      },
      {
        type: "text",
        from: { data: "leaves" },
        encode: {
          enter: {
            x: { signal: "datum.x0 + 6" },
            y: { signal: "datum.y0 + 16" },
            text: { signal: `(datum.x1 - datum.x0 > 50 && datum.y1 - datum.y0 > 22) ? datum.name + '  ' + format(datum.value, '${fmt}') : ''` },
            fill: { field: "ink" },
            font: { value: FONT },
            fontSize: { value: 11 },
            fontWeight: { value: 600 },
            limit: { signal: "datum.x1 - datum.x0 - 10" },
          },
        },
      },
    ],
  };
}

const RENDER_TIMEOUT_MS = 20_000;

async function libs() {
  try {
    return await Promise.all([import("vega"), import("vega-lite"), import("@resvg/resvg-js")]);
  } catch (e) {
    throw new Error(
      `Chart images need the rendering libraries for this platform (${process.platform}-${process.arch}), which failed to load: ` +
        `${(e as Error).message}. Reinstall with npm ci on this machine, or use a notion_views chart view instead.`
    );
  }
}

/** Render a Vega-Lite (or, with engine "vega", a Vega) spec to SVG, with a time limit. */
export async function renderSvg(spec: vl.TopLevelSpec | Record<string, unknown>, engine: "vega-lite" | "vega" = "vega-lite"): Promise<string> {
  const [vega, vegaLite] = await libs();
  const compiled = engine === "vega" ? (spec as object) : vegaLite.compile(spec as vl.TopLevelSpec).spec;
  // No loader: specs can't fetch anything (data must be inline).
  const loader = vega.loader();
  loader.load = async () => {
    throw new Error("Charts can't load external data or images.");
  };
  const view = new vega.View(vega.parse(compiled as never), { renderer: "none", loader });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      view.toSVG(),
      new Promise<string>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`The chart took longer than ${RENDER_TIMEOUT_MS / 1000}s to render.`)), RENDER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    view.finalize();
  }
}

/** Render a Vega-Lite (or Vega) spec to PNG at 2x for crisp display. */
export async function renderPng(spec: vl.TopLevelSpec | Record<string, unknown>, engine: "vega-lite" | "vega" = "vega-lite"): Promise<Uint8Array> {
  const svg = await renderSvg(spec, engine);
  const [, , { Resvg }] = await libs();
  const bg = (spec as { background?: string }).background;
  const resvg = new Resvg(svg, {
    ...(bg && bg !== "transparent" ? { background: bg } : {}),
    fitTo: { mode: "zoom", value: 2 },
    font: { loadSystemFonts: true, defaultFontFamily: "DejaVu Sans" },
  });
  return new Uint8Array(resvg.render().asPng());
}

export type ChartFormat = "png" | "svg";

export interface RenderedChart {
  bytes: Uint8Array;
  format: ChartFormat;
  notes: string[];
  /** A sentence describing the chart, for alt text and data tables. */
  alt: string;
}

export async function renderChart(spec: ChartSpec, rows: ChartRow[], format: ChartFormat = "png"): Promise<RenderedChart & { png: Uint8Array }> {
  const built = vegaLiteSpec(spec, rows);
  const engine = built.engine ?? "vega-lite";
  const bytes = format === "svg" ? new TextEncoder().encode(await renderSvg(built.spec, engine)) : await renderPng(built.spec, engine);
  return { bytes, png: bytes, format, notes: built.notes, alt: describeChart(spec, rows) };
}

const TYPE_NAMES: Partial<Record<ChartType, string>> = {
  stacked_bar: "stacked bar", stacked_column: "stacked column", grouped_column: "grouped column", stacked_area: "stacked area",
  small_multiples: "small-multiples", dual_axis: "dual-axis", boxplot: "box plot",
};

/** One or two plain sentences that say what a chart shows: for alt text and the data table under it. */
export function describeChart(spec: ChartSpec, rows: ChartRow[]): string {
  const kind = `${TYPE_NAMES[spec.type] ?? spec.type} chart`;
  const head = `${kind[0].toUpperCase()}${kind.slice(1)}${spec.title ? ` "${spec.title}"` : ""}`;
  if (!rows.length) return `${head} with no data.`;
  const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const series = seriesOrder(rows);
  if (spec.type === "histogram" || spec.type === "boxplot") {
    const ys = rows.map((r) => r.y).sort((a, b) => a - b);
    const median = ys[Math.floor(ys.length / 2)];
    return `${head} of ${rows.length} values from ${fmt(ys[0])} to ${fmt(ys[ys.length - 1])}, median ${fmt(median)}.`;
  }
  if (spec.type === "waterfall") {
    const end = rows.reduce((n, r) => (r.series === "total" ? n : n + r.y), 0);
    const ups = rows.filter((r) => r.series !== "total" && r.y > 0).length;
    const downs = rows.filter((r) => r.series !== "total" && r.y < 0).length;
    return `${head}: ${ups} increases and ${downs} decreases, ending at ${fmt(end)}.`;
  }
  if (spec.type === "funnel" && rows.length > 1) {
    const last = rows[rows.length - 1];
    return `${head}: ${rows.length} stages from ${rows[0].x} (${fmt(rows[0].y)}) to ${last.x} (${fmt(last.y)}), ${Math.round((last.y / (rows[0].y || 1)) * 100)}% of the first.`;
  }
  const byX = new Map<string, number>();
  for (const r of rows) if (r.series !== "target") byX.set(String(r.x), (byX.get(String(r.x)) ?? 0) + r.y);
  const sorted = [...byX.entries()].sort((a, b) => b[1] - a[1]);
  const [top, bottom] = [sorted[0], sorted[sorted.length - 1]];
  const total = sorted.reduce((n, [, v]) => n + v, 0);
  const parts = [`${head}: ${byX.size} ${byX.size === 1 ? "category" : "categories"}${series.length > 1 ? ` across ${series.length} series (${series.slice(0, 4).join(", ")}${series.length > 4 ? ", …" : ""})` : ""}.`];
  if (sorted.length > 1) parts.push(`Highest: ${top[0]} (${fmt(top[1])}); lowest: ${bottom[0]} (${fmt(bottom[1])}); total ${fmt(total)}.`);
  else parts.push(`Value: ${fmt(top[1])}.`);
  return parts.join(" ");
}

// ---------- advanced: a Vega-Lite spec given directly ----------

const MAX_CUSTOM_BYTES = 200_000;
const FORBIDDEN_KEYS = new Set(["url", "href", "baseURL", "loader", "usermeta"]);

/**
 * Check a raw Vega-Lite spec before rendering: inline data only (nothing fetched), no links or images, bounded
 * size, and the house theme applied where the spec doesn't set its own. Returns the spec to render.
 */
export function checkCustomSpec(input: Record<string, unknown>, theme: ChartTheme = "light"): vl.TopLevelSpec {
  const text = JSON.stringify(input);
  if (text.length > MAX_CUSTOM_BYTES) throw new Error(`The spec is ${text.length} bytes; the limit is ${MAX_CUSTOM_BYTES}. Aggregate the data first.`);
  let values = 0;
  const visit = (v: unknown, path: string): void => {
    if (Array.isArray(v)) return v.forEach((x, i) => visit(x, `${path}[${i}]`));
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN_KEYS.has(k)) throw new Error(`${path}.${k}: charts can't load or link to anything; put data inline in data.values.`);
      if (k === "mark" && (x === "image" || (x as { type?: string })?.type === "image")) throw new Error(`${path}.mark: image marks aren't allowed.`);
      if (k === "values" && Array.isArray(x)) values += x.length;
      visit(x, `${path}.${k}`);
    }
  };
  visit(input, "spec");
  if (values > 5000) throw new Error(`${values} data values is too many for one chart; aggregate first.`);
  for (const dim of ["width", "height"] as const) {
    const d = input[dim];
    if (typeof d === "number" && (d < 50 || d > 1600)) throw new Error(`${dim} must be between 50 and 1600.`);
  }
  const th = THEMES[theme];
  const config = (input.config as Record<string, unknown> | undefined) ?? {};
  return {
    ...input,
    background: (input.background as string | undefined) ?? th.surface ?? "transparent",
    padding: input.padding ?? 16,
    config: {
      font: FONT,
      view: { stroke: null },
      range: { category: PALETTES.default },
      title: { anchor: "start", fontSize: 16, fontWeight: 600, color: th.text, subtitleColor: th.text2 },
      axis: { labelColor: th.text2, titleColor: th.text2, gridColor: th.grid, domainColor: th.grid, tickColor: th.grid },
      legend: { labelColor: th.text2, titleColor: th.text2 },
      ...config,
    },
  } as vl.TopLevelSpec;
}

export async function renderCustom(input: Record<string, unknown>, theme: ChartTheme = "light", format: ChartFormat = "png"): Promise<{ bytes: Uint8Array; format: ChartFormat }> {
  const spec = checkCustomSpec(input, theme);
  return { bytes: format === "svg" ? new TextEncoder().encode(await renderSvg(spec)) : await renderPng(spec), format };
}
