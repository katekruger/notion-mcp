// Calls tool handlers the way the MCP server would (schema-parsed args), without a transport. Used by the eval scripts.
import { z } from "zod";

try {
  process.loadEnvFile?.(".env");
} catch {
  // Variables may come from the environment instead.
}

type Handler = (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const tools = new Map<string, { schema: z.ZodTypeAny; handler: Handler }>();
const registry = {
  registerTool(name: string, config: { inputSchema: z.ZodRawShape }, handler: Handler) {
    tools.set(name, { schema: z.object(config.inputSchema), handler });
  },
};

const mods = await Promise.all([
  import("../src/tools/read.js"),
  import("../src/tools/pages.js"),
  import("../src/tools/blocks.js"),
  import("../src/tools/content.js"),
  import("../src/tools/schema.js"),
  import("../src/tools/database.js"),
  import("../src/tools/visuals.js"),
  import("../src/tools/automations.js"),
]);
for (const m of mods) for (const [k, fn] of Object.entries(m)) if (k.startsWith("register") && typeof fn === "function") fn(registry as never);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

export async function tool(name: string, args: Record<string, unknown>): Promise<{ text: string; json: Json; isError: boolean }> {
  const t = tools.get(name);
  if (!t) throw new Error(`No tool ${name}`);
  const r = await t.handler(t.schema.parse(args));
  const text = r.content[0].text;
  let json: Json = {};
  try {
    json = JSON.parse(text) as Json;
  } catch {
    // Some tools answer in text.
  }
  return { text, json, isError: Boolean(r.isError) };
}

export async function must(name: string, args: Record<string, unknown>): Promise<Json> {
  const r = await tool(name, args);
  if (r.isError) throw new Error(`${name} failed: ${r.text}`);
  return r.json;
}

export function testPage(): string {
  const p = process.env.NOTION_TEST_PAGE;
  if (!process.env.NOTION_TOKEN || !p) {
    console.error("Set NOTION_TOKEN and NOTION_TEST_PAGE (env or .env).");
    process.exit(2);
  }
  return p;
}
