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

**1. Create a Notion integration.** Go to https://www.notion.so/profile/integrations, create an internal integration, enable read content, update content, insert content, and (if you want automations to comment) insert comments, then copy the secret. To set people properties by name or email, also enable "Read user information including email addresses". Personal access tokens can't look up users at all; with one, pass user ids.

**2. Share pages with it.** In Notion, open each top-level page or database you want Claude to reach, click `•••` → `Connections`, and add the integration. Everything under a shared page is included.

**3. Install.** Requires Node 20 or later.

```bash
git clone https://github.com/katekruger/notion-mcp.git
cd notion-mcp
npm ci
npm run build
```

To update later: `git pull && npm ci && npm run build`, then restart Claude (or start a new Claude Code session).

**4. Connect it to Claude.** Use the full path to your clone.

Claude Code:

```bash
claude mcp add notion-plus --env NOTION_TOKEN=ntn_your_secret_here -- node /ABSOLUTE/PATH/TO/notion-mcp/dist/index.js
claude mcp list   # notion-plus should show as connected
```

Claude Desktop: open Settings → Developer → Edit Config, and add this to `claude_desktop_config.json`, then restart Claude Desktop:

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

Turn off the built-in Notion connector while using this one so Claude doesn't pick between two sets of Notion tools. Keep the token out of the repo: it belongs only in your Claude config (or a local `.env`, which is gitignored).

**5. Check it works.** Ask Claude "search Notion for <a page title>". You should see `notion_search` results with ids. To call tools by hand instead, run `NOTION_TOKEN=ntn_... npm run inspect` to open the MCP Inspector.

