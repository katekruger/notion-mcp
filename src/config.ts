// Every setting this server reads from the environment, checked in one place. The server validates them at
// startup and names every bad value at once, instead of failing later (a timeout of NaN, a misspelled time zone).
// config() re-reads the environment on each call, so tests and the CLI can change it between calls.
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const DEFAULT_NOTION_VERSION = "2026-03-11";

const zone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "not a valid IANA time zone, e.g. America/New_York");

const positiveInt = z
  .string()
  .regex(/^\d+$/, "must be a whole number of milliseconds")
  .transform(Number)
  .refine((n) => n >= 1000 && n <= 600_000, "must be between 1000 and 600000 ms");

const schema = z.object({
  NOTION_TOKEN: z.string().min(1).optional(),
  NOTION_VERSION: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a Notion API version like 2026-03-11").default(DEFAULT_NOTION_VERSION),
  NOTION_TIMEOUT_MS: positiveInt.default(30_000),
  NOTION_PLUS_HOME: z.string().min(1).optional(),
  NOTION_PLUS_WORKSPACE: z.string().regex(/^[A-Za-z0-9_-]+$/, "letters, digits, - and _ only").optional(),
  NOTION_PLUS_RULES: z.string().min(1).optional(),
  NOTION_PLUS_STATE: z.string().min(1).optional(),
  NOTION_PLUS_TIMEZONE: zone.optional(),
  NOTION_PLUS_UPLOAD_DIRS: z.string().optional(),
  NOTION_PLUS_LOG: z.enum(["json", "text", "off"]).default("json"),
});

export type Config = z.infer<typeof schema> & { home: string; timezone: string; uploadDirs: string[] };

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`The server's settings have problems:\n- ${problems.join("\n- ")}\nFix them in the env block of the server in your Claude config.`);
    this.name = "ConfigError";
  }
}

/** Only the variables we know, with blank values treated as unset (config UIs often write ""). */
function known(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(schema.shape)) {
    const v = env[k];
    if (v !== undefined && v.trim() !== "") out[k] = v.trim();
  }
  return out;
}

export function config(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(known(env));
  if (!parsed.success) throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const c = parsed.data;
  const uploadDirs = c.NOTION_PLUS_UPLOAD_DIRS ? c.NOTION_PLUS_UPLOAD_DIRS.split(path.delimiter).filter(Boolean) : [process.cwd(), os.tmpdir()];
  return {
    ...c,
    home: c.NOTION_PLUS_HOME ?? path.join(os.homedir(), ".notion-plus"),
    timezone: c.NOTION_PLUS_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    uploadDirs,
  };
}

/** Settings for the startup log: never the token itself. */
export function redactedSummary(c: Config): Record<string, unknown> {
  return {
    token: c.NOTION_TOKEN ? `set (…${c.NOTION_TOKEN.slice(-4)})` : "missing",
    notion_version: c.NOTION_VERSION,
    timeout_ms: c.NOTION_TIMEOUT_MS,
    home: c.home,
    ...(c.NOTION_PLUS_WORKSPACE ? { workspace: c.NOTION_PLUS_WORKSPACE } : {}),
    ...(c.NOTION_PLUS_RULES ? { rules: c.NOTION_PLUS_RULES } : {}),
    ...(c.NOTION_PLUS_STATE ? { state: c.NOTION_PLUS_STATE } : {}),
    timezone: c.timezone,
    upload_dirs: c.uploadDirs,
    log: c.NOTION_PLUS_LOG,
  };
}
