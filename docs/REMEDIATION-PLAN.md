# Notion Plus MCP: remediation and extension plan

## Context
`COMPREHENSIVE-CODE-AUDIT.md` (v0.8.0) found 10 P1, 18 P2 and 8 P3 issues. The main gap is durability, not features:
- Automation rows can be marked done after only half their actions ran.
- `last_fired` advances even when rows failed.
- A corrupt state file is quietly read as empty state.
- Writes from two processes race and one can be lost.
- A failed run returns MCP success.
- Database copy can silently drop content.

The goal is to fix all of these, then extend the build: templates, advanced charts, webhooks and a typed workflow engine. Two decisions are already made:
- **Storage:** keep JSON files, but harden them. No SQLite.
- **Scope:** everything through webhooks. Hosted multi-tenant mode is only designed, not built.

## How the work ships
- Six batches.
- Each batch is a branch built from the latest `main`, with one PR opened when the batch is done.
- Every PR must pass `npm run check` (lint, typecheck, test, build) plus the new tests for that batch.
- Each batch bumps the minor version and adds a CHANGELOG entry.
- Branch naming: the first batch lands on `claude/jolly-heisenberg-dx08r6`, which already carries the audit doc. Later batches continue on that branch after the previous PR merges, restarted from `main` each time.

---

## Batch 1: Fix database-copy correctness (v0.8.1). Small, ships first.
Fixes P1-09, P1-10 and P2-18 (partly).
- `src/services/dbcopy.ts` `readDatabase`:
  - Return `null` only for the specific Notion error that means "this is a linked view the API can't read" (`object_not_found` / `validation_error` on a linked source).
  - Re-throw every other error: auth, restricted, rate limit, timeout, 5xx. Use the error codes that `formatError` in `src/services/notion.ts` already checks.
- `src/services/copy.ts`, the row-content callback (~193-205):
  - Copy row children through the same recursive path the top-level page uses, so nested pages are copied too (with a depth limit).
  - Collect `skipped` and `nestedPages` from every row into the duplicate's result.
- The result gets `status: "complete" | "partial"` and a `warnings[]` list. The tool returns `isError` when the copy is partial.
- Add `max_rows` and `copy_row_content` options to duplicate. The dry run reports estimated rows, blocks and API calls.
- Tests in `test/content.test.ts` with mocked failures (403, 429, timeout). Add a live smoke case for a row that contains a sub-page.

## Batch 2: Durable persistence foundation (v0.9.0)
Fixes P1-03, P1-04, P2-10 and P3-08.
- New `src/services/store.ts`, a single JSON store helper used everywhere:
  - `readJson(path, schema)`:
    - A missing file (`ENOENT`) returns the default.
    - Bad JSON, a failed schema check or an unreadable file throws a new `StateCorruptError`. The bad file is moved to `<file>.corrupt-<ts>` and the error says how to recover.
  - `writeJson(path, data)`:
    - Writes a unique temp file `<file>.<pid>.<rand>.tmp`, fsyncs it, then renames it over the real file.
    - Keeps a rotating `.bak` copy.
    - Wraps the data in a versioned envelope `{version, revision, data}`.
  - `withLock(path, fn)`:
    - A cross-process lock using an exclusive-create `.lock` file that records the pid and a timestamp.
    - Stale locks time out. Retries back off.
    - No new dependency, so a small implementation.
  - `update(path, schema, fn)` does load, modify and save inside the lock, with a check that the revision hasn't changed underneath.
- Move `src/services/journal.ts`, `chartstore.ts` and the automation state and rules code onto `store.ts`. Fix `journal.ts` reading `NOTION_PLUS_HOME` at module load; it should use `homeDir()` like the others.
- Write-ahead journal:
  - `record` is split into `begin(op, snapshots)`, then `commit(id, resultIds)` or `abort(id)`.
  - Every write tool in `src/tools/*` follows the same pattern: begin, then the Notion call, then commit.
  - On startup, entries still marked `running` show up in `history` as "interrupted, may need manual check".
- Namespace all state by workspace: the bot id from `users.me`, cached.
- `expected_revision` on automation rule `save`.
- Tests:
  - A concurrency test: two child processes each doing 100 `update` calls, with no updates lost.
  - Corruption tests: truncated, malformed and permission-denied files.
  - A test that a crash between begin and commit leaves an `interrupted` entry.

