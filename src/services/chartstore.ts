// How each chart image was made, so it can be refreshed in place later (by a tool call or an automation).
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChartSpec, ChartRow } from "./charts.js";
import type { ChartSource } from "./chartdata.js";
import { homeDir } from "./files.js";

export interface StoredChart {
  block_id: string;
  page_id: string;
  spec: ChartSpec;
  source?: ChartSource;
  data?: ChartRow[];
  created: string;
  updated: string;
}

const file = () => path.join(homeDir(), "charts.json");

export async function loadCharts(): Promise<Record<string, StoredChart>> {
  try {
    return JSON.parse(await fs.readFile(file(), "utf8")) as Record<string, StoredChart>;
  } catch {
    return {};
  }
}

export async function saveChart(c: StoredChart): Promise<void> {
  const all = await loadCharts();
  all[c.block_id] = c;
  await fs.mkdir(homeDir(), { recursive: true });
  const tmp = file() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(all, null, 2));
  await fs.rename(tmp, file());
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
