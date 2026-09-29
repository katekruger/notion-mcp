// Group-and-summarize over database rows, so "how many X by Y" doesn't need every row in context.
import type { PageObjectResponse } from "@notionhq/client";
import { simplify, type PageProperty } from "./schema.js";

export const METRIC_OPS = [
  "count", "count_values", "count_empty", "distinct", "sum", "avg", "min", "max", "median", "checked", "percent_checked",
] as const;
export type MetricOp = (typeof METRIC_OPS)[number];
export const DATE_BUCKETS = ["day", "week", "month", "quarter", "year"] as const;
export type DateBucket = (typeof DATE_BUCKETS)[number];

export interface Metric {
  op: MetricOp;
  property?: string;
}

export interface AggregateSpec {
  group_by?: { property: string; by?: DateBucket };
  metrics: Metric[];
  sort?: "value_desc" | "value_asc" | "key_asc" | "key_desc";
  top?: number;
}

export interface Group {
  key: string;
  [metric: string]: string | number | null;
}

export const EMPTY_KEY = "(empty)";

/** A number for numeric metrics: numbers, number formulas/rollups, unique ids, checkboxes (1/0). */
export function numericValue(prop: PageProperty | undefined): number | null {
  if (!prop) return null;
  const p = prop as unknown as Record<string, unknown> & { type: string };
  const v = p[p.type] as unknown;
  switch (p.type) {
    case "number":
      return typeof v === "number" ? v : null;
    case "checkbox":
      return v ? 1 : 0;
    case "unique_id":
      return (v as { number: number | null }).number;
    case "formula":
    case "rollup": {
      const inner = v as Record<string, unknown> & { type: string };
      const x = inner[inner.type];
      return typeof x === "number" ? x : typeof x === "boolean" ? (x ? 1 : 0) : null;
    }
    default:
      return null;
  }
}

function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

/** Group keys for a row: one per multi-select option / person / relation, one date bucket, or "(empty)". */
export function groupKeys(prop: PageProperty | undefined, by?: DateBucket): string[] {
  if (!prop) return [EMPTY_KEY];
  const v = simplify(prop);
  if (isEmptyValue(v)) return [EMPTY_KEY];
  const p = prop as unknown as { type: string };
  const dateLike = ["date", "created_time", "last_edited_time"].includes(p.type) || (p.type === "formula" && typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v));
  if (dateLike) {
    const start = typeof v === "string" ? v : (v as { start: string }).start;
    return [bucket(start, by ?? "day")];
  }
  if (Array.isArray(v)) return [...new Set(v.map((x) => String(x)))];
  if (typeof v === "object") return [JSON.stringify(v)];
  return [String(v)];
}

/** ISO date/time → bucket label: 2026-10-05, 2026-W41, 2026-10, 2026-Q4, 2026. */
export function bucket(iso: string, by: DateBucket): string {
  const d = iso.slice(0, 10);
  const [y, m] = d.split("-").map(Number);
  switch (by) {
    case "day":
      return d;
    case "month":
      return d.slice(0, 7);
    case "quarter":
      return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
    case "year":
      return String(y);
    case "week": {
      // ISO week number.
      const date = new Date(Date.UTC(y, m - 1, Number(d.slice(8, 10))));
      const day = date.getUTCDay() || 7;
      date.setUTCDate(date.getUTCDate() + 4 - day);
      const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
      const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
      return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
    }
  }
}

export function metricName(m: Metric): string {
  return m.op === "count" ? "count" : `${m.op}_${m.property}`;
}

function round(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

function compute(m: Metric, rows: PageObjectResponse[]): number | string | null {
  if (m.op === "count") return rows.length;
  const props = rows.map((r) => r.properties[m.property as string]);
  switch (m.op) {
    case "count_values":
      return props.filter((p) => p && !isEmptyValue(simplify(p))).length;
    case "count_empty":
      return props.filter((p) => !p || isEmptyValue(simplify(p))).length;
    case "distinct":
      return new Set(props.flatMap((p) => (p ? groupKeys(p) : [])).filter((k) => k !== EMPTY_KEY)).size;
    case "checked":
      return props.filter((p) => numericValue(p) === 1).length;
    case "percent_checked":
      return rows.length ? round((props.filter((p) => numericValue(p) === 1).length / rows.length) * 100) : null;
    default: {
      const nums = props.map(numericValue).filter((x): x is number => x !== null);
      if (nums.length === 0) {
        // min/max also work on dates (as ISO strings).
        if (m.op === "min" || m.op === "max") {
          const dates = props.flatMap((p) => (p ? groupKeys(p, "day") : [])).filter((k) => k !== EMPTY_KEY).sort();
          return dates.length ? (m.op === "min" ? dates[0] : dates[dates.length - 1]) : null;
        }
        return null;
      }
      if (m.op === "sum") return round(nums.reduce((a, b) => a + b, 0));
      if (m.op === "avg") return round(nums.reduce((a, b) => a + b, 0) / nums.length);
      if (m.op === "min") return Math.min(...nums);
      if (m.op === "max") return Math.max(...nums);
      const sorted = [...nums].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : round((sorted[mid - 1] + sorted[mid]) / 2);
    }
  }
}

/** Group rows and compute metrics. Rows with several keys (multi-select, people, relations) count in each group. */
export function aggregate(rows: PageObjectResponse[], spec: AggregateSpec): { groups: Group[]; totals: Record<string, number | string | null>; group_count: number } {
  const metrics = spec.metrics.length ? spec.metrics : [{ op: "count" as const }];
  const totals = Object.fromEntries(metrics.map((m) => [metricName(m), compute(m, rows)]));
  if (!spec.group_by) return { groups: [], totals, group_count: 0 };
  const buckets = new Map<string, PageObjectResponse[]>();
  for (const r of rows) {
    for (const k of groupKeys(r.properties[spec.group_by.property], spec.group_by.by)) {
      const list = buckets.get(k) ?? [];
      list.push(r);
      buckets.set(k, list);
    }
  }
  let groups: Group[] = [...buckets.entries()].map(([key, list]) => ({
    key,
    ...Object.fromEntries(metrics.map((m) => [metricName(m), compute(m, list)])),
  }));
  const first = metricName(metrics[0]);
  const sort = spec.sort ?? (spec.group_by.by ? "key_asc" : "value_desc");
  const num = (g: Group) => (typeof g[first] === "number" ? (g[first] as number) : -Infinity);
  groups.sort((a, b) =>
    sort === "value_desc" ? num(b) - num(a) || a.key.localeCompare(b.key)
    : sort === "value_asc" ? num(a) - num(b) || a.key.localeCompare(b.key)
    : sort === "key_desc" ? b.key.localeCompare(a.key)
    : a.key.localeCompare(b.key)
  );
  const group_count = groups.length;
  if (spec.top) groups = groups.slice(0, spec.top);
  return { groups, totals, group_count };
}