## Batch 3: Automation execution correctness (v0.10.0)
Fixes P1-01, P1-02, P1-05, P1-06, P1-08 (local part), P2-11, P2-12 and P2-15.
- Runs and occurrences, in `src/services/automations.ts`:
  - Each run gets a run id. Each occurrence is `(rule_id, occurrence_iso)` and moves through the states pending, running, partial, succeeded, failed.
  - These are stored in `automation-state.json` through `store.update`.
  - Each row keeps a checkpoint: the list of completed step indexes, keyed by `run/occurrence/row_id`.
  - A retry resumes from the first step that didn't finish.
- Action order inside a row:
  - Append, comment and trash-free `set` steps run first.
  - The marker property and any `set` that removes the row from the rule's filter are written **last**, as the commit step.
  - Trash always runs last of all.
- `last_fired` only advances when the occurrence is `succeeded`, or the operator waived it with a new `notion_automation` action `waive`.
- Rename `max_writes` to `max_rows`, keeping the old name as a deprecated alias. Add real budgets for API calls, created blocks and wall time.
- Rules storage (P1-05):
  - Rules now live in `homeDir()/rules.json` by default. `NOTION_PLUS_RULES`, or repo mode, is an explicit opt-in.
  - New `export` and `import` actions.
  - New `deploy` action that prints a ready-to-commit rules file plus workflow snippet.
- Tool results:
  - `run` returns `isError: true` if any rule failed.
  - Every result has `status: success | partial_success | failed`, a `run_id`, and the undo ids.
  - `history` gets paging (`cursor`, `limit`), skips bad lines instead of failing, and warns when the run log couldn't be written.
- Durable state in GitHub Actions (P1-08):
  - The workflow uploads the state as an artifact and records the latest artifact id on a `notion-automations-state` branch.
  - The Actions cache stays, but only as a speed-up.
  - If state can't be restored, the runner refuses to start (fails closed) unless `--allow-fresh-state` is passed.
- `.github/workflows/automations.yml`: create the label if missing before opening an issue, and write a job summary as a fallback.
- Structured stderr logs (JSON lines with run and step ids).
- Tests: kill mid-row and resume, partial failure keeps `last_fired` unchanged, marker is written last, `isError` is set.

**→ Open PR after this batch.** It is the core durability milestone, covering batches 2 and 3 together if batch 2's PR hasn't merged yet.

## Batch 4: Hardening, operations and CI (v0.11.0)
Fixes P1-07, P2-05, P2-06, P2-07, P2-08, P2-09, P2-13, P2-14, P2-17 and P3-01 to P3-06.
- `src/config.ts`: one zod schema for all environment variables, parsed at startup, with a redacted summary logged to stderr.
- New `notion_doctor` tool. It checks:
  - the token and the bot's capabilities,
  - that the home directory is writable and state is valid,
  - that the chart renderer works,
  - how the rules are deployed and when the scheduler last ran.
- New `src/services/fetch.ts` for all outbound downloads:
  - HTTPS only, and private or loopback addresses are blocked after DNS lookup.
  - At most 5 redirects, a byte cap, and a timeout.
  - Replaces the current downloads in `files.ts:92` and `visualops.ts:116`.
- `src/tools/util.ts`:
  - Every result becomes a standard envelope `{status, summary, data, warnings, undo, pagination}`.
  - `fitToLimit` never cuts raw JSON text any more. Its last resort is the summary plus a cursor.
- Pagination: view listing with a cursor and a concurrency limit on detail reads, plus paged history and aggregates.
- Server instructions and read-tool responses say that Notion content is untrusted.
- Tool annotations are set per tool, with a test that checks each tool's write, destructive and idempotent flags.
- README: rewrite the undo claims honestly, and document the modes (interactive / scheduled / GitHub / webhook).
- CI:
  - Pin actions to commit SHAs. Add Dependabot and dependency review. Upgrade Vitest.
  - New `live.yml` runs nightly and when a release is tagged. It uses the secrets for a throwaway Notion workspace, runs `smoke` and `acceptance`, and cleans up. It only runs on trusted branches.
  - `release.yml` runs `npm run check`, then packs, unpacks, launches the server, does MCP initialize and list-tools (expecting all tools), and renders a chart, on each OS. It also publishes checksums and build provenance attestation plus an SBOM.
  - A check that the versions in `package.json`, `manifest.json`, the CHANGELOG and the git tag all agree.
- Add coverage thresholds, and fast-check property tests for markdown, CSV, schedule and the state parsers.

**→ Open PR.**

