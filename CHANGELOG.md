# Changelog

All notable changes to this project are documented here. Versions follow [semver](https://semver.org).

## 1.0.0-beta.1

Workflows, webhooks, and retries that don't duplicate (audit batch 6: P2-01, P2-02; P2-16 designed).

### Added
- **`notion_workflow`**: multi-step workflows (spec version 2).
  - **Triggers:** schedule, manual, or Notion webhook events.
  - **Notion steps:** `query`, `set`, `append`, `comment`, `create_page`, `move_page`, `duplicate_page`, `trash`, `replace_text`, `export_markdown`, `render_template`.
  - **Outside steps:** `http` and `slack`.
  - **Control steps:** `foreach`, `switch`, `approval`, `delay`, `run_workflow`.
  - **Per-step options:** `if`, `retry`, `timeout_seconds`, `continue_on_error`.
  - **References:** steps read each other with `${steps.<id>…}`, and the trigger, inputs, loop items, and `${secret:NAME}` the same way.
- **Durable runs.** Step state is saved as it changes.
  - Failed, paused, or interrupted runs continue after the last finished step.
  - Approvals wait for a checkbox or a comment keyword. Delays wait for their time.
  - Both are picked up by `npm run automations` or the webhook server.
- **No duplicates on retry.** A step that started but didn't finish checks what it already made before acting again, and adopts or removes it:
  - pages with the same title;
  - comments with the same text;
  - leftover appended blocks.

  HTTP steps send an `Idempotency-Key` header.
- **Webhook mode:** `npm run webhook`, plus a `Dockerfile`.
  - Checks Notion's `X-Notion-Signature`.
  - Drops duplicate events by id and rejects deliveries more than 10 minutes old.
  - Keeps a durable queue with retries and backoff, and a dead-letter list.
  - `notion_workflow` actions `events`, `replay`, `discard`; `GET /healthz`.
- **Failure notifications:**
  - per workflow (`on_failure`: Slack, HTTP, or a page comment);
  - for rule runs, through `NOTION_PLUS_NOTIFY`.
- **Settings:** `NOTION_PLUS_HTTP_ALLOW` (hosts HTTP steps may call), `NOTION_PLUS_SECRET_<NAME>` (workflow secrets, redacted wherever runs are stored or shown), `NOTION_PLUS_WORKFLOWS`, `NOTION_PLUS_WEBHOOK_TOKEN`, `NOTION_PLUS_WEBHOOK_PORT`, `NOTION_PLUS_NOTIFY`.
- **`convert`** turns a v1 rule into an equivalent workflow, saved disabled.
- **`docs/hosted-design.md`:** the design for a hosted, multi-user mode. Not built.

### Changed
- `safeFetch` can send POST/PUT/PATCH/DELETE with headers and a body. Those requests never follow redirects.
- The GitHub workflow runs `automations/workflows.json` and saves workflow run state on the state branch, alongside the rules' state.

### Fixed
- A rule row whose `append` failed part-way no longer duplicates blocks on retry. The retry removes what the failed attempt left first.

## 0.12.0

Templates and a wider chart catalog (audit batch 5: P2-03, P2-04, P3-07).

### Added
- **`notion_template`** builds pages from reusable, versioned templates.
  - **Inputs:** checked variables, `each` loops, `if`/`else` conditions, reusable `parts`, and `slots` filled at render time.
  - **Blocks:** markdown, callouts, toggles, columns, KPI numbers (fixed or computed from a database), charts, live views, tables (fixed or queried), Gantt charts, and raw block specs.
  - **Actions:** `list`, `get`, `validate`, `preview`, `render`, `save`, `delete`, `export`, `import`.
    - `preview` shows the outline, counts, and estimated requests, and with `compare_to` a line diff against an existing page.
    - `render` creates a page or appends to one. `notion_undo` removes it.
  - **Built-in templates:** `weekly-executive-report`, `content-brief`, `launch-plan`, `research-dossier`.
- **New chart types:** `histogram`, `heatmap`, `boxplot`, `waterfall`, `funnel`, `bullet`, `small_multiples`, `dual_axis`, `treemap`.
- **Other chart options:**
  - `annotations` add labeled reference lines at a category or a value.
  - `palette` picks named palettes (`default`, `cool`, `warm`, `mono`) or your own hex colors.
  - `format: "svg"` makes vector images.
  - `data_table` adds a "Chart data" toggle under the chart with a description and the numbers, as a text alternative.
  - Every chart returns `alt_text`.
- **`vega_lite` on `notion_create_chart`** renders a whole Vega-Lite spec. It is checked first: inline data only, no URLs, links, or image marks, and size limits. The server's theme applies.

### Changed
- Chart rendering has a 20-second time limit and can't load anything: the renderer's loader refuses every request.

### Not done (planned)
- Sankey and network diagrams. They need layout code that Vega doesn't provide.
- Rebuilding `notion_build_report` on top of templates. It keeps its own implementation for now.

## 0.11.0

Safe to operate and verify (audit batch 4: P1-07, P2-05 to P2-09, P2-13, P2-14, P2-17, P3-01 to P3-06).

### Breaking
- **Every tool returns the same JSON shape:** `{status, summary, data, warnings?, undo?, pagination?, next_actions?}`.
  - A tool's own result moves into `data`.
  - `undo_id` becomes `undo: {id, coverage}`.
  - `notes` and `note` become `warnings`.
  - `next_cursor` becomes `pagination`.
  - `next_step` becomes `next_actions`.
  - Errors are `{status: "error", summary, error}`.
  - Scripts can use `unwrap()` from `src/tools/util.ts` to read results in the old shape.
- **`notion_history` returns `{entries, next_cursor?}`** instead of a bare list. Entries carry `id` (was `undo_id`), and their status can now be `partly undoable`, `interrupted`, `in progress`, or `failed`.
- **Node 22 or later is required.** Node 20 reached end of life in April 2026.

### Added
- **`notion_doctor`** checks the setup and says how to fix what isn't working. It covers:
  - settings, the token, and the integration's capabilities;
  - whether any pages are shared with it;
  - the local state folder and its files, and the upload folders;
  - the chart renderer;
  - automation rules and unfinished runs.
- **`notion_capabilities`** reports what the server can do with this integration (probed with read-only calls), plus the API version and the limits.
- **Settings are checked in one place** (`src/config.ts`).
  - A bad value, such as a timeout that isn't a number, an API version that isn't a date, a misspelled time zone, or an unknown log mode, is reported with every problem listed.
  - The server still starts, so the message reaches the conversation through the tools and `notion_doctor`.
  - The startup log includes a redacted settings summary.
- **Undo coverage** on every write (`full`, `partial`, or `none`), and an "Undo coverage" table in the README.
- **`notion_views` `list`** pages with `limit` and `cursor`, and reads view details a few at a time.
- **The server's instructions, and every result carrying page, block, comment, or row text, say that Notion content is untrusted data,** not instructions.
- `SUPPORT.md`: supported versions, hosts, platforms, and the deprecation policy.

### Changed
- **Downloads have limits.** Re-uploaded files and chart backups only fetch HTTPS URLs, refuse private, local, and link-local addresses (checked at the address actually connected to, at every redirect), follow at most 5 redirects, cap the size (50 MB, 20 MB for chart backups), and time out.
- **Large results stay valid JSON.** They shrink their longest list and report how many items were left out. They are never cut mid-text.
- **Tool annotations are explicit.**
  - Writes default to not idempotent.
  - `notion_update_properties`, `notion_bulk_update`, `notion_patch_block`, and `notion_update_page` are marked idempotent.
  - `notion_views` is marked destructive, because it can delete views.
- **Fewer type casts.** The most common Notion calls go through typed adapters, cutting `as never` casts from 55 to 33.
- **CI:**
  - runs on Node 22 and 24;
  - checks that versions agree;
  - fails on high-severity runtime advisories;
  - enforces coverage thresholds.
  - Dependency review runs on pull requests. Dependabot proposes npm and Actions updates weekly. Every Action is pinned to a commit.
- **Release:**
  - runs the full check;
  - install-tests each platform's bundle (unpack, start, list every tool, render a chart);
  - publishes `sha256sums.txt`, a CycloneDX SBOM, and build provenance.
- **Live tests:** `live.yml` runs the live smoke and acceptance suites nightly and on tags once the `NOTION_TOKEN` and `NOTION_TEST_PAGE` secrets exist. Until then it passes with a notice.
- **Vitest 5** fixes the moderate advisory. Property tests (fast-check) cover CSV round-trips, markdown input, schedule occurrences, and state-file parsing.

### Known
- `npm audit` still reports `tmp` (high) through `@anthropic-ai/mcpb`'s interactive prompts. It's a dev-only tool used to build bundles, with no fix upstream yet. Runtime dependencies have no advisories.

## 0.10.0

Automation runs that recover (audit batch 3: P1-01, P1-02, P1-05, P1-06, P1-08, P2-11, P2-12, P2-15).

### Changed
- Row actions run as ordered steps with progress saved after each. The order is `set` values that keep the row matching, then `append` and `comment`, then the marker and any `set` values the condition checks, then `trash`. A row is marked handled only after everything before it succeeded.
- A row whose step failed is resumed on the next run from that step. Steps that already succeeded aren't repeated.
- A scheduled occurrence counts as fired only when all its rows and `then` actions succeeded. Otherwise the next run retries it without repeating completed `then` actions. Before, a failed occurrence was marked fired and skipped for good.
- Rules managed from Claude live in `rules.json` in the home folder, so reinstalling or upgrading keeps them. Rules in a checkout's `automations/rules.json` are copied there once. The GitHub workflow keeps running the committed file via `NOTION_PLUS_RULES`.
- Run limits cover rows, Notion requests, appended blocks, and wall time (`--max-rows`, `--max-requests`, `--max-blocks`, `--max-minutes`). Rows past a limit wait for the next run. `--max-writes` still works as the old name for `--max-rows`.
- The GitHub workflow saves schedule state to the `notion-automations-state` branch after every run instead of relying on the Actions cache. Once that branch exists, a missing state file stops the run (`--require-state`) instead of re-firing old occurrences.
- The CI workflow ignores that branch.

### Fixed
- `notion_automation` `run` is an error unless every rule succeeded, so a failed automation no longer looks successful. Each rule reports `succeeded`, `partial`, `failed`, or `skipped`, with the run's `run_id`, and undo ids are kept either way. The CLI exits non-zero for partial runs too.
- A failure to write the run log is reported as a warning instead of being dropped.
- The workflow's failure report creates the `notion-automations` label if it's missing. If it can't open an issue, it writes to the job summary.
- An unexpected error mid-rule still records undo for the writes that already happened.
- A rule's first scheduled occurrence is still retried more than 70 minutes after it failed, instead of being dropped because the rule had no fire history.

### Known limitation
- If an `append` step fails part-way (some blocks landed), its retry appends the whole content again. Idempotency markers are planned for the workflow engine.

### Added
- New `notion_automation` actions:
  - `waive`: give up on a rule's unfinished firing.
  - `export` / `import`: the whole rules file as JSON.
  - `deploy`: the rules file with chart recipes embedded, plus the GitHub Actions setup steps.
- `history` pages with `limit` and `cursor` and skips malformed lines.
- Structured JSON logs on stderr, each with the `run_id` (`NOTION_PLUS_LOG=text|off`).

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
