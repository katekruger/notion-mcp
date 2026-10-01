// How each chart image was made, so it can be refreshed in place later (by a tool call or an automation).
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChartSpec, ChartRow } from "./charts.js";
import type { ChartSource } from "./chartdata.js";
import { homeDir } from "./files.js";
import { readJson, updateJson } from "./store.js";
import { stateDir } from "./workspace.js";

export interface StoredChart {
  block_id: string;
  page_id: string;
  spec: ChartSpec;
  source?: ChartSource;
  data?: ChartRow[];
  /** Image format it was made in; refreshes keep it. */
  format?: "png" | "svg";
  created: string;
  updated: string;
}

const file = async () => path.join(await stateDir(), "charts.json");

function parseCharts(raw: unknown): Record<string, StoredChart> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected an object of chart recipes keyed by block id");
  return raw as Record<string, StoredChart>;
}

export async function loadCharts(): Promise<Record<string, StoredChart>> {
  return (await readJson(await file(), parseCharts, () => ({}))).data;
}

export async function saveChart(c: StoredChart): Promise<void> {
  await updateJson<Record<string, StoredChart>, null>(await file(), parseCharts, () => ({}), (all) => {
    all[c.block_id] = c;
    return { data: all, result: null };
  });
}

export async function getChart(blockId: string): Promise<StoredChart | undefined> {
  return (await loadCharts())[blockId];
}

/** Keep a copy of an image being replaced, for undo. */
export async function saveImageCopy(blockId: string, png: Uint8Array): Promise<string> {
  const dir = path.join(homeDir(), "charts");
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, `${blockId}-${Date.now()}.png`);
  await fs.writeFile(p, png);
  return p;
}
