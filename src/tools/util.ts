import { formatError } from "../services/notion.js";
import { runJournaled } from "../services/journal.js";

export const CHARACTER_LIMIT = 25000;

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

const NARROW_HINT = "Narrow the request: lower max_blocks/limit, add a filter, pick fewer properties, or read a sub-block.";

/** The longest array anywhere in a value, with a setter to replace it. */
function longestArray(value: unknown): { arr: unknown[]; set: (v: unknown[]) => void } | null {
  let best: { arr: unknown[]; set: (v: unknown[]) => void } | null = null;
  const visit = (v: unknown, set: (x: unknown[]) => void): void => {
    if (Array.isArray(v)) {
      if (!best || v.length > best.arr.length) best = { arr: v, set };
      v.forEach((item, i) => visit(item, (x) => (v[i] = x)));
    } else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const k of Object.keys(o)) visit(o[k], (x) => (o[k] = x));
    }
  };
  visit(value, () => undefined);
  return best;
}

/**
 * Serialize for the model, staying under CHARACTER_LIMIT. Structured results shrink their longest
 * list (keeping valid JSON and saying how many items were dropped) before falling back to cutting text.
 */
export function fitToLimit(body: string | Record<string, unknown> | unknown[], limit = CHARACTER_LIMIT): string {
  if (typeof body === "string") {
    return body.length <= limit ? body : body.slice(0, limit) + `\n\n[Truncated at ${limit} characters. ${NARROW_HINT}]`;
  }
  let text = JSON.stringify(body, null, 2);
  if (text.length <= limit) return text;
  const copy = JSON.parse(text) as Record<string, unknown> | unknown[];
  let dropped = 0;
  for (let i = 0; i < 40 && text.length > limit; i++) {
    const target = longestArray(copy);
    if (!target || target.arr.length <= 1) break;
    const keep = Math.max(1, Math.floor(target.arr.length * Math.min(0.9, limit / text.length)));
    dropped += target.arr.length - keep;
    target.set(target.arr.slice(0, keep));
    const wrapped = Array.isArray(copy)
      ? { items: copy, truncated: `${dropped} list items omitted to fit. ${NARROW_HINT}` }
      : { ...copy, truncated: `${dropped} list items omitted to fit. ${NARROW_HINT}` };
    text = JSON.stringify(wrapped, null, 2);
  }
  return text.length <= limit ? text : text.slice(0, limit) + `\n\n[Truncated at ${limit} characters. ${NARROW_HINT}]`;
}

export function ok(body: string | Record<string, unknown> | unknown[]): ToolResult {
  return { content: [{ type: "text", text: fitToLimit(body) }] };
}

export function fail(error: unknown): ToolResult {
  return { content: [{ type: "text", text: formatError(error) }], isError: true };
}

/** Wrap a handler so every thrown error becomes an actionable tool error instead of a crash. */
export function safe<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(e);
    }
  };
}

export const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

/** Anything with the MCP SDK's registerTool shape (the real server, or a test registry). */
interface ToolRegistry {
  registerTool(name: string, config: { annotations?: { readOnlyHint?: boolean } }, handler: (...a: never[]) => unknown): unknown;
}

/**
 * Wrap a server so every tool that isn't read-only writes a journal intent before its first Notion write
 * (see runJournaled). Register tools on the returned object.
 */
export function journalWrites<S extends ToolRegistry>(server: S): S {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== "registerTool") return Reflect.get(target, prop, receiver);
      return (name: string, config: { annotations?: { readOnlyHint?: boolean } }, handler: (...a: unknown[]) => Promise<ToolResult>) =>
        target.registerTool(
          name,
          config,
          (config.annotations?.readOnlyHint ? handler : (...a: unknown[]) => runJournaled(name, a[0], () => handler(...a))) as never
        );
    },
  });
}
