import { z } from "zod";
import { CREATABLE_TYPES, type BlockSpec } from "./blocks.js";

/** Tool-facing schema for structured blocks. Everything is checked again by normalizeSpecs before writing. */
export const blockSpecSchema: z.ZodType<BlockSpec> = z.lazy(() =>
  z
    .object({
      type: z.string().describe(`One of: ${CREATABLE_TYPES.filter((t) => t !== "table_row" && t !== "column").join(", ")}`),
      text: z
        .string()
        .optional()
        .describe(
          'Inline markdown: **bold**, *italic*, `code`, ~~strike~~, <u>under</u>, [link](url), $x^2$, <span color="red">…</span>, ' +
            '<mention-page url="…"/>, <mention-user email="…"/>, <mention-date start="2026-10-01"/>'
        ),
      checked: z.boolean().optional(),
      language: z.string().optional().describe("code: e.g. typescript, python, mermaid"),
      caption: z.string().optional(),
      icon: z.string().optional().describe("callout: emoji, image URL, or local image path"),
      emoji: z.string().optional(),
      color: z.string().optional().describe("e.g. red, blue_background (also red_bg)"),
      toggleable: z.boolean().optional().describe("headings: make it a toggle heading"),
      children: z.array(blockSpecSchema).optional(),
      rows: z.array(z.array(z.string())).optional().describe("table: rows of cell text (inline markdown)"),
      header_row: z.boolean().optional(),
      header_column: z.boolean().optional(),
      columns: z.array(z.array(blockSpecSchema)).optional().describe("column_list: 2+ lists of blocks"),
      tabs: z.array(z.object({ title: z.string(), children: z.array(blockSpecSchema).optional() })).optional(),
      url: z.string().optional().describe("bookmark/embed URL; image/file/pdf/video/audio URL or local path; link_to_page page link"),
      name: z.string().optional(),
      expression: z.string().optional().describe("equation: KaTeX"),
      synced_from: z.string().optional().describe("synced_block: original block id to reference; omit to create a new original"),
    })
    .strict()
);
