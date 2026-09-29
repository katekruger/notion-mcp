import { formatError } from "../services/notion.js";

export const CHARACTER_LIMIT = 25000;

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export function ok(body: string | Record<string, unknown> | unknown[]): ToolResult {
  let text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  if (text.length > CHARACTER_LIMIT) {
    text =
      text.slice(0, CHARACTER_LIMIT) +
      `\n\n[Truncated at ${CHARACTER_LIMIT} characters. Narrow the request: lower max_blocks/limit, add a filter, or read a sub-block.]`;
  }
  return { content: [{ type: "text", text }] };
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
