// Some steps reuse a tool's whole implementation (find and replace, duplicate page, render template) by calling its
// handler in-process with schema-parsed arguments, exactly as the MCP server would. Tools record their own undo.
import { z } from "zod";
import { unwrap } from "../../tools/util.js";

type Handler = (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
let tools: Map<string, { schema: z.ZodTypeAny; handler: Handler }> | null = null;

async function registry() {
  if (tools) return tools;
  const map = new Map<string, { schema: z.ZodTypeAny; handler: Handler }>();
  const reg = { registerTool: (name: string, c: { inputSchema: z.ZodRawShape }, h: Handler) => map.set(name, { schema: z.object(c.inputSchema), handler: h }) };
  const mods = await Promise.all([import("../../tools/blocks.js"), import("../../tools/content.js"), import("../../tools/templates.js")]);
  for (const m of mods) for (const [k, fn] of Object.entries(m)) if (k.startsWith("register") && typeof fn === "function") (fn as (r: unknown) => void)(reg);
  tools = map;
  return map;
}

/** Call a tool and return its data (with undo_id), or throw its error. */
export async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const t = (await registry()).get(name);
  if (!t) throw new Error(`No tool ${name}.`);
  const r = await t.handler(t.schema.parse(args));
  const { json, text } = unwrap(r);
  if (r.isError) throw new Error(text);
  return json;
}
