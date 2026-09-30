// Where this integration's local state lives. Each integration (token) gets its own folder under the home folder,
// so two servers pointed at different workspaces never mix undo history, chart recipes, or automation state.
import { promises as fs } from "node:fs";
import path from "node:path";
import { homeDir } from "./files.js";
import { notion, read } from "./notion.js";

let cached: { home: string; id: string } | null = null;

/** Folder-safe id of this integration: NOTION_PLUS_WORKSPACE, else the bot user's id (one call, cached). */
export async function workspaceKey(): Promise<string> {
  const home = homeDir();
  if (process.env.NOTION_PLUS_WORKSPACE) return sanitize(process.env.NOTION_PLUS_WORKSPACE);
  if (cached && cached.home === home) return cached.id;
  const me = await read(() => notion().users.me({}));
  const id = sanitize(me.id);
  cached = { home, id };
  return id;
}

function sanitize(s: string): string {
  const out = s.replace(/[^A-Za-z0-9_-]/g, "");
  if (!out) throw new Error(`"${s}" isn't a usable workspace key (letters, digits, - and _ only).`);
  return out;
}

/** Files written before state was kept per integration; copied once into the first integration folder that asks. */
const LEGACY_FILES = ["journal.json", "charts.json", "automation-state.json", "automation-runs.jsonl"];

/** This integration's state folder, creating it (and bringing over older top-level state) the first time. */
export async function stateDir(): Promise<string> {
  const dir = path.join(homeDir(), "workspaces", await workspaceKey());
  try {
    await fs.access(dir);
    return dir;
  } catch {
    await fs.mkdir(dir, { recursive: true });
  }
  for (const f of LEGACY_FILES) {
    try {
      // COPYFILE_EXCL: never overwrite state another process already created here.
      await fs.copyFile(path.join(homeDir(), f), path.join(dir, f), fs.constants.COPYFILE_EXCL);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EEXIST") throw e;
    }
  }
  return dir;
}

/** Tests only. */
export function resetWorkspaceCache(): void {
  cached = null;
}
