# notion-plus-mcp-server

A local MCP server for Notion built for precise edits. It changes exactly the block or field you point at, checks every value against the database schema before writing, previews risky changes, and can undo anything it did.

## Why this instead of the built-in Notion connector

| | Built-in connector | notion-plus |
|---|---|---|
| Editing page content | Rewrites content | Patches one block by id, inserts at an exact position, find/replace that keeps formatting and mentions |
| Setting properties | Values passed through as-is | Validated against the schema; forgiving name and option matching; all errors reported at once |
| Bulk changes | One call per row | Filtered bulk update with dry-run preview and rate limiting |
| Mistakes | Manual cleanup | Every write returns an `undo_id`; `notion_undo` reverts it |
| Stale overwrites | Not detected | Optional `expected_last_edited_time` refuses to write over newer edits |
| Schema changes | Limited | Add properties, add select options, rename properties |

## Setup

**1. Create a Notion integration.** Go to https://www.notion.so/profile/integrations, create an internal integration, enable read, update, and insert content, and copy the secret. To set people properties by name or email, also enable "Read user information including email addresses". Personal access tokens can't look up users at all; with one, pass user ids.

**2. Share your workspace with it.** In Notion, open each top-level page you want Claude to reach, click `•••` → `Connections`, and add the integration. Everything under a shared page is included.

**3. Install.**

```bash
git clone https://github.com/katekruger/notion-mcp.git
cd notion-mcp
npm install
npm run build
```

**4. Connect it to Claude.**

Claude Desktop: open Settings → Developer → Edit Config, and add this to `claude_desktop_config.json` (use the full path to your clone):

```json
{
  "mcpServers": {
    "notion-plus": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/notion-mcp/dist/index.js"],
      "env": { "NOTION_TOKEN": "ntn_your_secret_here" }
    }
  }
}
```

Restart Claude Desktop. The tools appear under the `notion-plus` server.

Claude Code:

```bash
claude mcp add notion-plus --env NOTION_TOKEN=ntn_your_secret_here -- node /ABSOLUTE/PATH/TO/notion-mcp/dist/index.js
```

Tip: turn off the built-in Notion connector while using this one so Claude doesn't pick between two sets of Notion tools.

**5. Test it (optional).** Run `NOTION_TOKEN=ntn_... npm run inspect` to open the MCP Inspector and call tools by hand.

## Tools

**Read**
- `notion_search`: find pages and databases by title.
- `notion_get_page`: properties plus a content outline with every block id.
- `notion_get_blocks`: read one section of a large page.
- `notion_find_blocks`: locate blocks by text or regex.
- `notion_get_schema`: property types, options, status groups, relations.
- `notion_query`: rows via simple `where` pairs or raw Notion filters.

**Write content**
- `notion_patch_block`: edit one block's text, checkbox, code language, or color.
- `notion_insert_blocks`: add markdown or structured blocks at the start, end, or after a specific block.
- `notion_replace_text`: find and replace across a page, keeping formatting (dry run by default).
- `notion_delete_blocks`: trash specific blocks.

**Write data**
- `notion_update_properties`: set row fields with validation.
- `notion_create_page`: new row or sub-page with content.
- `notion_bulk_update`: change every matching row (dry run by default).
- `notion_trash_page`: trash a page.

**Schema**
- `notion_add_property`: add a column.
- `notion_update_options`: add select or multi-select options. (Renaming options isn't possible through the API; see limits.)
- `notion_rename_property`: rename a column.

**Safety**
- `notion_history`: recent changes and their undo ids.
- `notion_undo`: revert a change.

The undo journal is stored in `~/.notion-plus/journal.json` (last 500 changes; set `NOTION_PLUS_HOME` to move it). Undo restores the snapshot taken at write time, so it will also overwrite later edits to the same fields. Undoing `notion_update_options` deletes the added options, which also clears them from any rows that used them since.

## Known Notion API limits

- A block's type can't be changed in place; insert a new block and delete the old one.
- Blocks can't be moved; insert a copy where you want it and delete the original.
- Status options and Notion's built-in database automations can't be created or edited through the API.
- Synced blocks, AI blocks, and some embeds are read-only.
- Last-edited times are rounded to the minute, so the freshness check catches edits made in an earlier minute.
- Select option names and colors can't be changed through the API. Renames are accepted and silently ignored; color changes are rejected. Rename options in Notion, or add a new option, move rows with `notion_bulk_update`, and delete the old option in Notion.
- Leaving an option out of a schema update deletes it and clears it from every row.
- One write can carry at most 100 relations or people, and at most 100 rich text segments per block or property (each segment up to 2000 characters). This server splits long text into segments and returns a clear error past those limits instead of truncating.
- `blocks.children.append` accepts 2 levels of nesting per request; deeper content is added in follow-up requests automatically.
- Page reads include at most 25 items of a title, rich text, relation, or people value. Undo snapshots and before/after previews re-read the full value, so nothing is lost; `notion_get_page` and bulk dry-run previews may still show only the first 25.
- New databases take a few seconds to appear in `notion_search`.
- Notion merges adjacent text segments with identical formatting when you read them back, and normalizes link URLs (for example adding a trailing `/`).
- Undoing a large insert trashes blocks one request at a time (about 3 per second).

## Development

```bash
npm test            # offline unit tests (no network)
npm run typecheck   # src, scripts, and tests
npm run smoke       # live test against a real workspace
```

`npm run smoke` needs `NOTION_TOKEN` and `NOTION_TEST_PAGE` (a page shared with the integration), from the environment or a local `.env` file (gitignored). It creates two throwaway databases under that page, runs every tool including dry runs and `notion_undo` for each write type, then moves them to the trash. It never writes outside the test page, and its undo journal goes to a temp folder. Set `SMOKE_KEEP=1` to keep the databases for inspection.

## Roadmap

- **Automations:** rules and schedules that run as GitHub Actions cron jobs, for example "stamp Completed Date when Status is Done" or "archive rows untouched for 30 days."
- Page templates, comments, and move/copy helpers.
