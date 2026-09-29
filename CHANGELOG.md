# Changelog

All notable changes to this project are documented here. Versions follow [semver](https://semver.org).

## 0.4.0

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