**6. Optional: scheduled automations.** See [Automations](#automations) and [GitHub Actions](#github-actions) below.

## Tools

**Read**
- `notion_search`: find pages and databases by title.
- `notion_get_page`: properties plus a content outline with every block id, or (`format: "markdown"`) the whole page as Notion-flavored markdown that can be written back.
- `notion_get_blocks`: read one section of a large page.
- `notion_find_blocks`: locate blocks by text or regex.
- `notion_get_schema`: property types, options, status groups, relations.
- `notion_query`: rows via `where` (equality, operators, `in`, `or`/`and`, relative dates) or raw Notion filters.
- `notion_aggregate`: counts, sums, averages, and more, grouped by any property or date bucket, without pulling rows into context.

**Write content**
- `notion_patch_block`: edit one block's text, checkbox, code language or caption, color, toggle heading, callout icon, or a table row's cells.
- `notion_insert_blocks`: add markdown or structured blocks at the start, end, or after a specific block.
- `notion_replace_text`: find and replace across a page's text, table cells, captions, and title, keeping formatting (dry run by default).
- `notion_delete_blocks`: trash specific blocks.
- `notion_copy_blocks`: copy blocks with everything inside them to another spot, or move them (`move: true`, dry run by default).
- `notion_comments`: list, add, and reply to comments.

**Pages**
- `notion_update_page`: title, icon, cover, lock, or move a page under another page or into a database.
- `notion_duplicate_page`: copy a page with its content, icon, cover, properties, and sub-pages.
- `notion_list_templates`: a database's templates, for `notion_create_page`'s `template`.

**Write data**
- `notion_update_properties`: set row fields with validation.
- `notion_create_page`: new row or sub-page with content, an icon and cover, or from a database template.
- `notion_bulk_update`: set values on every matching row, or different values per row (dry run by default, up to 500 rows).
- `notion_bulk_create`: add up to 1000 rows from JSON or CSV (dry run by default; every row validated first).
- `notion_trash_page`: trash a page.

**Databases**
- `notion_create_database`: a database with its full schema in one call: options (status options with groups), number formats, formulas, one- or two-way relations (including to itself), rollups, unique IDs, files, places.
- `notion_schema`: add, rename, or delete a property (delete previews first and undo restores the values), add select/multi-select/status options, change number formats and descriptions.

**Views and visuals**
- `notion_views`: list, read, create, update, and delete views: table, board, list, calendar, timeline, gallery, form, map, dashboard, and Notion's native chart views (column, bar, line, donut, number, with stacking). A view can be a database tab, a linked view placed anywhere on a page, or a dashboard widget.
- `notion_create_chart`: render a chart image (bar, column, stacked, grouped, line, area, pie, donut, scatter) from inline data or a database query, and refresh it in place later.
- `notion_build_report`: a report page for a database: summary, KPI numbers, live and image charts, a table of key rows (such as overdue items), and a Mermaid Gantt chart.

**Safety**
- `notion_history`: recent changes and their undo ids.
- `notion_undo`: revert a change. Refuses if anything it would restore was edited afterward, and lists what; pass `force: true` to overwrite.

**Automations** (see below)
- `notion_automation_list`: show the rules.
- `notion_automation_add`: check a rule against the live schema, save it, and preview what it would do.
- `notion_automation_dry_run`: show what each rule would change right now. Never writes.

### Content formats

`notion_insert_blocks` and `notion_create_page` take `markdown` or structured `blocks`, and both can express every block type the API can create:

| Content | Markdown | Structured block |
|---|---|---|
| Headings 1–4, toggle headings | `#`…`####`, `## Title {toggle="true"}` with indented children | `heading_1`…`heading_4`, `toggleable` |
| Lists, to-dos, nesting | `-`, `1.`, `- [ ]`, indent to nest (any depth) | `children` |
| Callouts | `> [!NOTE]` / `[!TIP]` / `[!IMPORTANT]` / `[!WARNING]` / `[!CAUTION]`, or `<callout icon="🔥" color="red_bg">` | `callout` with `icon` (emoji, URL, or local image) and `color` |
| Toggles | `<details><summary>Title</summary> … </details>` | `toggle` |
| Tables | pipe tables, or `<table header-row="true"><tr><td>…` | `table` with `rows`, `header_row`, `header_column` |
| Columns | `<columns><column> … </column></columns>` | `column_list` with `columns` |
| Tabs | `<tabs><tab>Title … </tab></tabs>` | `tab` with `tabs: [{title, children}]` |
| Code, Mermaid diagrams | ```` ```python ````, ```` ```mermaid ```` | `code` with `language`, `caption` |
| Equations | `$$ … $$` (block), `$x^2$` (inline) | `equation` with `expression` |
| Images, files, PDF, video, audio | `![caption](url)`, `<file src="…"/>` | `image` etc. with `url` (web URL or local path; local files are uploaded) |
| Bookmarks, embeds | `<bookmark url="…"/>`, `<embed src="…"/>` | `bookmark`, `embed` |
| Synced blocks | `<synced_block> … </synced_block>` (new), `<synced_block url="…">` (reference) | `synced_block` with `children` or `synced_from` |
| Links to pages, TOC, breadcrumb | `<link-to-page url="…"/>`, `<table_of_contents/>`, `<breadcrumb/>` | `link_to_page`, `table_of_contents`, `breadcrumb` |
| Dividers | `---` | `divider` |

Inline: `**bold**`, `*italic*`, `` `code` ``, `~~strike~~`, `<u>underline</u>`, `[link](url)`, `$x^2$`, `<span color="red">…</span>` (any color, or `blue_bg` for backgrounds), and mentions: `<mention-page url="…"/>`, `<mention-user email="…"/>`, `<mention-date start="2026-10-01"/>`. A block's color goes at the end of its line: `Text {color="blue"}`.

These are the same tags Notion's markdown export uses, so `notion_get_page` with `format: "markdown"` returns markdown you can edit and insert back; the live test suite checks that a full page survives the round trip line for line. Local files can be uploaded from the working directory and the temp folder; set `NOTION_PLUS_UPLOAD_DIRS` (separated by `:`, or `;` on Windows) to allow other folders.

The undo journal is stored in `~/.notion-plus/journal.json` (last 500 changes; set `NOTION_PLUS_HOME` to move it). Undo restores the snapshot taken at write time. Before writing, it checks every page, block, or database it would restore; if any was edited after the original change (by a person, or by a later change through this server, which it names), it writes nothing and lists them. The check is per object, so an edit to a different field of the same page also counts, and edits in the same minute as the original change can't be seen. Undoing added options deletes them, which also clears them from any rows that used them since. Schema changes are the exception to the edit check: a database's edit time moves with every schema change, so it can't tell whose change it was; schema undo only touches the property it names.

### Visuals: which to use

1. **Native Notion content** for structure and diagrams: callouts, columns, tables, equations, and Mermaid diagrams (```` ```mermaid ```` code blocks: flowcharts, sequence, Gantt, pie, timeline). Mermaid is checked before writing so a typo doesn't leave an error box.
2. **Chart views** (`notion_views` with `type: "chart"`) when the data lives in a Notion database: they stay live, filter with the database, and people can click through. They can sit on any page as a linked view.
3. **Chart images** (`notion_create_chart`) for chart types Notion lacks (area, scatter, grouped, multi-line), data from outside Notion, or a fixed snapshot. Images use one colorblind-checked palette, thin marks, direct value labels, and a legend whenever there's more than one series; past eight series the smallest fold into "Other". They are light-themed PNGs, so they don't switch in dark mode. The recipe is stored in `~/.notion-plus/charts.json`, and `refresh_block_id` redraws a chart from current data in the same block.
4. **Embeds** (`embed` blocks) for interactive charts hosted elsewhere, when neither of the above fits.

`notion_build_report` combines these: it uses a live chart view where Notion supports the chart type and renders an image otherwise.

### Queries and aggregation

`where` in `notion_query`, `notion_aggregate`, `notion_bulk_update`, and automation rules accepts:

```json
{
  "Status": {"in": ["Done", "At Risk"]},
  "Due": {"before": "today"},
  "Estimate": {">": 500, "<=": 1000},
  "Tags": "Q4",
  "Owner": null,
  "or": [{"Priority": "High"}, {"Task": {"contains": "urgent"}}],
  "$last_edited": {"after": "-7d"}
}
```

Operators: `=`, `!=`, `>`, `>=`, `<`, `<=`, `contains`, `not_contains`, `starts_with`, `ends_with`, `in`, `not_in`, `is_empty`, `before`, `after`, `on_or_before`, `on_or_after`, and date ranges such as `past_week` or `next_month`. Dates accept `today`, `tomorrow`, `yesterday`, and offsets like `+7d`, `-2w`, `+1m` (in `NOTION_PLUS_TIMEZONE`, default the system zone). Property names and option values are matched forgivingly and checked against the schema.

`notion_aggregate` takes `group_by` (a property, or `{"property": "Due", "by": "month"}`) and `metrics` such as `["count", "sum:Estimate", "avg:Estimate"]`. Rows with several values (multi-select, people, relations) count once in each of their groups, and relation groups show the related rows' titles. It scans up to 10,000 rows by default (`max_rows`, up to 50,000).

Relation values in writes can be page ids, links, or the related row's exact title.

## Known Notion API limits

- A block's type can't be changed in place; insert a new block and delete the old one.
- Blocks can't be moved, so `notion_copy_blocks` with `move: true` copies and then trashes the original: moved blocks get new ids and lose their comments. It refuses moves that would lose content the API can't recreate (databases, read-only blocks) or break synced-block references. Pages are moved natively.
- There's no API for duplicating a page; `notion_duplicate_page` rebuilds it. Databases inside the page aren't copied (they're listed as skipped), and sub-pages land at the end of the copy.
- Button blocks can't be created or read through the API. Breadcrumbs, bookmarks, and links to pages don't appear in Notion's markdown export; this server fills them in. Code captions aren't in the markdown export either.
- A heading 4 can't be updated without resending its text; `notion_patch_block` handles that.
- Notion's built-in database automations can't be created or edited through the API. Button blocks, AI blocks, and some embeds are read-only (the API returns them as `unsupported`).
- Map views need a place property (`map_by`). Dashboards can be created and given widgets, but the widget layout beyond "new row" or "existing row" is set in Notion.
- A chart image can be replaced in place, but Notion won't take an old file link back, so a refresh keeps a copy of the previous image in `~/.notion-plus/charts/` for undo.
- Status options can be added, each in a group (To-do, In progress, Complete). Options sent without a group all land in To-do, so this server guesses the group from the option name ("Done" → Complete) and says so. Views, including chart views, are supported by the API and planned here.
- Last-edited times are rounded to the minute, so the freshness check catches edits made in an earlier minute.
- Select and status option names and colors can't be changed through the API. Renames are accepted and silently ignored; color changes are rejected. Rename options in Notion, or add a new option, move rows with `notion_bulk_update`, and delete the old option in Notion.
- Leaving an option out of a schema update deletes it and clears it from every row, so this server always sends the full list.
- Verification properties can only be created in wikis; in a regular database Notion skips them without an error (`notion_create_database` reports it).
- There's no aggregation endpoint; `notion_aggregate` reads the matching rows and summarizes them on your machine (about 100 rows per request). Rows with more than 25 relations or people are counted by their first 25.
- Deleting a property deletes its values. `notion_schema` saves up to 2000 rows' values first so undo can put them back; a re-created unique ID renumbers rows, and a re-created two-way relation re-creates its other side.
- One write can carry at most 100 relations or people, and at most 100 rich text segments per block or property (each segment up to 2000 characters). This server splits long text into segments and returns a clear error past those limits instead of truncating.
- `blocks.children.append` accepts 2 levels of nesting per request; deeper content is added in follow-up requests automatically.
- Page reads include at most 25 items of a title, rich text, relation, or people value. Undo snapshots and before/after previews re-read the full value, so nothing is lost; `notion_get_page` and bulk dry-run previews may still show only the first 25.
- New databases take a few seconds to appear in `notion_search`.
- Notion merges adjacent text segments with identical formatting when you read them back, and normalizes link URLs (for example adding a trailing `/`).
- Undoing a large insert trashes blocks one request at a time (about 3 per second).
- A comment can only be deleted by the integration that created it, so undo can remove comments this server added, but nothing else.
- Requests time out after 30 seconds (`NOTION_TIMEOUT_MS`). Reads are retried after timeouts and dropped connections; writes are not, since the first attempt may have landed. Notion's 429 and 5xx responses are retried by the client, honoring `Retry-After`.
- Results are capped at 25,000 characters. Long lists are shortened (with a count of what was left out) so the result stays valid JSON; narrow the request to see the rest.

## Automations

Rules in `automations/rules.json` run on a schedule. Each rule is a database query; every row it matches gets the rule's actions. There are no webhooks: a GitHub Actions workflow checks hourly.

```json
{
  "version": 1,
  "timezone": "America/New_York",
  "rules": [
    {
      "id": "stamp-completed",
      "database": "https://www.notion.so/…",
      "when": { "where": { "Status": "Done", "Completed Date": null } },
      "actions": [{ "set": { "Completed Date": "{{today}}" } }]
    },
    {
      "id": "archive-stale",
      "database": "https://www.notion.so/…",
      "when": { "where": { "Status": "Done" }, "relative": [{ "property": "$last_edited", "older_than_days": 30 }] },
      "actions": [{ "trash": true }],
      "limit": 20
    },
    {
      "id": "welcome-high-priority",
      "database": "https://www.notion.so/…",
      "when": { "where": { "Priority": "High" } },
      "actions": [{ "comment": "Flagged high priority: {{page.Name}}" }, { "append": "- [ ] Triage by {{today}}" }],
      "marker": "Automated"
    }
  ]
}
```

**Conditions (`when`)**: `where` and `filter` work exactly like `notion_query`. `relative` takes `{property, older_than_days}` or `{property, newer_than_days}` for a date, created time, or last edited time property, or `"$created"` / `"$last_edited"`.

**Actions**: `{"set": {...}}` (validated like `notion_update_properties`), `{"append": "markdown"}` or blocks, `{"comment": "text"}`, `{"trash": true}`. Strings can use `{{today}}` (in the file's `timezone`), `{{now}}`, `{{page.<Property>}}`, `{{page.url}}`, and `{{page.id}}`.

**Each rule acts once per row.** Because rules are re-checked every hour, a rule must stop matching a row after acting on it, or it would act again on every run. The runner refuses a rule unless it changes a property its condition checks to a different value, trashes the row, or names a `marker`: a checkbox property the runner requires to be unchecked and then checks.

**Other options**: `enabled` (default true), `limit` (rows per run, default 50; the rest wait for the next run), `allow_new_options`, `data_source_name`.

### Running

```bash
npm run automations -- --dry-run            # preview every enabled rule
npm run automations -- --rule stamp-completed
npm run automations                         # apply
```

One run acts on at most 200 rows across all rules (`--max-writes` or `AUTOMATIONS_MAX_WRITES`). A failing rule is reported and the others still run. Each rule's run is one journal entry, so `notion_undo <undo_id>` reverts it, including deleting the comments it added.

From Claude, add rules with `notion_automation_add` (it saves to the local rules file); commit `automations/rules.json` so the scheduled workflow picks them up.

### GitHub Actions

`.github/workflows/automations.yml` runs the rules hourly (at minute 17) from the committed `automations/rules.json`, and has a manual **Run workflow** button with `dry_run` (on by default for manual runs) and `rule` inputs.

**One-time setup**

1. **Make a token for the job.** Create a separate internal integration (step 1 of [Setup](#setup)) and share only the databases your rules touch with it. Enable insert comments if rules comment. This limits what the scheduled job can reach.
2. **Add it as a repository secret.** Open the repo on GitHub, click the repo's **Settings** tab (the one after Insights, not the Settings in your profile menu), then **Secrets and variables → Actions → New repository secret**. Name it `NOTION_TOKEN` and paste the token. Direct link: `https://github.com/<owner>/notion-mcp/settings/secrets/actions`.
3. **Test the workflow.** Go to **Actions → Notion automations → Run workflow**, leave "dry run" checked, and run it. A green run with "No enabled rules." in the summary means the token and workflow are working.

**Adding a rule**

1. In Claude, ask for it in plain words, for example: "Add an automation to the Projects database that stamps Completed Date with today when Status is Done and Completed Date is empty." Claude uses `notion_automation_add`, which checks the rule against the live database, shows the rows it would act on, and saves it to your local `automations/rules.json`.
2. Commit and push `automations/rules.json`.
3. Run the workflow once by hand with "dry run" checked and read the summary. After that, the hourly runs apply it.

To pause a rule, set `"enabled": false` and push. To stop everything, disable the workflow under **Actions → Notion automations → ••• → Disable workflow**.

**Undoing a scheduled run**

Each run writes its summary (with an undo id per rule) to the run page and uploads the undo journal as an artifact named `notion-plus-journal-<run id>`, kept 90 days. To revert:

1. Download the artifact from the run page and unzip it into a folder.
2. Run `NOTION_TOKEN=ntn_... NOTION_PLUS_HOME=/path/to/that/folder npm run inspect`, or point your Claude config's `NOTION_PLUS_HOME` at it.
3. Call `notion_undo` with the undo id from the run summary.

GitHub may start scheduled runs a few minutes late, and turns off schedules in repos with no activity for 60 days.

## Development

```bash
npm test            # offline unit tests with vitest (no network)
npm run lint        # ESLint (typescript-eslint strict)
npm run typecheck   # src, scripts, and tests
npm run check       # all of the above plus the build; CI runs this on every push
npm run test:live   # live integration suite against a real workspace
```

`npm run test:live` (also `npm run smoke`) needs `NOTION_TOKEN` and `NOTION_TEST_PAGE` (a page shared with the integration), from the environment or a local `.env` file (gitignored). It creates two throwaway databases under that page, runs every tool including dry runs and `notion_undo` for each write type, then moves them to the trash. It never writes outside the test page, and its undo journal goes to a temp folder. Set `SMOKE_KEEP=1` to keep the databases for inspection.

Versions follow semver; see [CHANGELOG.md](CHANGELOG.md).

## Roadmap

Built in phases, each ending with the build, unit tests, and the live suite passing:

1. Foundations: tests, lint, CI, timeouts, partial-failure reporting, safer undo. (done, 0.2.0)
2. Content: every creatable block type, rich text colors and mentions, markdown round trip, move/copy/duplicate, icons, covers, templates, comments. (done, 0.3.0)
3. Databases: create with full schemas, schema editing (including status options), every property type, aggregation, bulk create. (done, 0.4.0)
4. Views and visuals: views including native chart views, generated chart images, Mermaid, report pages. (done, 0.5.0)
5. Automations: schedules, run state, more actions, full management from Claude.
6. Distribution: MCP Bundle, tool evaluations, acceptance tests.