## Batch 5: Content templates and advanced charts (v0.12.0)
Covers P2-03, P2-04 and P3-07. This is Phase 1 and Phase 2 of the audit roadmap.
- New `src/services/templates.ts` and a `notion_render_template` tool:
  - A versioned template spec with variables, `each` loops, `if` conditions, named slots, and parts that can be reused.
  - Components are markdown blocks, callouts, columns, KPI rows, charts, native views, tables and Gantt charts.
  - `preview` shows the planned block tree plus estimated block count and API calls, and compares against an existing page.
  - Templates are stored in `homeDir()/templates/` through `store.ts`, with import and export.
  - It reuses `markdown.ts` and `appendSpecs` in `blocks.ts`, plus the existing report building blocks in `visualops.ts`. `notion_build_report` is rebuilt as a template that ships with the server.
- Charts, in `src/services/charts.ts` (already Vega-Lite → SVG → PNG):
  - New safe high-level chart types: histogram, heatmap, box plot, waterfall, funnel, bullet, small multiples, dual-axis/layered, and annotations.
  - An advanced option that takes raw Vega-Lite, checked before rendering:
    - no loading data from URLs,
    - limits on row count and output size,
    - a timeout.
  - Sankey, network and treemap charts use Vega (not Vega-Lite) templates that ship with the server.
  - SVG output, explicit width and height, alt text that is generated automatically, and a table of the data included next to the chart.
  - Theme tokens, including brand-colour packs.
  - Snapshot tests comparing the SVG output (text diffs, so they behave the same on every OS).
- Sample templates: weekly executive report, content brief, launch plan, research dossier.

**→ Open PR.**

## Batch 6: Webhooks and workflow engine (v1.0.0-beta)
Covers P2-01 and P2-02. This is Phase 3 of the audit roadmap.
- Workflow schema v2 in `src/services/workflow/`:
  - Typed steps, each with an `id`, `if`, `retry`, `timeout` and outputs that later steps can reference with `${steps.x.out}`.
  - Branching (`switch`), `foreach`, `delay`, and `approval` (the run pauses and waits for a Notion checkbox or comment).
  - Sub-workflows.
  - v1 rules convert automatically into v2.
  - It runs on batch 3's checkpointed executor, so every step can be resumed and is idempotent.
- New step types:
  - move and duplicate a page,
  - patch, replace and delete blocks,
  - sync relations, maintain views, export a page as markdown,
  - `http` calls to an allow-list of hosts (through `fetch.ts`), plus Slack and email via webhook URLs.
  - Secrets are passed as `${secret:NAME}`, which is filled in from environment variables and redacted in logs. Never shell execution.
- Webhook mode, a new entry point `src/webhook-server.ts` (`npm run webhook`):
  - Checks Notion's webhook signatures.
  - Uses the event id to drop duplicates and to reject replays.
  - Keeps a durable queue on disk using `store.ts`, with retries and backoff.
  - A dead-letter file for events that keep failing, with `replay` and `cancel` actions.
  - Polling stays as a fallback.
  - Docs plus a Dockerfile.
- Notification sinks for runs that failed or partly failed.
- Tests: duplicate or late events, retries, a paused approval, recovery from dead-letter, and daylight-saving and clock changes for schedules.

**→ Open PR.**

## Deferred: design only
Hosted team mode (P2-16): OAuth token vault, a separate client, state and rate limit per tenant, and HTTP streaming transport. This gets a design doc `docs/hosted-design.md` in batch 6 but no code, so the global state isn't turned into multi-tenant state as a retrofit.

## Ideas beyond the audit
- **Idempotency keys on Notion writes.** Put a hidden `np:<run>:<step>` marker in created blocks or comments, so a step that is resumed can find what it already created instead of creating it twice. This is what makes the "no repeated side effects" exit criterion reachable given how the Notion API works.
- **A control database in Notion.** An optional place to put run history and state, so users can see and edit automation state inside Notion and GitHub runners have durable state for free.
- **`notion_capabilities`.** Returns what the current token and API can actually do, instead of what the README says.
- **Fault-injection harness.** A mock of the Notion client that can fail or crash at step N. It makes every future write path testable for crashes.

## Verification (every batch)
- `npm ci && npm run check`. The new unit and property tests pass.
- The batch-specific crash, concurrency and corruption tests pass. Batch 2 onward runs multiple processes.
- `npm run inspect` to call the changed tools by hand through MCP Inspector.
- Live suite (batch 4 onward in CI): `npm run smoke && npm run acceptance` against a throwaway workspace. **Needs:** a throwaway Notion integration token and workspace saved as repository secrets. The user needs to set these up before batch 4's live CI can pass.
- The release dry run bundles and handshakes on all 4 operating systems.
