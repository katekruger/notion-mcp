# Changelog

All notable changes to this project are documented here. Versions follow [semver](https://semver.org).

## 0.9.0

Durable local state (audit batch 2: P1-03, P1-04, P2-10, P3-08).

### Changed
- All local state (undo journal, chart recipes, automation state, run log) moves to a folder per integration, `~/.notion-plus/workspaces/<integration id>/`, so two integrations on one machine never mix history. Existing files are copied there the first time. `NOTION_PLUS_WORKSPACE` sets the folder name without a lookup. The scheduled workflow's artifact keeps this layout.
- State files are written atomically (unique temp file, flush, rename) with the previous version kept as `<file>.bak`, and every read-modify-write runs under a cross-process lock. Several servers can share the folder without losing each other's changes. Locks left by a process that died are cleared automatically.
- An automation run saves only the rules it ran, merged into the current state file, so concurrent runs don't erase each other's schedule history.

### Fixed
- A corrupt, cut-off, or unreadable state file no longer reads as empty (which could re-fire scheduled automations or hide undo history). The server stops with an error naming the file and how to recover. Only a missing file counts as empty.
- Writes are journaled before they reach Notion. A tool that stops with an error after writing leaves a `failed` entry, and one whose process dies leaves an entry that `notion_history` marks `interrupted`, both with the tool's input.

### Added
- `notion_automation` `list` and `get` return the rules file's `revision`. Edits accept `expected_revision` and are refused if the file changed since. Every edit now applies to the current file under its lock, so a change made elsewhere in the meantime is kept.

## 0.8.1

### Fixed
- `notion_duplicate_page` no longer reports a database as a "linked view" when reading it actually failed. Permission, auth, rate-limit, timeout, and server errors now stop the copy with the real error; only not-found (a linked view, or a source not shared with the integration) is skipped.
- Database rows are copied with all their content: sub-pages and databases inside a row are recreated under the copied row, and anything a row can't carry is listed in `skipped`. Previously these were dropped without a warning.

### Added
- Duplicate results carry `status`: `complete`, or `partial` when anything was skipped.
- `notion_duplicate_page` options `max_rows` (rows per data source) and `copy_row_content` (turn off for large databases where only values matter).
- The dry run includes an `estimate` of rows, API calls, and minutes.

## 0.8.0

### Added
- `notion_duplicate_page` copies databases on the page: every data source's schema, and (unless `databases: "schema"` or `"none"`) up to 500 rows per data source with their values and content. Relations and rollups inside the copy are re-pointed at the copied data source and rows.
- Chart `theme`: `light`, `dark` (Notion's dark background), or `transparent`, for `notion_create_chart`, stored recipes, and report charts.

### Changed
- Duplicated sub-pages and databases keep their position in the page instead of moving to the end.
- Release workflow: Intel Mac bundles build on `macos-15-intel` (`macos-13` is retired), and one platform failing no longer blocks the others from publishing.

### Fixed
- README: the comparison table and limits section understated schema support and still listed views as planned.

## 0.7.0

### Added
- MCP Bundle: `manifest.json`, `npm run bundle`, and a release workflow that builds a bundle per platform on `v*` tags. The bundle asks for the integration secret, an upload folder, and a time zone.
- `evals/notion-plus.xml`: 10 multi-step evaluation questions, with `npm run eval:seed` (fixed dataset) and `npm run eval:verify` (answers checked through the tools).
- `npm run acceptance`: the seven acceptance scenarios end to end.
- Comments read back as markdown (bold, italic, code, links).

### Changed
- Notion API version pinned to 2026-03-11 (`NOTION_VERSION` overrides).
- Chart rendering libraries load on first use, so a bundle for another platform still serves every other tool.
- Local uploads never treat the filesystem root as an allowed folder, even when the app starts the server there.
- Status groups guessed from names check to-do words first ("Not started" → To-do).
- Reports skip empty status groups in their default KPIs.

## 0.6.0

### Added
- Scheduled rules: `schedule` takes "hourly", "daily 09:00", "weekdays 09:00", "weekly mon 09:00", "monthly 1 09:00", or cron, in the rules file's time zone. Each scheduled time fires once (state kept per rule); a rule without history only catches up a recent time.
- `then` actions that run once per firing: `refresh_chart` (the chart's recipe is saved in the rule), `build_report` (replacing the previous report by default), and `create_page`.
- `notion_automation`: one tool for list, get, add, update, validate, dry_run, enable, disable, delete, run, and history.
- Run log (`automation-runs.jsonl`) and schedule state (`automation-state.json`) under `NOTION_PLUS_HOME`; `--force` for the CLI.
- GitHub Actions: state, journal, and run log carried between runs in the cache; a `force` input; an issue opened (or commented on) when a run fails.

### Changed
- `notion_automation_list`, `notion_automation_add`, and `notion_automation_dry_run` are replaced by `notion_automation`.
- The "acts once per row" check understands operators: a rule matching `Status not_in [Done, At Risk]` that sets "At Risk" is accepted.
- Chart refresh and report building moved into a shared service used by both the tools and automations.

## 0.5.0

### Added
- `notion_views`: list, get, create, update, delete views of every type (table, board, list, calendar, timeline, gallery, form, map, dashboard, chart), with filters, sorts, grouping, visible properties, and native chart settings. Views can be database tabs, linked views at an exact spot on a page, or dashboard widgets. All reversible.
- `notion_create_chart`: chart images rendered locally (Vega-Lite → PNG) with a validated, colorblind-safe palette; data inline or from a database query; refresh in place from current data, with undo.
- `notion_build_report`: report pages with a summary, KPIs, live chart views and chart images, a key-rows table (plus an optional live table), and a Mermaid Gantt chart.
- Mermaid code blocks are checked before writing.

### Changed
- Reads (including database queries, which are POSTs) retry Notion's 502/503/504 gateway errors.
- `notion_undo` returns an error when none of an entry's steps could be applied, instead of reporting success.
- Undo's edit check compares exact timestamps for objects that have them (views), and by minute for pages and blocks.



### Added
- `notion_create_database`: full schema in one call, including status options with groups, number formats, formulas, one- and two-way relations (also to the same database), rollups, unique IDs, files, and places.
- `notion_schema`: add, rename, and delete properties (delete previews affected rows and saves up to 2000 rows' values for undo), add select/multi-select/status options with status groups, change number formats and descriptions.
- `notion_aggregate`: count, count_values, count_empty, distinct, sum, avg, min, max, median, checked, percent_checked, grouped by any property or date bucket.
- `notion_bulk_create`: up to 1000 rows from JSON or CSV, every row validated first, dry run by default.
- `notion_bulk_update` `rows` mode: different values per row.
- `where` operators everywhere: comparisons, `in`, `contains`, `starts_with`, `is_empty`, date ranges, nested `or`/`and`, relative dates, and `$created` / `$last_edited`.
- Property writes: files (URLs or local files), place, verification; relations by related row title.
- Rollup arrays read as their values; places read as name and coordinates.

### Changed
- `notion_add_property`, `notion_update_options`, and `notion_rename_property` are replaced by `notion_schema`.
- Undo checks rows of a database for later edits with one query instead of one read per row.
- Schema undo no longer runs the edit check (a data source's edit time moves with every schema change).
- Bulk create, bulk update, and undo keep three requests in flight (still within Notion's rate limit): 300 rows update in about 110 seconds instead of 375.
- Undoing a created page no longer checks for later edits; the trashed page keeps them and can be restored from Notion's trash.
- Relation values with commas are read as one title unless every part is a page id or link.

## 0.3.0

### Added
- Every block type the API can create: heading 4, toggle headings, tables (header row/column), columns, tabs, callouts with emoji or image icons, equations, table of contents, breadcrumbs, bookmarks, embeds, images/files/PDF/video/audio (web URL or local file, uploaded via the File Upload API), synced blocks (new or reference), links to pages, and code captions.
- Rich text: colors and backgrounds, underline, inline equations, and page/database/user/date mentions, with formatting that nests.
- Markdown in Notion's own format (callouts, `<columns>`, `<details>`, `<table>`, `<tabs>`, colored spans, mentions) plus GitHub alerts (`> [!NOTE]`) and pipe tables, with nesting to any depth.
- `notion_get_page` `format: "markdown"`: the page as markdown that can be written back; blocks Notion's export leaves out (bookmarks, breadcrumbs, links to pages) are filled in.
- `notion_copy_blocks` (copy or move, with dry run), `notion_duplicate_page`, `notion_update_page` (title, icon, cover, lock, move), `notion_list_templates`, `notion_comments` (list, add, reply).
- `notion_create_page`: `template`, `icon` (emoji, URL, or local image), and `cover`.
- `notion_patch_block`: toggle headings, callout icons, code captions, and table row cells.
- `notion_replace_text` also covers table cells, captions, and the page title (`include_title`).

### Changed
- A request can now carry a block plus two levels below it (verified live), so nested content takes fewer requests.
- Undo checks inserted blocks for later edits with one listing of their parent instead of one read per block.
- The live suite also trashes the pages it creates.

## 0.2.0

### Added
- `notion_undo` checks whether anything it would restore was edited after the original change, and refuses with a list of those objects (naming later journal entries when the edit came from this server). `force: true` overwrites.
- Undo now deletes comments added by automation rules.
- Block inserts that fail partway record the blocks that did land, so `notion_undo` can remove them, and the error says where to resume.
- 30-second request timeout (`NOTION_TIMEOUT_MS`). Reads retry after timeouts and dropped connections; writes don't, since the first attempt may have landed.
- ESLint (typescript-eslint strict), vitest, `npm run check`, and a CI workflow that lints, typechecks, tests, and builds on every push.
- `npm run test:live` for the live integration suite, with new steps for undo conflicts and comment undo.

### Changed
- Oversized results shrink their longest list and stay valid JSON, with a count of omitted items, instead of being cut mid-text.
- The server reports its version from package.json.
- The Notion client only logs errors, not the expected not-found fallbacks.
- README: corrected API limits that Notion has since lifted (status options, views, comment deletion, page moves).

## 0.1.0

- Initial release: surgical block edits, schema-validated property writes, bulk updates with dry run, find/replace, schema tools, undo journal, polling automations with a GitHub Actions schedule.
