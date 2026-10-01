# notion-plus-mcp-server

A local MCP server for Notion built for precise edits. It changes exactly the block or field you point at, checks every value against the database schema before writing, previews risky changes, and records undo for the writes it supports (best effort; see [Undo coverage](#undo-coverage)).

## Why this instead of the built-in Notion connector

| | Built-in connector | notion-plus |
|---|---|---|
| Editing page content | Rewrites content | Patches one block by id, inserts at an exact position, find/replace that keeps formatting and mentions |
| Setting properties | Values passed through as-is | Validated against the schema; forgiving name and option matching; all errors reported at once |
| Bulk changes | One call per row | Filtered bulk update with dry-run preview and rate limiting |
| Mistakes | Manual cleanup | Writes return an `undo_id` with its coverage; `notion_undo` reverts what it can and refuses if things changed since |
| Stale overwrites | Not detected | Optional `expected_last_edited_time` refuses to write over newer edits |
| Schema changes | Limited | Create databases with relations, rollups, formulas, unique IDs, and status groups; add, rename, retype, or delete properties; manage options and number formats. Deleted properties keep their values for undo |
| Views | Not available | Create, edit, and delete table, board, list, calendar, timeline, gallery, form, chart, map, and dashboard views |

## Setup

**1. Create a Notion integration.** Go to https://www.notion.so/profile/integrations, create an internal integration, enable read content, update content, insert content, and (if you want automations to comment) insert comments, then copy the secret. To set people properties by name or email, also enable "Read user information including email addresses". Personal access tokens can't look up users at all; with one, pass user ids.

**2. Share pages with it.** In Notion, open each top-level page or database you want Claude to reach, click `•••` → `Connections`, and add the integration. Everything under a shared page is included.

**3. Install.** Two ways:

- **One-click bundle (Claude Desktop and Cowork).** Download the `.mcpb` file for your computer (`darwin-arm64` for Apple silicon Macs, `darwin-x64` for Intel Macs, `win32-x64`, `linux-x64`) from the [Releases](https://github.com/katekruger/notion-mcp/releases) page, double-click it (or drag it onto Claude Desktop's Settings → Extensions), and paste your integration secret when asked. You can also pick a folder uploads may come from and your time zone. Cowork runs inside Claude Desktop and uses the extensions installed there. Skip to step 5.
- **From source** (for Claude Code, or to run automations). Requires Node 22 or later.

```bash
git clone https://github.com/katekruger/notion-mcp.git
cd notion-mcp
npm ci
npm run build
```

To update later: `git pull && npm ci && npm run build`, then restart Claude (or start a new Claude Code session).

To build a bundle yourself: `npm run bundle` writes `bundles/notion-plus-<version>-<platform>-<arch>.mcpb`. Bundles are per platform because chart images use a native renderer; pushing a `v*` tag builds all four in GitHub Actions and attaches them to a release.

**4. Connect it to Claude** (from source). Use the full path to your clone.

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

**5. Check it works.** Ask Claude to "run notion_doctor". It checks the settings, the token, the integration's capabilities, whether any pages are shared with it, the local state folder, upload folders, and the chart renderer, and says how to fix anything that fails. Then ask "search Notion for <a page title>"; you should see `notion_search` results with ids. If a setting is invalid (a misspelled time zone, say), the server still starts and every tool answers with the exact setting to fix. To call tools by hand instead, run `NOTION_TOKEN=ntn_... npm run inspect` to open the MCP Inspector.

**6. Optional: scheduled automations.** See [Automations](#automations) and [GitHub Actions](#github-actions) below.

## Tools

Every tool answers with the same JSON shape:

```json
{
  "status": "ok | partial | error",
  "summary": "one line",
  "data": { "...the tool's own result..." },
  "warnings": ["things to know, such as what couldn't be copied"],
  "undo": { "id": "a1b2c3d4", "coverage": "full | partial | none" },
  "pagination": { "next_cursor": "…" },
  "next_actions": ["what to do next, when there's something to do"]
}
```

Only `status`, `summary`, and `data` are always there. Results that would be too large shrink their longest lists and say how many items were left out (`truncated`); they're always valid JSON. Results that carry page, block, comment, or row text include a warning that the text is untrusted data, and the server's instructions tell the model the same: content in Notion pages isn't a source of instructions.


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
- `notion_duplicate_page`: copy a page with its content, icon, cover, properties, sub-pages, and databases (schema and rows, or schema only with `databases: "schema"`). Sub-pages and databases keep their place in the page.
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
- `notion_history`: changes and their undo ids, newest first, paged with `cursor`. Each says whether it's undoable, partly undoable, undone, or was interrupted part-way (with the tool's input, to check by hand).
- `notion_doctor`: check the setup and say how to fix what isn't working. Changes nothing.
- `notion_capabilities`: what the server can do with this integration (probed with read-only calls), the API version, and the limits that matter for planning.
- `notion_undo`: revert a change. Refuses if anything it would restore was edited afterward, and lists what; pass `force: true` to overwrite.

**Automations** (see below)
- `notion_automation`: list, add, update, validate, dry-run, enable, disable, delete, and run rules, and see recent runs.

### API version

The server pins Notion API version `2026-03-11` (set `NOTION_VERSION` to override). That version renamed `archived` to `in_trash`, `transcription` blocks to `meeting_notes`, and replaced the flat `after` parameter of block appends with `position`; this server already used the new forms, and the full live suite passes on it.

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

The undo journal is stored in `~/.notion-plus/workspaces/<integration id>/journal.json` (last 500 changes; see [Local state](#local-state)). Each write is journaled before it reaches Notion: if the server stops mid-write, `notion_history` shows the entry as `interrupted` with the tool's input, so you can check those objects by hand. Undo restores the snapshot taken at write time. Before writing, it checks every page, block, or database it would restore; if any was edited after the original change (by a person, or by a later change through this server, which it names), it writes nothing and lists them. The check is per object, so an edit to a different field of the same page also counts, and edits in the same minute as the original change can't be seen. Undoing added options deletes them, which also clears them from any rows that used them since. Schema changes are the exception to the edit check: a database's edit time moves with every schema change, so it can't tell whose change it was; schema undo only touches the property it names.

### Visuals: which to use

1. **Native Notion content** for structure and diagrams: callouts, columns, tables, equations, and Mermaid diagrams (```` ```mermaid ```` code blocks: flowcharts, sequence, Gantt, pie, timeline). Mermaid is checked before writing so a typo doesn't leave an error box.
2. **Chart views** (`notion_views` with `type: "chart"`) when the data lives in a Notion database: they stay live, filter with the database, and people can click through. They can sit on any page as a linked view.
3. **Chart images** (`notion_create_chart`) for chart types Notion lacks (area, scatter, grouped, multi-line), data from outside Notion, or a fixed snapshot. Images use one colorblind-checked palette, thin marks, direct value labels, and a legend whenever there's more than one series; past eight series the smallest fold into "Other". Notion shows an image the same way in light and dark mode, so pick the surface with `theme`: `light` (default), `dark` (Notion's dark background), or `transparent` (no background and mid-gray text that reads on either). `build_report` charts take the same `theme`. The recipe is stored in `charts.json` in the [local state](#local-state) folder, and `refresh_block_id` redraws a chart from current data in the same block.
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

### Undo coverage

Undo is best effort: it covers the writes below, from a snapshot taken at write time, and refuses when something it would restore was edited afterward.

| Write | Undo |
|---|---|
| Property values, page title/icon/cover/lock, moves | Restores the previous values |
| Inserted, copied, or report blocks; created pages, rows, databases | Trashes them |
| Patched or replaced blocks, find and replace | Restores the previous content |
| Deleted blocks, trashed pages | Restores them from the trash |
| Schema changes, including deleted properties | Restores the property and up to 2000 rows' values |
| Comments added by this server | Deletes them |
| Views created, changed, or deleted | Deletes, restores, or re-creates them |
| Chart refreshes | Puts back the previous image (when it could be downloaded) |
| Automation runs | Everything above that the run did, as one entry |

Results say `coverage: "partial"` when part of a write can't be reverted (the entry names what), and `none` when nothing can. Undo can't see edits in the same minute as the original change (Notion reports edit times to the minute), entries roll off after 500 changes, and comments by other integrations, re-created unique IDs, and Notion-hosted files that expired can't be restored. A write interrupted by a crash is journaled as `interrupted` before it starts, so it's visible but may have nothing to undo.

## Known Notion API limits

- A block's type can't be changed in place; insert a new block and delete the old one.
- Blocks can't be moved, so `notion_copy_blocks` with `move: true` copies and then trashes the original: moved blocks get new ids and lose their comments. It refuses moves that would lose content the API can't recreate (databases, read-only blocks) or break synced-block references. Pages are moved natively.
- There's no API for duplicating a page or a database; `notion_duplicate_page` rebuilds both. Databases directly on the page are recreated in place with their schema and up to 500 rows per data source (values and content); relations inside the copied database point at the copied rows, while a two-way relation to a database outside the copy becomes one-way so nothing outside the copy changes. Views aren't copied (the copy gets a default table view), and linked database views can't be read through the API, so both are reported. Notion only creates pages and databases directly on a page, so sub-pages inside toggles or columns go to the end of the copy and databases there are skipped.
- Button blocks can't be created or read through the API. Breadcrumbs, bookmarks, and links to pages don't appear in Notion's markdown export; this server fills them in. Code captions aren't in the markdown export either.
- A heading 4 can't be updated without resending its text; `notion_patch_block` handles that.
- Notion's built-in database automations can't be created or edited through the API. Button blocks, AI blocks, and some embeds are read-only (the API returns them as `unsupported`).
- Map views need a place property (`map_by`). Dashboards can be created and given widgets, but the widget layout beyond "new row" or "existing row" is set in Notion.
- A chart image can be replaced in place, but Notion won't take an old file link back, so a refresh keeps a copy of the previous image in `~/.notion-plus/charts/` for undo.
- Status options can be added, each in a group (To-do, In progress, Complete). Options sent without a group all land in To-do, so this server guesses the group from the option name ("Done" → Complete) and says so.
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

Rules run on a schedule in GitHub Actions (or locally with `npm run automations`). Rules you manage from Claude are saved in `rules.json` in the [local state](#local-state) folder, so they survive reinstalling or upgrading the server; the GitHub workflow runs the committed `automations/rules.json` (it sets `NOTION_PLUS_RULES` to it). Upgrading from 0.9 or earlier, rules already in `automations/rules.json` of your checkout are copied to the new location the first time. A rule picks rows with a condition, runs at set times, or both, and acts on what it finds. Manage rules from Claude with `notion_automation` ("add an automation that…"), which checks each rule against the live database and previews it before saving.

```json
{
  "version": 1,
  "timezone": "America/New_York",
  "rules": [
    {
      "id": "at-risk",
      "schedule": "weekdays 09:00",
      "database": "https://www.notion.so/…",
      "when": { "where": { "Due": { "before": "today" }, "Status": { "not_in": ["Done", "At Risk"] } } },
      "actions": [{ "set": { "Status": "At Risk" } }, { "comment": "Past due: {{page.Task}} was due {{page.Due}}" }]
    },
    {
      "id": "stamp-completed",
      "database": "https://www.notion.so/…",
      "when": { "where": { "Status": "Done", "Completed Date": null } },
      "actions": [{ "set": { "Completed Date": "{{today}}" } }],
      "then": [{ "refresh_chart": "<chart image block id>" }]
    },
    {
      "id": "weekly-report",
      "schedule": "weekly mon 08:00",
      "then": [{ "build_report": { "database": "https://www.notion.so/…", "parent": "https://www.notion.so/…", "title": "Week of {{today}}" } }]
    }
  ]
}
```

**When a rule runs.** With only `when`, every run (hourly in GitHub Actions) checks for matching rows. With a `schedule` (`"hourly"`, `"daily 09:00"`, `"weekdays 09:00"`, `"weekly mon 09:00"`, `"monthly 1 09:00"`, or 5-field cron, in the file's `timezone`), the rule fires once per scheduled time, on the first run at or after it; with both, the condition is checked only at those times. Because the workflow runs at minute 17, "weekdays 09:00" fires at about 9:17.

**Conditions (`when`)**: `where` and `filter` work exactly like `notion_query`, including operators and relative dates. `relative` takes `{property, older_than_days | newer_than_days}` for a date, created time, or last edited time property, or `"$created"` / `"$last_edited"`.

**Row actions (`actions`)**, applied to each matching row: `{"set": {...}}` (validated like `notion_update_properties`), `{"append": "markdown"}` or blocks, `{"comment": "text"}`, `{"trash": true}`.

**Follow-up actions (`then`)**, run once per firing after the row actions (and, when the rule has a condition, only if it acted on at least one row):
- `{"refresh_chart": "<block id>"}`: redraw a chart made by `notion_create_chart` or a report. When you save the rule through `notion_automation`, the chart's recipe is copied into the rule so the GitHub runner can redraw it.
- `{"build_report": {...}}`: the same arguments as `notion_build_report`. `replace_previous` (on by default) trashes the report this rule built last time.
- `{"create_page": {"parent", "title", "template"?, "properties"?, "markdown"?}}`.

Strings can use `{{today}}` (in the file's `timezone`), `{{now}}`, and in row actions `{{page.<Property>}}`, `{{page.url}}`, `{{page.id}}`.

**Each rule acts once per row.** A rule must stop matching a row after acting on it, or it would act again on every run. The runner refuses a rule unless it writes a value its condition no longer matches (for example `Status: {"not_in": ["Done", "At Risk"]}` then setting `"At Risk"`), trashes the row, or names a `marker`: a checkbox property the runner requires to be unchecked and then checks. Scheduled rules also remember which scheduled time they last fired for, so a time fires once even if runs overlap or repeat.

**Order, retries, and partial failure.** Each row's actions run as steps, and progress is saved after every step: first `set` values that keep the row matching, then `append` and `comment`, then the writes that take the row out of the condition (the `marker`, or `set` values for properties the condition checks), then `trash`. A row is only marked handled once everything before it landed. If a step fails, the row keeps matching, and the next run picks it up again from the step that failed, skipping the ones that succeeded. A scheduled occurrence only counts as fired when every row and every `then` action of it succeeded; otherwise the next run retries it (completed `then` actions aren't repeated), until it succeeds, a newer occurrence arrives, or you `waive` it. An edited rule starts unfinished rows over. Each rule's run reports `succeeded`, `partial` (some steps failed or were left for the next run), `failed`, or `skipped` (not due).

**Other options**: `enabled` (default true), `limit` (rows per run, default 50; the rest wait for the next run), `allow_new_options`, `data_source_name`, `name`.

### Managing rules from Claude

`notion_automation` handles every step: `list`, `get`, `add`, `update` (merge fields), `validate` (check a rule and preview what it would do), `dry_run` (never writes; `force: true` ignores schedules), `enable`, `disable`, `delete`, `run` (writes; one undo id per rule; returned as an error unless every rule succeeded, with the details and undo ids kept), `history` (local runs, newest first, paged with `limit` and `cursor`), `waive` (give up on a rule's unfinished firing: the occurrence counts as fired and unfinished rows start over), `export` and `import` (the whole rules file as JSON; `import_mode` `merge` or `replace`), and `deploy` (the rules file with chart recipes embedded, plus the steps to run it in GitHub Actions). `list` and `get` return the file's `revision`; passing it back as `expected_revision` refuses the edit if the file changed in the meantime.

### Running locally

```bash
npm run automations -- --dry-run            # preview every enabled rule that's due
npm run automations -- --dry-run --force    # preview as if every schedule were due
npm run automations -- --rule at-risk --force
npm run automations                         # apply
```

One run stops starting new rows once it reaches any of its limits: 200 rows (`--max-rows`, `AUTOMATIONS_MAX_ROWS`; the old `--max-writes` still works), 3000 Notion requests (`--max-requests`), 5000 appended blocks (`--max-blocks`), or 20 minutes (`--max-minutes`). Rows left over run next time, and the run reports `partial`. A failing rule is reported and the others still run. The command exits non-zero unless every rule succeeded, and logs one JSON line per event on stderr, each with the run's `run_id` (`NOTION_PLUS_LOG=text` for plain lines, `off` to silence). Each rule's run is one journal entry, so `notion_undo <undo_id>` reverts it, including deleting the comments it added and trashing pages it created. Runs are logged to `automation-runs.jsonl`, and schedule state is kept in `automation-state.json`, both in the [local state](#local-state) folder.

### GitHub Actions

`.github/workflows/automations.yml` runs every hour (at minute 17) from the committed `automations/rules.json`. It never lets two runs overlap. Schedule state (which occurrences fired, and unfinished rows and occurrences to resume) is committed after every run to the `notion-automations-state` branch, which only holds `automation-state.json` (no page content). Once that branch exists, a run whose state can't be restored stops instead of re-firing old occurrences. The undo journal and run log carry over in the Actions cache (best effort: an evicted cache only shortens undo history) and are uploaded as an artifact (`notion-plus-journal-<run id>`, kept 90 days). When a run fails or is partial, it opens an issue labeled `notion-automations` (creating the label if needed) or comments on the open one; if that isn't possible, the job summary says so. The manual **Run workflow** button takes `dry_run` (on by default), `rule`, and `force`.

**One-time setup**

1. **Make a token for the job.** Create a separate internal integration (step 1 of [Setup](#setup)) and share only the pages and databases your rules touch with it (including report parents). Enable insert comments if rules comment. This limits what the scheduled job can reach.
2. **Add it as a repository secret.** Open the repo on GitHub, click the repo's **Settings** tab, then **Secrets and variables → Actions → New repository secret**. Name it `NOTION_TOKEN` and paste the token.
3. **Test the workflow.** Go to **Actions → Notion automations → Run workflow**, leave "dry run" checked, and run it. A green run whose summary lists your rules (or "No enabled rules.") means the token and workflow work.

**Adding a rule**

1. In Claude, ask for it in plain words, for example: "Every weekday at 9am, mark rows past their due date as At Risk and add a comment." Claude uses `notion_automation`, which checks the rule against the live database, shows the rows it would act on, and saves it on your machine.
2. Ask Claude to deploy the rules (`notion_automation` `deploy`), save the returned file as `automations/rules.json` in your repository, and commit and push it. (If you work in a checkout with `NOTION_PLUS_RULES` pointing at `automations/rules.json`, edits land there directly.)
3. Run the workflow once by hand with "dry run" checked (and "force" to see a scheduled rule now), and read the summary. After that, the hourly runs apply it.

To pause a rule, disable it (or set `"enabled": false`) and push. To give up on an occurrence that keeps failing, `waive` it (locally, on a state file restored from the `notion-automations-state` branch) or fix the cause; it's retried every run until then. To stop everything, disable the workflow under **Actions → Notion automations → ••• → Disable workflow**.

**Undoing a scheduled run**

Download the run's `notion-plus-journal-<run id>` artifact, unzip it into a folder (it keeps the `workspaces/<integration id>/` layout), point `NOTION_PLUS_HOME` at that folder (in your Claude config, or `NOTION_TOKEN=… NOTION_PLUS_HOME=… npm run inspect`), and call `notion_undo` with the undo id from the run summary.

GitHub may start scheduled runs a few minutes late, and turns off schedules in repos with no activity for 60 days.

### What Notion itself can't do through the API

- **Notion's built-in database automations** (the ⚡ button in a database) can't be created, read, or changed through the API. Rules here are the programmable alternative; they poll rather than react instantly.
- **Webhooks** can push changes the moment they happen, but Notion needs a public HTTPS URL to deliver them, and a local server doesn't have one. A future option: a small hosted endpoint (or a tunnel such as Cloudflare Tunnel) that receives the webhook and triggers the workflow with `workflow_dispatch`, so rules run within seconds instead of within the hour.

## Modes

| Mode | What runs it | Rules | State |
|---|---|---|---|
| Interactive | Claude Desktop, Cowork, or Claude Code, through this server | Edited with `notion_automation`, kept in your home folder | Local state folder |
| Local scheduled | `npm run automations` from cron or a task scheduler | Same file as interactive | Same folder |
| GitHub runner | `.github/workflows/automations.yml`, hourly | The committed `automations/rules.json` (use `notion_automation` `deploy`) | `notion-automations-state` branch, journal in the Actions cache |
| Webhook (planned) | A small service that reacts to Notion events | | |

## Local state

Everything the server remembers lives under `~/.notion-plus` (`NOTION_PLUS_HOME` moves it), in a folder per integration: `workspaces/<integration id>/`, with `journal.json` (undo history), `charts.json` (chart recipes), `automation-state.json` (which scheduled occurrences fired), and `automation-runs.jsonl` (run log). Two integrations sharing a machine never mix their history. `NOTION_PLUS_WORKSPACE` sets the folder name instead of looking up the integration; `NOTION_PLUS_STATE` moves just the automation state file. The first time a folder is created, state from older versions (kept directly in `~/.notion-plus`) is copied into it.

These files are safe to share between several servers at once (Claude Desktop, Cowork, Claude Code, the scheduled runner): each change is made under a lock, written to a temporary file, flushed, and swapped in, with the previous version kept as `<file>.bak`. If a file can't be read (cut off by a crash or a full disk, edited by hand into invalid JSON, or not readable), the server stops with an error naming it instead of treating it as empty, since that would lose undo history or repeat scheduled automations. Fix the file, restore the `.bak`, or move it away to start fresh. A leftover `<file>.lock` from a process that died is cleared automatically.

## Development

```bash
npm test                 # offline unit and property tests with vitest (no network)
npm run test:coverage    # the same, failing if coverage drops below the thresholds in vitest.config.ts
npm run lint             # ESLint (typescript-eslint strict)
npm run typecheck        # src, scripts, and tests
npm run check            # lint, typecheck, tests with coverage, build; CI runs this on Node 22 and 24
npm run check:version    # package.json, manifest.json, package-lock.json, and CHANGELOG.md agree
npm run test:live        # live integration suite against a real workspace
npm run bundle && node scripts/bundle-smoke.mjs   # build this platform's bundle and install-test it
```

CI also fails on known high-severity advisories in runtime dependencies, reviews new dependencies in pull requests, and Dependabot proposes updates weekly. Every GitHub Action is pinned to a commit. A release builds a bundle on each platform, install-tests it (unpack, start, list every tool, render a chart), and publishes it with `sha256sums.txt`, an SBOM, and build provenance.

**Live tests in CI.** `.github/workflows/live.yml` runs the smoke and acceptance suites nightly and on release tags once two repository secrets exist: `NOTION_TOKEN` (an integration used only for testing, in a throwaway workspace) and `NOTION_TEST_PAGE` (a page shared with it). Until then it passes with a notice. It never runs for pull requests, so forks can't reach the secrets.

### Evaluations and acceptance tests

- `evals/notion-plus.xml` holds 10 realistic, read-only questions (in the MCP evaluation format) that each need several tools to answer: aggregation, relations, schema, views, page content, and comments. `npm run eval:seed` builds the fixed dataset they're written against under your test page; `npm run eval:verify` answers every question through the tools and checks the expected answers. To measure how well a model picks tools, run the questions with the MCP evaluation harness against this server.
- `npm run acceptance` runs the seven acceptance scenarios (project tracker, views, report page, find/replace with preview and undo, the At Risk and Completed Date automations, and a 300-row bulk update with undo) and leaves the results under an "Acceptance <date>" page.

`npm run test:live` (also `npm run smoke`) needs `NOTION_TOKEN` and `NOTION_TEST_PAGE` (a page shared with the integration), from the environment or a local `.env` file (gitignored). It creates two throwaway databases under that page, runs every tool including dry runs and `notion_undo` for each write type, then moves them to the trash. It never writes outside the test page, and its undo journal goes to a temp folder. Set `SMOKE_KEEP=1` to keep the databases for inspection.

Versions follow semver; see [CHANGELOG.md](CHANGELOG.md) and, for supported versions and deprecations, [SUPPORT.md](SUPPORT.md).

## Roadmap

Built in phases, each ending with the build, unit tests, and the live suite passing:

1. Foundations: tests, lint, CI, timeouts, partial-failure reporting, safer undo. (done, 0.2.0)
2. Content: every creatable block type, rich text colors and mentions, markdown round trip, move/copy/duplicate, icons, covers, templates, comments. (done, 0.3.0)
3. Databases: create with full schemas, schema editing (including status options), every property type, aggregation, bulk create. (done, 0.4.0)
4. Views and visuals: views including native chart views, generated chart images, Mermaid, report pages. (done, 0.5.0)
5. Automations: schedules, run state, more actions, full management from Claude. (done, 0.6.0)
6. Distribution: MCP Bundle, tool evaluations, acceptance tests, API version 2026-03-11. (done, 0.7.0)

Possible next steps: webhooks through a small hosted relay for instant automations.
