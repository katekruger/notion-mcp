import { isFullPage } from "@notionhq/client";
import type { PageObjectResponse } from "@notionhq/client";
import { notion, read } from "./notion.js";

/** Every page matching a filter, up to `max`. `more` is true when rows beyond `max` exist. */
export async function queryAll(
  dataSourceId: string,
  opts: { filter?: Record<string, unknown>; sorts?: Record<string, unknown>[]; max: number }
): Promise<{ pages: PageObjectResponse[]; more: boolean }> {
  const pages: PageObjectResponse[] = [];
  let cursor: string | null = null;
  do {
    const res = await read(() =>
      notion().dataSources.query({
        data_source_id: dataSourceId,
        page_size: 100,
        result_type: "page",
        ...(opts.filter ? { filter: opts.filter } : {}),
        ...(opts.sorts ? { sorts: opts.sorts } : {}),
        ...(cursor ? { start_cursor: cursor } : {}),
      } as never)
    );
    for (const r of res.results) if (isFullPage(r as PageObjectResponse)) pages.push(r as PageObjectResponse);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor && pages.length < opts.max);
  return { pages: pages.slice(0, opts.max), more: pages.length > opts.max || Boolean(cursor) };
}
